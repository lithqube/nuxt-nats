# Contributing to nuxt-nats

Thanks for your interest in improving nuxt-nats. This guide covers the local dev workflow and what we expect in pull requests.

## Setup

Requires Node.js `>=22.12.0` (CI runs 22, 24 and 26) and Docker for the integration tests.

```bash
git clone https://github.com/lithqube/nuxt-nats.git
cd nuxt-nats
npm install
npm run dev:prepare
```

`dev:prepare` builds stubs and prepares the playground — run it after any change to `src/`.

## Running the module locally

The repo includes a Nuxt playground that consumes the module directly from source:

```bash
npm run dev
```

A local NATS server is required for end-to-end testing:

```bash
docker run -p 4222:4222 -p 8222:8222 nats:2.10-alpine -js
```

## Tests

```bash
# Unit tests (no Docker required)
npm test

# Single unit test
npx vitest run test/unit/consumer.test.ts

# Integration tests (Testcontainers — requires Docker)
npm run test:integration

# Both suites
npm run test:all

# Types (module + playground)
npm run test:types

# Lint
npm run lint

# Coverage, with floors on the credentials, Control Plane client and rotator code
npm run test:coverage

# Everything above plus both builds, as one pass/fail table
.claude/skills/verify/run.sh          # add --quick (no builds/Docker) or --live
```

Integration test files run one at a time (`fileParallelism: false`); each file starts and stops its own Testcontainers NATS through `startNats()` / `stopNats()` in `test/integration/setup.ts`. On OrbStack, Testcontainers may need `DOCKER_HOST=unix://$HOME/.orbstack/run/docker.sock TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE=/var/run/docker.sock` (the verify script sets them).

Consumer unit tests wait on what the loop did (`until(() => expect(...))`), never on fixed sleeps: see CLAUDE.md → Key Constraints.

### Live tests against Synadia Cloud

`npm run test:live` runs `test/live/` against a real Synadia Cloud account and is skipped unless enabled:

```bash
# with a personal access token (read from SYNADIA_CLOUD_TOKEN, ~/.config/synadia/token or the
# macOS Keychain service "synadia-cloud-pat"; never pass it on a command line)
node scripts/synadia-creds.mjs list                     # find a NATS user id
SYNADIA_LIVE=1 SYNADIA_NATS_USER_ID=<user id> npm run test:live

# or with a downloaded creds file
SYNADIA_LIVE=1 SYNADIA_CREDS_FILE=/path/to/user.creds npm run test:live
```

They use at most three connections, issue creds for that user (an issuance) and change nothing else. `SYNADIA_STREAMS=1` also creates and deletes a 1 MB R1 stream.

### Synadia Control Plane types

The Control Plane OpenAPI spec is vendored in `openapi/` (not published). After updating the YAML, regenerate the full types and fix what the drift test (`test/types/synadiaTypes.test-d.ts`) flags in the curated types:

```bash
npm run gen:synadia
```

## Pull requests

1. Fork the repo and create a branch from `main`.
2. Make changes — keep diffs focused; one logical change per PR.
3. Add or update tests. Bug fixes need a regression test; new features need both unit and integration coverage where it makes sense.
4. Update relevant docs in `docs/` (guides, ADRs) when behavior or public API changes.
5. Run `.claude/skills/verify/run.sh` (or at least `npm run lint && npm run test:all && npm run test:types`) locally.
6. Open the PR. The template will ask which areas you touched and prompt for verification evidence.

CI runs lint, unit (Node 22, 24 and 26), coverage, typecheck, integration, a Bun smoke test (`npm run test:bun`) and a packed-tarball consumer check (`npm run test:package`) on every PR. All must be green before merge.

## Architectural decisions

Non-trivial design changes should be captured as an ADR in `docs/adr/`. See existing ADRs for the format — short, decision-focused, dated.

## Releases

Maintainers cut releases. CI does not publish: releases go out by hand from an up-to-date `main`.

### Beta release (current pre-release channel, `beta` dist-tag)

Pre-releases have shipped under the `beta` dist-tag since 0.1.0-beta.1. There is no npm script for this path yet.

1. In a PR, bump the version and add its CHANGELOG entry, then merge to `main`:

   ```bash
   npm version prerelease --preid=beta --no-git-tag-version   # 0.1.0-beta.N → 0.1.0-beta.N+1
   ```

2. From `main`, verify, build and publish:

   ```bash
   npm run lint && npm run test:all && npm run prepack
   npm pack --dry-run          # dist/ and CHANGELOG.md (plus npm's README.md, LICENSE and package.json); no openapi/, test/, playground/ or .creds files
   npm publish --tag beta
   ```

   Always pass `--tag beta`: `package.json` no longer sets a default tag, and npm refuses to publish a prerelease version without one. The `release-beta` project skill (`.claude/skills/release-beta`) walks through these steps with checks.

3. Point `latest` at the new version. `latest` has tracked the newest beta since 0.1.0-beta.1, so a plain `npm install nuxt-nats` installs it, but `npm publish --tag beta` does not move it:

   ```bash
   npm dist-tag add nuxt-nats@0.1.0-beta.N latest
   ```

4. Tag the merge commit and push the tag:

   ```bash
   git tag -a v0.1.0-beta.N -m "v0.1.0-beta.N"
   git push origin v0.1.0-beta.N
   ```

### Alpha release (retired)

The alpha series is over: `npm run version:bump-alpha` and `version:bump-minor` / `-major` (preid `alpha`) must not be run on a beta or stable version, because `--preid=alpha` moves `0.1.0-beta.N` back to `0.1.0-alpha.0`.

### Stable release

Stable versions ship under `latest`, by hand from an up-to-date `main`, in the same PR-then-publish
shape as the betas. There is no `release` script: `changelogen --release` would rewrite the
hand-written CHANGELOG, so those scripts were removed.

1. In a PR, set the version (`npm version 0.1.0 --no-git-tag-version`), move `[Unreleased]` under a
   dated `## [0.1.0]` heading in CHANGELOG.md, and update the README status line. Merge it.
2. From `main`, verify and pack:

   ```bash
   .claude/skills/verify/run.sh        # the full gate
   AUDIT=1 npm run test:package        # tarball contents, a clean Nuxt consumer, runtime-only npm audit
   ```

3. Publish (npm prompts for 2FA, see below) and tag:

   ```bash
   npm publish                          # no publishConfig tag: this lands on `latest`
   npm dist-tag add nuxt-nats@0.1.0 beta   # optional: keep `beta` from pointing at an older beta
   git tag -a v0.1.0 -m "v0.1.0" && git push origin v0.1.0
   ```

4. Create the GitHub release for the tag (not marked pre-release) with the CHANGELOG section as notes,
   and check that the Nuxt Modules listing no longer shows Beta.

### Package manager and dependency audit

npm is the package manager: `package-lock.json` is the only lockfile, and CI installs with `npm ci`.

Release gate: `AUDIT=1 npm run test:package` runs `npm audit` on the module's runtime dependencies
alone (what consumers install). It must report no vulnerabilities. A plain `npm audit` over the repo
also covers the playground and test tooling, so it reports more; those findings are triaged here
rather than blocking a release:

| Advisory family | Reaches consumers | Decision |
|---|---|---|
| `glob`, `minimatch`, `archiver`, `readdir-glob`, `zip-stream` (moderate, DoS / traversal) | No: build and test tooling (`nitropack`, `testcontainers`) | Accept. The only suggested fix downgrades `testcontainers` two majors. Revisit when upstream updates |
| `nuxt`, `@nuxt/nitro-server`, `nitropack` (moderate) | No: playground and tests | Accept. Flagged only through the `archiver` chain above; already on the latest Nuxt |

Re-run `npm audit` before each release and update this table.

### Manual version control

If you need to set the version separately before releasing:

```bash
npm run version:bump-alpha     # 0.x.y-alpha.N → 0.x.y-alpha.N+1
npm run version:bump-minor     # 0.x.y → 0.(x+1).0-alpha.0
npm run version:bump-major     # 0.x.y → 1.0.0-alpha.0
npm run version:print          # print current version
npm run version:print-tag      # print v0.x.y-alpha.N
```

### npm OTP

If your npm account has 2FA enabled, `npm publish` will pause and print an auth URL:

```
Open this URL in your browser to authenticate:
  https://www.npmjs.com/auth/cli/<token>
```

Open the URL, approve the publish in the browser, and npm completes automatically.

## Reporting bugs and feature requests

Use the issue templates at https://github.com/lithqube/nuxt-nats/issues/new/choose. For security issues, see [SECURITY.md](./SECURITY.md) — do not open a public issue.
