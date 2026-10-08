/**
 * The id of the Nitro virtual module that exports the custom credentials provider. The
 * connection plugin imports it statically, so the provider exists before the first connect:
 * a generated plugin would run too late, because Nitro does not await async plugins.
 */
export const CREDENTIALS_PROVIDER_ID = '#nuxt-nats/credentials-provider'

/**
 * Source of the virtual module. `path` is the absolute path of the user's provider file;
 * without one the module exports undefined. JSON.stringify quotes the path safely.
 */
export function generateProviderModule(path?: string): string {
  if (!path) return 'export default undefined\n'
  return `export { default } from ${JSON.stringify(path)}\n`
}
