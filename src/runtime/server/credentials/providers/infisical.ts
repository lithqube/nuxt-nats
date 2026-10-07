import { readFileSync } from 'node:fs'
import { credentialRequest } from '../http'
import { CredentialsProviderError } from '../types'
import type { NatsCredentials, NatsCredentialsProvider } from '../types'

export type InfisicalAuthMethod = 'universal' | 'kubernetes' | 'oidc'

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
    /** Machine identity id (kubernetes, oidc). */
    identityId?: string
    /** Universal auth. */
    clientId?: string
    clientSecret?: string
    /**
     * File holding the identity token (kubernetes, oidc). Kubernetes default: the pod's
     * service-account token. Re-read on every login, so a projected token can rotate.
     */
    tokenPath?: string
    /** The identity token itself, when it is not in a file (e.g. an OIDC token from env). */
    jwt?: string
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
  else if (a.method === 'kubernetes' || a.method === 'oidc') {
    if (!a.identityId) fail('config', `${a.method} auth needs identityId`)
    if (a.method === 'oidc' && !a.jwt && !a.tokenPath) fail('config', 'oidc auth needs jwt or tokenPath')
  }
  else {
    fail('config', `unknown auth method "${String(a.method)}" (universal, kubernetes, oidc)`)
  }
}

/** Build the login request body for the configured machine-identity method. */
export function infisicalLoginBody(auth: InfisicalProviderOptions['auth']): { path: string, body: Record<string, string> } {
  if (auth.method === 'universal') {
    return { path: '/api/v1/auth/universal-auth/login', body: { clientId: auth.clientId!, clientSecret: auth.clientSecret! } }
  }
  let jwt = auth.jwt
  if (!jwt) {
    const path = auth.tokenPath || (auth.method === 'kubernetes' ? K8S_TOKEN_PATH : '')
    try {
      jwt = readFileSync(path, 'utf8').trim()
    }
    catch {
      fail('identity-token', `cannot read the identity token file "${path}"`)
    }
  }
  return { path: `/api/v1/auth/${auth.method}-auth/login`, body: { identityId: auth.identityId!, jwt } }
}

/** Interpret a secret value: a creds file (raw or base64) or a bare bearer JWT. */
export function credentialsFromSecret(value: string): NatsCredentials {
  const v = value.trim()
  if (/^eyJ[\w-]+\.[\w-]+\.[\w-]+$/.test(v)) return { userJwt: v }
  return { creds: v }
}

/**
 * Reads NATS credentials from an Infisical secret, logging in with a machine identity. The
 * Infisical access token is cached until shortly before it expires.
 */
export function infisicalProvider(options: InfisicalProviderOptions, timeoutMs = 10_000): NatsCredentialsProvider {
  validate(options)
  const site = (options.siteUrl || 'https://app.infisical.com').replace(/\/$/, '')
  let token: { value: string, expiresAt: number } | undefined

  async function login(signal: AbortSignal): Promise<string> {
    if (token && Date.now() < token.expiresAt) return token.value
    const { path, body } = infisicalLoginBody(options.auth)
    const res = await credentialRequest(NAME, `${site}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify(body),
      signal,
    })
    const { accessToken, expiresIn } = await res.json() as { accessToken?: string, expiresIn?: number }
    if (!accessToken) fail('bad-response', 'login response has no accessToken')
    // Renew a minute early so a fetch never starts with a token about to lapse.
    token = { value: accessToken, expiresAt: Date.now() + Math.max(0, (expiresIn ?? 0) - 60) * 1000 }
    return accessToken
  }

  return {
    name: NAME,
    async fetch({ signal }) {
      const timeout = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
      const accessToken = await login(timeout)
      const q = new URLSearchParams({
        projectId: options.projectId,
        environment: options.environment,
        secretPath: options.secretPath || '/',
      })
      let res: Response
      try {
        res = await credentialRequest(NAME, `${site}/api/v4/secrets/${encodeURIComponent(options.secretName)}?${q}`, {
          headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
          signal: timeout,
        })
      }
      catch (err) {
        // A revoked or expired session: log in again on the next attempt.
        if (err instanceof CredentialsProviderError && err.status === 401) token = undefined
        throw err
      }
      const data = await res.json() as { secret?: { secretValue?: string } }
      const value = data.secret?.secretValue
      if (!value) fail('empty-secret', `secret "${options.secretName}" is empty`)
      return credentialsFromSecret(value)
    },
    dispose() {
      token = undefined
    },
  }
}
