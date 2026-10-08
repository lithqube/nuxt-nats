/** Synadia Cloud connection endpoints. TLS is mandatory on every one of them. */
export type SynadiaRegion = 'global' | 'eu' | 'us' | 'asia' | 'west.us' | 'east.us'

export interface SynadiaCloudOptions {
  /**
   * 'global' (default) is geo-routed to the nearest region. A named region pins the
   * connection there, usually at higher latency for clients elsewhere.
   */
  region?: SynadiaRegion
}

const REGIONS: readonly SynadiaRegion[] = ['global', 'eu', 'us', 'asia', 'west.us', 'east.us']

function host(region: SynadiaRegion): string {
  return region === 'global' ? 'connect.ngs.global' : `${region}.geo.ngs.global`
}

/** TCP (TLS) and WebSocket server URLs for a Synadia Cloud region. */
export function synadiaServers(region: SynadiaRegion = 'global'): { servers: string[], wsServers: string[] } {
  if (!REGIONS.includes(region)) {
    throw new Error(`[nuxt-nats] Unknown Synadia Cloud region "${region}" — use one of: ${REGIONS.join(', ')}`)
  }
  const h = host(region)
  return { servers: [`tls://${h}`], wsServers: [`wss://${h}:443`] }
}
