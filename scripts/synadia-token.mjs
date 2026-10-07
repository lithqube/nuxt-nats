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

/** @returns {{ token: string, source: string } | undefined} the token and where it came from, or undefined */
export function resolveSynadiaToken(env = process.env) {
  if (env.SYNADIA_CLOUD_TOKEN) return { token: env.SYNADIA_CLOUD_TOKEN.trim(), source: 'SYNADIA_CLOUD_TOKEN' }

  const file = env.SYNADIA_CLOUD_TOKEN_FILE ?? join(homedir(), '.config', 'synadia', 'token')
  if (existsSync(file)) {
    const token = readFileSync(file, 'utf8').trim()
    if (token) return { token, source: file }
  }

  if (process.platform === 'darwin') {
    try {
      const token = execFileSync('security', ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-w'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim()
      if (token) return { token, source: `macOS Keychain (${KEYCHAIN_SERVICE})` }
    }
    catch {
      // not in the keychain
    }
  }
  return undefined
}
