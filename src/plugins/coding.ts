import { readFile, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { Type } from '@earendil-works/pi-ai'
import { defineExtension, defineTool, section, type ToolRegistration } from '@earendil-works/pi-durable'
import { CodingTools } from '@earendil-works/pi-durable/tools'
import type { Plugin } from '../plugin.ts'

export const bashParameters = Type.Object({
  command: Type.String({ minLength: 1, maxLength: 131072 }),
  description: Type.String({ minLength: 1, maxLength: 400, description: 'Concise active-voice description, 5–10 words, shown in the UI.' }),
  timeoutMs: Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: 2_147_483_647, description: 'Foreground timeout in milliseconds.' })),
  workdir: Type.Optional(Type.String({ minLength: 1, description: 'Working directory; relative paths resolve against the session workspace.' })),
}, { additionalProperties: false })

export async function createCodingPlugin(cwd: string): Promise<Plugin> {
  const instructions: string[] = []
  for (let dir = cwd; ; dir = dirname(dir)) {
    try { instructions.unshift(`Instructions from ${join(dir, 'AGENTS.md')}:\n${await readFile(join(dir, 'AGENTS.md'), 'utf8')}`) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    if (await stat(join(dir, '.git')).then(() => true, () => false) || dirname(dir) === dir) break
  }
  return {
    name: 'coding',
    extension: defineExtension({
      name: 'coding',
      tools: CodingTools.tools!.map((original: ToolRegistration) => original.name !== 'bash' ? original : defineTool({
        ...original, replay: 'unsafe', prepareArguments: undefined,
        description: 'Execute a bash command in a fresh shell and return stdout/stderr. State does not persist between calls; pass workdir instead of cd. Nonzero exits are reported with [exit code: N]. Long output is truncated to its tail, with full output saved to a temp file. Optionally set timeoutMs in milliseconds.',
        parameters: bashParameters,
        execute: async (args, api, context) => {
          if (!args.command.trim()) throw new Error('Command must not be blank')
          if (!args.description.trim()) throw new Error('Description must not be blank')
          if (args.timeoutMs !== undefined && (!Number.isFinite(args.timeoutMs) || args.timeoutMs <= 0 || args.timeoutMs > 2_147_483_647)) throw new Error('Invalid timeoutMs: expected positive finite milliseconds')
          const workdir = args.workdir === undefined ? undefined : resolve(api.env?.cwd ?? (await api.agent(context)).cwd ?? cwd, args.workdir)
          const env = api.env && workdir !== undefined ? new Proxy(api.env, { get(target, property) {
            if (property === 'cwd') return workdir
            const value = Reflect.get(target, property, target)
            return typeof value === 'function' ? value.bind(target) : value
          } }) : api.env
          const result = await original.execute({ command: args.command, ...(args.timeoutMs === undefined ? {} : { timeout: args.timeoutMs / 1000 }) }, { ...api, env }, context)
          const retained = api.retainedOutput().text
          const code = (result.structuredOutput as { exitCode: number }).exitCode
          return { ...result, isError: false, diagnostics: result.diagnostics?.filter(item => item.code !== 'exit_code'),
            output: [{ type: 'text' as const, text: `${retained || '(no output)'}\n[exit code: ${code}]` }] }
        },
      })),
      sections: [
        section('bash_policy', () => 'Check the [exit code: N] marker on every bash result; investigate failures before moving on.'),
        section('preamble', () => 'You are a coding agent. Inspect the project before editing. Make the smallest complete change, preserve user work, validate tool inputs, and run the relevant checks. Explain results and remaining limitations plainly.', { tag: false }),
        section('cwd', input => input.env?.cwd),
        section('project_instructions', () => instructions.join('\n\n') || undefined),
      ],
    }),
  }
}
