import { describe, it, expect, beforeAll } from 'vitest'
import { createAccount, createUser, encodeUser, fmtCreds } from '@nats-io/jwt'
import { decodeCredsInput, parseCreds } from '../../src/runtime/server/utils/parseCreds'

let creds = ''
let jwt = ''
let seed = ''

beforeAll(async () => {
  const akp = createAccount()
  const ukp = createUser()
  jwt = await encodeUser('U', ukp, akp, {})
  seed = new TextDecoder().decode(ukp.getSeed())
  creds = new TextDecoder().decode(fmtCreds(jwt, ukp))
})

describe('parseCreds', () => {
  it('extracts the JWT and seed from a creds file', () => {
    expect(parseCreds(creds)).toEqual({ jwt, seed })
  })

  it('handles CRLF line endings', () => {
    expect(parseCreds(creds.replace(/\n/g, '\r\n'))).toEqual({ jwt, seed })
  })

  it('throws without a JWT block', () => {
    expect(() => parseCreds('-----BEGIN USER NKEY SEED-----\nSUAX\n------END USER NKEY SEED------')).toThrow(/NATS USER JWT/)
  })

  it('throws without a seed block', () => {
    expect(() => parseCreds(`-----BEGIN NATS USER JWT-----\n${jwt}\n------END NATS USER JWT------`)).toThrow(/USER NKEY SEED/)
  })
})

describe('decodeCredsInput', () => {
  it('returns raw creds unchanged (trimmed)', () => {
    expect(decodeCredsInput(`  ${creds}\n`)).toBe(creds.trim())
  })

  it('decodes base64 creds', () => {
    expect(decodeCredsInput(Buffer.from(creds).toString('base64'))).toBe(creds.trim())
  })

  it('rejects anything else without echoing the value', () => {
    const secret = 'SUAXSECRETVALUE'
    let message = ''
    try {
      decodeCredsInput(secret)
    }
    catch (err) {
      message = (err as Error).message
    }
    expect(message).toMatch(/not a creds file/)
    expect(message).not.toContain(secret)
  })
})
