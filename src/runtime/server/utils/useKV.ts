import { Kvm } from '@nats-io/kv'
import { useNats } from './useNats'
import type { KV, KvOptions } from '@nats-io/kv'

const _kvCache = new Map<string, KV>()

/** For integration tests only — clears the KV bucket cache. */
export function _clearKVCache() {
  _kvCache.clear()
}

/**
 * Get or create a KV bucket. Results are cached per bucket name within the process.
 */
export async function useKV(bucket: string, opts?: Partial<KvOptions>): Promise<KV> {
  if (_kvCache.has(bucket)) {
    return _kvCache.get(bucket)!
  }
  const nc = useNats()
  const kvm = new Kvm(nc)
  const kv = opts ? await kvm.create(bucket, opts) : await kvm.open(bucket)
  _kvCache.set(bucket, kv)
  return kv
}
