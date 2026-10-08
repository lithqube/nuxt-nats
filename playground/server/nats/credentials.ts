import { readFile } from 'node:fs/promises'

// Example custom credentials provider. Enable it at runtime with
//   NUXT_NATS_CREDENTIALS_PROVIDER=custom PLAYGROUND_CREDS_FILE=/path/to/user.creds
// A real one would read from Vault, AWS Secrets Manager, your own service, ...
export default defineNatsCredentialsProvider({
  name: 'playground-file',
  async fetch() {
    const path = process.env.PLAYGROUND_CREDS_FILE
    if (!path) throw new Error('set PLAYGROUND_CREDS_FILE')
    return { creds: await readFile(path, 'utf8') }
  },
})
