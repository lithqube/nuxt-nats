# Object Store

JetStream Object Store provides blob storage backed by a JetStream stream. Files are split into chunks and stored as messages, then reassembled on retrieval. Suitable for user uploads, generated files, and large binary assets that need to be shared across server instances.

## Basic usage

```ts
// server/api/upload.post.ts
export default defineEventHandler(async (event) => {
  const data = await readRawBody(event)
  if (!data) throw createError({ statusCode: 400, message: 'No body' })

  const obs = await useObj('uploads')
  const info = await obs.put({ name: 'report.pdf' }, data)

  return { name: info.name, size: info.size }
})
```

```ts
// server/api/download/[name].get.ts
export default defineEventHandler(async (event) => {
  const name = getRouterParam(event, 'name')!
  const obs = await useObj('uploads')

  const entry = await obs.get(name)
  if (!entry) throw createError({ statusCode: 404 })

  setHeader(event, 'Content-Type', 'application/octet-stream')
  setHeader(event, 'Content-Disposition', `attachment; filename="${name}"`)

  return entry.data   // ReadableStream<Uint8Array>
})
```

`useObj(bucket)` opens the bucket and caches the handle per process. The first call with options creates the bucket if it doesn't exist.

## Create a bucket with options

```ts
const obs = await useObj('assets', {
  storage: 'file',        // 'file' | 'memory'
  replicas: 1,
  max_chunk_size: 1_048_576,   // 1 MB per chunk (default: 128 KB)
  ttl: 86_400_000,             // entry TTL in ms (24 hours)
  description: 'User-uploaded assets',
})
```

## Operations

```ts
const obs = await useObj('uploads')

// Upload from Buffer / Uint8Array
await obs.put({ name: 'avatar.png' }, imageBuffer)

// Upload with metadata
await obs.put({
  name: 'document.pdf',
  description: 'Q1 report',
  headers: { 'Content-Type': 'application/pdf' },
}, pdfBuffer)

// Get (returns ReadableStream)
const entry = await obs.get('avatar.png')
if (entry) {
  const buffer = await toBuffer(entry.data)
}

// Object info (no data)
const info = await obs.info('avatar.png')
console.log(info?.size, info?.chunks)

// Delete
await obs.delete('avatar.png')

// List all objects
const list = await obs.list()
for await (const item of list) {
  console.log(item.name, item.size)
}
```

## Stream large files

For large files, avoid loading the entire file into memory. Use Node.js streams:

```ts
import { createReadStream, createWriteStream } from 'node:fs'
import { Readable } from 'node:stream'

// Upload from file
export default defineEventHandler(async () => {
  const obs = await useObj('backups')
  const stream = createReadStream('/tmp/database.dump')
  await obs.put({ name: 'database.dump' }, Readable.toWeb(stream))
  return { ok: true }
})

// Download to file
export default defineEventHandler(async () => {
  const obs = await useObj('backups')
  const entry = await obs.get('database.dump')
  if (!entry?.data) throw createError({ statusCode: 404 })

  const writer = createWriteStream('/tmp/restore.dump')
  await entry.data.pipeTo(new WritableStream({
    write(chunk) { writer.write(chunk) },
    close() { writer.end() },
  }))

  return { ok: true }
})
```

## Chunking and size limits

Object Store splits large files into chunks. The default chunk size is 128 KB. For large files, increase `max_chunk_size` to reduce the number of JetStream messages:

```ts
await useObj('videos', { max_chunk_size: 8_388_608 })  // 8 MB chunks
```

The maximum object size is limited by the underlying JetStream stream's `max_bytes` setting. Configure this when creating the bucket or via the NATS CLI.

## When to use Object Store vs KV

| Scenario | Use |
|---|---|
| Small JSON data, config, sessions | KV |
| Files, images, PDFs, binaries | Object Store |
| Data > 1 MB | Object Store |
| Need revision history | KV |
| Need TTL per entry | Either |
| Need change watchers | KV |

## Limitations

- Object Store is not suitable for random access within a file — retrieval always returns the full object.
- There is no partial update — replace the entire object to update.
- Not a CDN replacement. For static asset delivery to browsers, use Object Store for server-to-server transfer and serve to clients via a CDN or signed URL pattern.
