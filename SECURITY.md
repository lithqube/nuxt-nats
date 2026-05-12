# Security Policy

## Reporting a vulnerability

**Do not open a public issue, pull request, or discussion for security vulnerabilities.**

Report vulnerabilities privately via GitHub Security Advisories:

→ **https://github.com/lithqube/nuxt-nats/security/advisories/new**

Please include:

1. A description of the vulnerability and the affected component (connection, publish, consumer, KV, object store, health endpoint, etc.)
2. Steps to reproduce, ideally with a minimal Nuxt project or test case
3. The version of `nuxt-nats`, Nuxt, Node.js, and NATS server in use
4. Potential impact (data exposure, message loss, denial of service, etc.)
5. Suggested fix or mitigation, if you have one

You will receive an acknowledgement within **7 days** and a triage decision within **14 days**. We follow coordinated disclosure: please give us a reasonable window to ship a fix before publishing details.

## Supported versions

Until `1.0.0`, only the latest published version receives security fixes. After `1.0.0` we will publish a support matrix here.

## Scope

In scope:
- The `nuxt-nats` module source code (`src/`)
- Documented public APIs (`jsPublish`, `corePublish`, `defineNatsConsumer`, `useKV`, `useObj`, health endpoint, module options)

Out of scope:
- Vulnerabilities in upstream `@nats-io/*` packages — please report those to https://github.com/nats-io/nats.js
- Vulnerabilities in your own NATS server configuration
- Issues that require an attacker to already have full filesystem or environment access to the Nitro process
