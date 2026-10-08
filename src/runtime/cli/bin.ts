#!/usr/bin/env node
import { runRotate } from './rotate'

const { code } = await runRotate(process.argv.slice(2), {
  env: process.env,
  out: line => process.stdout.write(`${line}\n`),
  err: line => process.stderr.write(`${line}\n`),
})
process.exit(code)
