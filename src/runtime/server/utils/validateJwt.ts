export interface JwtCheck {
  /** The `exp` claim (epoch seconds), when the JWT has one. */
  exp?: number
}

/**
 * Log a malformed or expiring user JWT at startup. `source` names the setting the JWT came
 * from in the messages. Returns the decoded `exp` for callers that track expiry.
 */
export function validateJwt(jwt: string, source = 'NUXT_NATS_USER_JWT'): JwtCheck {
  if (!jwt) return {}

  const parts = jwt.split('.')
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) {
    console.error(`[nuxt-nats] ${source} is malformed — expected 3 parts (header.payload.signature)`)
    return {}
  }

  const payloadPart = parts[1]

  let payload: { exp?: number }
  try {
    payload = JSON.parse(Buffer.from(payloadPart, 'base64url').toString('utf8')) as { exp?: number }
  }
  catch {
    console.warn('[nuxt-nats] Could not decode JWT payload to check expiry')
    return {}
  }

  if (!payload.exp) return {}

  const remainingSec = payload.exp - Math.floor(Date.now() / 1000)
  if (remainingSec < 0) {
    console.error(`[nuxt-nats] ${source} EXPIRED ${Math.abs(remainingSec)}s ago — connection will fail`)
  }
  else if (remainingSec < 86400) {
    console.warn(`[nuxt-nats] ${source} expires in ${Math.round(remainingSec / 3600)}h`)
  }
  return { exp: payload.exp }
}
