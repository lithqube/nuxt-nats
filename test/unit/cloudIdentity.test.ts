import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { SignatureV4 } from '@smithy/signature-v4'
import { HttpRequest } from '@smithy/protocol-http'
import { Hash } from '@smithy/hash-node'
import {
  awsLoginBody,
  resolveAwsCredentials,
  resolveAwsRegion,
  signGetCallerIdentity,
  STS_GET_CALLER_IDENTITY_BODY,
} from '../../src/runtime/server/credentials/cloud/aws'
import { gcpIdentityToken } from '../../src/runtime/server/credentials/cloud/gcp'
import { azureAccessToken } from '../../src/runtime/server/credentials/cloud/azure'
import { infisicalLoginBody } from '../../src/runtime/server/credentials/providers/infisical'

const signal = new AbortController().signal
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
const text = (body: string, status = 200) => new Response(body, { status })

/** A fetch mock routed by "METHOD url-prefix"; unmatched requests fail like an unreachable host. */
function route(routes: Record<string, () => Response>) {
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    const key = Object.keys(routes).find(k => `${init?.method ?? 'GET'} ${url}`.startsWith(k))
    if (!key) throw new TypeError(`fetch failed: ${url}`)
    return routes[key]!()
  })
  vi.stubGlobal('fetch', fn)
  return fn
}

function tmpFile(content: string) {
  const file = join(mkdtempSync(join(tmpdir(), 'nuxt-nats-')), 'f')
  writeFileSync(file, content)
  return file
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const KEYS = { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY' }

/** The AWS SDK's own SigV4 signer, as the reference implementation. */
async function smithySign(creds: { accessKeyId: string, secretAccessKey: string, sessionToken?: string }, region: string, date: Date) {
  const signer = new SignatureV4({ credentials: creds, region, service: 'sts', sha256: Hash.bind(null, 'sha256'), applyChecksum: false })
  const req = new HttpRequest({
    protocol: 'https:',
    hostname: `sts.${region}.amazonaws.com`,
    path: '/',
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded; charset=utf-8', 'host': `sts.${region}.amazonaws.com` },
    body: STS_GET_CALLER_IDENTITY_BODY,
  })
  return (await signer.sign(req, { signingDate: date })).headers
}

describe('signGetCallerIdentity (SigV4)', () => {
  const date = new Date('2026-10-07T21:05:38.851Z')

  it('matches the AWS SDK signer', async () => {
    const ours = signGetCallerIdentity(KEYS, 'eu-west-1', date)
    const ref = await smithySign(KEYS, 'eu-west-1', date)
    expect(ours.Authorization).toBe(ref.authorization)
    expect(ours['X-Amz-Date']).toBe('20261007T210538Z')
    expect(ours.Host).toBe('sts.eu-west-1.amazonaws.com')
  })

  it('matches the AWS SDK signer with a session token', async () => {
    const creds = { ...KEYS, sessionToken: 'FwoGZXIvYXdzEXAMPLETOKEN' }
    const ours = signGetCallerIdentity(creds, 'us-east-1', date)
    const ref = await smithySign(creds, 'us-east-1', date)
    expect(ours.Authorization).toBe(ref.authorization)
    expect(ours['X-Amz-Security-Token']).toBe(creds.sessionToken)
    expect(ours.Authorization).toContain('SignedHeaders=content-type;host;x-amz-date;x-amz-security-token')
  })
})

describe('resolveAwsRegion', () => {
  it('prefers explicit, then AWS_REGION, then AWS_DEFAULT_REGION', async () => {
    expect(await resolveAwsRegion('ap-south-1', { AWS_REGION: 'x' }, signal)).toBe('ap-south-1')
    expect(await resolveAwsRegion('', { AWS_REGION: 'eu-central-1', AWS_DEFAULT_REGION: 'y' }, signal)).toBe('eu-central-1')
    expect(await resolveAwsRegion(undefined, { AWS_DEFAULT_REGION: 'us-west-2' }, signal)).toBe('us-west-2')
  })

  it('falls back to the EC2 instance identity document (IMDSv2)', async () => {
    const fetch = route({
      'PUT http://169.254.169.254/latest/api/token': () => text('imds-token'),
      'GET http://169.254.169.254/latest/dynamic/instance-identity/document': () => json({ region: 'sa-east-1' }),
    })
    expect(await resolveAwsRegion(undefined, {}, signal)).toBe('sa-east-1')
    expect(fetch.mock.calls[1]![1]!.headers).toMatchObject({ 'X-aws-ec2-metadata-token': 'imds-token' })
  })

  it('fails with a clear message off EC2', async () => {
    route({})
    await expect(resolveAwsRegion(undefined, {}, signal)).rejects.toMatchObject({ code: 'aws-region' })
  })
})

describe('resolveAwsCredentials', () => {
  it('reads env credentials first', async () => {
    const fetch = route({})
    expect(await resolveAwsCredentials({ AWS_ACCESS_KEY_ID: 'a', AWS_SECRET_ACCESS_KEY: 's', AWS_SESSION_TOKEN: 't' }, 'us-east-1', signal))
      .toEqual({ accessKeyId: 'a', secretAccessKey: 's', sessionToken: 't' })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('assumes the role with a web identity token (EKS IRSA), token in the body only', async () => {
    const fetch = route({
      'POST https://sts.eu-west-1.amazonaws.com/': () => json({
        AssumeRoleWithWebIdentityResponse: { AssumeRoleWithWebIdentityResult: { Credentials: { AccessKeyId: 'ASIA1', SecretAccessKey: 'sec', SessionToken: 'tok' } } },
      }),
    })
    const env = { AWS_WEB_IDENTITY_TOKEN_FILE: tmpFile('web-identity-jwt\n'), AWS_ROLE_ARN: 'arn:aws:iam::1:role/app', AWS_ROLE_SESSION_NAME: 's1' }
    expect(await resolveAwsCredentials(env, 'eu-west-1', signal)).toEqual({ accessKeyId: 'ASIA1', secretAccessKey: 'sec', sessionToken: 'tok' })
    const [url, init] = fetch.mock.calls[0]!
    expect(url).not.toContain('web-identity-jwt')
    const body = new URLSearchParams(init!.body as string)
    expect(body.get('Action')).toBe('AssumeRoleWithWebIdentity')
    expect(body.get('WebIdentityToken')).toBe('web-identity-jwt')
    expect(body.get('RoleArn')).toBe('arn:aws:iam::1:role/app')
  })

  it('reports an unreadable web identity token file', async () => {
    route({})
    await expect(resolveAwsCredentials({ AWS_WEB_IDENTITY_TOKEN_FILE: '/nope', AWS_ROLE_ARN: 'arn' }, 'us-east-1', signal))
      .rejects.toThrow(/cannot read AWS_WEB_IDENTITY_TOKEN_FILE/)
  })

  it('uses the container endpoint with an authorization token file (EKS Pod Identity)', async () => {
    const fetch = route({
      'GET http://169.254.170.23/v1/credentials': () => json({ AccessKeyId: 'ASIA2', SecretAccessKey: 's2', Token: 't2' }),
    })
    const env = { AWS_CONTAINER_CREDENTIALS_FULL_URI: 'http://169.254.170.23/v1/credentials', AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE: tmpFile('pod-token') }
    expect(await resolveAwsCredentials(env, 'us-east-1', signal)).toEqual({ accessKeyId: 'ASIA2', secretAccessKey: 's2', sessionToken: 't2' })
    expect(fetch.mock.calls[0]![1]!.headers).toEqual({ Authorization: 'pod-token' })
  })

  it('uses the ECS relative URI', async () => {
    route({ 'GET http://169.254.170.2/v2/credentials/abc': () => json({ AccessKeyId: 'ASIA3', SecretAccessKey: 's3' }) })
    expect(await resolveAwsCredentials({ AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: '/v2/credentials/abc' }, 'us-east-1', signal))
      .toEqual({ accessKeyId: 'ASIA3', secretAccessKey: 's3', sessionToken: undefined })
  })

  it('falls back to the EC2 instance profile (IMDSv2)', async () => {
    route({
      'PUT http://169.254.169.254/latest/api/token': () => text('imds'),
      'GET http://169.254.169.254/latest/meta-data/iam/security-credentials/app-role': () => json({ AccessKeyId: 'ASIA4', SecretAccessKey: 's4', Token: 't4' }),
      'GET http://169.254.169.254/latest/meta-data/iam/security-credentials/': () => text('app-role\n'),
    })
    expect(await resolveAwsCredentials({}, 'us-east-1', signal)).toEqual({ accessKeyId: 'ASIA4', secretAccessKey: 's4', sessionToken: 't4' })
  })

  it('fails clearly when no source has credentials', async () => {
    route({})
    await expect(resolveAwsCredentials({}, 'us-east-1', signal)).rejects.toMatchObject({ code: 'aws-credentials' })
  })

  it('rejects a source that returns no keys', async () => {
    route({ 'GET http://169.254.170.2/x': () => json({}) })
    await expect(resolveAwsCredentials({ AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: '/x' }, 'us-east-1', signal))
      .rejects.toThrow(/returned no AWS credentials/)
  })
})

describe('awsLoginBody', () => {
  it('encodes the signed request the way Infisical expects', async () => {
    const body = await awsLoginBody('ident-1', 'eu-west-1', { AWS_ACCESS_KEY_ID: KEYS.accessKeyId, AWS_SECRET_ACCESS_KEY: KEYS.secretAccessKey }, signal)
    expect(body.identityId).toBe('ident-1')
    expect(body.iamHttpRequestMethod).toBe('POST')
    expect(Buffer.from(body.iamRequestBody, 'base64').toString()).toBe(STS_GET_CALLER_IDENTITY_BODY)
    const headers = JSON.parse(Buffer.from(body.iamRequestHeaders, 'base64').toString())
    expect(headers.Host).toBe('sts.eu-west-1.amazonaws.com')
    expect(headers.Authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/eu-west-1\/sts\/aws4_request/)
    expect(JSON.stringify(body)).not.toContain(KEYS.secretAccessKey)
  })
})

describe('gcpIdentityToken', () => {
  it('asks the metadata server for a full-format ID token for the audience', async () => {
    const fetch = route({ 'GET http://metadata.google.internal/': () => text('gcp-id-token\n') })
    expect(await gcpIdentityToken('ident-1', signal)).toBe('gcp-id-token')
    const [url, init] = fetch.mock.calls[0]!
    expect(url).toBe('http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity?audience=ident-1&format=full')
    expect(init!.headers).toEqual({ 'Metadata-Flavor': 'Google' })
  })
})

describe('azureAccessToken', () => {
  it('uses the instance metadata service on VMs and AKS', async () => {
    const fetch = route({ 'GET http://169.254.169.254/metadata/identity/oauth2/token': () => json({ access_token: 'az-token' }) })
    expect(await azureAccessToken('https://management.azure.com/', undefined, {}, signal)).toBe('az-token')
    const [url, init] = fetch.mock.calls[0]!
    expect(url).toBe('http://169.254.169.254/metadata/identity/oauth2/token?api-version=2018-02-01&resource=https%3A%2F%2Fmanagement.azure.com%2F')
    expect(init!.headers).toEqual({ Metadata: 'true' })
  })

  it('uses IDENTITY_ENDPOINT on App Service, with a user-assigned identity', async () => {
    const fetch = route({ 'GET http://localhost:42356/msi/token': () => json({ access_token: 'app-token' }) })
    const env = { IDENTITY_ENDPOINT: 'http://localhost:42356/msi/token', IDENTITY_HEADER: 'hdr' }
    expect(await azureAccessToken('https://management.azure.com/', 'client-1', env, signal)).toBe('app-token')
    const [url, init] = fetch.mock.calls[0]!
    expect(url).toContain('api-version=2019-08-01')
    expect(url).toContain('client_id=client-1')
    expect(init!.headers).toEqual({ 'X-IDENTITY-HEADER': 'hdr' })
  })

  it('fails when the endpoint returns no token', async () => {
    route({ 'GET http://169.254.169.254/metadata/identity/oauth2/token': () => json({}) })
    await expect(azureAccessToken('r', undefined, {}, signal)).rejects.toMatchObject({ code: 'identity-token' })
  })
})

describe('infisicalLoginBody — cloud methods', () => {
  it('aws signs an STS request for the identity', async () => {
    const env = { AWS_ACCESS_KEY_ID: 'a', AWS_SECRET_ACCESS_KEY: 's', AWS_REGION: 'eu-west-1' }
    const { path, body } = await infisicalLoginBody({ method: 'aws', identityId: 'id' }, signal, env)
    expect(path).toBe('/api/v1/auth/aws-auth/login')
    expect(Object.keys(body).sort()).toEqual(['iamHttpRequestMethod', 'iamRequestBody', 'iamRequestHeaders', 'identityId'])
  })

  it('gcp uses the identity id as audience by default, or a configured audience', async () => {
    const fetch = route({ 'GET http://metadata.google.internal/': () => text('t') })
    expect(await infisicalLoginBody({ method: 'gcp', identityId: 'id' }, signal, {})).toEqual({ path: '/api/v1/auth/gcp-auth/login', body: { identityId: 'id', jwt: 't' } })
    await infisicalLoginBody({ method: 'gcp', identityId: 'id', audience: 'aud-2' }, signal, {})
    expect(fetch.mock.calls[0]![0]).toContain('audience=id&')
    expect(fetch.mock.calls[1]![0]).toContain('audience=aud-2&')
  })

  it('gcp and azure accept a token that is passed in instead of fetched', async () => {
    const fetch = route({})
    expect((await infisicalLoginBody({ method: 'gcp', identityId: 'id', jwt: 'signed-iam-jwt' }, signal, {})).body.jwt).toBe('signed-iam-jwt')
    expect((await infisicalLoginBody({ method: 'gcp', identityId: 'id', tokenPath: tmpFile('file-jwt') }, signal, {})).body.jwt).toBe('file-jwt')
    expect((await infisicalLoginBody({ method: 'azure', identityId: 'id', jwt: 'az' }, signal, {})).body).toEqual({ identityId: 'id', jwt: 'az' })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('azure uses the default resource unless one is configured', async () => {
    const fetch = route({ 'GET http://169.254.169.254/metadata/identity/oauth2/token': () => json({ access_token: 'az' }) })
    await infisicalLoginBody({ method: 'azure', identityId: 'id' }, signal, {})
    await infisicalLoginBody({ method: 'azure', identityId: 'id', audience: 'api://infisical' }, signal, {})
    expect(fetch.mock.calls[0]![0]).toContain('resource=https%3A%2F%2Fmanagement.azure.com%2F')
    expect(fetch.mock.calls[1]![0]).toContain('resource=api%3A%2F%2Finfisical')
  })
})
