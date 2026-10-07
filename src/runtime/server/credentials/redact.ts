// Patterns for secret material that must never reach a log line: JWTs, NKey seeds, Synadia
// access tokens, Infisical tokens and PEM / creds blocks.
const PATTERNS: RegExp[] = [
  // A PEM body is base64 (no '-'), so the class cannot run into the END marker. The JWT and
  // seed inside a creds block are caught by their own patterns.
  /-----BEGIN [A-Z ]+-----[\w+/=\s]+/g,
  /\beyJ[\w-]+\.[\w-]+\.[\w-]+/g,
  /\bS[A-Z]A[A-Z2-7]{50,}\b/g,
  /\buat_\w+/g,
  /\bst\.[\w.-]{20,}/g,
]

/** Replace anything that looks like secret material with `[redacted]`. */
export function redact(text: string): string {
  return PATTERNS.reduce((out, re) => out.replace(re, '[redacted]'), text)
}

/** A loggable one-line description of an error, redacted. */
export function describeError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  return redact(msg)
}
