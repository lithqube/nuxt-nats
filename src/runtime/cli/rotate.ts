import { readFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { jwtAuthenticator } from '@nats-io/nats-core'
import { createSynadiaClient, SynadiaApiError } from '../synadia/client'
import type { SynadiaClient } from '../synadia/client'
import { decodeCredsInput, parseCreds } from '../server/utils/parseCreds'
import { parseDuration } from '../server/utils/parseDuration'
import { jwtTimes } from '../server/credentials/jwt'
import { describeError } from '../server/credentials/redact'
import { CredentialsProviderError } from '../server/credentials/types'
import { fileStore, infisicalStore, moduleStore } from './stores'
import type { SecretStore } from './stores'

// nuxt-nats-rotate: issue fresh creds for one Synadia Cloud NATS user and write them where the
// apps read them (Tier A: an Infisical secret). Run it on a schedule; it skips while the stored
// creds have more than --min-remaining left, so frequent runs are cheap.

export const USAGE = `Usage: nuxt-nats-rotate --user-id <id> [options]

Issues fresh creds for a Synadia Cloud NATS user and stores them for your apps.

Options:
  --user-id <id>          NATS user to issue creds for (env SYNADIA_NATS_USER_ID)
  --token-file <path>     Control Plane token file (default: env SYNADIA_CLOUD_TOKEN)
  --api-url <url>         Control Plane API (default: https://cloud.synadia.com/api)
  --store <kind>          infisical (default, INFISICAL_* env) | file | module:<path>
  --file <path>           Path for --store file
  --encoding <enc>        base64 | raw (default: base64 for infisical, raw otherwise)
  --min-remaining <dur>   Skip while the stored creds expire later than this (default: 6h)
  --force                 Rotate even when the stored creds are fresh
  --rotate-nkey           Give the user a new nkey before issuing
  --revoke-old            With --rotate-nkey: revoke the previous key once the new creds are stored
  --verify                Connect with the new creds before storing them
  --servers <urls>        For --verify (default: tls://connect.ngs.global)
  --dry-run               Do everything except storing and revoking
  -h, --help              Show this help

Output: one JSON line on stdout. Exit codes: 0 ok or skipped, 1 failure, 2 usage error.`

type Env = Record<string, string | undefined>

export interface RotateDeps {
  env: Env
  out: (line: string) => void
  err: (line: string) => void
  /** Connect for --verify; resolves when the connection is confirmed and closed. */
  verify?: (servers: string[], jwt: string, seed: string) => Promise<void>
  now?: () => number
}

export interface RotateResult {
  action: 'skipped' | 'rotated' | 'dry-run' | 'error' | 'help'
  userId?: string
  /** ISO time the new (or current, when skipped) creds expire; null when they do not. */
  expiresAt?: string | null
  nkeyRotated?: boolean
  revokedOldKey?: boolean
  code?: string
  warnings?: string[]
}

class UsageError extends Error {}

async function defaultVerify(servers: string[], jwt: string, seed: string) {
  const { connect } = await import('@nats-io/transport-node')
  const nc = await connect({
    servers,
    authenticator: jwtAuthenticator(jwt, new TextEncoder().encode(seed)),
    reconnect: false,
    timeout: 10_000,
    name: 'nuxt-nats-rotate',
  })
  try {
    await nc.flush()
  }
  finally {
    await nc.close()
  }
}

function iso(exp?: number) {
  return exp ? new Date(exp * 1000).toISOString() : null
}

function parse(argv: string[]) {
  return parseArgs({
    args: argv,
    strict: true,
    options: {
      'user-id': { type: 'string' },
      'token-file': { type: 'string' },
      'api-url': { type: 'string' },
      'store': { type: 'string' },
      'file': { type: 'string' },
      'encoding': { type: 'string' },
      'min-remaining': { type: 'string' },
      'force': { type: 'boolean' },
      'rotate-nkey': { type: 'boolean' },
      'revoke-old': { type: 'boolean' },
      'verify': { type: 'boolean' },
      'servers': { type: 'string' },
      'dry-run': { type: 'boolean' },
      'help': { type: 'boolean', short: 'h' },
    },
  }).values
}

export async function runRotate(argv: string[], deps: RotateDeps): Promise<{ code: number, result: RotateResult }> {
  const now = deps.now ?? Date.now
  const emit = (code: number, result: RotateResult) => {
    deps.out(JSON.stringify(result))
    return { code, result }
  }

  let args: ReturnType<typeof parse>
  try {
    args = parse(argv)
  }
  catch (err) {
    deps.err(`nuxt-nats-rotate: ${(err as Error).message}\n\n${USAGE}`)
    return emit(2, { action: 'error', code: 'usage' })
  }
  if (args.help) {
    deps.err(USAGE)
    return { code: 0, result: { action: 'help' } }
  }

  const warnings: string[] = []
  const withWarnings = (r: RotateResult): RotateResult => (warnings.length ? { ...r, warnings } : r)
  try {
    const userId = args['user-id'] || deps.env.SYNADIA_NATS_USER_ID
    if (!userId) throw new UsageError('--user-id (or SYNADIA_NATS_USER_ID) is required')
    if (args['revoke-old'] && !args['rotate-nkey']) throw new UsageError('--revoke-old only applies with --rotate-nkey')

    let token = deps.env.SYNADIA_CLOUD_TOKEN
    if (args['token-file']) {
      try {
        token = readFileSync(args['token-file'], 'utf8').trim()
      }
      catch {
        throw new UsageError(`cannot read --token-file "${args['token-file']}"`)
      }
    }
    if (!token) throw new UsageError('a Control Plane token is required: SYNADIA_CLOUD_TOKEN or --token-file')

    let minRemainingSec: number
    try {
      minRemainingSec = parseDuration(args['min-remaining'] ?? '6h') / 1e9
    }
    catch {
      throw new UsageError(`invalid --min-remaining "${args['min-remaining']}" (e.g. 30m, 6h, 2d)`)
    }
    const storeKind = args.store ?? 'infisical'
    const encoding = args.encoding ?? (storeKind === 'infisical' ? 'base64' : 'raw')
    if (encoding !== 'base64' && encoding !== 'raw') throw new UsageError('--encoding must be base64 or raw')

    let store: SecretStore
    if (storeKind === 'infisical') {
      store = infisicalStore(deps.env)
    }
    else if (storeKind === 'file') {
      if (!args.file) throw new UsageError('--store file needs --file <path>')
      store = fileStore(args.file)
    }
    else if (storeKind.startsWith('module:')) {
      store = await moduleStore(storeKind.slice('module:'.length))
    }
    else {
      throw new UsageError(`unknown --store "${storeKind}" (infisical, file, module:<path>)`)
    }

    // 1. Are the stored creds still fresh?
    const stored = await store.read()
    if (stored && !args.force && !args['rotate-nkey']) {
      let exp: number | undefined
      let valid = true
      try {
        exp = jwtTimes(parseCreds(decodeCredsInput(stored)).jwt).exp
      }
      catch {
        valid = false
        warnings.push('the stored value is not a creds file; replacing it')
      }
      if (valid && !exp) return emit(0, withWarnings({ action: 'skipped', userId, expiresAt: null }))
      if (exp && exp - now() / 1000 > minRemainingSec) return emit(0, withWarnings({ action: 'skipped', userId, expiresAt: iso(exp) }))
    }

    // 2. Issue (after an optional nkey rotation).
    const client: SynadiaClient = createSynadiaClient({ token, apiUrl: args['api-url'] || deps.env.SYNADIA_API_URL })
    let user = await client.natsUsers.get(userId)
    if (!user.jwt_expires_in_secs) warnings.push('the user has no JWT expiry, so issued creds never expire; set one in Synadia Cloud for short-lived credentials')
    const oldKey = user.user_public_key
    if (args['rotate-nkey']) user = await client.natsUsers.rotate(userId)
    const creds = await client.natsUsers.issueCreds(userId)
    const { jwt, seed } = parseCreds(creds)
    const { exp } = jwtTimes(jwt)

    // 3. Prove they work before anyone depends on them.
    if (args.verify) {
      const servers = (args.servers ?? 'tls://connect.ngs.global').split(',').map(s => s.trim()).filter(Boolean)
      try {
        await (deps.verify ?? defaultVerify)(servers, jwt, seed)
      }
      catch (err) {
        throw new CredentialsProviderError('rotate', 'verify-failed', `connecting with the new creds failed: ${describeError(err)}`)
      }
    }

    const nkeyRotated = !!args['rotate-nkey']
    if (args['dry-run']) {
      return emit(0, withWarnings({ action: 'dry-run', userId, expiresAt: iso(exp), nkeyRotated, revokedOldKey: false }))
    }

    // 4. Store, then retire the old key: apps refetch the stored creds on the auth error that follows.
    await store.write(encoding === 'base64' ? Buffer.from(creds).toString('base64') : creds)
    let revokedOldKey = false
    if (args['revoke-old'] && oldKey && oldKey !== user.user_public_key) {
      await client.natsUsers.revoke(user.account.id, oldKey)
      revokedOldKey = true
    }
    return emit(0, withWarnings({ action: 'rotated', userId, expiresAt: iso(exp), nkeyRotated, revokedOldKey }))
  }
  catch (err) {
    if (err instanceof UsageError) {
      deps.err(`nuxt-nats-rotate: ${err.message}`)
      return emit(2, { action: 'error', code: 'usage' })
    }
    const code = err instanceof SynadiaApiError || err instanceof CredentialsProviderError ? err.code : 'error'
    deps.err(`nuxt-nats-rotate: ${describeError(err)}`)
    return emit(1, withWarnings({ action: 'error', code }))
  }
}
