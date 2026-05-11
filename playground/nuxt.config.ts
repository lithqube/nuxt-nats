export default defineNuxtConfig({
  modules: ['nuxt-nats'],
  devtools: { enabled: true },
  compatibilityDate: 'latest',

  nats: {
    servers: ['nats://localhost:4222'],
    streams: [
      {
        name: 'EVENTS',
        subjects: ['events.>'],
        retention: 'limits',
        storage: 'file',
        replicas: 1,
        provision: 'startup',
      },
    ],
    health: {
      enabled: true,
      endpoint: '/api/_nats/health',
    },
  },

  runtimeConfig: {
    nats: {
      // Override via env: NUXT_NATS_TOKEN, NUXT_NATS_SERVERS, etc.
      token: '',
    },
  },
})
