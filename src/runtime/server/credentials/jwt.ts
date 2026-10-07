/** The `iat` and `exp` claims (epoch seconds) of a JWT, without verifying it. */
export function jwtTimes(jwt: string): { iat?: number, exp?: number } {
  const payload = jwt.split('.')[1]
  if (!payload) return {}
  try {
    const { iat, exp } = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { iat?: number, exp?: number }
    return {
      ...(typeof iat === 'number' ? { iat } : {}),
      ...(typeof exp === 'number' ? { exp } : {}),
    }
  }
  catch {
    return {}
  }
}
