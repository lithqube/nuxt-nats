import { credentialRequest } from '../http'
import { CredentialsProviderError } from '../types'
import type { NatsCredentialsProvider } from '../types'

export interface SynadiaProviderOptions {
  /** Default: https://cloud.synadia.com/api */
  apiUrl?: string
  /** The NATS user to issue creds for. */
  userId: string
  /**
   * A Control Plane token. Use a service-account token scoped to this one NATS user
   * (resource `NatsUser:<userId>`), never a personal access token, which can do anything in
   * your account.
   */
  token: string
}

const NAME = 'synadia'

/**
 * Issues fresh creds for one NATS user from the Synadia Control Plane on every fetch. The
 * JWT lifetime is the user's `jwt_expires_in_secs`, so configure that on the user for
 * short-lived credentials.
 */
export function synadiaProvider(options: SynadiaProviderOptions, timeoutMs = 10_000): NatsCredentialsProvider {
  if (!options.userId) throw new CredentialsProviderError(NAME, 'config', 'userId is required')
  if (!options.token) throw new CredentialsProviderError(NAME, 'config', 'token is required (NUXT_NATS_CREDENTIALS_SYNADIA_TOKEN)')
  const api = (options.apiUrl || 'https://cloud.synadia.com/api').replace(/\/$/, '')

  return {
    name: NAME,
    async fetch({ signal }) {
      const res = await credentialRequest(NAME, `${api}/core/beta/nats-users/${encodeURIComponent(options.userId)}/creds`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${options.token}`, Accept: 'text/plain' },
        signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
      })
      return { creds: await res.text() }
    },
  }
}
