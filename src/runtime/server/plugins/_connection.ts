import type { NatsConnection } from '@nats-io/nats-core'
import type { JetStreamClient, JetStreamManager } from '@nats-io/jetstream'

// Module-level singletons — one per process, shared across all requests
let _nc: NatsConnection | undefined
let _js: JetStreamClient | undefined
let _jsm: JetStreamManager | undefined

export function getNatsConnection() {
  return _nc
}
export function getJetStream() {
  return _js
}
export function getJetStreamManager() {
  return _jsm
}

export function setNatsConnection(nc: NatsConnection | undefined) {
  _nc = nc
}
export function setJetStream(js: JetStreamClient | undefined) {
  _js = js
}
export function setJetStreamManager(jsm: JetStreamManager | undefined) {
  _jsm = jsm
}

/** For integration tests only — injects a pre-existing connection into the module singletons. */
export function _setConnectionForTesting(nc: NatsConnection, js: JetStreamClient, jsm: JetStreamManager) {
  _nc = nc
  _js = js
  _jsm = jsm
}
