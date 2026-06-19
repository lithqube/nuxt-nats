export function validateJwt(jwt: string): void {
  if (!jwt) return

  const parts = jwt.split('.')
  if (parts.length !== 3) {
    console.error('[nuxt-nats] NUXT_NATS_USER_JWT is malformed — expected 3 parts (header.payload.signature)')
    return
  }

  const payloadPart = parts[1]
  if (!payloadPart) return

  let payload: { exp?: number }
  try {
    payload = JSON.parse(Buffer.from(payloadPart, 'base64url').toString('utf8')) as { exp?: number }
  }
  catch {
    console.warn('[nuxt-nats] Could not decode JWT payload to check expiry')
    return
  }

  if (!payload.exp) return

  const remainingSec = payload.exp - Math.floor(Date.now() / 1000)
  if (remainingSec < 0) {
    console.error(`[nuxt-nats] NUXT_NATS_USER_JWT EXPIRED ${Math.abs(remainingSec)}s ago — connection will fail`)
  }
  else if (remainingSec < 86400) {
    console.warn(`[nuxt-nats] NUXT_NATS_USER_JWT expires in ${Math.round(remainingSec / 3600)}h`)
  }
}
