## What does this PR do?

<!-- 1–3 sentences. Focus on the "why", not a diff summary. -->

## Related issue / ticket

<!-- Format: Fixes #123 / Closes #123 -->
<!-- Required for features and architectural changes. Bug fixes can skip if obvious. -->

## Type of change

- [ ] Bug fix
- [ ] New feature
- [ ] Refactor (no behavior change)
- [ ] Documentation
- [ ] Infrastructure / CI
- [ ] Test-only change

## Affected area

- [ ] Connection lifecycle (plugins/nats.ts)
- [ ] JetStream publish (utils/publish.ts)
- [ ] Consumer / DLQ / backoff (utils/consumer.ts)
- [ ] KV store (utils/useKV.ts)
- [ ] Object store (utils/useObj.ts)
- [ ] Health endpoint (server/routes)
- [ ] Stream provisioning (module.ts)
- [ ] docs/
- [ ] CI / tooling

## Checklist

- [ ] `npm run lint` passes
- [ ] `npm test` passes (unit tests)
- [ ] `npm run test:integration` passes (requires Docker)
- [ ] `npm run test:types` passes (TypeScript)
- [ ] No secrets committed
- [ ] Public API changes reflected in docs/

## Verification

<!-- How did you prove this works? Tests added, manual steps, log output. -->
