import { CredentialsProviderError } from './types'

/**
 * A fetch for credential sources. Failures become CredentialsProviderError with the HTTP status
 * only: response bodies from secret stores can echo request data, so they are never read on error.
 */
export async function credentialRequest(
  provider: string,
  url: string,
  init: RequestInit & { signal: AbortSignal },
): Promise<Response> {
  let res: Response
  try {
    res = await fetch(url, init)
  }
  catch (err) {
    const aborted = init.signal.aborted
    throw new CredentialsProviderError(provider, aborted ? 'timeout' : 'network', aborted ? `request to ${new URL(url).host} timed out` : `request to ${new URL(url).host} failed`, { cause: err })
  }
  if (!res.ok) {
    const code = res.status === 401 ? 'unauthorized' : res.status === 403 ? 'forbidden' : res.status === 404 ? 'not-found' : res.status === 429 ? 'rate-limited' : 'http-error'
    throw new CredentialsProviderError(provider, code, `${init.method ?? 'GET'} ${new URL(url).pathname} returned HTTP ${res.status}`, { status: res.status })
  }
  return res
}
