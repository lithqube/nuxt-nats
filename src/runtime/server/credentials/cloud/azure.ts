import { credentialRequest } from '../http'
import { CredentialsProviderError } from '../types'

// Azure identity for Infisical Azure auth: a managed-identity access token for `resource`,
// whose `aud` claim must match the resource configured on the Infisical identity.

type Env = Record<string, string | undefined>
export const AZURE_DEFAULT_RESOURCE = 'https://management.azure.com/'

/**
 * App Service / Functions / Container Apps expose IDENTITY_ENDPOINT + IDENTITY_HEADER; VMs and
 * AKS use the instance metadata service. `clientId` selects a user-assigned identity.
 */
export async function azureAccessToken(resource: string, clientId: string | undefined, env: Env, signal: AbortSignal): Promise<string> {
  const timeout = AbortSignal.any([signal, AbortSignal.timeout(5_000)])
  let res: Response
  if (env.IDENTITY_ENDPOINT && env.IDENTITY_HEADER) {
    const q = new URLSearchParams({ 'api-version': '2019-08-01', resource, ...(clientId ? { client_id: clientId } : {}) })
    res = await credentialRequest('infisical', `${env.IDENTITY_ENDPOINT}?${q}`, {
      headers: { 'X-IDENTITY-HEADER': env.IDENTITY_HEADER },
      signal: timeout,
    })
  }
  else {
    const q = new URLSearchParams({ 'api-version': '2018-02-01', resource, ...(clientId ? { client_id: clientId } : {}) })
    res = await credentialRequest('infisical', `http://169.254.169.254/metadata/identity/oauth2/token?${q}`, {
      headers: { Metadata: 'true' },
      signal: timeout,
    })
  }
  const { access_token: token } = await res.json() as { access_token?: string }
  if (!token) throw new CredentialsProviderError('infisical', 'identity-token', 'the Azure managed identity endpoint returned no access_token')
  return token
}
