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

Maintainers cut releases. The workflow is:

```bash
npm run version:bump-alpha     # or :bump-minor / :bump-major
npm run release                # lint + test + prepack + changelogen + publish
```

Alpha versions publish under the `alpha` dist-tag and do not become the default for `npm install nuxt-nats`.

## Reporting bugs and feature requests

Use the issue templates at https://github.com/lithqube/nuxt-nats/issues/new/choose. For security issues, see [SECURITY.md](./SECURITY.md) — do not open a public issue.
