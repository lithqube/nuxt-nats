export interface ParsedCreds {
  /** The user JWT. */
  jwt: string
  /** The user NKey seed (starts with "SU"). */
  seed: string
}

const JWT_BLOCK = /-{3,}BEGIN NATS USER JWT-{3,}\s+(\S+)\s+-{3,}END NATS USER JWT-{3,}/
const SEED_BLOCK = /-{3,}BEGIN USER NKEY SEED-{3,}\s+(\S+)\s+-{3,}END USER NKEY SEED-{3,}/

/**
 * Accept a creds file as-is or base64-encoded. Base64 is the safe way to put a multiline
 * creds file into an env var or a secrets manager.
 */
export function decodeCredsInput(value: string): string {
  const trimmed = value.trim()
  if (trimmed.includes('BEGIN NATS USER JWT')) return trimmed

  const decoded = Buffer.from(trimmed, 'base64').toString('utf8')
  if (decoded.includes('BEGIN NATS USER JWT')) return decoded.trim()

  // Never echo the value: it is a secret.
  throw new Error('[nuxt-nats] NUXT_NATS_CREDS is not a creds file (raw or base64) — expected a "BEGIN NATS USER JWT" block')
}

/** Extract the user JWT and NKey seed from a `.creds` file. */
export function parseCreds(text: string): ParsedCreds {
  const jwt = JWT_BLOCK.exec(text)?.[1]
  const seed = SEED_BLOCK.exec(text)?.[1]
  if (!jwt) throw new Error('[nuxt-nats] Creds file has no "NATS USER JWT" block')
  if (!seed) throw new Error('[nuxt-nats] Creds file has no "USER NKEY SEED" block')
  return { jwt, seed }
}
