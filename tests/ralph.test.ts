import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { Type, type FauxResponseStep } from '@earendil-works/pi-ai'
import { createModels } from '@earendil-works/pi-ai/models'
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import { createRegistry, defineExtension, defineTool, Harness, MemoryStorage, type Conversation, type Extension } from '@earendil-works/pi-durable'
import { createRalphPlugin, RalphDoc, validateRalphReport } from '../src/plugins/ralph.ts'
import { SubagentPlugin } from '../src/plugins/subagent.ts'

const context = BACKGROUND_CONTEXT
const continuing = { status: 'continue', summary: 'First patch verified.', evidence: ['test passed'], nextSteps: ['check next file'], blocker: '' }
const complete = { status: 'complete', summary: 'Requested work verified.', evidence: ['tests passed'], nextSteps: [], blocker: '' }
const blocked = { status: 'blocked', summary: 'Cannot authenticate.', evidence: [], nextSteps: [], blocker: 'Need a valid credential from the human.' }
const call = (maxRounds?: number) => fauxAssistantMessage([fauxToolCall('ralph', { objective: 'Immutable objective: implement and verify.', ...(maxRounds ? { maxRounds } : {}) })], { stopReason: 'toolUse' })
async function setup(t: TestContext, responses: FauxResponseStep[], extra: Extension[] = [], options = {}) {
  const faux = fauxProvider(); faux.setResponses(responses)
  const models = createModels(); models.setProvider(faux.provider)
  const registry = createRegistry(); const plugin = createRalphPlugin({ timeoutMs: 2000, ...options })
  for (const extension of [SubagentPlugin.extension, plugin.extension, ...extra]) registry.install(extension)
  const harness = await Harness.open(new MemoryStorage(), { registry, models, settings: { retry: { maxRetries: 0 } } }, context)
  t.after(() => harness.close(context))
  const root = await harness.root(context, { agent: { model: { provider: 'faux', modelId: 'faux-1' }, cwd: '/tmp/pie2-ralph' } })
  return { harness, root, plugin, faux }
}
async function run(root: Conversation) { return (await root.submit({ type: 'input', content: 'Human explicitly requests Ralph. Private parent-only note.' }, context)).wait(context) }
async function output(root: Conversation) {
  const result = (await root.entries({ order: 'ascending' }, 100, undefined, context)).items.flatMap(entry => entry.model ?? []).find(message => message.role === 'toolResult')
  assert.ok(result && result.role === 'toolResult')
  return { ...result, value: JSON.parse(result.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('')) }
}

test('Ralph uses fresh independent child contexts and only a structured report crosses rounds', { timeout: 8000 }, async t => {
  const { root, harness, plugin } = await setup(t, [call(3),
    transcript => {
      assert.ok(!JSON.stringify(transcript.messages).includes('Private parent-only note'))
      assert.ok(JSON.stringify(transcript.messages).includes('Immutable objective: implement and verify.'))
      return fauxAssistantMessage(JSON.stringify(continuing))
    },
    transcript => {
      const messages = JSON.stringify(transcript.messages)
      assert.ok(messages.includes('First patch verified.'))
      assert.ok(!messages.includes('Private parent-only note'))
      assert.equal(transcript.messages.filter(message => message.role === 'user').length, 1)
      return fauxAssistantMessage(JSON.stringify(complete))
    }, fauxAssistantMessage('Checked worker report.'),
  ])
  assert.equal((await run(root)).status, 'done')
  const result = await output(root)
  assert.equal(result.isError, false)
  assert.equal(result.value.result.status, 'complete')
  assert.equal(result.value.result.roundsStarted, 2)
  assert.deepEqual(result.value.result.report, complete)
  const children = await harness.commit(tx => tx.scanConversations({ ownerConversationId: root.id }, 100), context)
  assert.equal(children.items.length, 2)
  assert.notEqual(children.items[0]!.id, children.items[1]!.id)
  assert.match((await plugin.commands!.ralph!('status', { harness, conversation: root, context })).output!, /Requested work verified/)
})

for (const [name, reports, maxRounds, expected] of [
  ['concrete blocker', [blocked], 3, 'blocked'],
  ['budget exhaustion', [continuing, continuing], 2, 'budget-limited'],
  ['child failure retains prior handoff', [continuing, null], 3, 'round-failed'],
] as const) {
  test(`Ralph ${name}`, { timeout: 8000 }, async t => {
    const { root } = await setup(t, [call(maxRounds), ...reports.map(report => report ? fauxAssistantMessage(JSON.stringify(report)) : fauxAssistantMessage('', { stopReason: 'error', errorMessage: 'child unavailable' })), fauxAssistantMessage('Reported.')])
    await run(root)
    const result = await output(root)
    assert.equal(result.value.result.status, expected)
    assert.equal(result.value.agentsStarted, reports.length)
    assert.equal(result.isError, expected === 'round-failed')
    if (expected === 'round-failed') assert.deepEqual(result.value.result.report, continuing)
  })
}

for (const [name, report] of [
  ['arbitrary DONE text', 'Work DONE, everything complete.'],
  ['unsupported completion shape', JSON.stringify({ status: 'DONE', report: 'complete' })],
  ['completion without evidence', JSON.stringify({ ...complete, evidence: [] })],
  ['continuation without next action', JSON.stringify({ ...continuing, nextSteps: [] })],
  ['blocked without concrete reason', JSON.stringify({ ...blocked, blocker: '' })],
  ['oversized report', JSON.stringify({ ...continuing, summary: 'x'.repeat(17_000) })],
] as const) {
  test(`Ralph rejects ${name}`, { timeout: 8000 }, async t => {
    const { root } = await setup(t, [call(3), fauxAssistantMessage(report), fauxAssistantMessage('Reported invalid worker output.')])
    await run(root)
    const result = await output(root)
    assert.equal(result.isError, true)
    assert.notEqual(result.value.result.status, 'complete')
    assert.equal(result.value.agentsStarted, 1)
  })
}

test('Ralph default is 64 rounds and deployment ceiling is 256', () => {
  const tool = createRalphPlugin().extension.tools![0]!
  const schema = tool.parameters as ReturnType<typeof Type.Object>
  assert.equal((schema.properties.maxRounds as { maximum: number }).maximum, 256)
  assert.match(tool.description, /Default 64 rounds/)
  assert.throws(() => createRalphPlugin({ maxRounds: 257 }), /256/)
  assert.throws(() => createRalphPlugin({ maxRounds: 2, defaultRounds: 3 }), /ceiling/)
})

test('Ralph validates normalized report invariants', () => {
  assert.deepEqual(validateRalphReport(complete), complete)
  assert.throws(() => validateRalphReport({ ...complete, summary: ' padded ' }), /Invalid/)
  assert.throws(() => validateRalphReport({ ...complete, evidence: [''] }), /Invalid/)
  assert.throws(() => validateRalphReport({ ...complete, extra: true }), /Invalid/)
})

test('Ralph duplicate execution uses durable result receipt', { timeout: 8000 }, async t => {
  const plugin = createRalphPlugin({ timeoutMs: 2000 })
  const original = plugin.extension.tools![0]!
  const repeat = defineExtension({ ...plugin.extension, tools: [{ ...original, execute: async (args, api, ctx) => {
    const first = await original.execute(args, api, ctx)
    assert.deepEqual(await original.execute(args, api, ctx), first)
    return first
  } }] })
  const { root, harness, faux } = await setup(t, [call(2), fauxAssistantMessage(JSON.stringify(complete)), fauxAssistantMessage('Done.')], [repeat])
  await run(root)
  assert.equal(faux.state.callCount, 3)
  assert.equal((await harness.snapshot(RalphDoc, root.id, context))!.runs.length, 1)
  assert.equal((await harness.commit(tx => tx.scanConversations({ ownerConversationId: root.id }, 100), context)).items.length, 1)
})

test('cancelling Ralph stops its owned child before starting another round', { timeout: 8000 }, async t => {
  let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve })
  let stopped = false
  const gate = defineExtension({ name: 'gate', tools: [defineTool({ name: 'gate', description: 'Wait for cancellation.', parameters: Type.Object({}), execute: async (_args, _api, ctx) => {
    entered()
    await new Promise<void>((_resolve, reject) => { ctx.abortSignal?.addEventListener('abort', () => { stopped = true; reject(new Error('stopped')) }, { once: true }) })
    return {}
  } })] })
  const { root, harness, plugin } = await setup(t, [call(3), fauxAssistantMessage([fauxToolCall('gate', {})], { stopReason: 'toolUse' })], [gate])
  const pending = run(root)
  await started
  await root.abort(context)
  assert.equal((await pending).status, 'unanswered')
  await harness.waitForIdle(context)
  assert.equal(stopped, true)
  assert.equal((await harness.commit(tx => tx.scanConversations({ ownerConversationId: root.id }, 100), context)).items.length, 1)
  assert.match((await plugin.commands!.ralph!('status', { harness, conversation: root, context })).output!, /cancelled/)
})
