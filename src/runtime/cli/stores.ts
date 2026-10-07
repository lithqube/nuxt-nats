import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createInfisicalClient } from '../server/credentials/providers/infisical'
import type { InfisicalAuthMethod } from '../server/credentials/providers/infisical'

/** Where the rotator keeps the current creds. The Infisical store is what apps read in Tier A. */
export interface SecretStore {
  name: string
  read(): Promise<string | undefined>
  write(value: string): Promise<void>
}

type Env = Record<string, string | undefined>

/** Infisical, configured from INFISICAL_* env vars (the same names as the app's settings). */
export function infisicalStore(env: Env): SecretStore {
  const client = createInfisicalClient({
    siteUrl: env.INFISICAL_SITE_URL,
    projectId: env.INFISICAL_PROJECT_ID ?? '',
    environment: env.INFISICAL_ENVIRONMENT ?? '',
    secretPath: env.INFISICAL_SECRET_PATH,
    secretName: env.INFISICAL_SECRET_NAME || 'NATS_CREDS',
    auth: {
      method: (env.INFISICAL_AUTH_METHOD || 'universal') as InfisicalAuthMethod,
      identityId: env.INFISICAL_IDENTITY_ID,
      clientId: env.INFISICAL_CLIENT_ID,
      clientSecret: env.INFISICAL_CLIENT_SECRET,
      tokenPath: env.INFISICAL_TOKEN_PATH,
      jwt: env.INFISICAL_JWT,
      region: env.INFISICAL_AWS_REGION,
      audience: env.INFISICAL_AUDIENCE,
      managedIdentityClientId: env.INFISICAL_MANAGED_IDENTITY_CLIENT_ID,
    },
  })
  const signal = () => AbortSignal.timeout(30_000)
  return {
    name: 'infisical',
    read: () => client.read(signal()),
    write: value => client.write(value, signal()),
  }
}

/** A local file, written atomically with mode 0600 (for a VM or systemd unit using credsFile). */
export function fileStore(path: string): SecretStore {
  return {
    name: 'file',
    async read() {
      return existsSync(path) ? readFileSync(path, 'utf8') : undefined
    },
    async write(value) {
      const tmp = `${path}.${process.pid}.tmp`
      writeFileSync(tmp, value, { mode: 0o600 })
      renameSync(tmp, path)
    },
  }
}

/** Your own store: a module whose default export is `{ read(), write(value) }`. */
export async function moduleStore(path: string): Promise<SecretStore> {
  const url = pathToFileURL(isAbsolute(path) ? path : resolve(path)).href
  const mod = await import(url) as { default?: Partial<SecretStore> }
  const store = mod.default
  if (!store || typeof store.read !== 'function' || typeof store.write !== 'function') {
    throw new Error(`[nuxt-nats] ${path} must default-export { read(), write(value) }`)
  }
  return { name: store.name ?? 'module', read: store.read.bind(store), write: store.write.bind(store) }
}
