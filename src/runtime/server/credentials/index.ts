import { infisicalProvider } from './providers/infisical'
import type { InfisicalAuthMethod } from './providers/infisical'
import { synadiaProvider } from './providers/synadia'
import { CredentialsProviderError } from './types'
import type { NatsCredentialsProvider } from './types'
import type { RefreshOptions } from './manager'

export type CredentialsProviderKind = 'static' | 'infisical' | 'synadia' | 'custom'

/** `runtimeConfig.nats.credentials`. Every leaf exists (as '' when unset) so env vars map. */
export interface CredentialsRuntimeConfig {
  provider?: CredentialsProviderKind | ''
  refresh?: RefreshOptions
  infisical?: {
    siteUrl?: string
    projectId?: string
    environment?: string
    secretPath?: string
    secretName?: string
    auth?: {
      method?: InfisicalAuthMethod | ''
      identityId?: string
      clientId?: string
      clientSecret?: string
      tokenPath?: string
      jwt?: string
      region?: string
      audience?: string
      managedIdentityClientId?: string
    }
  }
  synadia?: {
    apiUrl?: string
    userId?: string
    token?: string
  }
}

/**
 * The provider for the configured kind, or undefined for 'static' (the creds / JWT / token
 * settings, read once). Throws on a misconfiguration so boot fails with a clear message.
 */
export function createCredentialsProvider(
  cfg: CredentialsRuntimeConfig | undefined,
  custom: NatsCredentialsProvider | undefined,
): NatsCredentialsProvider | undefined {
  const kind = cfg?.provider || 'static'
  if (kind === 'static') return undefined
  if (kind === 'custom') {
    if (!custom || typeof custom.fetch !== 'function') {
      throw new CredentialsProviderError('custom', 'config', 'nats.credentials.customProvider must default-export defineNatsCredentialsProvider({ name, fetch })')
    }
    return custom
  }
  if (kind === 'infisical') {
    const i = cfg?.infisical ?? {}
    const a = i.auth ?? {}
    return infisicalProvider({
      siteUrl: i.siteUrl,
      projectId: i.projectId ?? '',
      environment: i.environment ?? '',
      secretPath: i.secretPath,
      secretName: i.secretName ?? '',
      auth: {
        method: (a.method || 'universal') as InfisicalAuthMethod,
        identityId: a.identityId,
        clientId: a.clientId,
        clientSecret: a.clientSecret,
        tokenPath: a.tokenPath,
        jwt: a.jwt,
        region: a.region,
        audience: a.audience,
        managedIdentityClientId: a.managedIdentityClientId,
      },
    })
  }
  if (kind === 'synadia') {
    const s = cfg?.synadia ?? {}
    return synadiaProvider({ apiUrl: s.apiUrl, userId: s.userId ?? '', token: s.token ?? '' })
  }
  throw new CredentialsProviderError(String(kind), 'config', `unknown credentials provider "${String(kind)}" (static, infisical, synadia, custom)`)
}
