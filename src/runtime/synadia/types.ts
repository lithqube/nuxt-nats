// Curated Synadia Control Plane types for the subset the client exposes. The full generated
// schema (openapi/synadia-control-plane.d.ts, 870 KB) is not shipped; test/types/synadiaTypes.test-d.ts
// checks these against it, so a spec update that breaks them fails the type tests.

export interface SynadiaTeam {
  id: string
  name: string
  created: string
}

export interface SynadiaSystemInfo {
  id: string
  name: string
  /** Comma-separated client URLs. */
  server_urls?: string
  http_gateway_url?: string
  jetstream_domain?: string
  jetstream_enabled: boolean
  user_jwt_expires_in_secs: number
}

export interface SynadiaAccountInfo {
  id: string
  name: string
  account_public_key?: string
  is_system_account: boolean
  user_jwt_expires_in_secs: number
}

export interface SynadiaAccount extends SynadiaAccountInfo {
  created: string
  system: SynadiaSystemInfo
  team: { id: string, name: string }
}

export interface SynadiaNatsUser {
  id: string
  name: string
  created: string
  user_public_key: string
  /** JWT lifetime of issued creds; 0 means they do not expire. */
  jwt_expires_in_secs: number
  jwt_expires_at_max: number
  sk_group_id?: string
  account: SynadiaAccountInfo
  system: SynadiaSystemInfo
}

export interface SynadiaPermission {
  allow?: string[]
  deny?: string[]
}

export interface SynadiaNatsUserCreate {
  name: string
  /** Signing-key group that signs the user; its permissions apply to the user. */
  sk_group_id: string
  /** JWT lifetime of issued creds in seconds. Set it for short-lived credentials. */
  jwt_expires_in_secs?: number
  jwt_settings?: {
    pub?: SynadiaPermission
    sub?: SynadiaPermission
    bearer_token?: boolean
    allowed_connection_types?: string[]
    tags?: string[]
    /** Limits; -1 (the default) is unlimited. */
    data?: number
    payload?: number
    subs?: number
  }
}

export type SynadiaIssuanceStatus = 'Active' | 'Revoked' | 'Partially Revoked' | 'SK Disabled' | 'SK Group Disabled' | 'SK Removed' | 'Expired'

export interface SynadiaIssuance {
  id: string
  name: string
  created: string
  /** User public key the creds were issued for. */
  sub: string
  iat_min: number
  iat_max: number
  exp_max?: number
  status: SynadiaIssuanceStatus
}

export interface SynadiaRevocation {
  account_id: string
  user_nkey_public: string
  /** JWTs for this key issued before this time (epoch seconds) are rejected. */
  before: number
  created: string
}

export interface SynadiaStreamConfig {
  name: string
  subjects?: string[]
  [key: string]: unknown
}

export interface SynadiaStream {
  id?: string
  name: string
  created: string
  config?: SynadiaStreamConfig
  state: { messages: number, bytes: number, [key: string]: unknown }
}

export interface SynadiaKvBucketConfig {
  bucket: string
  history?: number
  storage?: 'file' | 'memory'
  num_replicas?: number
  max_bytes?: number
  max_age?: number
  description?: string
  compression?: boolean
}

export interface SynadiaKvBucket {
  id: string
  stream_name: string
  bytes: number
  num_values: number
  config: { bucket: string, history: number, storage: string, num_replicas: number, max_bytes?: number }
}

export interface SynadiaConnections {
  connections: Array<Record<string, unknown>>
  num_connections: number
  total: number
}
