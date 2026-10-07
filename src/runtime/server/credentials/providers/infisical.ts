import { readFileSync } from 'node:fs'
import { credentialRequest } from '../http'
import { awsLoginBody } from '../cloud/aws'
import { AZURE_DEFAULT_RESOURCE, azureAccessToken } from '../cloud/azure'
import { gcpIdentityToken } from '../cloud/gcp'
import { CredentialsProviderError } from '../types'
import type { NatsCredentials, NatsCredentialsProvider } from '../types'

export type InfisicalAuthMethod = 'universal' | 'kubernetes' | 'oidc' | 'aws' | 'gcp' | 'azure'

export interface InfisicalProviderOptions {
  /** Default: https://app.infisical.com */
  siteUrl?: string
  projectId: string
  /** Environment slug, e.g. 'prod'. */
  environment: string
  /** Default: '/' */
  secretPath?: string
  /** The secret holding the `.creds` file (raw or base64) or a bearer user JWT. */
  secretName: string
  auth: {
    method: InfisicalAuthMethod
    /** Machine identity id (every method but universal). */
    identityId?: string
    /** Universal auth. */
    clientId?: string
    clientSecret?: string
    /**
     * File holding the identity token (kubernetes, oidc). Kubernetes default: the pod's
     * service-account token. Re-read on every login, so a projected token can rotate.
     */
    tokenPath?: string
    /**
     * The identity token itself, when it is not in a file (e.g. an OIDC token from env). For
     * gcp and azure it replaces the metadata-server token (a GCP IAM-signed JWT, a token from
     * elsewhere).
     */
    jwt?: string
    /** aws: region of the STS endpoint. Default: AWS_REGION, AWS_DEFAULT_REGION, then EC2 metadata. */
    region?: string
    /**
     * gcp: ID token audience (default: identityId). azure: token resource, which must match the
     * identity's configured resource (default: https://management.azure.com/).
     */
    audience?: string
    /** azure: client id of a user-assigned managed identity. */
    managedIdentityClientId?: string
  }
}

const K8S_TOKEN_PATH = '/var/run/secrets/kubernetes.io/serviceaccount/token'
const NAME = 'infisical'

function fail(code: string, message: string): never {
  throw new CredentialsProviderError(NAME, code, message)
}

/** Validate options up front, so a misconfiguration fails at boot with a clear message. */
function validate(o: InfisicalProviderOptions) {
  if (!o.projectId) fail('config', 'projectId is required')
  if (!o.environment) fail('config', 'environment is required')
  if (!o.secretName) fail('config', 'secretName is required')
  const a = o.auth
  if (a.method === 'universal') {
    if (!a.clientId || !a.clientSecret) fail('config', 'universal auth needs clientId and clientSecret')
  }
  else if (['kubernetes', 'oidc', 'aws', 'gcp', 'azure'].includes(a.method)) {
    if (!a.identityId) fail('config', `${a.method} auth needs identityId`)
    if (a.method === 'oidc' && !a.jwt && !a.tokenPath) fail('config', 'oidc auth needs jwt or tokenPath')
  }
  else {
    fail('config', `unknown auth method "${String(a.method)}" (universal, kubernetes, oidc, aws, gcp, azure)`)
  }
}

function readTokenFile(path: string): string {
  try {
    return readFileSync(path, 'utf8').trim()
  }
  catch {
    fail('identity-token', `cannot read the identity token file "${path}"`)
  }
}

/**
 * Build the login request for the configured machine-identity method. Cloud methods fetch an
 * identity token (or sign an STS request) from the platform first.
 */
export async function infisicalLoginBody(
  auth: InfisicalProviderOptions['auth'],
  signal: AbortSignal,
  env: Record<string, string | undefined> = process.env,
): Promise<{ path: string, body: Record<string, string> }> {
  if (auth.method === 'universal') {
    return { path: '/api/v1/auth/universal-auth/login', body: { clientId: auth.clientId!, clientSecret: auth.clientSecret! } }
  }
  const identityId = auth.identityId!
  if (auth.method === 'aws') {
    return { path: '/api/v1/auth/aws-auth/login', body: await awsLoginBody(identityId, auth.region, env, signal) }
  }
  if (auth.method === 'gcp') {
    const jwt = auth.jwt || (auth.tokenPath ? readTokenFile(auth.tokenPath) : await gcpIdentityToken(auth.audience || identityId, signal))
    return { path: '/api/v1/auth/gcp-auth/login', body: { identityId, jwt } }
  }
  if (auth.method === 'azure') {
    const jwt = auth.jwt || await azureAccessToken(auth.audience || AZURE_DEFAULT_RESOURCE, auth.managedIdentityClientId, env, signal)
    return { path: '/api/v1/auth/azure-auth/login', body: { identityId, jwt } }
  }
  let jwt = auth.jwt
  if (!jwt) jwt = readTokenFile(auth.tokenPath || (auth.method === 'kubernetes' ? K8S_TOKEN_PATH : ''))
  return { path: `/api/v1/auth/${auth.method}-auth/login`, body: { identityId, jwt } }
}

/** Interpret a secret value: a creds file (raw or base64) or a bare bearer JWT. */
export function credentialsFromSecret(value: string): NatsCredentials {
  const v = value.trim()
  if (/^eyJ[\w-]+\.[\w-]+\.[\w-]+$/.test(v)) return { userJwt: v }
  return { creds: v }
}

export interface InfisicalClient {
  /** The secret value, or undefined when the secret does not exist. */
  read(signal: AbortSignal): Promise<string | undefined>
  /** Update the secret, creating it when missing. Throws when a change-approval policy holds the write. */
  write(value: string, signal: AbortSignal): Promise<void>
  /** Forget the cached access token. */
  reset(): void
}

/**
 * Infisical access for one secret, logging in with a machine identity. The access token is
 * cached until a minute before it expires, and dropped after a 401.
 */
export function createInfisicalClient(options: InfisicalProviderOptions, timeoutMs = 10_000): InfisicalClient {
  validate(options)
  const site = (options.siteUrl || 'https://app.infisical.com').replace(/\/$/, '')
  const secretUrl = `${site}/api/v4/secrets/${encodeURIComponent(options.secretName)}`
  const scope = { projectId: options.projectId, environment: options.environment, secretPath: options.secretPath || '/' }
  let token: { value: string, expiresAt: number } | undefined

  async function login(signal: AbortSignal): Promise<string> {
    if (token && Date.now() < token.expiresAt) return token.value
    const { path, body } = await infisicalLoginBody(options.auth, signal)
    const res = await credentialRequest(NAME, `${site}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify(body),
      signal,
    })
    const { accessToken, expiresIn } = await res.json() as { accessToken?: string, expiresIn?: number }
    if (!accessToken) fail('bad-response', 'login response has no accessToken')
    // Renew a minute early so a request never starts with a token about to lapse.
    token = { value: accessToken, expiresAt: Date.now() + Math.max(0, (expiresIn ?? 0) - 60) * 1000 }
    return accessToken
  }

  /** An authenticated request; a 401 drops the cached token so the next call logs in again. */
  async function authed(url: string, init: RequestInit, signal: AbortSignal): Promise<Response> {
    const timeout = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
    const accessToken = await login(timeout)
    try {
      return await credentialRequest(NAME, url, {
        ...init,
        headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json', ...(init.body ? { 'Content-Type': 'application/json' } : {}) },
        signal: timeout,
      })
    }
    catch (err) {
      if (err instanceof CredentialsProviderError && err.status === 401) token = undefined
      throw err
    }
  }

  async function send(method: 'PATCH' | 'POST', value: string, signal: AbortSignal) {
    const res = await authed(secretUrl, { method, body: JSON.stringify({ ...scope, secretValue: value }) }, signal)
    const data = await res.json() as { secret?: unknown, approval?: unknown, policyId?: unknown }
    // With a change-approval policy Infisical answers with an approval request, not the secret.
    if (!data.secret) fail('approval-required', `writing secret "${options.secretName}" needs approval in Infisical; nothing was written`)
  }

  return {
    async read(signal) {
      let res: Response
      try {
        res = await authed(`${secretUrl}?${new URLSearchParams(scope)}`, {}, signal)
      }
      catch (err) {
        if (err instanceof CredentialsProviderError && err.status === 404) return undefined
        throw err
      }
      const data = await res.json() as { secret?: { secretValue?: string } }
      return data.secret?.secretValue || undefined
    },
    async write(value, signal) {
      try {
        await send('PATCH', value, signal)
      }
      catch (err) {
        if (err instanceof CredentialsProviderError && err.status === 404) return send('POST', value, signal)
        throw err
      }
    },
    reset() {
      token = undefined
    },
  }
}

/** Reads NATS credentials from an Infisical secret (see createInfisicalClient). */
export function infisicalProvider(options: InfisicalProviderOptions, timeoutMs = 10_000): NatsCredentialsProvider {
  const client = createInfisicalClient(options, timeoutMs)
  return {
    name: NAME,
    async fetch({ signal }) {
      const value = await client.read(signal)
      if (!value) fail('empty-secret', `secret "${options.secretName}" is empty or missing`)
      return credentialsFromSecret(value)
    },
    dispose() {
      client.reset()
    },
  }
}
