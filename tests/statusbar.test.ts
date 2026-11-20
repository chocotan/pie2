import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import type { AssistantMessage, Usage } from '@earendil-works/pi-ai'
import { createModels } from '@earendil-works/pi-ai/models'
import { fauxProvider } from '@earendil-works/pi-ai/providers/faux'
import {
  AssistantEntry, CompactionEntry, ResetEntry, ROOT_CONVERSATION_ID, UsageDoc, createRegistry, Harness, MemoryStorage,
  type EntryRecord, type SnapshotEvent, type TaskId, type UsageState,
} from '@earendil-works/pi-durable'
import { visibleWidth } from '@earendil-works/pi-tui'
import { createStatusBarPlugin } from '../src/plugins/statusbar.ts'
import { createTasksPlugin, TodoDoc } from '../src/plugins/tasks.ts'
import { createGoalPlugin, GoalDoc } from '../src/plugins/goal.ts'
import { createBackgroundPlugin, BackgroundDoc, type BackgroundJob } from '../src/plugins/background.ts'

const context = BACKGROUND_CONTEXT
const session = '/tmp/sessions/2026-06-24T00-00-00-000Z_11111111-2222-3333-4444-0123456789ab.sqlite'
const usage = (input = 0, output = 0, cacheRead = 0, cacheWrite = 0): Usage => ({
  input, output, cacheRead, cacheWrite, totalTokens: input + output + cacheRead + cacheWrite,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
})
const ledger = (value = usage()): UsageState => ({ models: { 'test/one': value }, tools: {} })
const agent = { model: { provider: 'test', modelId: 'one' }, thinkingLevel: 'high' as const }
const snapshot = (overrides: Partial<SnapshotEvent> = {}): SnapshotEvent => ({
  type: 'snapshot', agent, entries: [], usage: ledger(), tools: [], nestedTools: [], compactions: [], inbox: [], ...overrides,
})
const assistant = (value: Usage, model = 'one'): AssistantMessage => ({
  role: 'assistant', api: 'test', provider: 'test', model, timestamp: 0, stopReason: 'stop', content: [], usage: value,
})
const entry = (id: number, value: Usage, model = 'one'): EntryRecord => ({
  id: id as EntryRecord['id'], conversationId: ROOT_CONVERSATION_ID, kind: AssistantEntry.kind, model: [assistant(value, model)],
})
function models() {
  const models = createModels()
  models.setProvider(fauxProvider({ provider: 'test', models: [
    { id: 'one', reasoning: true, contextWindow: 10_000 }, { id: 'two', reasoning: true, contextWindow: 20_000 },
  ] }).provider)
  return models
}
async function open(cwd = tmpdir()) {
  const plugin = await createStatusBarPlugin({ cwd, session, models: models() })
  const bar = plugin.statusBar!
  const render = (width = 1_000) => bar.render(width).join('\n')
  return { plugin, bar, render }
}

test('statusBar is a native empty extension and preserves the footer prefix and short session ID', async () => {
  const { plugin, bar, render } = await open()
  assert.equal(plugin.name, 'statusBar')
  assert.equal(plugin.extension.name, 'statusBar')
  assert.equal(plugin.extension.tools?.length ?? 0, 0)
  bar.snapshot(snapshot())
  assert.match(render(), /^test\/one · thinking high · ready · #456789ab · ↑0 ↓0/)
  assert.doesNotMatch(render(), /cache|ctx|queued/)
  bar.setModel('test/two', 'low')
  assert.match(render(), /^test\/two · thinking low · ready/)
})

test('usage_changed replaces model and tool totals while streaming usage never accumulates', async () => {
  const { bar, render } = await open()
  const state: UsageState = { models: { 'test/one': usage(100, 20, 700, 200), 'test/two': usage(20, 5) }, tools: { Agent: usage(30, 15) } }
  bar.snapshot(snapshot({ usage: state }))
  assert.match(render(), /↑150 ↓40/)
  assert.match(render(), /cache 67%/)
  for (let i = 0; i < 3; i++) {
    bar.update({ type: 'message_update', usage: usage(9_999, 9_999), changes: [] })
    bar.update({ type: 'usage_changed', usage: state })
  }
  assert.match(render(), /↑150 ↓40/)
  assert.match(render(), /cache 67%/)
  assert.doesNotMatch(render(), /ctx/)
  bar.update({ type: 'usage_changed', usage: ledger(usage(200, 50)) })
  assert.match(render(), /↑200 ↓50/)
  assert.match(render(), /cache 0%/)
  bar.update({ type: 'usage_changed', usage: ledger(usage(0, 50)) })
  assert.doesNotMatch(render(), /cache/)
})

test('context uses the latest completed request with disjoint cache tokens, not session totals or partials', async () => {
  const { bar, render } = await open()
  const latest = entry(2, usage(200, 100, 500, 200))
  bar.snapshot(snapshot({ usage: ledger(usage(100_000, 20_000)), entries: [entry(1, usage(2_000, 500)), latest] }))
  assert.match(render(), /~10% ctx/)
  bar.update({ type: 'message_update', usage: usage(8_000, 1_000), changes: [] })
  assert.match(render(), /~10% ctx/)
  bar.update({ type: 'message_end', entry: latest })
  assert.match(render(), /~10% ctx/)
  bar.update({ type: 'message_end', entry: entry(3, usage(1_500, 500)) })
  assert.match(render(), /~20% ctx/)
})

test('unknown request usage and model changes hide stale context; changing only thinking preserves it', async () => {
  const { bar, render } = await open()
  bar.snapshot(snapshot({ entries: [entry(1, usage(900, 100))] }))
  bar.setModel('test/one', 'low')
  assert.match(render(), /~10% ctx/)
  bar.update({ type: 'agent_changed', agent: { ...agent, model: { provider: 'test', modelId: 'two' } } })
  assert.doesNotMatch(render(), /ctx/)
  bar.update({ type: 'message_end', entry: entry(2, usage(900, 100)) })
  assert.doesNotMatch(render(), /ctx/)
  bar.update({ type: 'message_end', entry: entry(3, usage(900, 100), 'two') })
  assert.match(render(), /~5% ctx/)
  bar.update({ type: 'message_end', entry: entry(4, usage(), 'two') })
  assert.doesNotMatch(render(), /ctx/)
  bar.snapshot(snapshot({ entries: [entry(1, usage(0, 500))] }))
  assert.doesNotMatch(render(), /ctx/)
  bar.snapshot(snapshot({ entries: [entry(1, usage(Number.NaN, 100))] }))
  assert.doesNotMatch(render(), /ctx/)
  bar.snapshot(snapshot({ agent: { model: { provider: 'absent', modelId: 'unknown' } }, entries: [entry(1, usage(900, 100))] }))
  assert.doesNotMatch(render(), /ctx/)
})

test('reset and compaction boundaries invalidate earlier request context in events and restored snapshots', async () => {
  const { bar, render } = await open()
  const old = entry(1, usage(900, 100))
  const reset: EntryRecord = { id: 3 as EntryRecord['id'], conversationId: ROOT_CONVERSATION_ID, kind: ResetEntry.kind, head: 3 as EntryRecord['id'] }
  bar.snapshot(snapshot({ entries: [old] }))
  bar.update({ type: 'entry_appended', entry: reset })
  assert.doesNotMatch(render(), /ctx/)
  bar.snapshot(snapshot({ entries: [reset, old] }))
  assert.doesNotMatch(render(), /ctx/)
  const summary: EntryRecord = { ...reset, kind: CompactionEntry.kind, head: old.id }
  bar.snapshot(snapshot({ entries: [summary, old] }))
  assert.doesNotMatch(render(), /ctx/)
  bar.snapshot(snapshot({ entries: [summary, old, entry(4, usage(1_500, 500))] }))
  assert.match(render(), /~20% ctx/)
  const taskId = 5 as TaskId
  bar.update({ type: 'compaction_start', taskId, reason: 'threshold', blocking: true })
  assert.match(render(), /thinking high · working · compacting/)
  assert.doesNotMatch(render(), /ctx/)
  bar.update({ type: 'message_end', entry: entry(6, usage(900, 100)) })
  assert.doesNotMatch(render(), /ctx/)
  bar.update({ type: 'compaction_end', taskId, reason: 'threshold' })
  assert.match(render(), /thinking high · ready/)
  assert.doesNotMatch(render(), /ctx/)
  bar.update({ type: 'message_end', entry: entry(7, usage(900, 100)) })
  assert.match(render(), /~10% ctx/)
})

test('run state and queue count restore from snapshots and follow committed events', async () => {
  const { bar, render } = await open()
  const items: SnapshotEvent['inbox'] = [{ id: 1 as SnapshotEvent['inbox'][number]['id'], mode: 'steer' }]
  bar.snapshot(snapshot({ inbox: items }))
  assert.doesNotMatch(render(), /queued/)
  bar.update({ type: 'run_start', inputs: [] })
  assert.match(render(), /thinking high · working · 1 queued/)
  bar.update({ type: 'inbox_update', items: [...items, ...items] })
  assert.match(render(), /2 queued/)
  bar.update({ type: 'run_end', inputs: [] })
  assert.match(render(), /thinking high · ready/)
  assert.doesNotMatch(render(), /queued/)
  bar.snapshot(snapshot({ run: { inputs: [] }, inbox: items }))
  assert.match(render(), /thinking high · working · 1 queued/)
  bar.update({ type: 'inbox_update', items: [] })
  assert.doesNotMatch(render(), /queued/)
  bar.update(snapshot())
  assert.match(render(), /thinking high · ready/)
})

test('footer remains one terminal-width-safe line for CJK names, narrow terminals and control characters', async () => {
  const { bar, render } = await open('/tmp/项目\nworkspace')
  bar.setModel('供应商/中文模型', 'high')
  for (const width of [0, 1, 2, 5, 20, 40, 80, 160]) {
    const lines = bar.render(width)
    assert.equal(lines.length, 1)
    assert.ok(visibleWidth(lines[0]!) <= width, `${width}: ${lines[0]}`)
    assert.doesNotMatch(lines[0]!, /[\n\r\u001b]/)
  }
  assert.match(render(), /供应商\/中文模型/)
  assert.equal(render(0), '')
})

test('home directory is abbreviated and Git branch is read once without a running Git process', async t => {
  const home = await open(homedir())
  assert.match(home.render(), / · ~(?: \([^)]*\))?$/)
  const cwd = await mkdtemp(join(tmpdir(), 'pie2-statusbar-'))
  t.after(() => rm(cwd, { recursive: true, force: true }))
  const git = (...args: string[]) => promisify(execFile)('git', args, { cwd })
  await git('init', '--initial-branch=status-test')
  const { bar, render } = await open(cwd)
  assert.match(render(), /\(status-test\)$/)
  await git('symbolic-ref', 'HEAD', 'refs/heads/changed')
  bar.render(1_000)
  assert.match(render(), /\(status-test\)$/)
})

test('/status reads the actual root snapshot in MemoryStorage and documents usage without leaking model metadata', async t => {
  const available = models()
  const plugin = await createStatusBarPlugin({ cwd: tmpdir(), session, models: available })
  const registry = createRegistry()
  registry.install(plugin.extension)
  const harness = await Harness.open(new MemoryStorage(), { models: available, registry }, context)
  t.after(() => harness.close(context))
  const conversation = await harness.root(context)
  await conversation.configure(agent, context)
  await conversation.commit(async tx => {
    await tx.appendEntry(AssistantEntry, conversation.id, { model: [assistant(usage(200, 100, 500, 200))] })
    const state = await tx.doc(UsageDoc, conversation.id)
    state.models['test/one'] = usage(2_000, 1_000, 5_000, 2_000)
    state.tools.Agent = usage(100, 50)
  }, context)
  const command = () => plugin.commands!.status!('', { harness, conversation, context })
  const first = (await command()).output!
  assert.match(first, new RegExp(`Session: ${session}`))
  assert.match(first, /Model: test\/one\nThinking: high\nState: ready/)
  assert.match(first, /input 2100, output 1050, cache read 5000, cache write 2000/)
  assert.match(first, /Cache hit: 55%/)
  assert.match(first, /Context: ~10% \(1000 \/ 10000 tokens\)/)
  assert.match(first, /excludes later tool output/)
  assert.match(first, /Input is uncached/)
  assert.doesNotMatch(first, /apiKey|headers|baseUrl|cost/)
  assert.equal((await command()).output, first)
  await conversation.reset(undefined, context)
  assert.match((await command()).output!, /Context: unknown/)
})

test('activity summarises todo, goal and jobs separately from the single-line footer', async t => {
  const available = models()
  const registry = createRegistry()
  let harness!: Harness
  registry.install(createTasksPlugin(() => harness).extension)
  registry.install(createGoalPlugin(() => harness).extension)
  registry.install(createBackgroundPlugin(() => harness).extension)
  harness = await Harness.open(new MemoryStorage(), { models: available, registry }, context)
  t.after(() => harness.close(context))
  const root = await harness.root(context)
  await harness.commit(async tx => {
    ;(await tx.doc(TodoDoc, root.id)).todos = [
      { content: 'Implement parser', status: 'in_progress' }, { content: 'Test parser', status: 'completed' },
    ]
    ;(await tx.doc(GoalDoc, root.id)).goal = {
      id: 'goal-1', revision: 1, objective: 'Ship the parser', phase: 'active',
      maxGoalRounds: 5, roundsStarted: 2, createdAt: 0, updatedAt: 0,
    }
    ;(await tx.doc(BackgroundDoc, root.id)).jobs = [{
      id: 1 as BackgroundJob['id'], command: 'sleep 5', description: 'Wait', timeout: null, workdir: null,
      status: 'running', createdAt: 0, startedAt: 0, finishedAt: null, exitCode: null, output: '',
      outputBytes: 0, cursor: 0, truncated: false, error: null, reported: false, delivery: null,
    }]
  }, context)
  const plugin = await createStatusBarPlugin({ cwd: tmpdir(), session, models: available, getHarness: () => harness })
  const bar = plugin.statusBar!
  bar.snapshot(snapshot())
  await bar.refreshActivity!()
  const activity = bar.activity!()
  assert.match(activity.summary, /Todo 1\/2/)
  assert.match(activity.summary, /Goal active 2\/5/)
  assert.ok(activity.lines.includes('Goal [active] 2/5 Ship the parser'))
  assert.match(activity.summary, /Jobs 1\/1 active/)
  assert.match(activity.summary, /Agents 0/)
  assert.ok(activity.lines.includes('Todo [in_progress] Implement parser'))
  assert.equal(bar.render(1_000).length, 1)
  assert.doesNotMatch(bar.render(1_000)[0]!, /Todo|Goal|Agents|Jobs/)
})
