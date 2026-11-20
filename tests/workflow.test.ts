import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { Type, type FauxResponseStep } from '@earendil-works/pi-ai'
import { createModels } from '@earendil-works/pi-ai/models'
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import { createRegistry, defineExtension, defineTool, Harness, MemoryStorage, ToolTask, hook, type Conversation, type Extension } from '@earendil-works/pi-durable'
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node'
import { createWorkflowPlugin, WorkflowDoc } from '../src/plugins/workflow.ts'
import { SubagentPlugin } from '../src/plugins/subagent.ts'

const context = BACKGROUND_CONTEXT
const call = (script: string, extra = {}) => fauxAssistantMessage([fauxToolCall('workflow', { meta: { name: 'audit', description: 'Audit independent pieces', phases: [{ title: 'Review' }] }, script, ...extra })], { stopReason: 'toolUse' })
async function setup(t: TestContext, responses: FauxResponseStep[], limits = {}, extra: Extension[] = [], storage = new MemoryStorage()) {
  const faux = fauxProvider(); faux.setResponses(responses)
  const models = createModels(); models.setProvider(faux.provider)
  const registry = createRegistry()
  const plugin = createWorkflowPlugin({ timeoutMs: 2000, ...limits })
  for (const extension of [SubagentPlugin.extension, plugin.extension, ...extra]) registry.install(extension)
  const harness = await Harness.open(storage, { registry, models, settings: { retry: { maxRetries: 0 } } }, context)
  t.after(() => harness.close(context))
  const root = await harness.root(context, { agent: { model: { provider: 'faux', modelId: 'faux-1' } } })
  return { harness, root, plugin, faux }
}
async function run(root: Conversation) { return (await root.submit({ type: 'input', content: 'Explicitly run a large workflow audit. Private parent content.' }, context)).wait(context) }
async function output(root: Conversation) {
  const result = (await root.entries({ order: 'ascending' }, 100, undefined, context)).items.flatMap(entry => entry.model ?? []).find(message => message.role === 'toolResult')
  assert.ok(result && result.role === 'toolResult')
  return { ...result, value: JSON.parse(result.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('')) }
}

test('workflow runs JavaScript with args, phases, parallel children and structured JSON', { timeout: 8000 }, async t => {
  const { harness, root, plugin } = await setup(t, [
    call(`phase('Review'); log('Starting checks'); const results = await Promise.all(args.paths.map(path => agent('Review '+path, {label:path, schema:{type:'object',properties:{ok:{type:'boolean'}},required:['ok'],additionalProperties:false}}))); return {results};`, { args: { paths: ['first', 'second'] } }),
    transcript => { assert.ok(!JSON.stringify(transcript.messages).includes('Private parent content')); return fauxAssistantMessage('{"ok":true}') },
    fauxAssistantMessage('{"ok":false}'), fauxAssistantMessage('Collected.'),
  ])
  assert.equal((await run(root)).status, 'done')
  const result = await output(root)
  assert.equal(result.isError, false)
  assert.deepEqual(result.value.result, { results: [{ ok: true }, { ok: false }] })
  assert.equal(result.value.agentsStarted, 2)
  const runs = await harness.snapshot(WorkflowDoc, root.id, context)
  assert.equal(runs?.runs[0]?.phase, 'Review')
  assert.equal(runs?.runs[0]?.agents.length, 2)
  assert.match((await plugin.commands!.workflows!('list', { harness, conversation: root, context })).output!, /Starting checks/)
})

test('workflow drains a delegation even when the script omits await', { timeout: 8000 }, async t => {
  const { root, harness } = await setup(t, [call('agent("still working"); return "all done";'), fauxAssistantMessage('Actual child result.'), fauxAssistantMessage('Collected.')])
  await run(root)
  const result = await output(root)
  assert.equal(result.isError, false)
  assert.equal(result.value.result, 'all done')
  assert.equal(result.value.agentsStarted, 1)
  assert.equal(result.value.partial[0].status, 'completed')
  assert.equal(result.value.partial[0].output, 'Actual child result.')
  assert.equal((await harness.commit(tx => tx.scanConversations({ ownerConversationId: root.id }, 100), context)).items.length, 1)
})

test('an uncollected failed delegation fails the workflow and preserves its result', { timeout: 8000 }, async t => {
  const { root } = await setup(t, [call('agent("will fail"); return "all done";'), fauxAssistantMessage('Partial child evidence.', { stopReason: 'error', errorMessage: 'Child failed.' }), fauxAssistantMessage('Reported.')])
  await run(root)
  const result = await output(root)
  assert.equal(result.isError, true)
  assert.equal(result.value.status, 'failed')
  assert.equal(result.value.result, null)
  assert.match(result.value.error, /uncollected failed delegation/)
  assert.equal(result.value.partial[0].status, 'failed')
  assert.match(result.value.partial[0].output, /Child failed/)
  assert.match(result.value.partial[0].output, /Partial child evidence/)
})

test('workflow drains ignored parallel and pipeline work including delegations started by later callbacks', { timeout: 8000 }, async t => {
  const script = `
    agent('seed').then(() => { phase('Review'); return agent('callback'); });
    parallel([() => agent('parallel seed').then(() => agent('parallel callback'))]);
    pipeline(['item'], () => agent('pipeline first'), () => agent('pipeline second'));
    return 'script value';
  `
  const { root } = await setup(t, [call(script), ...Array.from({ length: 6 }, (_, index) => fauxAssistantMessage(`Child result ${index + 1}`)), fauxAssistantMessage('All collected.')])
  await run(root)
  const result = await output(root)
  assert.equal(result.isError, false)
  assert.equal(result.value.result, 'script value')
  assert.equal(result.value.agentsStarted, 6)
  assert.ok(result.value.partial.every((agent: { status: string }) => agent.status === 'completed'))
  assert.deepEqual(result.value.partial.map((agent: { output: string }) => agent.output).sort(), Array.from({ length: 6 }, (_, index) => `Child result ${index + 1}`))
})

for (const script of [
  'agent("seed").then(() => agent("late failure")); return "all done";',
  'parallel([() => agent("seed"), () => agent("late failure")]); return "all done";',
  'pipeline(["item"], () => agent("seed"), () => agent("late failure")); return "all done";',
]) {
  test(`uncollected callback or helper failures cannot report completion: ${script}`, { timeout: 8000 }, async t => {
    const { root } = await setup(t, [call(script), fauxAssistantMessage('Collected seed.'), fauxAssistantMessage('Late partial result.', { stopReason: 'error', errorMessage: 'Late failure.' }), fauxAssistantMessage('Reported.')])
    await run(root)
    const result = await output(root)
    assert.equal(result.isError, true)
    assert.equal(result.value.status, 'failed')
    assert.match(result.value.error, /uncollected failed delegation/)
    assert.equal(result.value.partial.length, 2)
    assert.equal(result.value.partial.filter((agent: { status: string }) => agent.status === 'failed').length, 1)
    assert.ok(result.value.partial.some((agent: { output: string }) => /Late partial result/.test(agent.output)))
  })
}

test('an ignored callback rejection fails cleanly after preserving the completed child', { timeout: 8000 }, async t => {
  const { root } = await setup(t, [call('agent("seed").then(() => { throw new Error("Callback rejected"); }); return "all done";'), fauxAssistantMessage('Collected seed.'), fauxAssistantMessage('Reported.')])
  await run(root)
  const result = await output(root)
  assert.equal(result.isError, true)
  assert.match(result.value.error, /uncollected failed delegation or callback/)
  assert.equal(result.value.partial[0].status, 'completed')
  assert.equal(result.value.partial[0].output, 'Collected seed.')
})

test('workflow replay returns its receipt without repeating children or progress', { timeout: 8000 }, async t => {
  const plugin = createWorkflowPlugin({ timeoutMs: 2000 })
  const original = plugin.extension.tools![0]!
  const repeat = defineExtension({ ...plugin.extension, tools: [{ ...original, execute: async (args, api, ctx) => {
    const first = await original.execute(args, api, ctx)
    assert.deepEqual(await original.execute(args, api, ctx), first)
    return first
  } }] })
  const { harness, root, faux } = await setup(t, [call('log("once"); return await agent("one child");'), fauxAssistantMessage('one result'), fauxAssistantMessage('Done.')], {}, [repeat])
  await run(root)
  assert.equal(faux.state.callCount, 3)
  assert.equal((await harness.snapshot(WorkflowDoc, root.id, context))!.runs[0]!.logs.length, 1)
  assert.equal((await harness.commit(tx => tx.scanConversations({ ownerConversationId: root.id }, 100), context)).items.length, 1)
})

test('workflow calls pass native nested ToolTask hooks', { timeout: 8000 }, async t => {
  let nested = false
  const policy = defineExtension({ name: 'test-plan', hooks: [hook(ToolTask, { beforeTool: async call => {
    if (call.name === 'subagent') nested = call.parent !== undefined
    return undefined
  } })] })
  const { root } = await setup(t, [call('return await agent("inspect");'), fauxAssistantMessage('inspected'), fauxAssistantMessage('Done.')], {}, [policy])
  await run(root)
  assert.equal(nested, true)
})

for (const [name, script, limits, pattern] of [
  ['infinite loop deadline', 'while(true) {}', { timeoutMs: 150 }, /timed out/i],
  ['arbitrary host access', 'return process.env;', {}, /process/],
  ['arbitrary tool access', 'return await tools.bash({command:"whoami"});', {}, /bash/],
  ['agent cap cannot be caught', 'try { await agent("a"); await agent("b"); } catch {} return "pretend success";', { maxAgents: 1 }, /cap/],
  ['output cap cannot be caught', 'return "x".repeat(60000);', {}, /50000/],
  ['unsupported schema fails loudly', 'return await agent("a", {schema:{type:"object",pattern:"bad"}});', {}, /schema/],
  ['invalid options fail loudly', 'return await agent("a", {isolation:"fork"});', {}, /option/],
] as const) {
  test(`workflow ${name}`, { timeout: 8000 }, async t => {
    const responses = name === 'agent cap cannot be caught' ? [call(script), fauxAssistantMessage('first result'), fauxAssistantMessage('Parent done.')] : [call(script), fauxAssistantMessage('Parent done.')]
    const { root } = await setup(t, responses, limits)
    await run(root)
    const result = await output(root)
    assert.equal(result.isError, true)
    assert.match(result.value.error, pattern)
  })
}

test('workflow failure retains completed child results and logs', { timeout: 8000 }, async t => {
  const { root } = await setup(t, [call('await agent("collect evidence"); log("saved partial"); throw new Error("review failed");'), fauxAssistantMessage('partial evidence'), fauxAssistantMessage('Blocked.')])
  await run(root)
  const result = await output(root)
  assert.equal(result.isError, true)
  assert.match(result.value.partial[0].output, /partial evidence/)
  assert.match(result.value.error, /review failed/)
})

test('ordinary child failure maps to null and pipeline items progress independently', { timeout: 8000 }, async t => {
  const { root } = await setup(t, [call('return await pipeline([1,2], async n => { if(n===1) throw Error("drop"); return n; }, n => agent("check "+n));'), fauxAssistantMessage('', { stopReason: 'error', errorMessage: 'child failed' }), fauxAssistantMessage('Handled.')])
  await run(root)
  assert.deepEqual((await output(root)).value.result, [null, null])
})

test('workflow limits concurrency while allowing multiple children to overlap', { timeout: 8000 }, async t => {
  let active = 0; let max = 0; let visits = 0
  let entered!: () => void; const both = new Promise<void>(resolve => { entered = resolve })
  let release!: () => void; const released = new Promise<void>(resolve => { release = resolve })
  const gate = defineExtension({ name: 'gate', tools: [defineTool({ name: 'gate', description: 'Check concurrency.', parameters: Type.Object({}), execute: async (_args, _api, ctx) => {
    active++; max = Math.max(max, active); if (++visits === 2) entered()
    await new Promise<void>((resolve, reject) => { const abort = () => reject(new Error('aborted')); ctx.abortSignal?.addEventListener('abort', abort, { once: true }); released.then(() => { ctx.abortSignal?.removeEventListener('abort', abort); resolve() }) })
    active--; return { output: [{ type: 'text', text: 'released' }] }
  } })] })
  const toolRound = () => fauxAssistantMessage([fauxToolCall('gate', {})], { stopReason: 'toolUse' })
  const { root } = await setup(t, [call('return await Promise.all([1,2,3].map(n=>agent("task "+n)));'), toolRound(), toolRound(), fauxAssistantMessage('first'), fauxAssistantMessage('second'), toolRound(), fauxAssistantMessage('third'), fauxAssistantMessage('All done.')], { concurrency: 2 }, [gate])
  const pending = run(root)
  await both
  assert.equal(visits, 2)
  release()
  await pending
  assert.equal(max, 2)
  assert.equal((await output(root)).value.agentsStarted, 3)
})

test('cancelling a workflow aborts owned child work and query reconciles status', { timeout: 8000 }, async t => {
  let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve })
  let stopped = false
  const gate = defineExtension({ name: 'gate', tools: [defineTool({ name: 'gate', description: 'Wait for cancellation.', parameters: Type.Object({}), execute: async (_args, _api, ctx) => {
    entered()
    await new Promise<void>((_resolve, reject) => { ctx.abortSignal?.addEventListener('abort', () => { stopped = true; reject(new Error('stopped')) }, { once: true }) })
    return {}
  } })] })
  const { root, harness, plugin } = await setup(t, [call('return await agent("wait");'), fauxAssistantMessage([fauxToolCall('gate', {})], { stopReason: 'toolUse' })], {}, [gate])
  const pending = run(root)
  await started
  await root.abort(context)
  assert.equal((await pending).status, 'unanswered')
  await harness.waitForIdle(context)
  assert.equal(stopped, true)
  assert.match((await plugin.commands!.workflows!('list', { harness, conversation: root, context })).output!, /cancelled/)
})

test('workflow deadline cancels a still-running child and retains its partial status', { timeout: 8000 }, async t => {
  let stopped = false
  const gate = defineExtension({ name: 'gate', tools: [defineTool({ name: 'gate', description: 'Wait for timeout.', parameters: Type.Object({}), execute: async (_args, _api, ctx) => {
    await new Promise<void>((_resolve, reject) => { ctx.abortSignal?.addEventListener('abort', () => { stopped = true; reject(new Error('deadline')) }, { once: true }) })
    return {}
  } })] })
  const { root, harness } = await setup(t, [call('return await Promise.all([agent("wait"), agent("stay queued")]);'), fauxAssistantMessage([fauxToolCall('gate', {})], { stopReason: 'toolUse' }), fauxAssistantMessage('Deadline reached.')], { timeoutMs: 200, concurrency: 1 }, [gate])
  await run(root)
  await harness.waitForIdle(context)
  assert.equal(stopped, true)
  const result = await output(root)
  assert.equal(result.isError, true)
  assert.match(result.value.error, /timed out/i)
  assert.equal(result.value.partial[0].status, 'failed')
  assert.equal((await harness.commit(tx => tx.scanConversations({ ownerConversationId: root.id }, 100), context)).items.length, 1)
})

test('workflow schema uses TypeBox for nested constraints and rejects malformed child JSON', { timeout: 8000 }, async t => {
  const { root } = await setup(t, [call('return await agent("json", {schema: {type:"object",properties:{items:{type:"array",items:{oneOf:[{const:"ok"},{type:"integer"}]}}},required:["items"],additionalProperties:false}});'), fauxAssistantMessage('{"items":["wrong"]}'), fauxAssistantMessage('Reported invalid output.')])
  await run(root)
  const result = await output(root)
  assert.equal(result.isError, false)
  assert.equal(result.value.result, null)
  assert.match(result.value.partial[0].output, /schema/)
})

test('SQLite reopen replays the native script journal without repeating completed child effects', { timeout: 8000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'pie2-workflow-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const faux = fauxProvider()
  const models = createModels(); models.setProvider(faux.provider)
  const registry = createRegistry()
  let effects = 0; let attempts = 0
  let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve })
  const helpers = defineExtension({ name: 'helpers', tools: [defineTool({ name: 'effect', description: 'One completed external effect.', parameters: Type.Object({}), execute: async () => { effects++; return { output: [{ type: 'text', text: 'recorded' }] } } }), defineTool({
    name: 'gate', description: 'Pause the second child across restart.', replay: 'safe', parameters: Type.Object({}), execute: async (_args, _api, ctx) => {
      if (++attempts === 1) {
        entered()
        await new Promise<void>((_resolve, reject) => ctx.abortSignal?.addEventListener('abort', () => reject(new Error('closing')), { once: true }))
      }
      return { output: [{ type: 'text', text: 'resumed' }] }
    },
  })] })
  for (const extension of [SubagentPlugin.extension, createWorkflowPlugin({ timeoutMs: 6000 }).extension, helpers]) registry.install(extension)
  const open = async () => Harness.open(await openNodeSqliteStorage(join(directory, 'state.sqlite')), { models, registry, settings: { retry: { maxRetries: 0 } } }, context)
  let harness = await open()
  t.after(() => harness.close(context))
  const root = await harness.root(context, { agent: { model: { provider: 'faux', modelId: 'faux-1' } } })
  const toolRound = (name: string) => fauxAssistantMessage([fauxToolCall(name, {})], { stopReason: 'toolUse' })
  faux.setResponses([call('const a = await agent("first"); const b = await agent("second"); return {a,b};'), toolRound('effect'), fauxAssistantMessage('first result'), toolRound('gate')])
  const pending = run(root).catch(() => undefined)
  await started
  await harness.close(context)
  await pending
  faux.setResponses([fauxAssistantMessage('second result'), fauxAssistantMessage('Collected after restart.')])
  harness = await open()
  const restored = (await harness.conversation(root.id, context))!
  harness.resume()
  await harness.waitForIdle(context)
  const result = await output(restored)
  assert.equal(result.isError, false)
  assert.deepEqual(result.value.result, { a: 'first result', b: 'second result' })
  assert.equal(effects, 1)
  assert.equal((await harness.commit(tx => tx.scanConversations({ ownerConversationId: root.id }, 100), context)).items.length, 2)
})
