// Re-export the NatsEvents interface so user apps can augment it:
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
