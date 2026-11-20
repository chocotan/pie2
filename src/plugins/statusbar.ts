import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import { basename, resolve } from 'node:path'
import { promisify } from 'node:util'
import type { Usage } from '@earendil-works/pi-ai'
import { clampThinkingLevel, type Models } from '@earendil-works/pi-ai/models'
import {
  CompactionEntry, ResetEntry, defineExtension, watchEvents,
  type AgentEvent, type AgentState, type EntryRecord, type SnapshotEvent, type TaskId, type UsageState,
} from '@earendil-works/pi-durable'
import { stripTerminalSequences, truncateToWidth, visibleWidth } from '@earendil-works/pi-tui'
import type { Harness } from '@earendil-works/pi-durable'
import type { Plugin, StatusBar } from '../plugin.ts'
import { createActivityProjection } from '../activity.ts'

type Tokens = Pick<Usage, 'input' | 'output' | 'cacheRead' | 'cacheWrite'>
const emptyTokens = (): Tokens => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })
const singleLine = (text: string) => stripTerminalSequences(text).replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
const compact = (value: number) => value >= 1_000_000 ? `${+(value / 1_000_000).toFixed(1)}m` : value >= 1_000 ? `${+(value / 1_000).toFixed(1)}k` : String(value)
const cacheRate = (tokens: Tokens) => {
  const input = tokens.input + tokens.cacheRead + tokens.cacheWrite
  return input > 0 ? Math.round(tokens.cacheRead / input * 100) : undefined
}

function nativeUsageState(usage: UsageState): Tokens {
  const totals = emptyTokens()
  for (const value of [...Object.values(usage.models), ...Object.values(usage.tools)]) {
    totals.input += value.input
    totals.output += value.output
    totals.cacheRead += value.cacheRead
    totals.cacheWrite += value.cacheWrite
  }
  return totals
}

function assistantUsage(entry: EntryRecord, model: string): number | undefined {
  const message = entry.model?.[0]
  if (message?.role !== 'assistant' || `${message.provider}/${message.model}` !== model) return
  const { input, output, cacheRead, cacheWrite } = message.usage
  if (![input, output, cacheRead, cacheWrite].every(value => Number.isFinite(value) && value >= 0)) return
  if (input + cacheRead + cacheWrite <= 0) return
  return input + cacheRead + cacheWrite + output
}

export async function createStatusBarPlugin({ cwd, session, models, getHarness }: { cwd: string; session: string; models: Models; getHarness?: () => Harness }): Promise<Plugin> {
  cwd = resolve(cwd)
  session = resolve(session)
  const home = homedir()
  const directory = cwd === home ? '~' : cwd.startsWith(`${home}/`) ? `~${cwd.slice(home.length)}` : cwd
  const shortId = basename(session).replace(/\.[^.]+$/, '').slice(-8)
  let branch = ''
  try {
    // shortcut: branch is read at startup, refresh it if live Git status is added.
    const result = await promisify(execFile)('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], { cwd, timeout: 1_000, maxBuffer: 4_096, encoding: 'utf8' })
    branch = result.stdout.trim()
  } catch { /* Not a Git worktree, detached HEAD, or Git unavailable. */ }
  let model = 'No model'
  let thinking = 'off'
  let working = false
  let queued = 0
  let totals = emptyTokens()
  let contextTokens: number | undefined
  const activity = createActivityProjection(getHarness)
  const compactions = new Set<TaskId>()
  const phase = () => compactions.size ? 'compacting' : working ? 'working' : 'ready'
  const contextWindow = () => {
    const slash = model.indexOf('/')
    return slash < 0 ? undefined : models.getModel(model.slice(0, slash), model.slice(slash + 1))?.contextWindow
  }
  const contextPercent = () => {
    const window = contextWindow()
    return contextTokens !== undefined && window && window > 0 ? Math.round(contextTokens / window * 100) : undefined
  }
  const setModel = (value: string, level: string) => {
    if (model !== value) contextTokens = undefined
    model = value
    thinking = level
  }
  const setAgent = (agent: AgentState) => {
    const ref = agent.model
    const selected = ref && models.getModel(ref.provider, ref.modelId)
    setModel(ref ? `${ref.provider}/${ref.modelId}` : 'No model', selected ? clampThinkingLevel(selected, agent.thinkingLevel ?? 'off') : agent.thinkingLevel ?? 'off')
  }
  const recordEntry = (entry: EntryRecord) => {
    if (ResetEntry.is(entry) || CompactionEntry.is(entry) || entry.head !== undefined || entry.edits?.length) contextTokens = undefined
    else if (entry.model?.[0]?.role === 'assistant') contextTokens = compactions.size ? undefined : assistantUsage(entry, model)
  }
  const statusBar: StatusBar = {
    setModel,
    activity: activity.activity,
    refreshActivity: activity.refreshActivity,
    setRenderHook: activity.setRenderHook,
    snapshot(snapshot: SnapshotEvent) {
      setAgent(snapshot.agent)
      totals = nativeUsageState(snapshot.usage)
      working = snapshot.run !== undefined
      queued = snapshot.inbox.length
      compactions.clear()
      for (const compaction of snapshot.compactions) compactions.add(compaction.taskId)
      contextTokens = undefined
      activity.start()
      const boundary = snapshot.entries.reduce((latest, entry) => entry.head !== undefined || ResetEntry.is(entry) || CompactionEntry.is(entry) || entry.edits?.length ? Math.max(latest, entry.id) : latest, 0)
      for (const entry of snapshot.entries) if (entry.id > boundary) recordEntry(entry)
    },
    update(event: AgentEvent) {
      activity.start()
      switch (event.type) {
        case 'snapshot': statusBar.snapshot(event); break
        case 'usage_changed': totals = nativeUsageState(event.usage); break
        case 'agent_changed': setAgent(event.agent); break
        case 'run_start': working = true; break
        case 'run_end': working = false; break
        case 'inbox_update': queued = event.items.length; break
        case 'message_end':
        case 'entry_appended': recordEntry(event.entry); break
        case 'compaction_start': compactions.add(event.taskId); contextTokens = undefined; break
        case 'compaction_end': compactions.delete(event.taskId); contextTokens = undefined; break
      }
    },
    render(width: number) {
      if (width <= 0) return ['']
      const percent = contextPercent()
      const cache = cacheRate(totals)
      let line = singleLine(`${model} · thinking ${thinking} · ${phase() === 'ready' ? 'ready' : 'working'}`)
      const fields = [
        ...(compactions.size ? ['compacting'] : []),
        ...(working && queued ? [`${queued} queued`] : []),
        `#${shortId}`, `↑${compact(totals.input)} ↓${compact(totals.output)}`,
        ...(cache === undefined ? [] : [`cache ${cache}%`]),
        ...(percent === undefined ? [] : [`~${percent}% ctx`]),
        `${directory}${branch ? ` (${branch})` : ''}`,
      ]
      for (const field of fields) {
        const next = `${line} · ${singleLine(field)}`
        if (visibleWidth(next) <= width) line = next
      }
      return [stripTerminalSequences(truncateToWidth(line, width, ''))]
    },
  }
  return {
    name: 'statusBar',
    extension: defineExtension({ name: 'statusBar' }),
    statusBar,
    commands: {
      status: async (_args, { harness, conversation, context }) => {
        const stream = await watchEvents(harness, conversation.id, context)
        try { statusBar.snapshot(stream.snapshot) }
        finally { await stream.stop() }
        const percent = contextPercent()
        const cache = cacheRate(totals)
        return { output: [
          `Session: ${session}`, `Directory: ${cwd}${branch ? ` (${branch})` : ''}`,
          `Model: ${model}`, `Thinking: ${thinking}`, `State: ${phase()}`, `Queued: ${queued}`,
          `Tokens (session): input ${totals.input}, output ${totals.output}, cache read ${totals.cacheRead}, cache write ${totals.cacheWrite}`,
          'Input is uncached; totals include native model and tool usage, not streaming partials.',
          `Cache hit: ${cache === undefined ? 'unknown' : `${cache}%`} (cache read / (input + cache read + cache write))`,
          `Context: ${percent === undefined ? 'unknown' : `~${percent}% (${contextTokens} / ${contextWindow()} tokens)`}`,
          'Context estimates the latest completed request (input + cache read + cache write + output); excludes later tool output.',
        ].map(singleLine).join('\n') }
      },
    },
  }
}
