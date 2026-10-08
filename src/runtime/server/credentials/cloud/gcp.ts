import { credentialRequest } from '../http'

// GCP identity for Infisical GCP auth (ID token type): an ID token from the metadata server of
// GCE, GKE (workload identity), Cloud Run or Cloud Functions, with the Infisical identity id as
// the audience.

const METADATA = 'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity'

export async function gcpIdentityToken(audience: string, signal: AbortSignal): Promise<string> {
  const q = new URLSearchParams({ audience, format: 'full' })
  const res = await credentialRequest('infisical', `${METADATA}?${q}`, {
    headers: { 'Metadata-Flavor': 'Google' },
    signal: AbortSignal.any([signal, AbortSignal.timeout(2_000)]),
  })
  return (await res.text()).trim()
}
