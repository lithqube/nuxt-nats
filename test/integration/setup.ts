import { NatsContainer, type StartedNatsContainer } from '@testcontainers/nats'
import { connect } from '@nats-io/transport-node'
import { jetstream, jetstreamManager } from '@nats-io/jetstream'
import type { NatsConnection } from '@nats-io/nats-core'
import type { JetStreamClient, JetStreamManager } from '@nats-io/jetstream'
import { _setConnectionForTesting } from '../../src/runtime/server/plugins/_connection'

export interface NatsTestContext {
  container: StartedNatsContainer
  nc: NatsConnection
  js: JetStreamClient
  jsm: JetStreamManager
}

export async function startNats(): Promise<NatsTestContext> {
  const container = await new NatsContainer('nats:2.10-alpine')
    .withJetStream()
    .start()

  const nc = await connect(container.getConnectionOptions())
  const js = jetstream(nc)
  const jsm = await jetstreamManager(nc)

  _setConnectionForTesting(nc, js, jsm)

  return { container, nc, js, jsm }
}

export async function stopNats(ctx: NatsTestContext) {
  try { await ctx.nc.drain() } catch {}
  await ctx.container.stop()
}
