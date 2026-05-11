const UNITS: Record<string, number> = {
  ns: 1,
  us: 1_000,
  ms: 1_000_000,
  s: 1_000_000_000,
  m: 60 * 1_000_000_000,
  h: 3_600 * 1_000_000_000,
  d: 86_400 * 1_000_000_000,
}

/**
 * Parse a Go-style duration string into nanoseconds for JetStream StreamConfig.
 * Accepts: "30s", "5m", "2h", "7d", "500ms", "100us", "1ns"
 */
export function parseDuration(s: string): number {
  const m = s.match(/^(\d+(?:\.\d+)?)(ns|us|ms|[smhd])$/)
  if (!m) throw new Error(`[nuxt-nats] Invalid duration "${s}" — use e.g. "24h", "30m", "7d"`)
  return Math.round(Number(m[1]) * UNITS[m[2]])
}
