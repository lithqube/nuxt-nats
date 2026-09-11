# Typed Events

`nuxt-nats` uses TypeScript module augmentation so your event subjects and payload shapes are validated at compile time — no separate schema registry or code generation required.

## Declare your events

Create a `.d.ts` file under `server/` (for example `server/types/nats.d.ts`), or under `shared/` if app code needs the types too:

```ts
// server/types/nats.d.ts
import type {} from 'nuxt-nats'

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

Two details decide whether this works:

- **Start with `import type {} from 'nuxt-nats'`.** The import makes the file a module, so `declare module 'nuxt-nats'` extends the package's types rather than replacing them, and it loads those types, so the extension reaches the `NatsEvents` that `jsPublish` reads. With no import or export at all, TypeScript reads the block as a new ambient module that replaces `nuxt-nats` for the whole project, and the package's other types disappear with it. `export {}` on its own is not enough either: the extension then reaches `jsPublish` only if some other file in the same tsconfig imports `nuxt-nats`, and Nuxt's server tsconfig has none.
- **Put it where the server tsconfig can see it.** In Nuxt 4, server code is type-checked with `.nuxt/tsconfig.server.json`, which includes `server/` and `shared/**/*.d.ts` but not a root `types/` folder.

`NatsEvents` is declared in the module's runtime and re-exported from `nuxt-nats`, so the augmentation merges into the same interface `jsPublish` reads.

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

// ✅ also compiles — 'orders.shipped' is not in NatsEvents, so the untyped overload takes it
await jsPublish('orders.shipped', { id: 'ord_123' })

// ✗ TypeScript error — missing required field 'currency'
await jsPublish('orders.created', {
  id: 'ord_123',
  customerId: 'cust_456',
  total: 99.99,
})
```

Undeclared subjects, and subjects held in a `string` variable, fall through to an untyped overload, which allows gradual adoption. A declared subject never does: its payload has to match. Before 0.1.0-beta.2 it could, because the untyped overload also accepted a declared subject whose payload did not match, so the error above never appeared.

## Type-safe consumers

Use the generic parameter on `defineNatsConsumer` to type the payload. In `server/` code `NatsEvents` is also auto-imported, so the import is optional there:

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
// apps/api/server/types/nats.d.ts
import type {} from 'nuxt-nats'
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

Unvalidated messages that throw from `OrderCreated.parse` will call `msg.nak()` (via the error handler in the consumer loop) and be redelivered. After `maxDeliver` attempts they are routed to `deadLetterSubject`, if one is set.
