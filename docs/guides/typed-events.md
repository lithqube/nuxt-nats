# Typed Events

`nuxt-nats` uses TypeScript module augmentation so your event subjects and payload shapes are validated at compile time — no separate schema registry or code generation required.

## Declare your events

Create a file anywhere in your project (e.g., `types/nats.d.ts`):

```ts
declare module 'nuxt-nats' {
  interface NatsEvents {
    'orders.created': {
      id: string
      customerId: string
      total: number
      currency: string
    }
    'orders.cancelled': {
      id: string
      reason: string
    }
    'user.registered': {
      id: string
      email: string
      plan: 'free' | 'pro' | 'enterprise'
    }
    'invoice.paid': {
      invoiceId: string
      amount: number
      paidAt: string
    }
  }
}
```

No import needed — the augmentation is automatically merged into the module's `NatsEvents` interface by TypeScript.

## Type-safe publish

Once declared, `jsPublish` validates both the subject and the payload:

```ts
// ✅ correct — both subject and payload match
await jsPublish('orders.created', {
  id: 'ord_123',
  customerId: 'cust_456',
  total: 99.99,
  currency: 'USD',
})

// ✗ TypeScript error — 'orders.shipped' is not in NatsEvents
await jsPublish('orders.shipped', { id: 'ord_123' })

// ✗ TypeScript error — missing required field 'currency'
await jsPublish('orders.created', {
  id: 'ord_123',
  customerId: 'cust_456',
  total: 99.99,
})
```

Unknown subjects (not in `NatsEvents`) still compile — they fall through to the untyped overload. This allows gradual adoption.

## Type-safe consumers

Use the generic parameter on `defineNatsConsumer` to type the payload:

```ts
import type { NatsEvents } from 'nuxt-nats'

defineNatsConsumer<NatsEvents['orders.created']>({
  stream: 'ORDERS',
  durable: 'billing',

  async handler(msg, payload) {
    // payload is typed as { id: string; customerId: string; total: number; currency: string }
    await chargeBillingSystem(payload.customerId, payload.total)
    msg.ack()
  },
})
```

## Sharing event types across services

For multi-service architectures where producers and consumers live in different repositories, extract `NatsEvents` into a shared package:

```
packages/
  nats-contracts/
    index.ts        ← exports NatsEvents interface
apps/
  api/              ← augments NatsEvents, publishes
  workers/          ← augments NatsEvents, consumes
```

```ts
// packages/nats-contracts/index.ts
export interface NatsEvents {
  'orders.created': { id: string; total: number }
}
```

```ts
// apps/api/types/nats.d.ts
import type { NatsEvents as ContractEvents } from '@company/nats-contracts'

declare module 'nuxt-nats' {
  interface NatsEvents extends ContractEvents {}
}
```

## Runtime validation

TypeScript types are compile-time only. If a non-TypeScript producer (e.g., a Go service) sends a malformed payload, `JSON.parse` succeeds and the type assertion is incorrect.

For runtime safety, validate inside the consumer handler:

```ts
import { z } from 'zod'

const OrderCreated = z.object({
  id: z.string(),
  total: z.number(),
})

defineNatsConsumer<NatsEvents['orders.created']>({
  stream: 'ORDERS',
  durable: 'billing',
  async handler(msg, payload) {
    const data = OrderCreated.parse(payload)   // throws if invalid
    await processOrder(data)
    msg.ack()
  },
})
```

Unvalidated messages that throw from `OrderCreated.parse` will call `msg.nak()` (via the error handler in the consumer loop) and be redelivered. After `maxDeliver` attempts they route to the DLQ.
