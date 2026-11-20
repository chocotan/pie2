import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'
import { BACKGROUND_CONTEXT, type Context } from '@earendil-works/chord/context'
import { Type, type TranscriptContext } from '@earendil-works/pi-ai'
import { createModels } from '@earendil-works/pi-ai/models'
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import {
  configure, createRegistry, defineDoc, defineExtension, defineTool, Harness, MemoryStorage, section,
  type Conversation, type ConversationId, type Extension, type JsonObject, type Storage, type Task, type TaskId,
} from '@earendil-works/pi-durable'
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node'
import { SubagentPlugin } from '../src/plugins/subagent.ts'

const context = BACKGROUND_CONTEXT
const toolRound = (name: string, args: JsonObject) => fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: 'toolUse' })
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}
const options = { timeout: 10_000 }
type AgentRecord = { id: ConversationId; runTaskId: TaskId; status: string; background: boolean; queuedMessages: number; result?: string }
function suspended(context: Context, entered: () => void, released: Promise<void>) {
  return new Promise<void>((resolve, reject) => {
    const signal = context.abortSignal
    const abort = () => reject(new Error('Invocation stopped'))
    if (signal?.aborted) return abort()
    signal?.addEventListener('abort', abort, { once: true })
    released.then(() => { signal?.removeEventListener('abort', abort); resolve() }, reject)
    entered()
  })
}
function makeGate() {
  const visits: { entered: ReturnType<typeof deferred>; release: ReturnType<typeof deferred> }[] = []
  const visit = (index: number) => visits[index] ??= { entered: deferred(), release: deferred() }
  let count = 0
  const extension = defineExtension({ name: 'gate', tools: [defineTool({
    name: 'Gate', description: 'Wait for test release.', parameters: Type.Object({}), replay: 'safe',
    execute: async (_args, _api, context) => {
      const current = visit(count++)
      await suspended(context, current.entered.resolve, current.release.promise)
      return { output: [{ type: 'text', text: 'released' }] }
    },
  })] })
  return { extension, entered: (index = 0) => visit(index).entered.promise, release: (index = 0) => visit(index).release.resolve() }
}
type ReporterState = { phase: 'deliver' } | { phase: 'report'; status: 'completed' | 'failed' | 'aborted' | 'interrupted'; result: string; notify: boolean }
function reportGate(afterSubmit: boolean) {
  const entered = deferred()
  const release = deferred()
  const runner = SubagentPlugin.extension.tasks![0] as Task<{ child: ConversationId; prompt: string; generation: number }, ReporterState, null, object>
  const definition: typeof runner.definition = { ...runner.definition, phases: { ...runner.definition.phases,
    report: async (task, runtime, context) => {
      await runner.definition.phases.report(task, { ...runtime, conversation: async (id, context) => {
        const handle = (await runtime.conversation(id, context))!
        return { ...handle, submit: async (input, context) => {
          if (!afterSubmit) await suspended(context, entered.resolve, release.promise)
          const result = await handle.submit(input, context)
          if (afterSubmit) await suspended(context, entered.resolve, release.promise)
          return result
        } }
      } }, context)
    },
  } }
  return { entered: entered.promise, release: release.resolve,
    extension: defineExtension({ ...SubagentPlugin.extension, tasks: [{ definition }, ...SubagentPlugin.extension.tasks!.slice(1)] }),
  }
}
function route(fail = false) {
  return (request: TranscriptContext) => {
    const last = request.messages.findLast(message => message.role !== 'system')!
    const content = typeof last.content === 'string' ? last.content : last.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
    if (last.role === 'toolResult') {
      if (last.toolName === 'Gate') return fail ? fauxAssistantMessage('', { stopReason: 'error', errorMessage: 'Background provider failed' }) : fauxAssistantMessage('Child answer from isolated context.')
      return fauxAssistantMessage('Parent is free to respond.')
    }
    if (content === 'launch') return toolRound('subagent', { prompt: 'child work', description: 'Background worker' })
    if (content.startsWith('child ')) return toolRound('Gate', {})
    if (content.startsWith('send ')) {
      const match = /^send (\d+) ([\s\S]+)$/.exec(content)!
      return toolRound('send_message', { subagent_id: match[1]!, message: match[2]! })
    }
    if (content.startsWith('interrupt ')) return toolRound('interrupt_agent', { agent_id: content.slice(10) })
    if (content.startsWith('Background subagent ')) return fauxAssistantMessage('Collected background result.')
    throw new Error(`Unexpected model request: ${content}`)
  }
}
async function setup(t: TestContext, config: { extension?: Extension; extras?: Extension[]; fail?: boolean; storage?: Storage } = {}) {
  const gate = makeGate()
  const models = createModels()
  const faux = fauxProvider()
  faux.setResponses(Array.from({ length: 100 }, () => route(config.fail)))
  models.setProvider(faux.provider)
  const registry = createRegistry()
  registry.install(config.extension ?? SubagentPlugin.extension)
  registry.install(gate.extension)
  for (const extension of config.extras ?? []) registry.install(extension)
  const errors: unknown[] = []
  const harness = await Harness.open(config.storage ?? new MemoryStorage(), { models, registry, settings: { retry: { maxRetries: 0 } }, onReport: error => errors.push(error) }, context)
  t.after(() => harness.close(context))
  const root = await harness.root(context, { agent: { model: { provider: 'faux', modelId: 'faux-1' }, cwd: '/tmp/background-parent', instructions: 'Inherited project instruction.' } })
  return { harness, root, gate, faux, models, registry, errors }
}
async function say(root: Conversation, content: string) { return (await root.submit({ type: 'input', content }, context)).wait(context) }
async function command(harness: Harness, root: Conversation, args = '') {
  return (await SubagentPlugin.commands!.agents!(args, { harness, conversation: root, context })).output!
}
async function records(harness: Harness, root: Conversation): Promise<AgentRecord[]> {
  const output = await command(harness, root)
  return output === 'No subagents.' ? [] : JSON.parse(output)
}
async function entries(root: Conversation) { return (await root.entries({ order: 'ascending' }, 100, undefined, context)).items }
async function reports(root: Conversation) { return (await entries(root)).filter(entry => entry.kind === 'pie2.background-result') }
async function settle(harness: Harness, root: Conversation, record: AgentRecord) {
  await harness.waitForTask(record.runTaskId, context)
  await root.waitForIdle(context)
}
async function stopSettled(harness: Harness, root: Conversation) {
  const tasks = await harness.commit(tx => tx.scanTasks({ conversationId: root.id, kind: 'pie2.subagent-interrupt' }, 100), context)
  for (const task of tasks.items) await harness.waitForTask(task.id, context)
}

test('omitted background flag starts immediately and automatically reports one isolated result', options, async t => {
  const skills = defineExtension({ name: 'skills', sections: [section('skills', () => 'Test skill')] })
  const goal = defineExtension({ name: 'goal' })
  const background = defineExtension({ name: 'background' })
  const { harness, root, gate, errors } = await setup(t, { extras: [skills, goal, background] })
  assert.equal((await say(root, 'launch')).status, 'done')
  await gate.entered()
  const [record] = await records(harness, root)
  assert.equal(record!.background, true)
  assert.equal(record!.status, 'running')
  const tool = (await entries(root)).flatMap(entry => entry.model ?? []).find(message => message.role === 'toolResult')!
  assert.equal(tool.role, 'toolResult')
  assert.equal(tool.isError, false)
  assert.deepEqual(JSON.parse(tool.content.find(block => block.type === 'text')!.text), { kind: 'continuable', subagentId: String(record!.id) })
  assert.equal((await reports(root)).length, 0)
  const child = (await harness.conversation(record!.id, context))!
  const agent = await child.agent(context)
  assert.ok((await entries(child)).some(entry => entry.kind === 'pie2.coordinator-message' && JSON.stringify(entry.data) === JSON.stringify({ senderConversationId: root.id })))
  assert.deepEqual(agent.model, { provider: 'faux', modelId: 'faux-1' })
  assert.equal(agent.cwd, '/tmp/background-parent')
  assert.deepEqual(agent.extensions.map(extension => extension.name), ['subagent', 'gate', 'skills', 'background'])
  assert.ok(agent.instructions?.includes('Inherited project instruction.'))
  assert.ok(!JSON.stringify(await entries(child)).includes('launch'))
  gate.release()
  await settle(harness, root, record!)
  const [report] = await reports(root)
  assert.deepEqual(report!.data, { source: 'subagent', id: record!.id, description: 'Background worker', status: 'completed' })
  assert.match(JSON.stringify(report!.model), /not a new user instruction/)
  assert.match(JSON.stringify(report!.model), /Child answer from isolated context/)
  assert.equal((await reports(root)).length, 1)
  assert.equal((await records(harness, root))[0]!.status, 'completed')
  assert.match(await command(harness, root, `get ${record!.id}`), /Child answer/)
  assert.deepEqual(errors, [])
})
test('provider failure automatically reports error without a Todo binding', options, async t => {
  const { harness, root, gate, errors } = await setup(t, { fail: true })
  await say(root, 'launch')
  await gate.entered()
  const [record] = await records(harness, root)
  gate.release()
  await settle(harness, root, record!)
  assert.equal((await records(harness, root))[0]!.status, 'failed')
  assert.match(JSON.parse(await command(harness, root, `get ${record!.id}`)).result, /Background provider failed/)
  assert.equal((await reports(root)).length, 1)
  assert.deepEqual(errors, [])
})
test('ordinary parent abort leaves background child running', options, async t => {
  const { harness, root, gate, errors } = await setup(t)
  await say(root, 'launch')
  await gate.entered()
  const [record] = await records(harness, root)
  await root.abort(context)
  await SubagentPlugin.afterInterrupt!({ harness, conversation: root, context })
  assert.equal((await records(harness, root))[0]!.status, 'running')
  gate.release()
  await settle(harness, root, record!)
  assert.equal((await reports(root)).length, 1)
  assert.deepEqual(errors, [])
})
test('background creation replay reuses runner, child and submission', options, async t => {
  const original = SubagentPlugin.extension.tools![0]!
  const extension = defineExtension({ ...SubagentPlugin.extension, tools: [{ ...original, execute: async (args, api, context) => {
    const first = await original.execute(args, api, context)
    assert.deepEqual(await original.execute(args, api, context), first)
    return first
  } }, ...SubagentPlugin.extension.tools!.slice(1)] })
  const { harness, root, gate, errors } = await setup(t, { extension })
  await say(root, 'launch')
  await gate.entered()
  const all = await records(harness, root)
  assert.equal(all.length, 1)
  const runners = await harness.commit(tx => tx.scanTasks({ conversationId: root.id, kind: 'pie2.subagent-runner' }, 100), context)
  assert.equal(runners.items.length, 1)
  const child = (await harness.conversation(all[0]!.id, context))!
  assert.equal((await entries(child)).filter(entry => entry.model?.some(message => message.role === 'user')).length, 1)
  gate.release()
  await settle(harness, root, all[0]!)
  assert.equal((await reports(root)).length, 1)
  assert.deepEqual(errors, [])
})
test('SQLite close pauses work and reopen resumes same child with exactly one report', options, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'pie2-subagent-background-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const path = join(directory, 'session.sqlite')
  const initial = await setup(t, { storage: await openNodeSqliteStorage(path) })
  await say(initial.root, 'launch')
  await initial.gate.entered()
  const [record] = await records(initial.harness, initial.root)
  await initial.harness.close(context)
  const errors: unknown[] = []
  const reopened = await Harness.open(await openNodeSqliteStorage(path), { models: initial.models, registry: initial.registry, settings: { retry: { maxRetries: 0 } }, onReport: error => errors.push(error) }, context)
  t.after(() => reopened.close(context))
  const root = (await reopened.conversation(initial.root.id, context))!
  reopened.resume()
  await initial.gate.entered(1)
  assert.equal((await records(reopened, root))[0]!.id, record!.id)
  initial.gate.release(1)
  await settle(reopened, root, record!)
  assert.equal((await reports(root)).length, 1)
  const child = (await reopened.conversation(record!.id, context))!
  assert.equal((await entries(child)).filter(entry => entry.model?.some(message => message.role === 'user')).length, 1)
  assert.deepEqual(initial.errors, [])
  assert.deepEqual(errors, [])
})
test('reopen after report admission does not report or wake parent twice', options, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'pie2-subagent-report-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const path = join(directory, 'session.sqlite')
  const held = reportGate(true)
  const initial = await setup(t, { extension: held.extension, storage: await openNodeSqliteStorage(path) })
  await say(initial.root, 'launch')
  await initial.gate.entered()
  const [record] = await records(initial.harness, initial.root)
  initial.gate.release()
  await held.entered
  await initial.root.waitForIdle(context)
  assert.equal((await reports(initial.root)).length, 1)
  const calls = initial.faux.state.callCount
  await initial.harness.close(context)
  initial.registry.install(SubagentPlugin.extension)
  const reopened = await Harness.open(await openNodeSqliteStorage(path), { models: initial.models, registry: initial.registry }, context)
  t.after(() => reopened.close(context))
  const root = (await reopened.conversation(initial.root.id, context))!
  await settle(reopened, root, record!)
  assert.equal((await reports(root)).length, 1)
  assert.equal(initial.faux.state.callCount, calls)
  assert.deepEqual(initial.errors, [])
})
test('send_message retains transcript, returns messageId and is replay safe', options, async t => {
  const original = SubagentPlugin.extension.tools!.find(tool => tool.name === 'send_message')!
  const extension = defineExtension({ ...SubagentPlugin.extension, tools: SubagentPlugin.extension.tools!.map(tool => tool.name !== 'send_message' ? tool : {
    ...original, execute: async (args, api, context) => {
      const first = await original.execute(args, api, context)
      assert.deepEqual(await original.execute(args, api, context), first)
      assert.ok((first.structuredOutput as { messageId: string }).messageId)
      return first
    },
  }) })
  const { harness, root, gate, errors } = await setup(t, { extension })
  await say(root, 'launch')
  await gate.entered()
  const [record] = await records(harness, root)
  gate.release()
  await settle(harness, root, record!)
  await say(root, `send ${record!.id} child follow-up`)
  await gate.entered(1)
  const [followup] = await records(harness, root)
  assert.equal(followup!.id, record!.id)
  assert.notEqual(followup!.runTaskId, record!.runTaskId)
  const child = (await harness.conversation(record!.id, context))!
  assert.match(JSON.stringify(await entries(child)), /Child answer from isolated context/)
  gate.release(1)
  await settle(harness, root, followup!)
  assert.equal((await reports(root)).length, 2)
  assert.equal((await records(harness, root)).length, 1)
  assert.deepEqual(errors, [])
})
test('interrupt parks queued messages; later send wakes them FIFO without losing logical message IDs', options, async t => {
  const { harness, root, gate, errors } = await setup(t)
  await say(root, 'launch')
  await gate.entered()
  const [record] = await records(harness, root)
  await say(root, `send ${record!.id} child queued-one`)
  const queued = (await records(harness, root))[0]!
  await say(root, `send ${record!.id} child queued-two`)
  await say(root, `interrupt ${record!.id}`)
  await stopSettled(harness, root)
  assert.equal((await reports(root)).length, 0)
  const parked = (await records(harness, root))[0]!
  assert.equal(parked.status, 'interrupted')
  assert.equal(parked.queuedMessages, 2)
  await say(root, `send ${record!.id} child waking-send`)
  await gate.entered(1)
  const followup = (await records(harness, root))[0]!
  assert.equal(followup.id, record!.id)
  const runners = await harness.commit(tx => tx.scanTasks({ conversationId: root.id, kind: 'pie2.subagent-runner' }, 100), context)
  assert.ok(runners.items.some(task => (task.input as { messageId?: string }).messageId === String(queued.runTaskId)))
  gate.release(1)
  await gate.entered(2)
  gate.release(2)
  await gate.entered(3)
  gate.release(3)
  await settle(harness, root, followup)
  const child = (await harness.conversation(record!.id, context))!
  const inputs = (await entries(child)).filter(entry => entry.model?.some(message => message.role === 'user')).map(entry => JSON.stringify(entry.model))
  assert.equal(inputs.length, 4)
  assert.match(inputs[1]!, /child queued-one/)
  assert.match(inputs[2]!, /child queued-two/)
  assert.match(inputs[3]!, /child waking-send/)
  assert.equal((await reports(root)).length, 3)
  assert.deepEqual(errors, [])
})
test('interrupt accepts without waiting for child cancellation and completed interrupt is a no-op', options, async t => {
  const { harness, root, gate, errors } = await setup(t)
  await say(root, 'launch')
  await gate.entered()
  const [record] = await records(harness, root)
  gate.release()
  await settle(harness, root, record!)
  await say(root, `interrupt ${record!.id}`)
  const result = (await entries(root)).flatMap(entry => entry.model ?? []).findLast(message => message.role === 'toolResult')!
  assert.equal(result.role, 'toolResult')
  assert.deepEqual(JSON.parse(result.content.find(block => block.type === 'text')!.text), { accepted: true })
  assert.equal((await records(harness, root))[0]!.status, 'completed')
  assert.equal((await reports(root)).length, 1)
  assert.deepEqual(errors, [])
})
test('interrupt racing report admission suppresses late notification and returns before reporter releases', options, async t => {
  const held = reportGate(false)
  const { harness, root, gate, errors } = await setup(t, { extension: held.extension })
  await say(root, 'launch')
  await gate.entered()
  const [record] = await records(harness, root)
  gate.release()
  await held.entered
  await command(harness, root, `stop ${record!.id}`)
  assert.equal((await reports(root)).length, 0)
  held.release()
  await stopSettled(harness, root)
  await settle(harness, root, record!)
  assert.equal((await reports(root)).length, 0)
  assert.equal((await records(harness, root))[0]!.status, 'interrupted')
  assert.deepEqual(errors, [])
})
test('SQLite completed child accepts follow-ups after explicit resume', options, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'pie2-subagent-message-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const path = join(directory, 'session.sqlite')
  const initial = await setup(t, { storage: await openNodeSqliteStorage(path) })
  await say(initial.root, 'launch')
  await initial.gate.entered()
  const [record] = await records(initial.harness, initial.root)
  initial.gate.release()
  await settle(initial.harness, initial.root, record!)
  await initial.harness.close(context)
  const reopened = await Harness.open(await openNodeSqliteStorage(path), { models: initial.models, registry: initial.registry }, context)
  t.after(() => reopened.close(context))
  const root = (await reopened.conversation(initial.root.id, context))!
  await command(reopened, root, `send ${record!.id} child follow-up`)
  await initial.gate.entered(1)
  const followup = (await records(reopened, root))[0]!
  initial.gate.release(1)
  await settle(reopened, root, followup)
  assert.equal((await reports(root)).length, 2)
  assert.equal((await records(reopened, root)).length, 1)
  assert.deepEqual(initial.errors, [])
})
test('send and interrupt reject foreign children and blank messages without reporters', options, async t => {
  const { harness, root, errors } = await setup(t)
  const foreign = await harness.createConversation({ ownership: { kind: 'ownerless' } }, context)
  await say(root, `send ${foreign.id} child follow-up`)
  await say(root, `interrupt ${foreign.id}`)
  const results = (await entries(root)).flatMap(entry => entry.model ?? []).filter(message => message.role === 'toolResult')
  assert.equal(results.length, 2)
  assert.ok(results.every(result => result.isError && JSON.stringify(result.content).includes('Unknown subagent')))
  await assert.rejects(command(harness, root, `send ${foreign.id} child follow-up`), /Unknown subagent/)
  await assert.rejects(command(harness, root, `send ${foreign.id}  \n `), /Usage:/)
  assert.equal((await harness.commit(tx => tx.scanTasks({ conversationId: root.id, kind: 'pie2.subagent-runner' }, 100), context)).items.length, 0)
  assert.deepEqual(errors, [])
})
test('abort including background cancels child and reporters without wakeup', options, async t => {
  const { harness, root, gate, errors } = await setup(t)
  await say(root, 'launch')
  await gate.entered()
  const [record] = await records(harness, root)
  await root.abort(context, { background: true })
  await settle(harness, root, record!)
  await SubagentPlugin.afterInterrupt!({ harness, conversation: root, context })
  assert.equal((await reports(root)).length, 0)
  assert.equal((await records(harness, root))[0]!.status, 'aborted')
  assert.deepEqual(errors, [])
})
test('background answer is UTF-8 bounded to 50 KB and absent from report metadata', options, async t => {
  const { harness, root, gate, faux, errors } = await setup(t)
  const base = route()
  faux.setResponses(Array.from({ length: 20 }, () => request => {
    const last = request.messages.findLast(message => message.role !== 'system')!
    return last.role === 'toolResult' && last.toolName === 'Gate' ? fauxAssistantMessage(`x${'文'.repeat(20_000)}`) : base(request)
  }))
  await say(root, 'launch')
  await gate.entered()
  const [record] = await records(harness, root)
  gate.release()
  await settle(harness, root, record!)
  const result: string = JSON.parse(await command(harness, root, `get ${record!.id}`)).result
  assert.ok(Buffer.byteLength(result) <= 50_000)
  assert.ok(!result.includes('\uFFFD'))
  assert.ok(!Object.hasOwn((await records(harness, root))[0]!, 'result'))
  assert.match(result, /truncated at 50 KB/)
  assert.deepEqual(errors, [])
})

test('background failures retain actual partial output in automatic result reports', options, async t => {
  const { harness, root, gate, faux, errors } = await setup(t)
  const base = route()
  faux.setResponses(Array.from({ length: 20 }, () => request => {
    const last = request.messages.findLast(message => message.role !== 'system')!
    return last.role === 'toolResult' && last.toolName === 'Gate'
      ? fauxAssistantMessage('Partial child evidence.', { stopReason: 'error', errorMessage: 'Provider stopped' }) : base(request)
  }))
  await say(root, 'launch')
  await gate.entered()
  const [record] = await records(harness, root)
  gate.release()
  await settle(harness, root, record!)
  assert.equal((await records(harness, root))[0]!.status, 'failed')
  assert.match(JSON.stringify((await reports(root))[0]!.model), /Provider stopped/)
  assert.match(JSON.stringify((await reports(root))[0]!.model), /Partial child evidence/)
  assert.deepEqual(errors, [])
})
test('legacy metadata and queued native submissions upgrade without dropping pending messages', options, async t => {
  const LegacyDoc = defineDoc<{ description: string; taskId: string | null; background: boolean; runners: TaskId[]; generation: number }>({
    kind: 'pie2.subagent', version: 1, scope: 'conversation', history: 'latest', fork: 'initial',
    initial: () => ({ description: 'Legacy worker', taskId: 'old-task', background: true, runners: [], generation: 0 }), checkpointWhen: () => false,
  })
  const anchor = SubagentPlugin.extension.tasks![1] as Task<null, { phase: 'done' }, null, object>
  const runner = SubagentPlugin.extension.tasks![0] as Task<{ child: ConversationId; prompt: string; generation: number }, ReporterState, null, object>
  const legacy = defineExtension({ name: 'legacy-fixture', tools: [defineTool({
    name: 'LegacySpawn', description: 'Seed a pre-upgrade child and runner inputs.', parameters: Type.Object({}),
    execute: async (_args, api, ctx) => {
      const parent = await api.agent(ctx)
      await api.commit(async tx => {
        const owner = await tx.createTask(anchor, null, { ownership: { kind: 'conversation' }, conversationId: api.conversationId, background: true })
        const child = await tx.createConversation({ ownership: { kind: 'task', taskId: owner } })
        await configure(tx, child.id, { extensions: parent.extensions, model: parent.model })
        const metadata = await tx.doc(LegacyDoc, child.id)
        for (const prompt of ['child work', 'child legacy-queued']) {
          metadata.runners.push(await tx.createTask(runner, { child: child.id, prompt, generation: 0 }, { ownership: { kind: 'conversation' }, conversationId: api.conversationId, background: true }))
        }
      }, ctx)
      return { output: [{ type: 'text', text: 'Seeded legacy child.' }] }
    },
  })] })
  const { harness, root, gate, faux, errors } = await setup(t, { extras: [legacy] })
  const base = route()
  faux.setResponses(Array.from({ length: 50 }, () => request => {
    const last = request.messages.findLast(message => message.role !== 'system')!
    return last.role === 'user' && JSON.stringify(last.content).includes('legacy launch') ? toolRound('LegacySpawn', {}) : base(request)
  }))
  await say(root, 'legacy launch')
  await gate.entered()
  const [record] = await records(harness, root)
  await command(harness, root, `stop ${record!.id}`)
  await stopSettled(harness, root)
  assert.equal((await records(harness, root))[0]!.queuedMessages, 1)
  await command(harness, root, `send ${record!.id} child after-upgrade`)
  await gate.entered(1)
  gate.release(1)
  await gate.entered(2)
  gate.release(2)
  await allRunnersSettled(harness, root)
  const child = (await harness.conversation(record!.id, context))!
  const inputs = (await entries(child)).filter(entry => entry.model?.some(message => message.role === 'user'))
  assert.equal(inputs.length, 3)
  assert.match(JSON.stringify(inputs[1]!.model), /child legacy-queued/)
  assert.match(JSON.stringify(inputs[2]!.model), /child after-upgrade/)
  assert.equal((await reports(root)).length, 2)
  assert.deepEqual(errors, [])
})

async function allRunnersSettled(harness: Harness, root: Conversation) {
  for (;;) {
    const tasks = await harness.commit(tx => tx.scanTasks({ conversationId: root.id, kind: 'pie2.subagent-runner' }, 100), context)
    const live = tasks.items.filter(task => task.state.status !== 'terminal')
    if (!live.length) break
    for (const task of live) await harness.waitForTask(task.id, context)
  }
  await root.waitForIdle(context)
}
function nestedRoute(request: TranscriptContext) {
  const plain = (content: (typeof request.messages)[number]['content']) => typeof content === 'string' ? content : content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
  const last = request.messages.findLast(message => message.role !== 'system')!
  const input = plain(last.content)
  const branch = request.messages.some(message => message.role === 'user' && plain(message.content) === 'child work')
  if (last.role === 'user' && input === 'child work') return toolRound('subagent', { description: 'Nested independent work', prompt: 'child grandchild' })
  if (last.role === 'toolResult' && last.toolName === 'subagent' && branch) return fauxAssistantMessage('Premature branch answer.')
  if (last.role === 'user' && input.startsWith('Background subagent ') && branch) return fauxAssistantMessage('Verified descendant result.')
  return route()(request)
}
test('background parent waits for its descendant and reports the answer after collecting the descendant notice', options, async t => {
  const { harness, root, gate, faux, errors } = await setup(t)
  faux.setResponses(Array.from({ length: 100 }, () => nestedRoute))
  await say(root, 'launch')
  await gate.entered()
  const [record] = await records(harness, root)
  const child = (await harness.conversation(record!.id, context))!
  assert.equal((await records(harness, child)).length, 1)
  assert.equal((await reports(root)).length, 0)
  gate.release()
  await allRunnersSettled(harness, root)
  const notifications = await reports(root)
  assert.equal(notifications.length, 1)
  assert.match(JSON.stringify(notifications[0]!.model), /Verified descendant result/)
  assert.ok(!JSON.stringify(notifications[0]!.model).includes('Premature branch answer'))
  assert.deepEqual(errors, [])
})
test('interrupting a parent leaves published descendants running and observes their later result without waking parked messages', options, async t => {
  const { harness, root, gate, faux, errors } = await setup(t)
  faux.setResponses(Array.from({ length: 100 }, () => nestedRoute))
  await say(root, 'launch')
  await gate.entered()
  const [record] = await records(harness, root)
  const child = (await harness.conversation(record!.id, context))!
  const [descendant] = await records(harness, child)
  await say(root, `send ${record!.id} child parked-work`)
  await command(harness, root, `stop ${record!.id}`)
  await stopSettled(harness, root)
  assert.equal((await records(harness, child))[0]!.status, 'running')
  assert.equal((await records(harness, root))[0]!.queuedMessages, 1)
  assert.equal((await reports(root)).length, 0)
  gate.release()
  await settle(harness, child, descendant!)
  await allRunnersSettled(harness, root)
  assert.equal((await reports(root)).length, 1)
  assert.match(JSON.stringify((await reports(root))[0]!.model), /Verified descendant result/)
  assert.equal((await records(harness, root))[0]!.queuedMessages, 1)
  assert.ok(!JSON.stringify(await entries(child)).includes('child parked-work'))
  assert.deepEqual(errors, [])
})
test('ancestor can interrupt deeper descendants but a sibling cannot', options, async t => {
  const { harness, root, gate, faux, errors } = await setup(t)
  faux.setResponses(Array.from({ length: 100 }, () => nestedRoute))
  await say(root, 'launch')
  await gate.entered()
  const [record] = await records(harness, root)
  const child = (await harness.conversation(record!.id, context))!
  const [descendant] = await records(harness, child)
  const sibling = await harness.createConversation({ ownership: { kind: 'ownerless' }, agent: { model: { provider: 'faux', modelId: 'faux-1' } } }, context)
  await say(sibling, `interrupt ${descendant!.id}`)
  const foreign = (await entries(sibling)).flatMap(entry => entry.model ?? []).find(message => message.role === 'toolResult')!
  assert.equal(foreign.role, 'toolResult')
  assert.equal(foreign.isError, true)
  await say(root, `interrupt ${descendant!.id}`)
  await stopSettled(harness, child)
  await allRunnersSettled(harness, root)
  assert.equal((await records(harness, child))[0]!.status, 'interrupted')
  assert.deepEqual(errors, [])
})
test('parked messages survive SQLite reopen and a later send admits them once in order', options, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'pie2-subagent-parked-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const path = join(directory, 'session.sqlite')
  const initial = await setup(t, { storage: await openNodeSqliteStorage(path) })
  await say(initial.root, 'launch')
  await initial.gate.entered()
  const [record] = await records(initial.harness, initial.root)
  await say(initial.root, `send ${record!.id} child parked-before-close`)
  await command(initial.harness, initial.root, `stop ${record!.id}`)
  await stopSettled(initial.harness, initial.root)
  await initial.harness.close(context)
  const reopened = await Harness.open(await openNodeSqliteStorage(path), { models: initial.models, registry: initial.registry }, context)
  t.after(() => reopened.close(context))
  const root = (await reopened.conversation(initial.root.id, context))!
  reopened.resume()
  assert.equal((await records(reopened, root))[0]!.queuedMessages, 1)
  await command(reopened, root, `send ${record!.id} child wake-after-reopen`)
  await initial.gate.entered(1)
  initial.gate.release(1)
  await initial.gate.entered(2)
  initial.gate.release(2)
  await allRunnersSettled(reopened, root)
  const child = (await reopened.conversation(record!.id, context))!
  const inputs = (await entries(child)).filter(entry => entry.model?.some(message => message.role === 'user'))
  assert.equal(inputs.length, 3)
  assert.match(JSON.stringify(inputs[1]!.model), /child parked-before-close/)
  assert.match(JSON.stringify(inputs[2]!.model), /child wake-after-reopen/)
  assert.equal((await reports(root)).length, 2)
  assert.deepEqual(initial.errors, [])
})
