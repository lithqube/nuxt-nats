---
name: release-beta
description: Cut a nuxt-nats beta release on npm (0.1.0-beta.N) — version bump, CHANGELOG heading, verification, dry-run pack, publish under the beta dist-tag, move latest, tag. Use when asked to release, publish, cut a beta, ship to npm, or bump the beta version. Never use the alpha scripts for this.
---

# Release a nuxt-nats beta

Pre-releases ship on the `beta` dist-tag, and `latest` tracks the newest beta. The source of truth
is CONTRIBUTING.md → Releases; this skill adds the checks and the stop points.

## Hard rules

- **Never run `npm run release:alpha`, `npm run version:bump-alpha`, `npm run release` or
  `npm run release:stable`** for a beta. `--preid=alpha` turns `0.1.0-beta.N` into
  `0.1.0-alpha.0`, which sorts below the published betas; `release`/`release:stable` publish to
  `latest` through changelogen.
- **Publishing, `npm dist-tag`, pushing tags and pushing branches are outward-facing and
  irreversible.** Show the exact command and wait for the user's explicit yes before each one.
  Approval for one step is not approval for the next.
- **Never publish from anything but an up-to-date `main`** with a clean working tree.
- **npm auth is the user's.** If `npm whoami` fails, ask the user to run `npm login` themselves; never
  handle their credentials. With 2FA, `npm publish` prints a URL the user must open and approve.

## Steps

### 1. Prepare the version (in a PR)

```bash
git switch main && git pull --ff-only
node -p "require('./package.json').version"          # current: 0.1.0-beta.N
```

- If `package.json` is **already** at the version being released (it was bumped earlier), skip the
  bump. Otherwise:

  ```bash
  npm version prerelease --preid=beta --no-git-tag-version   # → 0.1.0-beta.N+1
  ```

- Confirm the result matches `^0\.1\.0-beta\.\d+$`. Abort if it says `alpha`.
- `CHANGELOG.md`: the top entry must be headed `## [<version>] — <YYYY-MM-DD>` (not
  `[Unreleased]`). Rename the heading if needed and make sure the entry covers everything since the
  previous release (`git log v<previous>..HEAD --oneline`).
- Keep `package-lock.json` and `pnpm-lock.yaml` in sync (`pnpm install --lockfile-only`).
- Commit, open a PR, and merge it to `main` (the user decides when).

### 2. Verify on main

```bash
git switch main && git pull --ff-only && git status --porcelain   # must print nothing
```

Run the full gate with the `verify` skill (`.claude/skills/verify/run.sh`). Every step must pass.
Then check the tarball:

```bash
npm pack --dry-run 2>&1 | tail -25
```

It must contain `dist/` (module, `runtime/`, `types.d.mts`, `runtime/cli/bin.js`) and
`CHANGELOG.md`, plus npm's `README.md`, `LICENSE` and `package.json` — no
`openapi/`, `test/`, `playground/` or `.creds` files.

### 3. Publish — STOP for approval

```bash
npm whoami                     # must succeed; otherwise the user runs `npm login`
npm view nuxt-nats dist-tags   # note the current beta/latest
npm publish --tag beta        # publishConfig.tag is also "beta"
```

### 4. Move `latest` — STOP for approval

```bash
npm dist-tag add nuxt-nats@<version> latest
npm view nuxt-nats dist-tags   # beta and latest both show <version>
```

### 5. Tag — STOP for approval

```bash
git tag -a v<version> -m "v<version>"
git push origin v<version>
```

### 6. Report

The published version, both dist-tags, the tag, and anything skipped. Update the project memory
note about release status.
