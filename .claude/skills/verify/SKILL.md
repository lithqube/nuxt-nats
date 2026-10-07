---
name: verify
description: Run the full nuxt-nats verification gate (dev:prepare, lint, unit tests, type check, coverage floors, module build, playground build, Testcontainers integration tests, optionally live Synadia Cloud tests) and report one pass/fail table. Use after any code change in this repo, before committing or opening a PR, when asked to "verify", "run the checks", "make sure everything passes", or at the end of each delivery wave.
---

# Verify nuxt-nats

Run the gate script and report its table. Do not hand-run the steps one by one.

```bash
.claude/skills/verify/run.sh            # full gate (~2-3 min)
.claude/skills/verify/run.sh --quick    # lint, unit, types only
.claude/skills/verify/run.sh --live     # full gate + live Synadia Cloud tests
```

It exits 0 only when every step passes, prints `PASS/FAIL/SKIP` per step with timings and the
unit/integration test counts, and keeps each step's log in a temp dir (path printed at the end).
On a failure, read that step's log before changing anything.

## What the steps catch

| Step | Command | Notes |
|---|---|---|
| prepare | `npm run dev:prepare` | Needed after module source changes; stubs the module, prepares the playground |
| lint | `npm run lint` | |
| unit | `npm test` | Also runs `test/types/*.test-d.ts`, including the Synadia spec-drift test |
| types | `npm run test:types` | vue-tsc on the module **and** the playground. Must be 0 errors |
| coverage | `npm run test:coverage` | Floors on `src/runtime/server/credentials/**`, `src/runtime/synadia/**`, `src/runtime/cli/rotate.ts` |
| prepack | `npm run prepack` | Builds `dist/`; `dist/runtime/cli/bin.js` must keep its shebang |
| playground | `npm run dev:build` | Real Nuxt/Nitro build, exercises the virtual module `#nuxt-nats/credentials-provider` |
| integration | `npm run test:integration` | Testcontainers NATS; one file at a time |
| live | `npm run test:live` | Opt-in, against the user's Synadia Cloud account |

## Environment gotchas

- **Docker is OrbStack.** If integration is `SKIP`, run `open -a OrbStack` and rerun. If many
  integration files fail with "Hook timed out" or `docker ps` hangs, the daemon is wedged: ask the
  user before restarting OrbStack (it stops their other containers), then rerun. The script
  sets `DOCKER_HOST` and `TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE` itself; without them Testcontainers
  fails with "Could not find a working container runtime strategy" even when `docker info` works.
- **Live tests** read the personal access token from the macOS Keychain (service
  `synadia-cloud-pat`, via `scripts/synadia-token.mjs`). Never print it. The default test user is
  `CLI` (`2ZA68pwTQI7PhawVoe92JsmVNFR`, account Default); override with `SYNADIA_NATS_USER_ID`.
  Each run issues creds for that user (an issuance); nothing else changes. Add `SYNADIA_STREAMS=1`
  only with the user's consent (it uses a stream slot of their plan).
- **Flaky timing?** Rerun the single file 5 times
  (`npx vitest run test/unit/<file>`) before blaming the code; fix the test or the code so it is
  deterministic rather than retrying.

## When changing exports

If `src/module.ts` re-exports change, also type-check a consumer against the built `dist/` that
augments `NatsEvents` (see CLAUDE.md → Typed subjects). Keep the explicit
`export type { ... } from './runtime/types'` list; `export type *` breaks the published types.
