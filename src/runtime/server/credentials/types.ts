/** Credentials a provider hands to the connection. One of `creds` or `userJwt` is required. */
export interface NatsCredentials {
  /** `.creds` file contents, raw or base64. */
  creds?: string
  /** User JWT, with `nkeySeed` for a signed user or alone for a bearer-token user. */
  userJwt?: string
  nkeySeed?: string
  /** Epoch seconds. Derived from the JWT `exp` claim when omitted. */
  expiresAt?: number
}

export interface CredentialsFetchContext {
  /** Why the manager is fetching: first load, a scheduled refresh, or a rejected connection. */
  reason: 'initial' | 'scheduled' | 'auth-error'
  /** Aborted when the fetch times out or the server shuts down. */
  signal: AbortSignal
}

/**
 * A source of NATS credentials that can change over time (a secrets manager, the Synadia
 * Control Plane, your own service). The module fetches before connecting, refreshes ahead of
 * expiry, and reconnects when the credentials change.
 */
export interface NatsCredentialsProvider {
  /** Shown in logs and the health endpoint. */
  name: string
  fetch(ctx: CredentialsFetchContext): Promise<NatsCredentials>
  dispose?(): void | Promise<void>
}

/** Identity helper so a custom provider file is typed. */
export function defineNatsCredentialsProvider(provider: NatsCredentialsProvider): NatsCredentialsProvider {
  return provider
}

/**
 * A provider failure. Carries what is safe to log — never a response body, a token or
 * credential material.
 */
export class CredentialsProviderError extends Error {
  readonly provider: string
  readonly status?: number
  readonly code: string

  constructor(provider: string, code: string, message: string, opts: { status?: number, cause?: unknown } = {}) {
    super(`[nuxt-nats] credentials provider "${provider}": ${message}`, opts.cause === undefined ? undefined : { cause: opts.cause })
    this.name = 'CredentialsProviderError'
    this.provider = provider
    this.code = code
    this.status = opts.status
  }
}
