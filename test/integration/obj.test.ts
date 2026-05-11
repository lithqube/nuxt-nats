import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { startNats, stopNats, type NatsTestContext } from './setup'
import { useObj, _clearObjCache } from '../../src/runtime/server/utils/useObj'

let ctx: NatsTestContext

beforeAll(async () => {
  ctx = await startNats()
}, 30_000)

afterAll(async () => {
  await stopNats(ctx)
})

beforeEach(() => {
  _clearObjCache()
})

function toReadableStream(buf: Buffer): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(buf))
      controller.close()
    },
  })
}

async function streamToBuffer(stream: ReadableStream<Uint8Array>): Promise<Buffer> {
  const chunks: Uint8Array[] = []
  const reader = stream.getReader()
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
  }
  return Buffer.concat(chunks)
}

describe('useObj', () => {
  it('puts and gets a small binary object', async () => {
    const obs = await useObj('obj-test-basic', { storage: 'memory' })
    const data = Buffer.from('hello nats object store')

    await obs.put({ name: 'hello.txt' }, toReadableStream(data))
    const result = await obs.get('hello.txt')

    expect(result).not.toBeNull()
    const buf = await streamToBuffer(result!.data)
    expect(buf.toString()).toBe('hello nats object store')
  })

  it('returns null for missing objects', async () => {
    const obs = await useObj('obj-test-missing', { storage: 'memory' })
    const result = await obs.get('nonexistent.bin')
    expect(result).toBeNull()
  })

  it('returns object info without data', async () => {
    const obs = await useObj('obj-test-info', { storage: 'memory' })
    const data = Buffer.from('some content')

    await obs.put({ name: 'doc.txt', description: 'test doc' }, toReadableStream(data))
    const info = await obs.info('doc.txt')

    expect(info).not.toBeNull()
    expect(info!.name).toBe('doc.txt')
    expect(info!.size).toBe(data.length)
  })

  it('deletes an object', async () => {
    const obs = await useObj('obj-test-delete', { storage: 'memory' })
    await obs.put({ name: 'temp.bin' }, toReadableStream(Buffer.from('temporary')))
    await obs.delete('temp.bin')

    const result = await obs.get('temp.bin')
    expect(result).toBeNull()
  })

  it('replaces an object on re-put with same name', async () => {
    const obs = await useObj('obj-test-replace', { storage: 'memory' })

    await obs.put({ name: 'data.bin' }, toReadableStream(Buffer.from('v1')))
    await obs.put({ name: 'data.bin' }, toReadableStream(Buffer.from('version 2')))

    const result = await obs.get('data.bin')
    const buf = await streamToBuffer(result!.data)
    expect(buf.toString()).toBe('version 2')
  })

  it('handles larger payloads split across chunks', async () => {
    const obs = await useObj('obj-test-large', { storage: 'memory', max_chunk_size: 1024 })
    const large = Buffer.alloc(8192, 'x') // 8 KB — multiple chunks at 1 KB each

    await obs.put({ name: 'large.bin' }, toReadableStream(large))
    const result = await obs.get('large.bin')

    expect(result).not.toBeNull()
    const buf = await streamToBuffer(result!.data)
    expect(buf.length).toBe(8192)
    expect(buf.every(b => b === 'x'.charCodeAt(0))).toBe(true)
  })

  it('caches the bucket handle on subsequent calls', async () => {
    _clearObjCache()
    const obs1 = await useObj('obj-test-cache', { storage: 'memory' })
    const obs2 = await useObj('obj-test-cache')

    expect(obs1).toBe(obs2)
  })
})
