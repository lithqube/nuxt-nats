import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest'
import { createAccount, createUser, encodeUser, fmtCreds } from '@nats-io/jwt'
import { buildAuthOptions, describeAuth, resolveAuthMode } from '../../src/runtime/server/utils/buildConnectionOptions'

afterEach(() => { vi.restoreAllMocks() })

describe('buildAuthOptions — JWT+NKey (production)', () => {
  it('uses jwtAuthenticator when both userJwt and nkeySeed are set', () => {
    const opts = buildAuthOptions({
      token: '',
      user: '',
      pass: '',
      nkeySeed: 'SUACSP3ZIAMH4SZJDQBJSKCJODPWI2OEGRRYHZEJ6YJPKXY4DPZ6XYZ',
      userJwt: 'eyJ0eXAiOiJqd3Q.signed.jwt-here',
    })

    expect(opts.authenticator).toBeDefined()
    expect(typeof opts.authenticator).toBe('function')
    expect(opts.token).toBeUndefined()
    expect(opts.user).toBeUndefined()
    expect(opts.pass).toBeUndefined()
  })

  it('jwtAuthenticator takes precedence over nkeyAuthenticator when both credentials are set', () => {
    const jwtOnly = buildAuthOptions({
      token: '',
      user: '',
      pass: '',
      nkeySeed: 'SUACSP3ZIAMH4SZJDQBJSKCJODPWI2OEGRRYHZEJ6YJPKXY4DPZ6XYZ',
      userJwt: '',
    })
    const jwtAndKey = buildAuthOptions({
      token: '',
      user: '',
      pass: '',
      nkeySeed: 'SUACSP3ZIAMH4SZJDQBJSKCJODPWI2OEGRRYHZEJ6YJPKXY4DPZ6XYZ',
      userJwt: 'eyJ0eXAiOiJqd3Q.signed.jwt-here',
    })

    expect(jwtOnly.authenticator).toBeDefined()
    expect(jwtAndKey.authenticator).toBeDefined()

    expect(jwtAndKey.authenticator).not.toBe(jwtOnly.authenticator)
  })

  it('does not set token/user/pass when using JWT auth', () => {
    const opts = buildAuthOptions({
      token: 'should-be-ignored',
      user: 'should-be-ignored',
      pass: 'should-be-ignored',
      nkeySeed: 'SUACSP3ZIAMH4SZJDQBJSKCJODPWI2OEGRRYHZEJ6YJPKXY4DPZ6XYZ',
      userJwt: 'eyJ0eXAiOiJqd3Q.signed.jwt-here',
    })

    expect(opts.token).toBeUndefined()
    expect(opts.user).toBeUndefined()
    expect(opts.pass).toBeUndefined()
  })
})

describe('buildAuthOptions — NKey only (dev)', () => {
  it('uses nkeyAuthenticator when only nkeySeed is set', () => {
    const opts = buildAuthOptions({
      token: '',
      user: '',
      pass: '',
      nkeySeed: 'SUACSP3ZIAMH4SZJDQBJSKCJODPWI2OEGRRYHZEJ6YJPKXY4DPZ6XYZ',
      userJwt: '',
    })

    expect(opts.authenticator).toBeDefined()
    expect(typeof opts.authenticator).toBe('function')
    expect(opts.token).toBeUndefined()
    expect(opts.user).toBeUndefined()
    expect(opts.pass).toBeUndefined()
  })

  it('produces a different authenticator for NKey-only vs JWT+NKey', () => {
    const nkeyOnly = buildAuthOptions({
      token: '',
      user: '',
      pass: '',
      nkeySeed: 'SUACSP3ZIAMH4SZJDQBJSKCJODPWI2OEGRRYHZEJ6YJPKXY4DPZ6XYZ',
      userJwt: '',
    })
    const jwtPlusKey = buildAuthOptions({
      token: '',
      user: '',
      pass: '',
      nkeySeed: 'SUACSP3ZIAMH4SZJDQBJSKCJODPWI2OEGRRYHZEJ6YJPKXY4DPZ6XYZ',
      userJwt: 'eyJ0eXAiOiJqd3Q.signed.jwt-here',
    })

    expect(nkeyOnly.authenticator).not.toBe(jwtPlusKey.authenticator)
  })
})

describe('buildAuthOptions — token / user+pass / anonymous', () => {
  it('uses token when only token is set', () => {
    const opts = buildAuthOptions({
      token: 'my-token',
      user: '',
      pass: '',
      nkeySeed: '',
      userJwt: '',
    })

    expect(opts.token).toBe('my-token')
    expect(opts.authenticator).toBeUndefined()
    expect(opts.user).toBeUndefined()
    expect(opts.pass).toBeUndefined()
  })

  it('uses user/pass when only user is set', () => {
    const opts = buildAuthOptions({
      token: '',
      user: 'alice',
      pass: 's3cret',
      nkeySeed: '',
      userJwt: '',
    })

    expect(opts.user).toBe('alice')
    expect(opts.pass).toBe('s3cret')
    expect(opts.authenticator).toBeUndefined()
    expect(opts.token).toBeUndefined()
  })

  it('returns empty options when no credentials are set (anonymous)', () => {
    const opts = buildAuthOptions({
      token: '',
      user: '',
      pass: '',
      nkeySeed: '',
      userJwt: '',
    })

    expect(opts).toEqual({})
  })

  it('uses jwtAuthenticator(jwt) when only userJwt is set (unsigned JWT, no signing)', () => {
    const opts = buildAuthOptions({
      token: '',
      user: '',
      pass: '',
      nkeySeed: '',
      userJwt: 'eyJ0eXAiOiJqd3Q.signed.jwt-here',
    })

    expect(opts.authenticator).toBeDefined()
    expect(typeof opts.authenticator).toBe('function')
    expect(opts.token).toBeUndefined()
    expect(opts.user).toBeUndefined()
    expect(opts.pass).toBeUndefined()
  })

  it('produces a different authenticator for JWT-only vs JWT+NKey', () => {
    const jwtOnly = buildAuthOptions({
      token: '',
      user: '',
      pass: '',
      nkeySeed: '',
      userJwt: 'eyJ0eXAiOiJqd3Q.signed.jwt-here',
    })
    const jwtAndKey = buildAuthOptions({
      token: '',
      user: '',
      pass: '',
      nkeySeed: 'SUACSP3ZIAMH4SZJDQBJSKCJODPWI2OEGRRYHZEJ6YJPKXY4DPZ6XYZ',
      userJwt: 'eyJ0eXAiOiJqd3Q.signed.jwt-here',
    })

    expect(jwtOnly.authenticator).toBeDefined()
    expect(jwtAndKey.authenticator).toBeDefined()
    expect(jwtOnly.authenticator).not.toBe(jwtAndKey.authenticator)
  })

  it('prefers JWT-only over token auth (token is ignored)', () => {
    const opts = buildAuthOptions({
      token: 'should-be-ignored',
      user: '',
      pass: '',
      nkeySeed: '',
      userJwt: 'eyJ0eXAiOiJqd3Q.signed.jwt-here',
    })

    expect(opts.authenticator).toBeDefined()
    expect(opts.token).toBeUndefined()
  })

  it('prefers JWT+NKey over token auth (token is ignored)', () => {
    const opts = buildAuthOptions({
      token: 'should-be-ignored',
      user: '',
      pass: '',
      nkeySeed: 'SUACSP3ZIAMH4SZJDQBJSKCJODPWI2OEGRRYHZEJ6YJPKXY4DPZ6XYZ',
      userJwt: 'eyJ0eXAiOiJqd3Q.signed.jwt-here',
    })

    expect(opts.authenticator).toBeDefined()
    expect(opts.token).toBeUndefined()
  })

  it('prefers NKey over token auth (token is ignored)', () => {
    const opts = buildAuthOptions({
      token: 'should-be-ignored',
      user: '',
      pass: '',
      nkeySeed: 'SUACSP3ZIAMH4SZJDQBJSKCJODPWI2OEGRRYHZEJ6YJPKXY4DPZ6XYZ',
      userJwt: '',
    })

    expect(opts.authenticator).toBeDefined()
    expect(opts.token).toBeUndefined()
  })
})

describe('buildAuthOptions — creds (Synadia Cloud)', () => {
  const none = { token: '', user: '', pass: '', nkeySeed: '', userJwt: '' }
  let creds = ''
  let jwt = ''

  beforeAll(async () => {
    const ukp = createUser()
    jwt = await encodeUser('U', ukp, createAccount(), {})
    creds = new TextDecoder().decode(fmtCreds(jwt, ukp))
  })

  it('uses an authenticator for creds and ignores every lower-priority method', () => {
    const opts = buildAuthOptions({ ...none, creds, userJwt: 'eyJ.x.y', nkeySeed: 'SUAX', token: 't', user: 'u', pass: 'p' })
    expect(typeof opts.authenticator).toBe('function')
    expect(opts.token).toBeUndefined()
    expect(opts.user).toBeUndefined()
  })

  it('throws on malformed creds before any connect attempt', () => {
    expect(() => buildAuthOptions({ ...none, creds: 'not-a-creds-file' })).toThrow(/not a creds file/)
  })

  it('does not read the creds file when building options (it is read per connect)', () => {
    expect(() => buildAuthOptions({ ...none, credsFile: '/does/not/exist.creds' })).not.toThrow()
  })

  it('resolveAuthMode follows the documented priority', () => {
    expect(resolveAuthMode({ ...none, creds, credsFile: '/x' })).toBe('creds')
    expect(resolveAuthMode({ ...none, credsFile: '/x', userJwt: 'j' })).toBe('creds-file')
    expect(resolveAuthMode({ ...none, userJwt: 'j', nkeySeed: 's' })).toBe('jwt-nkey')
    expect(resolveAuthMode({ ...none, userJwt: 'j' })).toBe('jwt')
    expect(resolveAuthMode({ ...none, nkeySeed: 's' })).toBe('nkey')
    expect(resolveAuthMode({ ...none, token: 't' })).toBe('token')
    expect(resolveAuthMode({ ...none, user: 'u' })).toBe('user-pass')
    expect(resolveAuthMode(none)).toBe('anonymous')
  })

  it('describeAuth returns the creds JWT for expiry checks', () => {
    expect(describeAuth({ ...none, creds })).toEqual({ mode: 'creds', jwt, source: 'NUXT_NATS_CREDS' })
  })

  it('the creds-file authenticator reads the file on each call and signs the nonce', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'nuxt-nats-')), 'u.creds')
    writeFileSync(file, creds)
    const { authenticator } = buildAuthOptions({ ...none, credsFile: file })
    const auth = authenticator!('nonce') as { jwt: string, nkey: string, sig: string }
    expect(auth.jwt).toBe(jwt)
    expect(auth.sig).toBeTruthy()
    writeFileSync(file, 'rotated: not a creds file')
    expect(() => authenticator!('nonce')).toThrow(/NATS USER JWT/)
  })

  it('describeAuth reads a creds file once', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'nuxt-nats-')), 'u.creds')
    writeFileSync(file, creds)
    expect(describeAuth({ ...none, credsFile: file })).toEqual({ mode: 'creds-file', jwt, source: 'NUXT_NATS_CREDS_FILE' })
  })

  it('describeAuth logs an unreadable creds file without throwing', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(describeAuth({ ...none, credsFile: '/does/not/exist.creds' })).toEqual({ mode: 'creds-file' })
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('/does/not/exist.creds'), expect.any(String))
  })
})
