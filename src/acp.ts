import { stdin, stdout, stderr } from 'node:process'
import { Readable, Writable } from 'node:stream'
import { basename, isAbsolute, resolve } from 'node:path'
import { realpath, stat } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import {
  agent, methods, ndJsonStream, RequestError,
  type AgentContext, type ClientCapabilities, type ContentBlock, type SessionConfigOption, type SessionModeState,
  type NewSessionRequest, type LoadSessionRequest, type Stream, type ElicitationPropertySchema,
} from '@agentclientprotocol/sdk'
import { defineExtension, hook, ToolTask, watchEvents, type UserInput } from '@earendil-works/pi-durable'
import { clampThinkingLevel } from '@earendil-works/pi-ai/models'
import { configureModels } from './models.ts'
import { openHost, type Host } from './host.ts'
import { listSessions, resolveSession } from './sessions.ts'
import { getModelOptions, getThinkingOptions } from './plugins/models.ts'
import { PlanDoc } from './plugins/plan.ts'
import { TodoDoc } from './plugins/tasks.ts'
import type { Plugin } from './plugin.ts'
import type { UserAnswer } from './interaction.ts'
import { AcpEvents, safeInput, sessionSender, toolKind, toolTitle } from './acp-events.ts'

export interface AcpOptions {
  cwd?: string
  provider?: string
  model?: string
  baseUrl?: string
  pluginPaths?: string[]
  disablePlugins?: string[]
  skillDirectories?: string[]
  input?: Readable
  output?: Writable
  stream?: Stream
  configureModels?: typeof configureModels
}
type Session = {
  host: Host
  cwd: string
  events: AcpEvents
  watcher: Awaited<ReturnType<typeof watchEvents>>
  send: ReturnType<typeof sessionSender>
  abort: AbortController
  busy: boolean
  closing: boolean
  pending?: Promise<unknown>
  tail: Promise<void>
  lastMode?: string
  lastConfig?: string
}
const invalid = (message: string) => new RequestError(-32602, message)
const busy = () => new RequestError(-32000, 'Session is busy; cancel or wait for the current prompt')
const modes = [
  { id: 'build', name: 'Build', description: 'Implement and verify changes, with tool permissions.' },
  { id: 'plan', name: 'Plan', description: 'Read-only planning; implementation requires explicit plan approval.' },
]

async function promptContent(blocks: ContentBlock[], host: Host): Promise<UserInput> {
  if (!blocks.length) throw invalid('Prompt must contain at least one content block')
  const agent = await host.conversation.agent(host.context)
  const model = agent.model && host.models.getModel(agent.model.provider, agent.model.modelId)
  const content: Exclude<UserInput, string> = []
  for (const block of blocks) {
    switch (block.type) {
      case 'text': content.push({ type: 'text', text: block.text }); break
      case 'resource':
        if (!('text' in block.resource)) throw invalid('Binary embedded resources are unsupported; provide embedded text or an image')
        content.push({ type: 'text', text: `<resource uri=${JSON.stringify(block.resource.uri)}>\n${block.resource.text}\n</resource>` })
        break
      case 'resource_link':
        content.push({ type: 'text', text: `Referenced resource: ${block.title ?? block.name}\nURI: ${block.uri}${block.description ? `\n${block.description}` : ''}` })
        break
      case 'image':
        if (!model?.input.includes('image')) throw invalid('The current model does not support image input')
        if (!/^image\/(png|jpeg|gif|webp)$/.test(block.mimeType) || !block.data || !/^[A-Za-z0-9+/]*={0,2}$/.test(block.data) || block.data.length % 4 !== 0 || block.data.length > 28_000_000) throw invalid('Image must contain supported MIME type and valid base64 data (at most 20 MiB)')
        content.push({ type: 'image', mimeType: block.mimeType, data: block.data })
        break
      default: throw invalid(`Unsupported prompt content type: ${block.type}`)
    }
  }
  return content
}

/** Native ACP v1 transport over the same hosts, plugins and durable sessions as the CLI. */
export async function startAcp(options: AcpOptions = {}): Promise<void> {
  const baseCwd = resolve(options.cwd ?? process.cwd())
  const sessions = new Map<string, Session>()
  const opening = new Set<Promise<unknown>>()
  const loading = new Set<string>()
  let capabilities: ClientCapabilities = {}
  let disconnected = false
  let connectionSignal: AbortSignal
  const app = agent({ name: 'pie2' })
  const get = (id: string) => {
    const session = sessions.get(id)
    if (!session || session.closing) throw RequestError.sessionNotFound(id)
    return session
  }
  const state = async (session: Session) => {
    const { host } = session
    const agent = await host.conversation.agent(host.context)
    const model = agent.model && host.models.getModel(agent.model.provider, agent.model.modelId)
    const plan = host.plugins.some(plugin => plugin.name === 'plan')
      ? await host.harness.snapshot(PlanDoc, host.conversation.id, host.context) : undefined
    const availableModes = plan !== undefined || host.commandNames.includes('plan') ? modes : [modes[0]!]
    const modeState: SessionModeState = { currentModeId: plan?.mode ?? 'build', availableModes }
    const configOptions: SessionConfigOption[] = [{ id: 'mode', name: 'Mode', category: 'mode', type: 'select', currentValue: modeState.currentModeId,
      options: availableModes.map(item => ({ value: item.id, name: item.name, description: item.description })) }]
    if (host.commandNames.includes('model')) {
      const available = await getModelOptions(host.models)
      configOptions.push({ id: 'model', name: 'Model', category: 'model', type: 'select',
        currentValue: agent.model ? `${agent.model.provider}/${agent.model.modelId}` : '',
        options: available.map(item => ({ value: item.value, name: item.label, description: item.description })) })
    }
    if (host.commandNames.includes('thinking') && model) configOptions.push({ id: 'thinking', name: 'Thinking', category: 'thought_level', type: 'select',
      currentValue: clampThinkingLevel(model, agent.thinkingLevel), options: (await getThinkingOptions(host.models, host.conversation, host.context)).map(item => ({ value: item.value, name: item.label })) })
    return { modes: modeState, configOptions }
  }
  const notifyState = async (session: Session) => {
    const settings = await state(session)
    if (session.lastMode !== settings.modes.currentModeId) {
      await session.send({ sessionUpdate: 'current_mode_update', currentModeId: settings.modes.currentModeId })
      session.lastMode = settings.modes.currentModeId
    }
    const key = JSON.stringify(settings.configOptions)
    if (session.lastConfig !== key) {
      await session.send({ sessionUpdate: 'config_option_update', configOptions: settings.configOptions })
      session.lastConfig = key
    }
    return settings
  }
  const setMode = async (session: Session, value: string) => {
    if (!['build', 'plan'].includes(value)) throw invalid('Unknown mode; expected build or plan')
    if (!session.host.commandNames.includes('plan')) {
      if (value === 'plan') throw invalid('Planning plugin is disabled')
    } else await session.host.command(`/plan ${value === 'plan' ? 'on' : 'off'}`)
    await notifyState(session)
  }
  const closeSession = async (session: Session) => {
    if (session.closing) return
    session.closing = true
    session.abort.abort()
    session.host.interaction.close()
    try {
      await session.host.interrupt({ background: true })
      await session.pending?.catch(() => {})
      await session.watcher.stop()
      await session.tail.catch(() => {})
    } finally { await session.host.close() }
  }
  const open = async (params: NewSessionRequest | LoadSessionRequest, client: AgentContext) => {
    if (params.mcpServers.length) throw invalid('MCP servers are not supported by pie2 yet')
    if (params.additionalDirectories?.length || params.systemPrompt) throw invalid('Additional directories and client system prompts are not supported')
    if (!isAbsolute(params.cwd)) throw invalid('cwd must be an absolute directory')
    let cwd: string
    try {
      cwd = await realpath(params.cwd)
      if (!(await stat(cwd)).isDirectory()) throw invalid('cwd must name an existing directory')
    } catch { throw invalid('cwd must name an existing directory') }
    const id = 'sessionId' in params ? params.sessionId : undefined
    if (id && !/^[A-Za-z0-9_-]{1,200}$/.test(id)) throw invalid('sessionId must be an opaque session identifier')
    if (id && sessions.has(id)) {
      const session = get(id)
      if (session.cwd !== cwd) throw invalid('Session belongs to a different workspace')
      if (session.busy) throw busy()
      const view = await session.host.conversation.context(session.host.context)
      const replay = new AcpEvents(session.send)
      for (const entry of view.entries) await replay.entry(entry, true)
      return { sessionId: id, ...await state(session) }
    }
    let path: string | undefined
    const loadKey = id ? `${cwd}:${id}` : undefined
    if (loadKey && loading.has(loadKey)) throw busy()
    if (loadKey) loading.add(loadKey)
    let host: Host | undefined
    let session: Session | undefined
    const decisions = new Map<string, boolean>()
    const permissions: Plugin = { name: 'acpPermissions', extension: defineExtension({ name: 'acpPermissions', hooks: [hook(ToolTask, {
      beforeTool: async (call, api, context) => {
        const signal = AbortSignal.any([connectionSignal, ...(context.abortSignal ? [context.abortSignal] : [])])
        signal.throwIfAborted()
        // Plan's earlier hook blocks writes before this permission request; ACP never overrides it.
        if (!host || !session) return { block: 'ACP session is not ready' }
        await session.events.pending(`task-${api.taskId}`, call.name, call.arguments, call.parent ? `task-${call.parent.taskId}` : undefined)
        const remembered = decisions.get(call.name)
        if (remembered !== undefined) return remembered ? undefined : { block: `ACP permission denied for ${call.name}` }
        const outcome = (await client.request(methods.client.session.requestPermission, {
          sessionId: basename(host.session, '.sqlite'),
          toolCall: { toolCallId: `task-${api.taskId}`, name: call.name,
            title: toolTitle(call.name, call.arguments), kind: toolKind(call.name), status: 'pending', rawInput: safeInput(call.arguments),
            _meta: { 'pie2.toolName': call.name, 'pie2.permissionScope': 'session/tool-name' } },
          options: [
            { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
            { optionId: 'allow_always', name: `Allow ${call.name} for this session`, kind: 'allow_always' },
            { optionId: 'reject_once', name: 'Deny once', kind: 'reject_once' },
            { optionId: 'reject_always', name: `Deny ${call.name} for this session`, kind: 'reject_always' },
          ],
        }, { cancellationSignal: signal, stopWaitingOnCancel: true })).outcome
        signal.throwIfAborted()
        if (outcome.outcome !== 'selected') return { block: 'ACP permission cancelled; no permission granted' }
        if (outcome.optionId === 'allow_always') decisions.set(call.name, true)
        if (outcome.optionId === 'reject_always') decisions.set(call.name, false)
        return ['allow_once', 'allow_always'].includes(outcome.optionId) ? undefined : { block: 'ACP permission denied; no permission granted' }
      },
    })] }) }
    try {
      if (id) {
        try { path = await resolveSession(cwd, id) } catch { throw RequestError.sessionNotFound(id) }
      }
      const configured = await (options.configureModels ?? configureModels)({ cwd, provider: options.provider, model: options.model, baseUrl: options.baseUrl })
      const plugins: Plugin[] = []
      for (const file of options.pluginPaths ?? []) {
        const { default: exported } = await import(pathToFileURL(resolve(baseCwd, file)).href)
        plugins.push(typeof exported === 'function' ? await exported({ cwd }) : exported)
      }
      // Permissions cannot be disabled through the user plugin switch.
      host = await openHost({ cwd, session: path, ...configured, plugins: [...plugins, permissions],
        disablePlugins: options.disablePlugins?.filter(name => name !== 'acpPermissions'), skillDirectories: options.skillDirectories,
        overrideModel: Boolean(options.provider || options.model || options.baseUrl), onReport: () => stderr.write('pie2: agent runtime diagnostic (details omitted)\n') })
      if (disconnected) { await host.close(); throw new RequestError(-32800, 'ACP connection closed') }
      const sessionId = basename(host.session, '.sqlite')
      const send = sessionSender(client, sessionId)
      const events = new AcpEvents(send)
      const watcher = await watchEvents(host.harness, host.conversation.id, host.context)
      session = { host, cwd, events, send, watcher, abort: new AbortController(), busy: false, closing: false, tail: Promise.resolve() }
      sessions.set(sessionId, session)
      const current = session
      host.interaction.attach(async (questions, context) => {
        if (!capabilities.elicitation?.form) throw new Error('ACP client does not support elicitation forms; no answer or plan approval was granted. Use session/set_mode build to explicitly leave planning.')
        const properties: Record<string, ElicitationPropertySchema> = {}
        for (const [index, question] of questions.entries()) {
          const choices = question.options?.map((option, i) => ({ const: String(i), title: option.label, description: option.description }))
          properties[`q${index}`] = question.multiSelect && choices?.length
            ? { type: 'array', title: question.header, description: question.question, items: { anyOf: choices } }
            : { type: 'string', title: question.header, description: question.question, ...(choices?.length ? { oneOf: choices } : {}) }
          // A separate optional field preserves free answers without making them an approval choice.
          if (choices?.length) properties[`custom${index}`] = { type: 'string', title: 'Other answer / feedback' }
        }
        const response = await client.request(methods.client.elicitation.create, { mode: 'form', sessionId,
          message: questions.map(question => question.question).join('\n\n'), requestedSchema: { type: 'object', properties } },
        { cancellationSignal: AbortSignal.any([connectionSignal, ...(context.abortSignal ? [context.abortSignal] : [])]), stopWaitingOnCancel: true })
        if (response.action !== 'accept' || !response.content || typeof response.content !== 'object') throw new Error('User declined or cancelled; no answer or approval was granted')
        const values = response.content as Record<string, unknown>
        return questions.map((question, index): UserAnswer => {
          const value = values[`q${index}`]
          const custom = values[`custom${index}`]
          if (!question.options?.length) {
            if (typeof value !== 'string') throw new Error('Missing text answer')
            return { id: question.id, selected: [], custom: value }
          }
          const choices = value === undefined ? [] : Array.isArray(value) ? value : [value]
          const selected = choices.map(choice => {
            if (typeof choice !== 'string' || !/^\d+$/.test(choice) || !question.options?.[Number(choice)]) throw new Error('Invalid elicitation choice')
            return question.options[Number(choice)]!.label
          })
          if (custom !== undefined && typeof custom !== 'string') throw new Error('Invalid feedback')
          return { id: question.id, selected, ...(typeof custom === 'string' && custom.trim() ? { custom } : {}) }
        })
      })
      for (const entry of watcher.snapshot.entries) await events.entry(entry, true)
      let lastTodos: string | undefined
      watcher.start(async batch => {
        current.tail = current.tail.then(async () => {
          for (const event of batch) await events.event(event)
          if (host!.plugins.some(plugin => plugin.name === 'tasks') && batch.some(event => event.type === 'run_start' || event.type === 'turn_start' || event.type === 'snapshot' || event.type === 'tool_execution_end' && event.toolName === 'todo_write')) {
            const todos = await host!.harness.snapshot(TodoDoc, host!.conversation.id, host!.context)
            const key = JSON.stringify(todos?.todos ?? [])
            if (key !== lastTodos) {
              lastTodos = key
              await send({ sessionUpdate: 'plan', entries: (todos?.todos ?? []).map(todo => ({ content: todo.content, status: todo.status, priority: 'medium' })) })
            }
          }
          if (batch.some(event => event.type === 'agent_changed' || event.type === 'tool_execution_end' && ['enter_plan_mode', 'exit_plan_mode'].includes(event.toolName))) await notifyState(current)
        })
        await current.tail
      })
      const result = { sessionId, ...await state(session) }
      session.lastMode = result.modes.currentModeId
      session.lastConfig = JSON.stringify(result.configOptions)
      host.harness.resume()
      return result
    } catch (error) {
      if (session) { sessions.delete(basename(session.host.session, '.sqlite')); await closeSession(session).catch(() => {}) }
      else await host?.close().catch(() => {})
      if (error instanceof RequestError) throw error
      throw new RequestError(-32603, 'Unable to open session; check pie2 configuration and workspace access')
    } finally { if (loadKey) loading.delete(loadKey) }
  }
  const openingRequest = (params: NewSessionRequest | LoadSessionRequest, client: AgentContext) => {
    const work = open(params, client)
    opening.add(work)
    void work.finally(() => opening.delete(work)).catch(() => {})
    return work
  }
  app.onRequest(methods.agent.initialize, ({ params }) => {
    capabilities = params.clientCapabilities ?? {}
    return { protocolVersion: 1, agentInfo: { name: 'pie2', version: '0.1.0' }, authMethods: [],
      agentCapabilities: { loadSession: true, promptCapabilities: { image: true, embeddedContext: true }, sessionCapabilities: { list: {}, close: {} } } }
  })
  app.onRequest(methods.agent.session.new, ({ params, client }) => openingRequest(params, client))
  app.onRequest(methods.agent.session.load, ({ params, client }) => openingRequest(params, client))
  app.onRequest(methods.agent.session.list, async ({ params }) => {
    if (params.cursor) throw invalid('Pagination cursors are unsupported')
    const cwd = params.cwd ?? baseCwd
    if (!isAbsolute(cwd)) throw invalid('cwd must be absolute')
    let canonical: string
    try { canonical = await realpath(cwd) } catch { throw invalid('Workspace does not exist') }
    return { sessions: (await listSessions(canonical)).map(item => ({ sessionId: item.id, cwd: canonical, updatedAt: new Date(item.updatedAt).toISOString() })) }
  })
  app.onRequest(methods.agent.session.setMode, async ({ params }) => {
    const session = get(params.sessionId)
    if (session.busy) throw busy()
    await setMode(session, params.modeId)
    await notifyState(session)
    return {}
  })
  app.onRequest(methods.agent.session.setConfigOption, async ({ params }) => {
    const session = get(params.sessionId)
    if (session.busy) throw busy()
    if (typeof params.value !== 'string') throw invalid('Expected a select option value')
    const settings = await state(session)
    const option = settings.configOptions.find(option => option.id === params.configId)
    if (!option || option.type !== 'select' || !option.options.some(item => 'value' in item && item.value === params.value)) throw invalid('Unknown configuration option or value')
    try {
      if (params.configId === 'mode') await setMode(session, params.value)
      else await session.host.command(`/${params.configId} ${params.value}`)
    } catch (error) { if (error instanceof RequestError) throw error; throw invalid('Unable to apply configuration option') }
    const { configOptions } = await notifyState(session)
    return { configOptions }
  })
  app.onNotification(methods.agent.session.cancel, async ({ params }) => {
    const session = sessions.get(params.sessionId)
    if (!session || session.closing) return
    session.abort.abort()
    await session.host.interrupt()
  })
  app.onRequest(methods.agent.session.close, async ({ params }) => {
    const session = get(params.sessionId)
    await closeSession(session)
    sessions.delete(params.sessionId)
    return {}
  })
  app.onRequest(methods.agent.session.prompt, ({ params, signal }) => {
    const session = get(params.sessionId)
    if (session.busy) throw busy()
    session.busy = true
    session.abort = new AbortController()
    const cancel = () => { session.abort.abort(); void session.host.interrupt().catch(() => {}) }
    signal.addEventListener('abort', cancel, { once: true })
    if (signal.aborted) cancel()
    const work = (async () => {
      try {
        const content = await promptContent(params.prompt, session.host)
        if (session.abort.signal.aborted) return { stopReason: 'cancelled' as const }
        const submission = await session.host.conversation.submit({ type: 'input', content, whenBusy: 'reject' }, session.host.context)
        if (session.abort.signal.aborted) await session.host.interrupt()
        const result = await submission.wait(session.host.context)
        await session.tail
        const view = await session.host.conversation.context(session.host.context)
        for (const entry of view.entries) await session.events.entry(entry)
        if (session.abort.signal.aborted) return { stopReason: 'cancelled' as const }
        if (result.status !== 'done' || result.type !== 'input') throw new RequestError(-32603, 'Agent run did not complete; check model configuration or retry')
        const answer = view.entries.find(entry => entry.id === result.answer)?.model?.find(message => message.role === 'assistant')
        return { stopReason: answer?.role === 'assistant' && answer.stopReason === 'length' ? 'max_tokens' as const : 'end_turn' as const }
      } catch (error) {
        if (session.abort.signal.aborted) return { stopReason: 'cancelled' as const }
        if (error instanceof RequestError) throw error
        throw new RequestError(-32603, 'Agent prompt failed; check model configuration or retry')
      } finally {
        signal.removeEventListener('abort', cancel)
        session.busy = false
        session.pending = undefined
      }
    })()
    session.pending = work
    return work
  })
  const stream = options.stream ?? ndJsonStream(Writable.toWeb(options.output ?? stdout) as WritableStream<Uint8Array>, Readable.toWeb(options.input ?? stdin) as ReadableStream<Uint8Array>)
  const connection = app.connect(stream)
  connectionSignal = connection.signal
  try { await connection.closed }
  finally {
    disconnected = true
    await Promise.allSettled(opening)
    await Promise.allSettled([...sessions.values()].map(closeSession))
    sessions.clear()
  }
}
