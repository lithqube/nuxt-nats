import { createHash, createHmac } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { credentialRequest } from '../http'
import { CredentialsProviderError } from '../types'

// AWS identity for Infisical AWS auth, without the AWS SDK: resolve credentials from the
// standard sources, then SigV4-sign an sts:GetCallerIdentity request for Infisical to replay.

export interface AwsCredentials {
  accessKeyId: string
  secretAccessKey: string
  sessionToken?: string
}

type Env = Record<string, string | undefined>
const NAME = 'infisical'
const IMDS = 'http://169.254.169.254'
const ECS_HOST = 'http://169.254.170.2'
const METADATA_TIMEOUT_MS = 2_000

function withTimeout(signal: AbortSignal, ms = METADATA_TIMEOUT_MS) {
  return AbortSignal.any([signal, AbortSignal.timeout(ms)])
}

async function imdsToken(signal: AbortSignal): Promise<string> {
  const res = await credentialRequest(NAME, `${IMDS}/latest/api/token`, {
    method: 'PUT',
    headers: { 'X-aws-ec2-metadata-token-ttl-seconds': '21600' },
    signal: withTimeout(signal),
  })
  return res.text()
}

/** Region: explicit, AWS_REGION, AWS_DEFAULT_REGION, then the EC2 instance identity document. */
export async function resolveAwsRegion(explicit: string | undefined, env: Env, signal: AbortSignal): Promise<string> {
  const region = explicit || env.AWS_REGION || env.AWS_DEFAULT_REGION
  if (region) return region
  try {
    const token = await imdsToken(signal)
    const res = await credentialRequest(NAME, `${IMDS}/latest/dynamic/instance-identity/document`, {
      headers: { 'X-aws-ec2-metadata-token': token, 'Accept': 'application/json' },
      signal: withTimeout(signal),
    })
    const doc = await res.json() as { region?: string }
    if (doc.region) return doc.region
  }
  catch {
    // not on EC2 — fall through to the error below
  }
  throw new CredentialsProviderError(NAME, 'aws-region', 'cannot determine the AWS region; set credentials.infisical.auth.region or AWS_REGION')
}

function fromJson(c: { AccessKeyId?: string, SecretAccessKey?: string, Token?: string, SessionToken?: string }, source: string): AwsCredentials {
  if (!c.AccessKeyId || !c.SecretAccessKey) {
    throw new CredentialsProviderError(NAME, 'aws-credentials', `${source} returned no AWS credentials`)
  }
  return { accessKeyId: c.AccessKeyId, secretAccessKey: c.SecretAccessKey, sessionToken: c.Token ?? c.SessionToken }
}

/**
 * AWS credentials from, in order: env vars, a web identity token (EKS IRSA), the container
 * credentials endpoint (ECS, EKS Pod Identity), and the EC2 instance profile (IMDSv2).
 */
export async function resolveAwsCredentials(env: Env, region: string, signal: AbortSignal): Promise<AwsCredentials> {
  if (env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY) {
    return { accessKeyId: env.AWS_ACCESS_KEY_ID, secretAccessKey: env.AWS_SECRET_ACCESS_KEY, sessionToken: env.AWS_SESSION_TOKEN || undefined }
  }

  if (env.AWS_WEB_IDENTITY_TOKEN_FILE && env.AWS_ROLE_ARN) {
    let token: string
    try {
      token = readFileSync(env.AWS_WEB_IDENTITY_TOKEN_FILE, 'utf8').trim()
    }
    catch {
      throw new CredentialsProviderError(NAME, 'aws-credentials', `cannot read AWS_WEB_IDENTITY_TOKEN_FILE "${env.AWS_WEB_IDENTITY_TOKEN_FILE}"`)
    }
    // A POST body, so the identity token never appears in a URL.
    const body = new URLSearchParams({
      Action: 'AssumeRoleWithWebIdentity',
      Version: '2011-06-15',
      RoleArn: env.AWS_ROLE_ARN,
      RoleSessionName: env.AWS_ROLE_SESSION_NAME || `nuxt-nats-${Date.now()}`,
      WebIdentityToken: token,
    })
    const res = await credentialRequest(NAME, `https://sts.${region}.amazonaws.com/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8', 'Accept': 'application/json' },
      body: body.toString(),
      signal: withTimeout(signal, 10_000),
    })
    const data = await res.json() as { AssumeRoleWithWebIdentityResponse?: { AssumeRoleWithWebIdentityResult?: { Credentials?: Record<string, string> } } }
    return fromJson(data.AssumeRoleWithWebIdentityResponse?.AssumeRoleWithWebIdentityResult?.Credentials ?? {}, 'AssumeRoleWithWebIdentity')
  }

  const fullUri = env.AWS_CONTAINER_CREDENTIALS_FULL_URI
  const relativeUri = env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI
  if (fullUri || relativeUri) {
    let authorization = env.AWS_CONTAINER_AUTHORIZATION_TOKEN
    if (env.AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE) {
      try {
        authorization = readFileSync(env.AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE, 'utf8').trim()
      }
      catch {
        throw new CredentialsProviderError(NAME, 'aws-credentials', `cannot read AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE "${env.AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE}"`)
      }
    }
    const res = await credentialRequest(NAME, fullUri || `${ECS_HOST}${relativeUri}`, {
      headers: authorization ? { Authorization: authorization } : {},
      signal: withTimeout(signal),
    })
    return fromJson(await res.json() as Record<string, string>, 'the container credentials endpoint')
  }

  let token: string
  try {
    token = await imdsToken(signal)
  }
  catch (err) {
    throw new CredentialsProviderError(NAME, 'aws-credentials', 'no AWS credentials found (env, web identity, container or EC2 instance profile)', { cause: err })
  }
  const headers = { 'X-aws-ec2-metadata-token': token }
  const roles = await (await credentialRequest(NAME, `${IMDS}/latest/meta-data/iam/security-credentials/`, { headers, signal: withTimeout(signal) })).text()
  const role = roles.split('\n')[0]?.trim()
  if (!role) throw new CredentialsProviderError(NAME, 'aws-credentials', 'the EC2 instance has no IAM role')
  const res = await credentialRequest(NAME, `${IMDS}/latest/meta-data/iam/security-credentials/${encodeURIComponent(role)}`, { headers, signal: withTimeout(signal) })
  return fromJson(await res.json() as Record<string, string>, 'the EC2 instance profile')
}

const hex = (data: string) => createHash('sha256').update(data, 'utf8').digest('hex')
const hmac = (key: string | Buffer, data: string) => createHmac('sha256', key).update(data, 'utf8').digest()

export const STS_GET_CALLER_IDENTITY_BODY = 'Action=GetCallerIdentity&Version=2011-06-15'

/** SigV4-sign `POST https://sts.<region>.amazonaws.com/` sts:GetCallerIdentity. Returns the request headers. */
export function signGetCallerIdentity(creds: AwsCredentials, region: string, now = new Date()): Record<string, string> {
  const host = `sts.${region}.amazonaws.com`
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '') // 20261007T210538Z
  const dateStamp = amzDate.slice(0, 8)
  const headers: Record<string, string> = {
    'content-type': 'application/x-www-form-urlencoded; charset=utf-8',
    'host': host,
    'x-amz-date': amzDate,
  }
  if (creds.sessionToken) headers['x-amz-security-token'] = creds.sessionToken

  const names = Object.keys(headers).sort()
  const signedHeaders = names.join(';')
  const canonicalRequest = [
    'POST',
    '/',
    '',
    ...names.map(n => `${n}:${headers[n]}`),
    '',
    signedHeaders,
    hex(STS_GET_CALLER_IDENTITY_BODY),
  ].join('\n')
  const scope = `${dateStamp}/${region}/sts/aws4_request`
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, hex(canonicalRequest)].join('\n')
  const kDate = hmac(`AWS4${creds.secretAccessKey}`, dateStamp)
  const kSigning = hmac(hmac(hmac(kDate, region), 'sts'), 'aws4_request')
  const signature = createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex')

  return {
    'Content-Type': headers['content-type']!,
    'Host': host,
    'X-Amz-Date': amzDate,
    ...(creds.sessionToken ? { 'X-Amz-Security-Token': creds.sessionToken } : {}),
    'Authorization': `AWS4-HMAC-SHA256 Credential=${creds.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  }
}

/** The Infisical aws-auth login body for this workload's AWS identity. */
export async function awsLoginBody(identityId: string, region: string | undefined, env: Env, signal: AbortSignal) {
  const r = await resolveAwsRegion(region, env, signal)
  const creds = await resolveAwsCredentials(env, r, signal)
  const headers = signGetCallerIdentity(creds, r)
  return {
    identityId,
    iamHttpRequestMethod: 'POST',
    iamRequestBody: Buffer.from(STS_GET_CALLER_IDENTITY_BODY).toString('base64'),
    iamRequestHeaders: Buffer.from(JSON.stringify(headers)).toString('base64'),
  }
}
