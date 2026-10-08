import { describe, expectTypeOf, it } from 'vitest'
import type { components } from '../../openapi/synadia-control-plane'
import type {
  SynadiaAccount,
  SynadiaIssuance,
  SynadiaKvBucket,
  SynadiaNatsUser,
  SynadiaRevocation,
  SynadiaStream,
  SynadiaSystemInfo,
  SynadiaTeam,
} from '../../src/runtime/synadia/types'

// The client ships curated types instead of the 870 KB generated schema. These assertions tie
// them to the vendored spec: after `npm run gen:synadia`, a field that was renamed, removed or
// retyped upstream fails here.
type S = components['schemas']

describe('curated Synadia types match the OpenAPI spec', () => {
  it('responses: every API value is a valid curated value', () => {
    expectTypeOf<S['TeamViewResponse']>().toExtend<SynadiaTeam>()
    expectTypeOf<S['SystemInfo']>().toExtend<SynadiaSystemInfo>()
    expectTypeOf<S['AccountViewResponse']>().toExtend<SynadiaAccount>()
    expectTypeOf<S['NatsUserViewResponse']>().toExtend<SynadiaNatsUser>()
    expectTypeOf<S['NatsUserIssuanceViewResponse']>().toExtend<SynadiaIssuance>()
    expectTypeOf<S['NatsUserRevocationViewResponse']>().toExtend<SynadiaRevocation>()
    expectTypeOf<S['JSStreamInfoResponse']>().toExtend<SynadiaStream>()
    expectTypeOf<S['JSKVBucketViewResponse']>().toExtend<SynadiaKvBucket>()
  })

  it('requests: what the client sends is a valid API request', () => {
    // natsUsers.create fills the limits the API requires (data/payload/subs) with -1.
    expectTypeOf<{ name: string, sk_group_id: string, jwt_expires_in_secs?: number }>().toExtend<S['NatsUserCreateRequest']>()
    expectTypeOf<{ before: number }>().toExtend<S['NatsUserRevocationRequest']>()
    // kvBuckets.create fills history, storage, num_replicas and compression.
    expectTypeOf<{ bucket: string, history: number, storage: 'file', num_replicas: number, compression: boolean }>().toExtend<S['JSKVBucketConfig']>()
  })
})
