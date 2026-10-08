// Resolve the Synadia Cloud personal access token for dev tooling and live tests, without it
// ever appearing on a command line. Sources, first match wins:
//   1. SYNADIA_CLOUD_TOKEN env var
//   2. a file: SYNADIA_CLOUD_TOKEN_FILE, default ~/.config/synadia/token (keep it chmod 600)
//   3. macOS Keychain: generic password, service "synadia-cloud-pat"
//      add once, from Terminal: security add-generic-password -a "$USER" -s synadia-cloud-pat -w
//      (with -w last and no value, security prompts for the token without echoing it)
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const KEYCHAIN_SERVICE = 'synadia-cloud-pat'

// Synadia Cloud tokens are long; anything this short is a mistyped prompt (e.g. a login
// password typed at the Keychain prompt). Reject it by source, never echoing any of it.
const MIN_TOKEN_LENGTH = 20

function checked(token, source) {
  if (token.length < MIN_TOKEN_LENGTH) {
    throw new Error(`the token from ${source} is too short to be a Synadia Cloud access token — replace it`
      + (source.startsWith('macOS Keychain') ? ` (security add-generic-password -U -a "$USER" -s ${KEYCHAIN_SERVICE} -w)` : ''))
  }
  return { token, source }
}

/**
 * @returns {{ token: string, source: string } | undefined} the token and where it came from, or undefined
 * @throws {Error} when a source holds a value too short to be a token
 */
export function resolveSynadiaToken(env = process.env) {
  if (env.SYNADIA_CLOUD_TOKEN) return checked(env.SYNADIA_CLOUD_TOKEN.trim(), 'SYNADIA_CLOUD_TOKEN')

  const file = env.SYNADIA_CLOUD_TOKEN_FILE ?? join(homedir(), '.config', 'synadia', 'token')
  if (existsSync(file)) {
    const token = readFileSync(file, 'utf8').trim()
    if (token) return checked(token, file)
  }

  if (process.platform === 'darwin') {
    let token = ''
    try {
      token = execFileSync('security', ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-w'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim()
    }
    catch {
      // not in the keychain
    }
    if (token) return checked(token, `macOS Keychain (${KEYCHAIN_SERVICE})`)
  }
  return undefined
}
