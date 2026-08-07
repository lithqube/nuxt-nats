export function normalizeServers(servers: string | string[]): string[] {
  if (typeof servers === 'string') return servers.split(',').map(s => s.trim()).filter(Boolean)
  return servers.flatMap(s => s.split(',').map(v => v.trim()).filter(Boolean))
}
