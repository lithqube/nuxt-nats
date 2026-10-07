# Synadia Cloud / Infisical / cloud identity — endpoint reference

## Synadia Cloud connection

| | |
|---|---|
| TCP (TLS required) | `tls://connect.ngs.global` (geo-routed), `tls://{eu,us,asia,west.us,east.us}.geo.ngs.global` |
| WebSocket | `wss://<same host>:443` |
| Auth | `.creds` (user JWT + NKey seed); bearer-token users authenticate with the JWT alone |
| JS domain / API prefix | not needed |

## Control Plane API — `https://cloud.synadia.com/api/core/beta`, `Authorization: Bearer <token>`

| Purpose | Call | Notes |
|---|---|---|
| Teams / systems / accounts | `GET /teams`, `/teams/{id}/systems`, `/systems/{id}/accounts`, `GET /accounts/{id}` | lists return `{ items }` |
| NATS users | `GET/POST /accounts/{id}/nats-users`, `GET/PATCH/DELETE /nats-users/{id}` | create: `name`, `sk_group_id` required; `jwt_settings` needs `data`/`payload`/`subs` (-1 = unlimited) |
| Issue creds | `POST /nats-users/{id}/creds` → text | each call is an issuance |
| Bearer JWT | `POST /nats-users/{id}/bearer-jwt` → text | user must allow bearer tokens |
| HTTP gateway token | `POST /nats-users/{id}/http-gw-token` → `{ token }` | Wave 4 (deferred) |
| Rotate nkey | `POST /nats-users/{id}/rotate` | old creds valid until expiry or revocation |
| Issuances | `GET /nats-users/{id}/issuances` | status: Active, Revoked, Expired, … |
| Revoke | `PUT /accounts/{id}/nats-user-revocations/{userNkeyPublic}` body `{ before }` | DELETE unrevokes |
| JetStream | `GET/POST /accounts/{id}/jetstream/{streams,kv-buckets,object-buckets}`, `GET/PATCH/DELETE /jetstream/stream/{id}`, `DELETE /jetstream/kv-bucket/{id}` | |
| Connections | `GET /accounts/{id}/connections?limit=&state=&user=` | |
| Service accounts | `POST /teams/{id}/service-accounts` (`name`, `role_id`, `resources: { "NatsUser:<id>": … }`), `POST /service-accounts/team/{id}/tokens` | scope rotator tokens to one user |

## Infisical — REST

| Purpose | Call |
|---|---|
| Universal auth | `POST /api/v1/auth/universal-auth/login` `{ clientId, clientSecret }` |
| Kubernetes / OIDC / GCP / Azure | `POST /api/v1/auth/{kubernetes,oidc,gcp,azure}-auth/login` `{ identityId, jwt }` |
| AWS | `POST /api/v1/auth/aws-auth/login` `{ identityId, iamHttpRequestMethod: "POST", iamRequestBody: b64("Action=GetCallerIdentity&Version=2011-06-15"), iamRequestHeaders: b64(JSON(signed headers)) }` |
| All logins return | `{ accessToken, expiresIn, accessTokenMaxTTL, tokenType }` |
| Read secret | `GET /api/v4/secrets/{name}?projectId&environment&secretPath` → `{ secret: { secretValue } }` |
| Update / create | `PATCH` / `POST /api/v4/secrets/{name}` `{ projectId, environment, secretPath, secretValue }`; an approval policy returns an approval object instead of `secret` |

## Workload identity tokens

| Platform | Source |
|---|---|
| Kubernetes | `/var/run/secrets/kubernetes.io/serviceaccount/token` |
| AWS | env keys → `AWS_WEB_IDENTITY_TOKEN_FILE`+`AWS_ROLE_ARN` (STS AssumeRoleWithWebIdentity, POST form, `Accept: application/json`) → `AWS_CONTAINER_CREDENTIALS_FULL_URI`/`_RELATIVE_URI` (+`AWS_CONTAINER_AUTHORIZATION_TOKEN[_FILE]`) → IMDSv2 (`PUT /latest/api/token`, `/latest/meta-data/iam/security-credentials/<role>`); region: `AWS_REGION`, `AWS_DEFAULT_REGION`, `/latest/dynamic/instance-identity/document`. Sign STS for `sts.<region>.amazonaws.com` |
| GCP | `http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity?audience=<identityId>&format=full`, header `Metadata-Flavor: Google` |
| Azure | IMDS `http://169.254.169.254/metadata/identity/oauth2/token?api-version=2018-02-01&resource=https://management.azure.com/` (`Metadata: true`); App Service `$IDENTITY_ENDPOINT?api-version=2019-08-01&resource=…` (`X-IDENTITY-HEADER`); `client_id` for user-assigned |

## JetStream error codes the module explains

10023 insufficient resources · 10027 max streams · 10028 memory · 10047 storage · 10058 stream name in use · 10113 max_bytes required · 10014 consumer not found
