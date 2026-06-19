import { nkeyAuthenticator, jwtAuthenticator } from '@nats-io/nats-core'

export interface ConnectionAuthConfig {
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

export function buildAuthOptions(cfg: ConnectionAuthConfig): ConnectionOptions {
  const opts: ConnectionOptions = {}

  if (cfg.userJwt && cfg.nkeySeed) {
    opts.authenticator = jwtAuthenticator(cfg.userJwt, new TextEncoder().encode(cfg.nkeySeed))
  }
  else if (cfg.userJwt) {
    opts.authenticator = jwtAuthenticator(cfg.userJwt)
  }
  else if (cfg.nkeySeed) {
    opts.authenticator = nkeyAuthenticator(new TextEncoder().encode(cfg.nkeySeed))
  }
  else if (cfg.token) {
    opts.token = cfg.token
  }
  else if (cfg.user) {
    opts.user = cfg.user
    opts.pass = cfg.pass
  }

  return opts
}
