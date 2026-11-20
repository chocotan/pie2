import { open, readdir, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { defineExtension, defineTool, section } from '@earendil-works/pi-durable'
import { Type } from 'typebox'
import { parse } from 'yaml'
import type { Plugin } from '../plugin.ts'

const maxSkillBytes = 256 * 1024
const validName = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

type Skill = { name: string; description: string; path: string; disabled: boolean }

async function readSkill(path: string) {
  const file = await open(path, 'r')
  try {
    const info = await file.stat()
    if (!info.isFile() || info.size > maxSkillBytes) throw new Error('SKILL.md must be a file of at most 256 KiB')
    const buffer = Buffer.alloc(maxSkillBytes + 1)
    let size = 0
    while (size < buffer.length) {
      const { bytesRead } = await file.read(buffer, size, buffer.length - size, null)
      if (!bytesRead) break
      size += bytesRead
    }
    if (size > maxSkillBytes) throw new Error('SKILL.md exceeds 256 KiB')
    return buffer.subarray(0, size).toString('utf8')
  } finally {
    await file.close()
  }
}

export async function createSkillsPlugin({
  cwd,
  directories = [],
  home = homedir(),
}: { cwd: string; directories?: string[]; home?: string }): Promise<Plugin> {
  const skills = new Map<string, Skill>()
  const visited = new Set<string>()
  const diagnostics: string[] = []
  const message = (error: unknown) => error instanceof Error ? error.message : String(error)

  async function scan(directory: string) {
    let entries
    try {
      const canonical = await realpath(directory)
      if (visited.has(canonical)) return
      visited.add(canonical)
      entries = await readdir(directory, { withFileTypes: true })
      entries.sort((a, b) => a.name.localeCompare(b.name))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') diagnostics.push(`${directory}: ${message(error)}`)
      return
    }
    const path = join(directory, 'SKILL.md')
    if (entries.some(entry => entry.name === 'SKILL.md')) {
      try {
        const content = await readSkill(path)
        const frontmatter = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content)
        if (!frontmatter) throw new Error('Missing YAML frontmatter')
        const metadata = parse(frontmatter[1], { maxAliasCount: 100 })
        const name = metadata?.name
        const description = typeof metadata?.description === 'string' ? metadata.description.trim() : ''
        if (typeof name !== 'string' || name.length > 64 || !validName.test(name)) throw new Error('Invalid skill name')
        if (!description || description.length > 1024) throw new Error('Description must contain 1–1024 characters')
        const disabled = metadata['disable-model-invocation']
        if (disabled !== undefined && typeof disabled !== 'boolean') throw new Error('disable-model-invocation must be boolean')
        if (skills.has(name)) diagnostics.push(`${path}: duplicate ${name}; keeping ${skills.get(name)!.path}`)
        else skills.set(name, { name, description, path, disabled: disabled === true })
      } catch (error) {
        diagnostics.push(`${path}: ${message(error)}`)
      }
    }
    for (const entry of entries) {
      const child = join(directory, entry.name)
      if (entry.isDirectory()) await scan(child)
      else if (entry.isSymbolicLink()) {
        try {
          if ((await stat(child)).isDirectory()) await scan(child)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') diagnostics.push(`${child}: ${message(error)}`)
        }
      }
    }
  }

  for (const directory of [
    join(cwd, '.agents/skills'), join(cwd, '.pi/skills'),
    ...directories.map(directory => resolve(cwd, directory)),
    join(home, '.agents/skills'), join(home, '.pi/agent/skills'),
  ]) await scan(resolve(directory))

  async function load(name: string, explicit: boolean) {
    const skill = skills.get(name)
    if (!skill) throw new Error(`Unknown skill: ${name}. Use /skills to list available skills.`)
    if (skill.disabled && !explicit) throw new Error(`Skill ${name} requires explicit invocation with /skill ${name}.`)
    const content = await readSkill(skill.path)
    return `Skill: ${name}\nLocation: ${skill.path}\nResolve all relative paths against: ${dirname(skill.path)}\n\n${content}`
  }

  const skillTool = defineTool({
    name: 'Skill',
    description: 'Load a skill by name when its description matches the task. Read its full instructions before using it. This tool only reads instructions and never executes scripts.',
    replay: 'safe',
    outputLimits: { maxBytes: maxSkillBytes + 16384, maxLines: maxSkillBytes + 100 },
    parameters: Type.Object({ name: Type.String({ minLength: 1, maxLength: 64, description: 'Available skill name' }) }),
    async execute({ name }) {
      try {
        return { output: [{ type: 'text', text: await load(name, false) }] }
      } catch (error) {
        return { isError: true, output: [{ type: 'text', text: message(error) }] }
      }
    },
  })

  return {
    name: 'skills',
    extension: defineExtension({
      name: 'skills',
      tools: [skillTool],
      sections: [section('skills', () => {
        const advertised = [...skills.values()].filter(skill => !skill.disabled)
        if (!advertised.length) return undefined
        return 'Available skills (metadata only). Use the Skill tool to read matching instructions before following them. Relative paths resolve from the skill directory.\n' +
          advertised.map(({ name, description, path }) => JSON.stringify({ name, description, path })).join('\n')
      })],
    }),
    commands: {
      async skills() {
        const list = [...skills.values()].map(skill => `${skill.name}${skill.disabled ? ' (explicit only)' : ''} — ${skill.description}\n  ${skill.path}`)
        return { output: [...(list.length ? list : ['No skills found.']), ...diagnostics.map(item => `Warning: ${item}`)].join('\n') }
      },
      async skill(args) {
        const match = /^(\S+)(?:\s+([\s\S]*))?$/.exec(args.trim())
        if (!match) return { output: 'Usage: /skill <name> [request]' }
        try {
          const content = await load(match[1]!, true)
          return { prompt: content + (match[2] ? `\n\nUser request:\n${match[2]}` : '') }
        } catch (error) {
          return { output: message(error) }
        }
      },
    },
  }
}
