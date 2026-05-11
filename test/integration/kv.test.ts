import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { startNats, stopNats, type NatsTestContext } from './setup'
import { useKV, _clearKVCache } from '../../src/runtime/server/utils/useKV'

let ctx: NatsTestContext

beforeAll(async () => {
  ctx = await startNats()
}, 30_000)

afterAll(async () => {
  await stopNats(ctx)
})

beforeEach(() => {
  _clearKVCache()
})

describe('useKV', () => {
  it('puts and gets a string value', async () => {
    const kv = await useKV('kv-test-basic', { storage: 'memory' })

    await kv.put('theme', 'dark')
    const entry = await kv.get('theme')

    expect(entry).not.toBeNull()
    expect(entry!.string()).toBe('dark')
  })

  it('returns null for missing keys', async () => {
    const kv = await useKV('kv-test-missing', { storage: 'memory' })
    const entry = await kv.get('nonexistent')
    expect(entry).toBeNull()
  })

  it('gets a JSON value via entry.json()', async () => {
    const kv = await useKV('kv-test-json', { storage: 'memory' })

    const data = { userId: '123', plan: 'pro' }
    await kv.put('session', JSON.stringify(data))
    const entry = await kv.get('session')

    expect(entry!.json<typeof data>()).toEqual(data)
  })

  it('overwrites an existing key', async () => {
    const kv = await useKV('kv-test-overwrite', { storage: 'memory' })

    await kv.put('key', 'v1')
    await kv.put('key', 'v2')
    const entry = await kv.get('key')

    expect(entry!.string()).toBe('v2')
  })

  it('deletes a key (tombstone)', async () => {
    const kv = await useKV('kv-test-delete', { storage: 'memory' })

    await kv.put('temp', 'value')
    await kv.delete('temp')
    const entry = await kv.get('temp')

    // After delete, entry exists as a tombstone with operation='DEL' or null
    if (entry) {
      expect(entry.operation).toBe('DEL')
    }
    else {
      expect(entry).toBeNull()
    }
  })

  it('uses optimistic locking via update()', async () => {
    const kv = await useKV('kv-test-lock', { storage: 'memory' })

    await kv.put('counter', '0')
    const entry = await kv.get('counter')
    const rev = entry!.revision

    await kv.update('counter', '1', rev)
    const updated = await kv.get('counter')
    expect(updated!.string()).toBe('1')

    // Using stale revision should throw
    await expect(kv.update('counter', '2', rev)).rejects.toThrow()
  })

  it('caches the bucket handle on subsequent calls', async () => {
    _clearKVCache()
    const kv1 = await useKV('kv-test-cache', { storage: 'memory' })
    const kv2 = await useKV('kv-test-cache')

    expect(kv1).toBe(kv2)
  })
})
