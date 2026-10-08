export default defineNuxtConfig({
  modules: ['nuxt-nats'],
  devtools: { enabled: true },

  runtimeConfig: {
    nats: {
      // Override via env: NUXT_NATS_TOKEN, NUXT_NATS_SERVERS, etc.
      token: '',
    },
  },
  compatibilityDate: 'latest',

  nats: {
    servers: ['nats://localhost:4222'],
    // Bundled example provider; selected at runtime with NUXT_NATS_CREDENTIALS_PROVIDER=custom
    credentials: { customProvider: 'nats/credentials.ts' },
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
    consumers: [
      {
        stream: 'EVENTS',
        durable: 'playground-events',
        filterSubjects: ['events.created'],
        ackPolicy: 'explicit',
        ackWait: 30_000,
        maxDeliver: 5,
        deadLetterSubject: 'events.dlq',
        provision: 'startup',
        handler: 'workers/events',
      },
    ],
    health: {
      enabled: true,
      endpoint: '/api/_nats/health',
    },
  },
})
