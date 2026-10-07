import { readFileSync } from 'node:fs'
import { nkeyAuthenticator, jwtAuthenticator } from '@nats-io/nats-core'
import { decodeCredsInput, parseCreds } from './parseCreds'

export interface ConnectionAuthConfig {
  /** Creds file contents (raw or base64). */
  creds?: string
  /** Path to a creds file, re-read on every (re)connect so a rotated file is picked up. */
  credsFile?: string
  token: string
  user: string
  pass: string
  nkeySeed: string
  userJwt: string
}

export interface ConnectionOptions {
  authenticator?: ReturnType<typeof nkeyAuthenticator>
  token?: string
  user?: string
  pass?: string
}

export type AuthMode = 'creds' | 'creds-file' | 'jwt-nkey' | 'jwt' | 'nkey' | 'token' | 'user-pass' | 'anonymous'

export interface AuthDescription {
  mode: AuthMode
  /** The user JWT to check for expiry, when the mode has one and it could be read. */
  jwt?: string
  /** The setting the JWT came from, for log messages. */
  source?: string
}

/** Which auth method `buildAuthOptions()` applies, in the same priority order. */
export function resolveAuthMode(cfg: ConnectionAuthConfig): AuthMode {
  if (cfg.creds) return 'creds'
  if (cfg.credsFile) return 'creds-file'
  if (cfg.userJwt && cfg.nkeySeed) return 'jwt-nkey'
  if (cfg.userJwt) return 'jwt'
  if (cfg.nkeySeed) return 'nkey'
  if (cfg.token) return 'token'
  if (cfg.user) return 'user-pass'
  return 'anonymous'
}

/**
 * Describe the configured auth for startup checks and the health endpoint. Reads the creds
 * file once; a failure is logged without any secret material and leaves `jwt` unset.
 */
export function describeAuth(cfg: ConnectionAuthConfig): AuthDescription {
  const mode = resolveAuthMode(cfg)
  try {
    if (mode === 'creds') return { mode, jwt: parseCreds(decodeCredsInput(cfg.creds!)).jwt, source: 'NUXT_NATS_CREDS' }
    if (mode === 'creds-file') return { mode, jwt: parseCreds(readFileSync(cfg.credsFile!, 'utf8')).jwt, source: 'NUXT_NATS_CREDS_FILE' }
  }
  catch (err) {
    const what = mode === 'creds' ? 'NUXT_NATS_CREDS' : `creds file "${cfg.credsFile}"`
    console.error(`[nuxt-nats] Could not read ${what}:`, (err as Error).message)
    return { mode }
  }
  if (mode === 'jwt-nkey' || mode === 'jwt') return { mode, jwt: cfg.userJwt, source: 'NUXT_NATS_USER_JWT' }
  return { mode }
}

/**
 * Priority: creds > creds file > JWT+NKey > JWT > NKey > token > user/pass > anonymous.
 * Only one method is applied.
 */
export function buildAuthOptions(cfg: ConnectionAuthConfig): ConnectionOptions {
  const opts: ConnectionOptions = {}
  const mode = resolveAuthMode(cfg)

  // Creds are parsed here rather than by the client's credsAuthenticator, whose pattern
  // requires a newline after the final END line and so rejects a trimmed or CRLF file.
  if (mode === 'creds') {
    const { jwt, seed } = parseCreds(decodeCredsInput(cfg.creds!)) // fails fast, before connecting
    opts.authenticator = jwtAuthenticator(jwt, new TextEncoder().encode(seed))
  }
  else if (mode === 'creds-file') {
    const path = cfg.credsFile!
    // Read on every (re)connect, so a rotated Kubernetes Secret volume or a file written by a
    // rotator takes effect without a restart. One read per connect: separate reads for the
    // JWT and the seed could straddle a rotation and pair one user's JWT with another's key.
    opts.authenticator = (nonce?: string) => {
      const { jwt, seed } = parseCreds(readFileSync(path, 'utf8'))
      return jwtAuthenticator(jwt, new TextEncoder().encode(seed))(nonce)
    }
  }
  else if (mode === 'jwt-nkey') {
    opts.authenticator = jwtAuthenticator(cfg.userJwt, new TextEncoder().encode(cfg.nkeySeed))
  }
  else if (mode === 'jwt') {
    opts.authenticator = jwtAuthenticator(cfg.userJwt)
  }
  else if (mode === 'nkey') {
    opts.authenticator = nkeyAuthenticator(new TextEncoder().encode(cfg.nkeySeed))
  }
  else if (mode === 'token') {
    opts.token = cfg.token
  }
  else if (mode === 'user-pass') {
    opts.user = cfg.user
    opts.pass = cfg.pass
  }

  return opts
}
