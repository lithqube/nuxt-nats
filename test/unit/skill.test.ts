import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'

// The nuxt-nats Claude skill ships in skills/nuxt-nats. It is documentation that an AI follows
// literally, so a stale signature in it produces wrong code. These checks tie it to the source.

const root = fileURLToPath(new URL('../..', import.meta.url))
const skillDir = join(root, 'skills/nuxt-nats')

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f)
    return statSync(p).isDirectory() ? walk(p) : [p]
  })
}

const skillFiles = walk(skillDir).filter(f => f.endsWith('.md'))
const skill = Object.fromEntries(skillFiles.map(f => [relative(skillDir, f), readFileSync(f, 'utf8')]))
const allSkillText = Object.values(skill).join('\n')

const utilsDir = join(root, 'src/runtime/server/utils')
const utilsSource = walk(utilsDir).map(f => readFileSync(f, 'utf8')).join('\n')
const repoText = [...walk(join(root, 'src')), ...walk(join(root, 'docs'))]
  .filter(f => /\.(?:ts|md)$/.test(f))
  .map(f => readFileSync(f, 'utf8'))
  .join('\n') + readFileSync(join(root, 'README.md'), 'utf8')

// Names the skill uses that belong to Nuxt, Nitro or h3 rather than this module.
const external = new Set(['defineNitroPlugin', 'defineEventHandler', 'defineNuxtConfig', 'useRuntimeConfig'])

describe('skills/nuxt-nats', () => {
  it('has valid frontmatter', () => {
    const fm = /^---\nname: (.+)\ndescription: (.+)\n---\n/.exec(skill['SKILL.md'] ?? '')
    expect(fm?.[1]).toBe('nuxt-nats')
    expect((fm?.[2] ?? '').length).toBeGreaterThan(100)
  })

  it('links every reference file, and every link resolves', () => {
    const linked = [...skill['SKILL.md']!.matchAll(/`(references\/[\w-]+\.md)`/g)].map(m => m[1]!)
    const present = Object.keys(skill).filter(k => k.startsWith('references/'))
    expect(new Set(linked)).toEqual(new Set(present))
    for (const l of linked) expect(existsSync(join(skillDir, l))).toBe(true)
  })

  it('only names utilities the module exports', () => {
    const names = new Set(allSkillText.match(/\b(?:use[A-Z]\w+|define[A-Z]\w+|jsPublish|corePublish|getAgentStatuses|stopAll\w+|closeAgents)\b/g) ?? [])
    const missing = [...names].filter(n =>
      !external.has(n) && !new RegExp(`export (?:async )?(?:function|const) ${n}\\b|export \\{[^}]*\\b${n}\\b[^}]*\\}`).test(utilsSource))
    expect(missing).toEqual([])
  })

  it('only names NUXT_NATS_* variables that appear in the source or docs', () => {
    const vars = new Set(allSkillText.match(/\bNUXT_NATS_[A-Z_]+\b/g) ?? [])
    const missing = [...vars].filter(v => !repoText.includes(v))
    expect(missing).toEqual([])
  })

  it('teaches the consumer handler signature the source declares', () => {
    expect(utilsSource).toMatch(/handler: \(msg: JsMsg, payload: T\) => Promise<void>/)
    expect(skill['references/consumers.md']).toContain('async handler(msg, payload)')
    expect(allSkillText).not.toMatch(/handler\(data, msg\)/)
  })

  it('teaches the dead-letter callback the source declares', () => {
    expect(utilsSource).toMatch(/onDeadLetter: \(event: DeadLetterEvent, msg: JsMsg\)/)
    expect(skill['references/consumers.md']).toContain('async onDeadLetter(event, msg)')
  })

  it('keeps the ack rule: a returning handler is not acked', () => {
    const loop = utilsSource.slice(utilsSource.indexOf('await handler(msg, payload)'))
    const afterHandler = loop.slice(0, loop.indexOf('finally'))
    expect(afterHandler).not.toMatch(/msg\.ack\(\)/)
    expect(skill['references/consumers.md']).toContain('The handler must ack')
  })
})
