import { describe, it, expect } from 'vitest'
import { synadiaServers } from '../../src/synadia'

describe('synadiaServers', () => {
  it('defaults to the geo-routed global endpoint', () => {
    expect(synadiaServers()).toEqual({
      servers: ['tls://connect.ngs.global'],
      wsServers: ['wss://connect.ngs.global:443'],
    })
  })

  it('maps a region to its geo endpoint', () => {
    expect(synadiaServers('eu')).toEqual({
      servers: ['tls://eu.geo.ngs.global'],
      wsServers: ['wss://eu.geo.ngs.global:443'],
    })
    expect(synadiaServers('west.us').servers).toEqual(['tls://west.us.geo.ngs.global'])
  })

  it('rejects an unknown region', () => {
    expect(() => synadiaServers('mars' as never)).toThrow(/Unknown Synadia Cloud region "mars"/)
  })
})
