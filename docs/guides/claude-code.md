# Using nuxt-nats with Claude Code

nuxt-nats ships a [Claude Code skill](https://docs.claude.com/en/docs/claude-code/skills) so an AI assistant writes code against the module's real API instead of guessing from the `nats` package. It covers module config and auth, `jsPublish`, consumers (including the rule that **the handler must ack**), dead letters, KV and Object Store, agents, and production gotchas.

## Install

The skill lives in [`skills/nuxt-nats`](../../skills/nuxt-nats) and is not part of the npm package. Copy it into your project's `.claude/skills/`:

```bash
npx giget@latest gh:lithqube/nuxt-nats/skills/nuxt-nats .claude/skills/nuxt-nats
```

From the first release that includes it, pin to the version you run with a ref: `gh:lithqube/nuxt-nats/skills/nuxt-nats#<tag>`. Re-run the command when you upgrade nuxt-nats. Claude loads the skill when you work with the module or ask to add NATS to a Nuxt app.

## General NATS skills

Questions that go beyond the module (stream and consumer design, clusters, Kubernetes, monitoring, troubleshooting, the Synadia agent wire protocol) are covered by the general skills in [nats-jetstream-claude-skills](https://github.com/lithqube/nats-jetstream-claude-skills): `jetstream-architecture`, `jetstream-deployment`, `jetstream-operations` and `nats-agent-fabric`. The nuxt-nats skill defers to them where appropriate. They are optional.

## Keeping it accurate

The skill is documentation an assistant follows literally, so it is tested like code: `test/unit/skill.test.ts` fails when the skill names a utility or `NUXT_NATS_*` variable that does not exist, or teaches a handler signature the source no longer declares. Change the skill in the same pull request as any change to the public API.
