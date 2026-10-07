#!/usr/bin/env node
// Dev helper for the live tests: find NATS users in a Synadia Cloud account and download one
// user's creds with a personal access token. Not published (package.json "files" is dist/).
//
//   export SYNADIA_CLOUD_TOKEN=uat_...        # set in your shell; never commit or paste it
//   node scripts/synadia-creds.mjs list
//   node scripts/synadia-creds.mjs fetch <natsUserId> <out.creds> [--force]
//
// Prints ids, names and expiry only — never the token, a JWT or a seed. Each `fetch` is an
// issuance recorded by Synadia Cloud; the file is written with mode 0600.
import { existsSync, writeFileSync } from 'node:fs'

const API = (process.env.SYNADIA_API_URL ?? 'https://cloud.synadia.com/api').replace(/\/$/, '')
const TOKEN = process.env.SYNADIA_CLOUD_TOKEN

function fail(message, code = 1) {
  console.error(`synadia-creds: ${message}`)
  process.exit(code)
}

async function call(method, path, accept = 'application/json') {
  const res = await fetch(`${API}/core/beta${path}`, {
    method,
    headers: { Authorization: `Bearer ${TOKEN}`, Accept: accept },
  })
  if (!res.ok) {
    const hint = res.status === 401 ? ' (token invalid or expired)' : res.status === 403 ? ' (token lacks access)' : ''
    fail(`${method} ${path} → HTTP ${res.status}${hint}`)
  }
  return accept === 'application/json' ? res.json() : res.text()
}

const items = async path => (await call('GET', path)).items ?? []

function expiryOf(creds) {
  const jwt = /-{3,}BEGIN NATS USER JWT-{3,}\s+(\S+)\s+/.exec(creds)?.[1]
  if (!jwt) fail('the API returned something that is not a creds file')
  const { exp } = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString('utf8'))
  return exp ? new Date(exp * 1000).toISOString() : 'never'
}

async function list() {
  for (const team of await items('/teams')) {
    console.log(`team    ${team.id}  ${team.name}`)
    for (const system of await items(`/teams/${team.id}/systems`)) {
      console.log(`  system  ${system.id}  ${system.name}`)
      for (const account of await items(`/systems/${system.id}/accounts`)) {
        console.log(`    account ${account.id}  ${account.name}`)
        for (const user of await items(`/accounts/${account.id}/nats-users`)) {
          const ttl = user.jwt_expires_in_secs ? `jwt ${user.jwt_expires_in_secs}s` : 'jwt no expiry'
          console.log(`      user  ${user.id}  ${user.name}  (${ttl})`)
        }
      }
    }
  }
}

async function fetchCreds(userId, out, force) {
  if (!userId || !out) fail('usage: fetch <natsUserId> <out.creds> [--force]', 2)
  if (existsSync(out) && !force) fail(`${out} exists; pass --force to overwrite`, 2)
  const creds = await call('POST', `/nats-users/${encodeURIComponent(userId)}/creds`, 'text/plain')
  const expires = expiryOf(creds)
  writeFileSync(out, creds.endsWith('\n') ? creds : `${creds}\n`, { mode: 0o600 })
  console.log(`wrote ${out} (mode 600, JWT expires ${expires})`)
}

const [cmd, ...args] = process.argv.slice(2)
if (!TOKEN) fail('set SYNADIA_CLOUD_TOKEN to a Synadia Cloud personal access token', 2)
if (cmd === 'list') await list()
else if (cmd === 'fetch') await fetchCreds(args[0], args[1], args.includes('--force'))
else fail('usage: list | fetch <natsUserId> <out.creds> [--force]', 2)
