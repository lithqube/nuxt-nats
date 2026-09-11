// Public runtime types, re-exported from the package entry by src/module.ts. That re-export
// is what makes the documented augmentation reach the interface jsPublish reads:
//
//   declare module 'nuxt-nats' {
//     interface NatsEvents {
//       'user.created': { id: string; email: string }
//       'invoice.paid': { invoiceId: string; amount: number }
//     }
//   }
//
// Then jsPublish becomes fully typed per subject.
export type { NatsEvents } from './server/utils/publish'
export type { NatsConsumerOptions } from './server/utils/consumer'
