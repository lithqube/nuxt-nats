# Contributing to nuxt-nats

Thanks for your interest in improving nuxt-nats. This guide covers the local dev workflow and what we expect in pull requests.

## Setup

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
```

Integration tests run in a single forked worker; the NATS container is shared across suites via `startNats()` / `stopNats()` in `test/integration/setup.ts`.

## Pull requests

1. Fork the repo and create a branch from `main`.
2. Make changes — keep diffs focused; one logical change per PR.
3. Add or update tests. Bug fixes need a regression test; new features need both unit and integration coverage where it makes sense.
4. Update relevant docs in `docs/` (guides, ADRs) when behavior or public API changes.
5. Run `npm run lint && npm run test:all` locally.
6. Open the PR. The template will ask which areas you touched and prompt for verification evidence.

CI runs lint, unit, and integration jobs on every PR. All three must be green before merge.

## Architectural decisions

Non-trivial design changes should be captured as an ADR in `docs/adr/`. See existing ADRs for the format — short, decision-focused, dated.

## Releases

Maintainers cut releases. There are two release paths:

### Alpha release (pre-release, `alpha` dist-tag)

Bumps `0.x.y-alpha.N → 0.x.y-alpha.N+1`, runs all tests, publishes under the `alpha` tag, and commits + pushes the version bump in one step:

```bash
npm run release:alpha
```

Consumers must opt in explicitly — `npm install nuxt-nats` still installs the latest stable.

```bash
npm install nuxt-nats@alpha   # install latest alpha
```

### Stable release

Bumps to the next stable version via `changelogen --release` (prompts for semver bump), runs all tests, publishes as the default `latest` tag, and pushes the git tag:

```bash
npm run release:stable
```

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
