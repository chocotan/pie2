import { parseArgs } from 'node:util'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { stdin, stdout, stderr } from 'node:process'
import { AssistantEntry, watchEvents, type ConversationId } from '@earendil-works/pi-durable'
import type { AssistantMessage, Message } from '@earendil-works/pi-ai'
import { clampThinkingLevel } from '@earendil-works/pi-ai/models'
import type { SlashCommand } from '@earendil-works/pi-tui'
import { configureModels } from './models.ts'
import { openHost } from './host.ts'
import { getModelOptions, getThinkingOptions } from './plugins/models.ts'
import { SubagentDoc } from './plugins/subagent.ts'
import type { Plugin } from './plugin.ts'
import type { TerminalUI } from './tui.ts'
import { listSessions, resolveSession } from './sessions.ts'

const help = `pie2 — a plugin-based coding CLI on pi-durable

Usage: pie2 [options] [prompt]
       pie2 install [--prefix <directory>]
       pie2 acp [--cwd <directory>]
      --acp                      Serve ACP v1 over stdin/stdout (same as pie2 acp)
  -p, --print                 Print one final answer and exit
      --json                  Emit committed agent events as JSON lines
      --cwd <directory>       Workspace (default: current directory)
      --session <sqlite>      Open a specific session database
  -r, --resume                Choose a previous session (interactive)
  -c, --continue              Resume the most recent session in this workspace
      --provider <name>       Override the configured default provider
      --model <id>            Override the configured default model
      --list-models           List model IDs without starting a session
      --base-url <url>        OpenAI-compatible Chat Completions endpoint
      --plugin <file>         Load a Plugin or async factory (repeatable)
      --disable-plugin <name> Disable a bundled plugin (repeatable)
      --skill-dir <directory> Additional skill directory (repeatable)
  -h, --help                  Show help

Commands: /model [provider/model], /thinking [level], /goal, /tasks,
          /agents, /jobs, /workflows, /ralph, /plan [on|off|status],
          /skills, /skill:name [request], /plugins, /history,
          /resume [id], /new, /status, /abort [all], /help, /exit
Interactive: / opens commands, Ctrl+P cycles models, Shift+Tab cycles thinking.
             Click a tool row to expand; Ctrl+O expands/collapses all tool rows.
             Ctrl+T opens top activity bar; /agents (or Tab in activity) inspects subagents.
             Escape/Ctrl+C interrupts, Ctrl+D exits an empty editor.
Config: ~/.pie2/config.json, then <cwd>/.pie2/config.json overrides.
        PIE2_CONFIG_DIR changes the user configuration directory.
Credentials: config.json apiKey (literal or $ENV_VAR), or provider environment keys.
`

function assistantText(message: AssistantMessage | undefined): string {
  return message?.content.flatMap(part => part.type === 'text' ? [part.text] : []).join('') ?? ''
}

type AgentRecord = {
  id: number
  description: string
  depth: number
  background?: boolean
  status?: string
  queued?: number
  parked?: number
  result?: string
}

function clipText(value: string, maxChars = 600): string {
  const trimmed = value.trim()
  return trimmed.length > maxChars ? `${trimmed.slice(0, maxChars)}\n…(truncated)` : trimmed
}

function formatAgentMessages(messages: readonly Message[]): string[] {
  const visible = messages.filter(message => message.role !== 'system')
  const tail = visible.slice(-14)
  const lines: string[] = []
  if (visible.length > tail.length) {
    lines.push(`_Showing latest ${tail.length} of ${visible.length} messages._`, '')
  }
  for (const message of tail) {
    if (message.role === 'user') {
      const content = typeof message.content === 'string'
        ? message.content
        : message.content.flatMap(part => part.type === 'text' ? [part.text] : ['[image]']).join('\n')
      lines.push('**User**', clipText(content, 500), '')
      continue
    }
    if (message.role === 'assistant') {
      const textParts: string[] = []
      const toolCalls: string[] = []
      for (const block of message.content) {
        if (block.type === 'text' && block.text.trim()) textParts.push(block.text)
        else if (block.type === 'toolCall') toolCalls.push(`\`${block.name}\``)
      }
      if (textParts.length || toolCalls.length) {
        lines.push('**Assistant**')
        if (textParts.length) lines.push(clipText(textParts.join('\n'), 800))
        if (toolCalls.length) lines.push(`Tools: ${toolCalls.join(', ')}`)
        lines.push('')
      }
      continue
    }
    if (message.role === 'toolResult') {
      const resultText = message.content.flatMap(part => part.type === 'text' ? [part.text] : []).join('\n')
      lines.push(`- Tool \`${message.toolName}\`${message.isError ? ' **(error)**' : ''}: ${clipText(resultText.replace(/\s+/g, ' '), 180)}`)
    }
  }
  return lines
}

async function formatAgentReport(host: Awaited<ReturnType<typeof openHost>>, record: AgentRecord): Promise<string> {
  const cid = record.id as ConversationId
  const [doc, conv] = await Promise.all([
    host.harness.snapshot(SubagentDoc, cid, host.context),
    host.harness.conversation(cid, host.context),
  ])
  const [agentMeta, view] = conv
    ? await Promise.all([conv.agent(host.context), conv.context(host.context)])
    : [undefined, undefined]
  const model = agentMeta?.model ? `\`${agentMeta.model.provider}/${agentMeta.model.modelId}\` (thinking: \`${agentMeta.thinkingLevel}\`)` : '_unknown_'
  const mode = record.background ? 'background' : 'foreground'
  const status = record.status ?? doc?.status ?? 'unknown'
  const lines = [
    `- **Status**: \`${status}\` · **Mode**: \`${mode}\` · **Depth**: \`${record.depth}\``,
    `- **Model**: ${model}`,
    `- **Description**: ${record.description || '_(none)_'}`,
    '',
  ]
  const pending = (doc?.messages ?? []).filter(item => item.state !== 'done')
  if (pending.length) {
    lines.push('### Message Queue', ...pending.map(item => `- \`[${item.state}]\` ${clipText(item.prompt.replace(/\s+/g, ' '), 160)}`), '')
  }
  if (view?.messages.length) {
    lines.push('### Transcript', ...formatAgentMessages(view.messages))
  }
  if (record.result) {
    lines.push('### Result', clipText(record.result, 1200))
  } else if (!view?.messages.length) {
    lines.push('_Waiting for output…_')
  }
  return lines.join('\n')
}

export async function main(argv = process.argv.slice(2)) {
  if (argv[0] === 'install') {
    const { installCommand } = await import('./install.ts')
    return installCommand(argv.slice(1))
  }
  if (argv[0] === 'acp') argv = ['--acp', ...argv.slice(1)]
  let next: string[] | undefined = argv
  while (next) next = await start(next)
}

async function start(argv: string[]): Promise<string[] | undefined> {
  const { values, positionals, tokens } = parseArgs({ args: argv, allowPositionals: true, tokens: true, options: {
    help: { type: 'boolean', short: 'h' }, acp: { type: 'boolean' }, print: { type: 'boolean', short: 'p' }, json: { type: 'boolean' },
    cwd: { type: 'string' }, session: { type: 'string' }, resume: { type: 'boolean', short: 'r' }, continue: { type: 'boolean', short: 'c' },
    provider: { type: 'string' }, model: { type: 'string' },
    'base-url': { type: 'string' }, 'list-models': { type: 'boolean' }, plugin: { type: 'string', multiple: true },
    'disable-plugin': { type: 'string', multiple: true }, 'skill-dir': { type: 'string', multiple: true },
  } })
  if (values.help) { stdout.write(help); return }
  const cwd = resolve(values.cwd ?? process.cwd())
  if (values.acp) {
    if (values.print || values.json || values.session !== undefined || values.resume || values.continue || values['list-models'] || positionals.length) {
      throw new Error('ACP mode accepts protocol requests on stdin; do not combine it with prompts, --print, --json, --session, --resume, --continue or --list-models')
    }
    const { startAcp } = await import('./acp.ts')
    await startAcp({ cwd, provider: values.provider, model: values.model, baseUrl: values['base-url'],
      pluginPaths: values.plugin?.map(file => resolve(file)), disablePlugins: values['disable-plugin'],
      skillDirectories: values['skill-dir']?.map(dir => resolve(dir)),
    })
    return
  }
  if ([values.session !== undefined, values.resume, values.continue].filter(Boolean).length > 1) throw new Error('Use only one of --session, --resume, or --continue')
  let prompt = positionals.join(' ')
  const interactive = !values.print && !values.json && !prompt && Boolean(stdin.isTTY && stdout.isTTY)
  if (values.resume && !interactive) throw new Error('--resume requires an interactive terminal; use --continue or --session <path> in print mode')
  if (!interactive && !prompt && !values['list-models'] && !stdin.isTTY) {
    stdin.setEncoding('utf8')
    for await (const chunk of stdin) prompt += chunk
    prompt = prompt.trim()
  }
  if (!interactive && !prompt && !values['list-models']) throw new Error('Supply a prompt or pipe input. Use --help for usage.')
  const configured = await configureModels({ cwd, provider: values.provider, model: values.model, baseUrl: values['base-url'] })
  if (values['list-models']) {
    const catalogue = configured.models.getModels().map(model => ({
      provider: model.provider, id: model.id, name: model.name, api: model.api,
      reasoning: model.reasoning, contextWindow: model.contextWindow, maxTokens: model.maxTokens,
    }))
    stdout.write(values.json ? `${JSON.stringify(catalogue)}\n` : catalogue.map(model => `${model.provider}/${model.id}\t${model.name}\t${model.api}`).join('\n') + '\n')
    return
  }
  let session = values.session
  const sessionItems = (sessions: Awaited<ReturnType<typeof listSessions>>) => sessions.map(item => ({
    value: item.path, label: new Date(item.updatedAt).toLocaleString(), description: item.id,
  }))
  if (values.continue || values.resume) {
    const sessions = await listSessions(cwd)
    if (!sessions.length) throw new Error('No previous sessions in this workspace. Start pie2 without --resume/--continue to create one.')
    if (values.continue) session = sessions[0]!.path
    else {
      const { TerminalUI } = await import('./tui.ts')
      const picker = new TerminalUI({ cwd, commands: [], onSubmit: async () => {}, onInterrupt: async () => { picker.close() } })
      picker.start()
      try { session = await picker.select('恢复会话', sessionItems(sessions)) }
      finally { picker.stop() }
      if (!session) return
    }
  }
  const plugins: Plugin[] = []
  for (const file of values.plugin ?? []) {
    const { default: exported } = await import(pathToFileURL(resolve(file)).href)
    plugins.push(typeof exported === 'function' ? await exported({ cwd }) : exported)
  }
  let ui: TerminalUI | undefined
  const writeJson = (value: unknown) => stdout.write(`${JSON.stringify(value)}\n`)
  const output = (message: string, error = false) => {
    if (ui) ui.notify(message, error)
    else if (values.json) writeJson({ type: error ? 'error' : 'command', output: message })
    else (error ? stderr : stdout).write(`${message}\n`)
  }
  const host = await openHost({
    cwd, session, ...configured,
    overrideModel: Boolean(values.provider || values.model || values['base-url'] || process.env.PIE2_PROVIDER || process.env.PIE2_MODEL || process.env.PIE2_BASE_URL),
    onReport: message => output(message, true),
    plugins, disablePlugins: values['disable-plugin'], skillDirectories: values['skill-dir']?.map(dir => resolve(dir)),
  })
  let stream: Awaited<ReturnType<typeof watchEvents>> | undefined
  let nextSession: string | null | undefined
  let interrupted = false
  let interruption = Promise.resolve()
  const abort = (all = false) => {
    interrupted = true
    interruption = interruption.then(async () => {
      await host.interrupt({ background: all })
      if (interactive) output(all ? '已中断全部工作，活动目标已暂停。' : '已中断前台工作，活动目标已暂停。')
    })
    return interruption
  }
  const signalAbort = () => {
    if (!interactive) process.exitCode = 130
    void abort().catch(error => output(String(error), true))
  }
  const signalExit = () => {
    process.exitCode = 143
    void abort().catch(error => output(String(error), true)).finally(() => ui?.close())
  }
  process.on('SIGINT', signalAbort)
  process.on('SIGTERM', signalExit)
  const refreshStatus = async () => {
    if (!ui) return
    const agent = await host.conversation.agent(host.context)
    const ref = agent.model
    const model = ref && host.models.getModel(ref.provider, ref.modelId)
    ui.setStatus(ref ? `${ref.provider}/${ref.modelId}` : 'No model', model ? clampThinkingLevel(model, agent.thinkingLevel) : agent.thinkingLevel)
  }
  try {
    const inspectAgent = async (agentId: number, allowBack = false) => {
      if (!ui || !host.commandNames.includes('agents')) return
      while (true) {
        const res = await host.command(`/agents get ${agentId}`)
        const record = JSON.parse(res.output!) as AgentRecord
        const status = record.status ?? 'unknown'
        const active = ['queued', 'pending', 'running', 'waiting', 'sleeping', 'completing'].includes(status)
        const content = await formatAgentReport(host, record)
        const action = await ui.inspect({
          title: `Agent #${record.id}`,
          badge: `[${status}]`,
          content,
          actions: [
            { key: 'r', label: 'Refresh' },
            { key: 'm', label: 'Send msg' },
            ...(active ? [{ key: 'x', label: 'Stop' }] : []),
            ...(allowBack ? [{ key: 'b', label: 'Back' }] : []),
          ],
        })
        if (action === 'r') continue
        if (action === 'm') {
          const message = await ui.prompt(`Send message to Agent #${agentId}`, 'Type follow-up instruction…')
          if (message) {
            const sent = await host.command(`/agents send ${agentId} ${message}`)
            if (sent.output) output(sent.output)
          }
          continue
        }
        if (action === 'x') {
          const stopped = await host.command(`/agents stop ${agentId}`)
          if (stopped.output) output(stopped.output)
          continue
        }
        if (action === 'b' && allowBack) {
          await inspectAgents()
          return
        }
        return
      }
    }
    const inspectAgents = async () => {
      if (!ui) return
      if (!host.commandNames.includes('agents')) {
        output('Subagents plugin is disabled.')
        return
      }
      const listed = await host.command('/agents list')
      if (!listed.output || listed.output === 'No subagents.') {
        await ui.inspect({
          title: 'Subagents',
          badge: '0',
          content: '当前会话暂无子代理（No subagents yet）。\n\n当对话启动子代理后，你可以通过以下方式查看其状态、消息队列、工具调用与完整输出：\n- 在顶部栏点击 `/agents 查看`，或在展开 Activity 面板后点击 `Agent #id` / 按 `Tab`\n- 直接在输入框运行 `/agents` 或 `/agents get <id>`',
        })
        return
      }
      const records = JSON.parse(listed.output) as AgentRecord[]
      const items = records.map(item => ({
        value: String(item.id),
        label: `#${item.id} [${item.status ?? 'unknown'}] ${item.description || '(no description)'}`,
        description: `${item.background ? 'background' : 'foreground'}${item.queued ? ` · queued ${item.queued}` : ''}${item.parked ? ` (parked ${item.parked})` : ''}`,
      }))
      const selected = await ui.select('Subagents · 选择查看详情', items)
      if (!selected) return
      await inspectAgent(Number(selected), true)
    }
    const run = async (input: string) => {
      input = input.trim()
      if (input === '/exit' || input === '/quit') { ui?.close(); return }
      if (input === '/help') { output(help); return }
      if (input === '/plugins') { output(host.plugins.map(plugin => plugin.name).join(', ')); return }
      if (input === '/abort' || input === '/abort all') { await abort(input === '/abort all'); return }
      if (input === '/new') {
        if (!ui) throw new Error('/new is interactive; start pie2 without --session to create a new session')
        nextSession = null
        ui.close()
        return
      }
      if (input === '/resume' || input.startsWith('/resume ')) {
        const reference = input.slice('/resume'.length).trim()
        const sessions = (await listSessions(cwd)).filter(item => item.path !== host.session)
        if (!sessions.length && !reference) { output('没有其他可恢复的会话。'); return }
        if (!ui) { output(sessions.map(item => `${item.id}\t${item.path}`).join('\n')); return }
        const selected = reference ? await resolveSession(cwd, reference) : await ui.select('恢复会话', sessionItems(sessions))
        if (reference && !selected) throw new Error('Unknown session. Use /resume to choose a session.')
        if (selected && selected !== host.session) { nextSession = selected; ui.close() }
        return
      }
      if (input === '/history') {
        const view = await host.conversation.context(host.context)
        if (values.json) writeJson({ type: 'history', messages: view.messages })
        else output(JSON.stringify(view.messages.filter(message => message.role !== 'system'), null, 2))
        return
      }
      if (ui && host.commandNames.includes('agents')) {
        if (input === '/agents' || input === '/agents list') {
          await inspectAgents()
          return
        }
        const getAgent = /^\/agents\s+get\s+([1-9]\d*)$/.exec(input)
        if (getAgent) {
          await inspectAgent(Number(getAgent[1]), true)
          return
        }
      }
      if (ui && (input === '/model' || input === '/thinking')) {
        const agent = await host.conversation.agent(host.context)
        const ref = agent.model
        const model = ref && host.models.getModel(ref.provider, ref.modelId)
        const items = input === '/model' ? await getModelOptions(host.models) : await getThinkingOptions(host.models, host.conversation, host.context)
        const current = input === '/model' ? (ref ? `${ref.provider}/${ref.modelId}` : undefined) : model ? clampThinkingLevel(model, agent.thinkingLevel) : agent.thinkingLevel
        const selected = await ui.select(input === '/model' ? '选择模型' : '选择 Thinking Level', items, current)
        if (!selected) return
        input += ` ${selected}`
      }
      const result = await host.command(input)
      if (result.output) output(result.output)
      await refreshStatus()
      if (!result.prompt) return
      interrupted = false
      const submission = await host.conversation.submit({ type: 'input', content: result.prompt, whenBusy: 'steer' }, host.context)
      const settled = await submission.wait(host.context)
      if (settled.status !== 'done' || settled.type !== 'input') {
        if (!interrupted) throw new Error(`Run ${settled.status}${'reason' in settled ? `: ${settled.reason}` : ''}${'detail' in settled && settled.detail ? ` (${settled.detail})` : ''}`)
        return
      }
      if (!interactive && !values.json) {
        const entry = await host.conversation.commit(tx => tx.entry(AssistantEntry, settled.answer), host.context)
        stdout.write(`${assistantText(entry?.model?.[0] as AssistantMessage | undefined)}\n`)
      }
    }
    if (!interactive) {
      if (values.json) {
        stream = await watchEvents(host.harness, host.conversation.id, host.context)
        writeJson(stream.snapshot)
        stream.start(async events => { for (const event of events) writeJson(event) })
      }
      await run(prompt)
      return
    }
    const descriptions: Record<string, string> = {
      help: '显示帮助', status: '当前会话与用量', model: '切换模型', thinking: '调整思考强度', goal: '管理目标', tasks: '查看和更新任务',
      agents: '查看和停止子代理', jobs: '查看和停止后台任务', workflows: '查看工作流及阶段', ralph: '查看逐轮迭代记录', plan: '规划模式与计划审阅', skills: '列出可用技能', skill: '调用技能', plugins: '查看插件',
      history: '查看会话历史', resume: '选择并恢复历史会话', new: '开始新会话', abort: '中断当前工作', exit: '退出',
    }
    const core = ['help', 'plugins', 'history', 'resume', 'new', 'abort', 'exit']
    const commands: SlashCommand[] = [...new Set([...core, ...host.commandNames])].map(name => ({ name, description: descriptions[name] ?? `运行 /${name}` }))
    for (const command of commands) {
      if (command.name === 'model' || command.name === 'thinking') command.getArgumentCompletions = async prefix => {
        const choices = command.name === 'model' ? await getModelOptions(host.models) : await getThinkingOptions(host.models, host.conversation, host.context)
        return choices.filter(item => `${item.value} ${item.label}`.toLowerCase().includes(prefix.toLowerCase()))
      }
    }
    const pending = new Set<Promise<void>>()
    const submit = async (input: string) => {
      const work = run(input).catch(error => output(`Error: ${error instanceof Error ? error.message : String(error)}`, true)).then(() => { pending.delete(work) })
      pending.add(work)
      await work
    }
    const cycle = async (kind: 'model' | 'thinking') => {
      const items = kind === 'model' ? await getModelOptions(host.models) : await getThinkingOptions(host.models, host.conversation, host.context)
      if (!items.length) { output('没有可用选项。'); return }
      const agent = await host.conversation.agent(host.context)
      const ref = agent.model
      const model = ref && host.models.getModel(ref.provider, ref.modelId)
      const current = kind === 'model' ? (ref ? `${ref.provider}/${ref.modelId}` : '') : model ? clampThinkingLevel(model, agent.thinkingLevel) : agent.thinkingLevel
      const next = items[(items.findIndex(item => item.value === current) + 1) % items.length]!
      await submit(`/${kind} ${next.value}`)
    }
    const { TerminalUI } = await import('./tui.ts')
    ui = new TerminalUI({
      cwd,
      commands,
      statusBar: host.statusBar,
      onSubmit: submit,
      onInterrupt: abort,
      onCycleModel: () => cycle('model'),
      onCycleThinking: () => cycle('thinking'),
      onInspectAgents: inspectAgents,
      onInspectAgent: id => inspectAgent(id, true),
    })
    host.interaction.attach((questions, context) => ui!.askUser(questions, context))
    stream = await watchEvents(host.harness, host.conversation.id, host.context)
    ui.showSnapshot(stream.snapshot)
    stream.start(async events => {
      for (const event of events) ui!.showEvent(event)
      if (events.some(event => event.type === 'agent_changed')) await refreshStatus()
    })
    await refreshStatus()
    ui.start()
    host.harness.resume()
    await ui.closed
    await abort()
    await Promise.allSettled(pending)
  } finally {
    process.off('SIGINT', signalAbort)
    process.off('SIGTERM', signalExit)
    try {
      await interruption
      await stream?.stop()
    } finally {
      host.interaction.attach(undefined)
      ui?.stop()
      await host.close()
    }
  }
  if (nextSession !== undefined) {
    const remove = new Set<number>()
    for (const token of tokens) {
      if (token.kind !== 'option' || !['session', 'resume', 'continue'].includes(token.name)) continue
      remove.add(token.index)
      if (token.name === 'session' && !token.inlineValue) remove.add(token.index + 1)
    }
    const next = argv.filter((_value, index) => !remove.has(index))
    return nextSession === null ? next : [...next, '--session', nextSession]
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { stderr.write(`Error: ${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1 })
}
