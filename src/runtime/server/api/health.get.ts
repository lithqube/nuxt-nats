import { defineEventHandler } from 'h3'
import { getNatsConnection, getJetStreamManager } from '../plugins/_connection'
import { getAgentStatuses } from '../utils/defineNatsAgent'

export default defineEventHandler(async () => {
  const nc = getNatsConnection()

  if (!nc) {
    return { status: 'disconnected', connected: false }
  }

  const result: Record<string, unknown> = {
    connected: true,
    status: 'ok',
    server: nc.getServer(),
  }

  // RTT check
  try {
    const rttNs = await nc.rtt()
    result.rttMs = Math.round(rttNs / 1_000_000)
  }
  catch {
    result.rttMs = null
  }

  // JetStream check
  const jsm = getJetStreamManager()
  if (jsm) {
    try {
      const info = await jsm.getAccountInfo()
      result.jetstream = {
        available: true,
        streams: info.streams,
        consumers: info.consumers,
        memory: info.memory,
        storage: info.storage,
      }
    }
    catch {
      result.jetstream = { available: false }
    }
  }
  else {
    result.jetstream = { available: false }
  }

  // Agent fabric (Synadia Agent Protocol) — registered hosts, if any
  const agents = getAgentStatuses()
  if (agents.length) {
    result.agents = agents
  }

  return result
})
