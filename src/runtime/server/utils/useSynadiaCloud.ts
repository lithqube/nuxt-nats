import { useRuntimeConfig } from 'nitropack/runtime'
import { createSynadiaClient } from '../../synadia/client'
import type { SynadiaClient, SynadiaClientOptions } from '../../synadia/client'

export type { SynadiaClient } from '../../synadia/client'

let _cached: { key: string, client: SynadiaClient } | undefined

/**
 * A typed Synadia Control Plane client (accounts, NATS users and their creds, revocations,
 * streams, KV buckets, connections). Configured from `nats.synadiaApi` with the token from
 * NUXT_NATS_SYNADIA_API_TOKEN, or from `options`.
 *
 * Use a service-account token scoped to what the app needs. A personal access token can do
 * anything in your account.
 */
export function useSynadiaCloud(options?: Partial<SynadiaClientOptions>): SynadiaClient {
  const cfg = (useRuntimeConfig().nats as { synadiaApi?: { url?: string, token?: string } } | undefined)?.synadiaApi
  const token = options?.token || cfg?.token || ''
  const apiUrl = options?.apiUrl || cfg?.url || undefined
  const key = `${apiUrl ?? ''}\0${token}`
  if (_cached?.key !== key || options?.timeoutMs !== undefined || options?.retries !== undefined) {
    _cached = { key, client: createSynadiaClient({ ...options, token, apiUrl }) }
  }
  return _cached.client
}
