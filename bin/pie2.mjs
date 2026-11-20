#!/usr/bin/env node
import { existsSync } from 'node:fs'

// Source links keep development edits live; packed installations contain only dist.
const source = new URL('../src/cli.ts', import.meta.url)
const entry = existsSync(source) ? source : new URL('../dist/cli.js', import.meta.url)
try {
  const { main } = await import(entry.href)
  await main()
} catch (error) {
  console.error(`Error: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
}
