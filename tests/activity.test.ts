import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { createModels } from '@earendil-works/pi-ai/models'
import { fauxProvider } from '@earendil-works/pi-ai/providers/faux'
import {
  createRegistry, defineExtension, defineTask, Harness, MemoryStorage, ROOT_CONVERSATION_ID,
  type TaskId,
} from '@earendil-works/pi-durable'
import { createActivityProjection } from '../src/activity.ts'
import { BackgroundDoc, type BackgroundJob } from '../src/plugins/background.ts'
import { GoalDoc } from '../src/plugins/goal.ts'
import { SubagentDoc } from '../src/plugins/subagent.ts'
import { TodoDoc } from '../src/plugins/tasks.ts'
import { PlanDoc } from '../src/plugins/plan.ts'
import { WorkflowDoc } from '../src/plugins/workflow.ts'
import { RalphDoc } from '../src/plugins/ralph.ts'

const context = BACKGROUND_CONTEXT
const root = ROOT_CONVERSATION_ID
const Owner = defineTask<null, { phase: 'done' }, null>({
  name: 'activity-test-owner', version: 1, initial: () => ({ phase: 'done' }),
  phases: { done: (_task, runtime, ctx) => runtime.commit(() => ({ status: 'terminal', outcome: { status: 'failed', error: { message: 'Owner failed' } } }), ctx) },
  abort: (_task, runtime, ctx) => runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), ctx),
})
async function setup(t: TestContext) {
  const faux = fauxProvider()
  const models = createModels()
  models.setProvider(faux.provider)
  const registry = createRegistry()
  registry.install(defineExtension({ name: 'activity-fixture', tasks: [Owner] }))
  const storage = new MemoryStorage()
  const harness = await Harness.open(storage, { registry, models }, context)
  await harness.root(context)
  t.after(() => harness.close(context))
  const projection = createActivityProjection(() => harness)
  return { harness, projection, storage, faux }
}
function job(id: number, overrides: Partial<BackgroundJob> = {}): BackgroundJob {
  return {
    id: id as TaskId, command: 'private command', description: `Work ${id}`, timeout: null, workdir: null,
    status: 'running', createdAt: 0, startedAt: 0, finishedAt: null, exitCode: null, output: 'private output',
    outputBytes: 0, cursor: 0, truncated: false, error: null, reported: false, delivery: null, ...overrides,
  }
}
function goal(phase: 'active' | 'paused' | 'blocked' | 'complete' = 'active') {
  return { id: 'goal-1', revision: 2, objective: 'Ship the feature', phase, maxGoalRounds: 7, roundsStarted: 3, createdAt: 0, updatedAt: 0 }
}
function nextRender(projection: ReturnType<typeof createActivityProjection>) {
  let done!: () => void
  let fail!: (error: Error) => void
  const rendered = new Promise<void>((resolve, reject) => { done = resolve; fail = reject })
  const timer = setTimeout(() => fail(new Error('Activity did not refresh after a native commit')), 4_000)
  projection.setRenderHook(done)
  return rendered.finally(() => clearTimeout(timer))
}

test('empty activity remains discoverable and never creates disabled-domain documents', async t => {
  const { harness, projection, storage, faux } = await setup(t)
  const child = await harness.commit(async tx => {
    const owner = await tx.createTask(Owner, null, { conversationId: root, ownership: { kind: 'conversation' }, background: true })
    return tx.createConversation({ ownership: { kind: 'task', taskId: owner } })
  }, context)
  await projection.refreshActivity()
  assert.equal(projection.activity().summary, 'Todo 0 · Goal — · Agents 0 · Jobs 0')
  assert.deepEqual(projection.activity().lines, ['Todo: no tasks', 'Goal: no goal', 'Agents: no subagents', 'Jobs: no background jobs'])
  const docs = await storage.scanDocuments({ scope: { kind: 'conversation', conversationId: root }, at: 'current' }, 100, undefined, context)
  assert.ok(!docs.items.some(doc => ['pie2.todos', 'pie2.goal', 'pie2.background', 'pie2.subagent'].includes(doc.kind)))
  assert.equal(await harness.snapshot(TodoDoc, root, context), undefined)
  assert.equal(await harness.snapshot(GoalDoc, root, context), undefined)
  assert.equal(await harness.snapshot(BackgroundDoc, root, context), undefined)
  assert.equal(await harness.snapshot(SubagentDoc, child.id, context), undefined)
  assert.equal(faux.state.callCount, 0)
})

test('plan and workflow activity refreshes from commits without double-counting Ralph as another workflow', async t => {
  const { harness, projection } = await setup(t)
  await projection.refreshActivity()
  const changed = nextRender(projection)
  await harness.commit(async tx => {
    Object.assign(await tx.doc(PlanDoc, root), { mode: 'plan', revision: 1, updatedAt: 1 })
    ;(await tx.doc(WorkflowDoc, root)).runs = [
      { id: '21', name: 'audit', description: 'Review modules', status: 'running', startedAt: 0, phase: 'verify', logs: [], agents: [{ seq: 1, label: 'Review parser', status: 'completed' }] },
      { id: '22', name: 'ralph', description: 'Fresh iterations', status: 'running', startedAt: 0, phase: 'round 2', logs: [], agents: [{ seq: 1, label: 'Round 1', status: 'completed' }, { seq: 2, label: 'Round 2', status: 'running' }] },
    ]
    ;(await tx.doc(RalphDoc, root)).runs = [{ id: '22', objective: 'Fix and verify', maxRounds: 4, status: 'running' }]
  }, context)
  await changed
  const value = projection.activity()
  assert.match(value.summary, /Plan read-only/)
  assert.match(value.summary, /Workflows 1\/1/)
  assert.match(value.summary, /Ralph 1\/1/)
  assert.match(value.lines.join('\n'), /Workflow #21.*verify/)
  assert.match(value.lines.join('\n'), /Ralph #22.*2\/4.*Fix and verify/)
  assert.doesNotMatch(value.lines.join('\n'), /Workflow #22/)
})

test('first projection restores complete Todo, paused Goal, real agents and terminal jobs', async t => {
  const { harness, projection } = await setup(t)
  await harness.commit(async tx => {
    ;(await tx.doc(TodoDoc, root)).todos = [
      { content: 'Plan feature', status: 'completed' }, { content: 'Build feature', status: 'in_progress' }, { content: 'Verify feature', status: 'pending' },
    ]
    ;(await tx.doc(GoalDoc, root)).goal = goal('paused')
    ;(await tx.doc(BackgroundDoc, root)).jobs = [
      job(31), job(32, { status: 'completed', description: 'Tests passed', exitCode: 0 }),
      job(33, { status: 'failed', description: 'Build failed', exitCode: 2, error: 'Compiler rejected source' }),
      job(34, { status: 'interrupted' }), job(35, { status: 'killed' }), job(36, { status: 'queued' }), job(37, { status: 'stopping' }),
    ]
    const owner = await tx.createTask(Owner, null, { conversationId: root, ownership: { kind: 'conversation' }, background: true })
    for (const status of ['running', 'completed', 'interrupted'] as const) {
      const child = await tx.createConversation({ ownership: { kind: 'task', taskId: owner } })
      Object.assign(await tx.doc(SubagentDoc, child.id), {
        description: `${status} child`, depth: 1, background: true, status,
        ...(status === 'interrupted' ? { runners: [owner], messages: [{ id: '1', prompt: 'private prompt', state: 'parked' }, { id: '2', prompt: 'private follow-up', state: 'queued' }] } : {}),
      })
    }
    // An owned conversation is not necessarily a subagent.
    await tx.createConversation({ ownership: { kind: 'task', taskId: owner } })
    const foreign = await tx.createConversation({ ownership: { kind: 'ownerless' } })
    Object.assign(await tx.doc(SubagentDoc, foreign.id), { depth: 1, description: 'Unrelated agent', status: 'running' })
  }, context)
  await projection.refreshActivity()
  const activity = projection.activity()
  assert.equal(activity.summary, 'Todo 1/3 · Goal paused 3/7 · Agents 1/3 active · Jobs 3/7 active')
  const detail = activity.lines.join('\n')
  for (const status of ['completed', 'in_progress', 'pending']) assert.match(detail, new RegExp(`Todo \\[${status}\\]`))
  assert.match(detail, /Goal \[paused\] 3\/7 Ship the feature/)
  assert.match(detail, /Agent #\d+ \[running\] queued 0 · running child/)
  assert.match(detail, /Agent #\d+ \[completed\] queued 0 · completed child/)
  assert.match(detail, /Agent #\d+ \[interrupted\] queued 2 \(parked 1\) · interrupted child/)
  assert.match(detail, /Job #32 \[completed\] Tests passed · exit 0/)
  assert.match(detail, /Job #33 \[failed\] Build failed · exit 2 · Compiler rejected source/)
  assert.match(detail, /Job #34 \[interrupted\]/)
  assert.match(detail, /Job #35 \[killed\]/)
  assert.doesNotMatch(detail, /Unrelated agent|private prompt|private follow-up|private command|private output/)
})

test('idle Goal writes and background completion refresh through native commits without AgentEvents', { timeout: 6_000 }, async t => {
  const { harness, projection } = await setup(t)
  await projection.refreshActivity()
  const first = nextRender(projection)
  await harness.commit(async tx => { (await tx.doc(GoalDoc, root)).goal = goal('blocked') }, context)
  await first
  assert.match(projection.activity().summary, /Goal blocked 3\/7/)
  const second = nextRender(projection)
  await harness.commit(async tx => { (await tx.doc(BackgroundDoc, root)).jobs = [job(1)] }, context)
  await second
  assert.match(projection.activity().summary, /Jobs 1\/1 active/)
  const third = nextRender(projection)
  await harness.commit(async tx => { Object.assign((await tx.doc(BackgroundDoc, root)).jobs[0]!, { status: 'completed', exitCode: 0 }) }, context)
  await third
  assert.match(projection.activity().summary, /Jobs 0\/1 active/)
  assert.match(projection.activity().lines.join('\n'), /Job #1 \[completed\].*exit 0/)
})

test('Goal details retain objective and blocking reason, including after completion', async t => {
  const { harness, projection } = await setup(t)
  await harness.commit(async tx => {
    ;(await tx.doc(GoalDoc, root)).goal = { ...goal('blocked'), blockedReason: { code: 'round-limit', message: 'Need a higher budget' } }
  }, context)
  await projection.refreshActivity()
  assert.match(projection.activity().summary, /Goal blocked 3\/7/)
  assert.match(projection.activity().lines.join('\n'), /Goal \[blocked\] 3\/7 Ship the feature/)
  assert.match(projection.activity().lines.join('\n'), /Goal blocked: round-limit: Need a higher budget/)
  await harness.commit(async tx => { (await tx.doc(GoalDoc, root)).goal = goal('complete') }, context)
  await projection.refreshActivity()
  assert.match(projection.activity().summary, /Goal complete/)
  assert.match(projection.activity().lines.join('\n'), /Goal \[complete\] 3\/7 Ship the feature/)
})

test('agent projection pages past 200 children, filters nonagents and counts agents rather than runners', async t => {
  const { harness, projection } = await setup(t)
  await harness.commit(async tx => {
    const owner = await tx.createTask(Owner, null, { conversationId: root, ownership: { kind: 'conversation' }, background: true })
    for (let i = 0; i < 205; i++) {
      const child = await tx.createConversation({ ownership: { kind: 'task', taskId: owner } })
      Object.assign(await tx.doc(SubagentDoc, child.id), { depth: 1, background: true, description: `Child ${i}`, status: i % 2 === 0 ? 'running' : 'completed' })
    }
    await tx.createConversation({ ownership: { kind: 'task', taskId: owner } })
  }, context)
  await projection.refreshActivity()
  assert.match(projection.activity().summary, /Agents 103\/205 active/)
  assert.equal(projection.activity().lines.filter(line => line.startsWith('Agent #')).length, 205)
  assert.match(projection.activity().lines.join('\n'), /Child 204/)
})

test('foreground terminal owner failure overrides stale running metadata', async t => {
  const { harness, projection } = await setup(t)
  const owner = await harness.commit(async tx => {
    const id = await tx.createTask(Owner, null, { conversationId: root, ownership: { kind: 'conversation' } })
    const child = await tx.createConversation({ ownership: { kind: 'task', taskId: id } })
    Object.assign(await tx.doc(SubagentDoc, child.id), { depth: 1, background: false, description: 'Failed foreground work', status: 'running' })
    return id
  }, context)
  await harness.waitForTask(owner, context)
  await projection.refreshActivity()
  assert.match(projection.activity().summary, /Agents 0\/1 active/)
  assert.match(projection.activity().lines.join('\n'), /Agent #\d+ \[failed\].*Failed foreground work/)
})

test('refresh coalesces native commit bursts and includes changes made during an in-flight read', { timeout: 6_000 }, async t => {
  const { harness, projection } = await setup(t)
  await projection.refreshActivity()
  let renders = 0
  projection.setRenderHook(() => { renders++ })
  const refresh = projection.refreshActivity()
  await Promise.all(Array.from({ length: 8 }, (_, i) => harness.commit(async tx => {
    ;(await tx.doc(TodoDoc, root)).todos = [{ content: `Step ${i}`, status: i === 7 ? 'completed' : 'in_progress' }]
  }, context)))
  await refresh
  await projection.refreshActivity()
  assert.match(projection.activity().summary, /Todo 1\/1/)
  assert.match(projection.activity().lines.join('\n'), /Todo \[completed\] Step 7/)
  assert.ok(renders <= 3, `commit burst produced ${renders} renders`)
  const stable = renders
  await projection.refreshActivity()
  assert.equal(renders, stable)
})

test('projection strips terminal controls from all public fields and omits messages, outputs and model config', async t => {
  const { harness, projection } = await setup(t)
  const unsafe = '\x1b[31mRed\x1b[0m\r\n\x00\x1b]0;terminal-title\x07clean'
  await (await harness.root(context)).configure({ model: { provider: 'private-api-key', modelId: 'secret-model-name' }, instructions: 'secret system instructions' }, context)
  await harness.commit(async tx => {
    ;(await tx.doc(TodoDoc, root)).todos = [{ content: unsafe, status: 'in_progress' }]
    ;(await tx.doc(GoalDoc, root)).goal = { ...goal('blocked'), objective: unsafe, blockedReason: { code: unsafe, message: unsafe } }
    ;(await tx.doc(BackgroundDoc, root)).jobs = [job(1, { description: unsafe, error: unsafe })]
    const owner = await tx.createTask(Owner, null, { conversationId: root, ownership: { kind: 'conversation' }, background: true })
    const child = await tx.createConversation({ ownership: { kind: 'task', taskId: owner } })
    Object.assign(await tx.doc(SubagentDoc, child.id), { depth: 1, background: true, description: unsafe, status: 'completed', result: 'private result', messages: [{ id: '1', prompt: 'private message', state: 'done' }] })
  }, context)
  await projection.refreshActivity()
  const activity = projection.activity()
  for (const line of [activity.summary, ...activity.lines]) assert.doesNotMatch(line, /[\u0000-\u001f\u007f-\u009f]/)
  const output = [activity.summary, ...activity.lines].join('\n')
  assert.match(output, /Red.*clean/)
  assert.doesNotMatch(output, /terminal-title|private result|private message|private command|private output|private-api-key|secret-model-name|secret system instructions/)
})

test('unavailable reads are visible without leaking errors and can recover before attachment', async t => {
  const { harness } = await setup(t)
  let ready = false
  const projection = createActivityProjection(() => { if (!ready) throw new Error('secret credential'); return harness })
  await projection.refreshActivity()
  assert.equal(projection.activity().summary, 'Activity unavailable')
  assert.doesNotMatch(projection.activity().lines.join('\n'), /secret credential/)
  ready = true
  await projection.refreshActivity()
  assert.equal(projection.activity().summary, 'Todo 0 · Goal — · Agents 0 · Jobs 0')
})

test('closing cancels queued refreshes, removes hooks and never reopens or renders', async t => {
  const { harness } = await setup(t)
  let gets = 0
  let renders = 0
  const projection = createActivityProjection(() => { gets++; return harness })
  await projection.refreshActivity()
  projection.setRenderHook(() => { renders++ })
  await harness.commit(async tx => { (await tx.doc(GoalDoc, root)).goal = goal() }, context)
  await harness.close(context)
  const before = renders
  projection.setRenderHook(() => { renders++ })
  projection.scheduleRefresh()
  await projection.refreshActivity()
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(renders, before)
  assert.equal(gets, 1)
})
