import { mkdir, realpath } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { processLock } from '@earendil-works/chord/node'
import type { ModelThinkingLevel } from '@earendil-works/pi-ai'
import type { Models } from '@earendil-works/pi-ai/models'
import { createRegistry, Harness, type ModelRef } from '@earendil-works/pi-durable'
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node'
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node'
import type { CommandContext, Plugin } from './plugin.ts'
import { createCodingPlugin } from './plugins/coding.ts'
import { createGoalPlugin } from './plugins/goal.ts'
import { createTasksPlugin } from './plugins/tasks.ts'
import { SubagentPlugin } from './plugins/subagent.ts'
import { createSkillsPlugin } from './plugins/skills.ts'
import { createModelsPlugin } from './plugins/models.ts'
import { createStatusBarPlugin } from './plugins/statusbar.ts'
import { createBackgroundPlugin } from './plugins/background.ts'
import { createSessionPath } from './sessions.ts'
import { createUserInteraction } from './interaction.ts'
import { createAskUserPlugin } from './plugins/ask-user.ts'
import { createFilesPlugin } from './plugins/files.ts'
import { createPlanPlugin } from './plugins/plan.ts'
import { createWebPlugin, type WebSearchOptions } from './plugins/web.ts'
import { createWorkflowPlugin } from './plugins/workflow.ts'
import { createRalphPlugin } from './plugins/ralph.ts'

export interface HostOptions {
  cwd: string
  session?: string
  models: Models
  model: ModelRef
  thinkingLevel?: ModelThinkingLevel
  overrideModel?: boolean
  onReport?: (message: string) => void
  plugins?: Plugin[]
  disablePlugins?: string[]
  skillDirectories?: string[]
  webSearch?: WebSearchOptions
}

export async function openHost(options: HostOptions) {
  const cwd = await realpath(resolve(options.cwd))
  const session = options.session ? resolve(options.session) : await createSessionPath(cwd)
  await mkdir(dirname(session), { recursive: true, mode: 0o700 })
  const canonicalSession = await realpath(session).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error
    return realpath(dirname(session)).then(dir => join(dir, session.slice(dirname(session).length + 1)))
  })
  const release = await processLock(`pie2:${canonicalSession}`)
  const interaction = createUserInteraction()
  let harness: Harness | undefined
  const getHarness = () => { if (!harness) throw new Error('Harness not open'); return harness }
  try {
    const plugins = [
      await createCodingPlugin(cwd), createFilesPlugin(), createTasksPlugin(getHarness),
      createAskUserPlugin(interaction), createPlanPlugin(getHarness, interaction),
      createWebPlugin(options.webSearch), createWorkflowPlugin(), createRalphPlugin(),
      createGoalPlugin(getHarness),
      SubagentPlugin, await createSkillsPlugin({ cwd, directories: options.skillDirectories }), createModelsPlugin(options.models),
      await createStatusBarPlugin({ cwd, session, models: options.models, getHarness }),
      createBackgroundPlugin(getHarness),
      ...options.plugins ?? [],
    ].filter(plugin => !options.disablePlugins?.includes(plugin.name))
    const registry = createRegistry()
    const commands = new Map<string, NonNullable<Plugin['commands']>[string]>()
    const names = new Set<string>()
    for (const plugin of plugins) {
      if (!plugin || typeof plugin.name !== 'string' || !plugin.extension) throw new Error('Invalid plugin export')
      if (names.has(plugin.name)) throw new Error(`Duplicate plugin: ${plugin.name}`)
      names.add(plugin.name)
      registry.install(plugin.extension)
      for (const [name, handler] of Object.entries(plugin.commands ?? {})) {
        if (commands.has(name)) throw new Error(`Duplicate command: /${name}`)
        commands.set(name, handler)
      }
    }
    harness = await Harness.open(await openNodeSqliteStorage(session), {
      models: options.models, registry,
      env: ({ cwd: directory }) => new NodeExecutionEnv({ cwd: directory ?? cwd }),
      onReport: (error, info) => {
        const message = `[${info.type}] ${error instanceof Error ? error.message : String(error)}`
        if (options.onReport) options.onReport(message)
        else console.error(message)
      },
    }, BACKGROUND_CONTEXT)
    const agent = { model: options.model, cwd, ...(options.thinkingLevel === undefined ? {} : { thinkingLevel: options.thinkingLevel }) }
    const conversation = await harness.root(BACKGROUND_CONTEXT, { agent })
    await conversation.configure({ cwd, ...(options.overrideModel ? { model: options.model } : {}) }, BACKGROUND_CONTEXT)
    const ctx: CommandContext = { harness, conversation, context: BACKGROUND_CONTEXT }
    let closed = false
    return {
      ...ctx, plugins, session, interaction, models: options.models, commandNames: [...commands.keys()],
      statusBar: plugins.findLast(plugin => plugin.statusBar)?.statusBar,
      async command(input: string) {
        const match = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(input.trim())
        if (!match) return { prompt: input }
        let [, name, args = ''] = match
        if (name.startsWith('skill:')) { args = `${name.slice(6)} ${args}`; name = 'skill' }
        const handler = commands.get(name)
        if (!handler) throw new Error(`Unknown command: /${name}`)
        return handler(args, ctx)
      },
      async interrupt(options: { background?: boolean } = {}) {
        for (const plugin of plugins) await plugin.interrupt?.(ctx)
        await conversation.abort(BACKGROUND_CONTEXT, options)
        for (const plugin of plugins) await plugin.afterInterrupt?.(ctx)
      },
      async close() {
        if (closed) return
        closed = true
        interaction.close()
        try { await harness!.close(BACKGROUND_CONTEXT) } finally { await release() }
      },
    }
  } catch (error) {
    interaction.close()
    try { await harness?.close(BACKGROUND_CONTEXT) } finally { await release() }
    throw error
  }
}

export type Host = Awaited<ReturnType<typeof openHost>>
