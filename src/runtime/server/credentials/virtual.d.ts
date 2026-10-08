// Nitro virtual module registered by src/module.ts (see src/providerTemplate.ts): the
// default export of nats.credentials.customProvider, or undefined.
declare module '#nuxt-nats/credentials-provider' {
  const provider: import('./types').NatsCredentialsProvider | undefined
  export default provider
}
