import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { Type, type FauxResponseStep } from '@earendil-works/pi-ai'
import { createModels } from '@earendil-works/pi-ai/models'
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import {
  createRegistry, defineExtension, defineTool, Harness, MemoryStorage, section,
  type Conversation, type Extension,
} from '@earendil-works/pi-durable'
import { SubagentPlugin } from '../src/plugins/subagent.ts'

const context = BACKGROUND_CONTEXT
const delegate = (args: { prompt: string; description?: string }, id = 'delegate') => fauxToolCall('subagent', { description: 'Scoped child work', ...args, run_in_background: false }, { id })
const toolRound = (...calls: ReturnType<typeof delegate>[]) => fauxAssistantMessage(calls, { stopReason: 'toolUse' })
async function setup(t: TestContext, responses: FauxResponseStep[], extension = SubagentPlugin.extension, extras: Extension[] = []) {
  const faux = fauxProvider()
  faux.setResponses(responses)
  const models = createModels()
  models.setProvider(faux.provider)
  const registry = createRegistry()
  registry.install(extension)
  for (const extra of extras) registry.install(extra)
  const harness = await Harness.open(new MemoryStorage(), { models, registry, settings: { retry: { maxRetries: 0 } } }, context)
  t.after(() => harness.close(context))
  const root = await harness.root(context, { agent: { model: { provider: 'faux', modelId: 'faux-1' }, thinkingLevel: 'high', cwd: '/tmp/pie2-parent', instructions: 'Inherited project instruction.' } })
  return { faux, harness, root }
}
async function run(root: Conversation) {
  return (await root.submit({ type: 'input', content: 'Private parent context: delegate the requested work.' }, context)).wait(context)
}
async function results(root: Conversation) {
  return (await root.entries({ order: 'ascending' }, 100, undefined, context)).items.flatMap(entry => entry.model ?? []).filter(message => message.role === 'toolResult')
}
async function agents(harness: Harness, root: Conversation, args = '') {
  return SubagentPlugin.commands!.agents!(args, { harness, conversation: root, context })
}

test('DSH tool names and schemas have no task IDs or legacy aliases', () => {
  const tools = SubagentPlugin.extension.tools!
  assert.deepEqual(tools.map(tool => tool.name), ['subagent', 'send_message', 'interrupt_agent'])
  const schemas = tools.map(tool => tool.parameters as ReturnType<typeof Type.Object>)
  assert.deepEqual(schemas[0]!.required, ['description', 'prompt'])
  assert.deepEqual(Object.keys(schemas[0]!.properties), ['description', 'prompt', 'run_in_background'])
  assert.deepEqual(schemas[1]!.required, ['subagent_id', 'message'])
  assert.deepEqual(schemas[2]!.required, ['agent_id'])
})

test('foreground returns real answer and inherits tools, skills and config without parent transcript or goal', async t => {
  const skills = defineExtension({ name: 'skills', sections: [section('skills', () => 'Available skill: code-review')] })
  const goal = defineExtension({ name: 'goal', sections: [section('goal', () => 'Parent-only goal')], tools: [defineTool({ name: 'GoalSet', description: 'Parent goal.', parameters: Type.Object({}), execute: async () => ({}) })] })
  const background = defineExtension({ name: 'background' })
  const { harness, root } = await setup(t, [
    toolRound(delegate({ prompt: 'Name three primes.', description: 'Find primes' })),
    transcript => {
      assert.ok(!JSON.stringify(transcript.messages).includes('Private parent context'))
      assert.ok(JSON.stringify(transcript).includes('Inherited project instruction.'))
      assert.ok(JSON.stringify(transcript).includes('Available skill: code-review'))
      assert.ok(!JSON.stringify(transcript).includes('Parent-only goal'))
      return fauxAssistantMessage('2, 3, 5')
    },
    fauxAssistantMessage('Delegation finished.'),
  ], SubagentPlugin.extension, [skills, goal, background])
  assert.equal((await run(root)).status, 'done')
  const [result] = await results(root)
  assert.equal(result!.isError, false)
  assert.deepEqual(result!.content, [{ type: 'text', text: '2, 3, 5' }])
  const children = await harness.commit(tx => tx.scanConversations({ ownerConversationId: root.id }, 100), context)
  assert.equal(children.items.length, 1)
  const child = (await harness.conversation(children.items[0]!.id, context))!
  const agent = await child.agent(context)
  const delegated = (await child.entries({ order: 'ascending' }, 100, undefined, context)).items.find(entry => entry.kind === 'pie2.coordinator-message')
  assert.ok(delegated)
  assert.deepEqual(delegated.data, { senderConversationId: root.id })
  assert.equal(agent.cwd, '/tmp/pie2-parent')
  assert.equal(agent.thinkingLevel, 'high')
  assert.deepEqual(agent.model, { provider: 'faux', modelId: 'faux-1' })
  assert.deepEqual(agent.extensions.map(extension => extension.name), ['subagent', 'skills', 'background'])
  assert.ok(agent.tools.some(tool => tool.name === 'subagent'))
  assert.ok(!agent.tools.some(tool => tool.name === 'GoalSet'))
  assert.match((await agents(harness, root)).output!, /Find primes/)
})

test('foreground replay reuses its owned child and submission', async t => {
  const original = SubagentPlugin.extension.tools![0]!
  const extension = defineExtension({ ...SubagentPlugin.extension, tools: [{ ...original,
    execute: async (args, api, callContext) => {
      const first = await original.execute(args, api, callContext)
      assert.deepEqual(await original.execute(args, api, callContext), first)
      assert.equal((first.structuredOutput as { kind: string }).kind, 'foreground')
      return first
    },
  }, ...SubagentPlugin.extension.tools!.slice(1)] })
  const { harness, root, faux } = await setup(t, [toolRound(delegate({ prompt: 'One answer.' })), fauxAssistantMessage('Only child answer.'), fauxAssistantMessage('Parent answer.')], extension)
  await run(root)
  assert.equal(faux.state.callCount, 3)
  assert.equal((await harness.commit(tx => tx.scanConversations({ ownerConversationId: root.id }, 100), context)).items.length, 1)
})

test('foreground child failures return actual provider errors', async t => {
  const { root } = await setup(t, [toolRound(delegate({ prompt: 'Do work.' })), fauxAssistantMessage('', { stopReason: 'error', errorMessage: 'Child provider failed' }), fauxAssistantMessage('Reported blocker.')])
  await run(root)
  const [result] = await results(root)
  assert.equal(result!.isError, true)
  assert.match(JSON.stringify(result!.content), /Child provider failed/)
})

test('foreground failure preserves partial assistant text from this turn', async t => {
  const { root } = await setup(t, [toolRound(delegate({ prompt: 'Do work.' })), fauxAssistantMessage('Partial child evidence.', { stopReason: 'error', errorMessage: 'Child provider failed' }), fauxAssistantMessage('Reported blocker.')])
  await run(root)
  const [result] = await results(root)
  assert.equal(result!.isError, true)
  assert.match(JSON.stringify(result!.content), /Child provider failed/)
  assert.match(JSON.stringify(result!.content), /Partial child evidence/)
})

test('children preserve the parent model tool visibility filter', async t => {
  const hidden = defineExtension({ name: 'hidden', tools: [defineTool({ name: 'HiddenTool', description: 'Not exposed to this model.', parameters: Type.Object({}), execute: async () => ({}) })] })
  const { harness, root } = await setup(t, [toolRound(delegate({ prompt: 'Do work.' })), fauxAssistantMessage('Child answer.'), fauxAssistantMessage('Done.')], SubagentPlugin.extension, [hidden])
  await root.configure({ modelTools: SubagentPlugin.extension.tools! }, context)
  await run(root)
  const children = await harness.commit(tx => tx.scanConversations({ ownerConversationId: root.id }, 100), context)
  const child = (await harness.conversation(children.items[0]!.id, context))!
  const agent = await child.agent(context)
  assert.ok(!agent.tools.some(tool => tool.name === 'HiddenTool'))
})

for (const args of [{ prompt: ' \n ' }, { prompt: 'work', description: '  ' }]) {
  test('blank delegation content is rejected before creation: ' + JSON.stringify(args), async t => {
    const { harness, root } = await setup(t, [toolRound(delegate(args)), fauxAssistantMessage('Invalid request.')])
    await run(root)
    assert.equal((await results(root))[0]!.isError, true)
    assert.equal((await harness.commit(tx => tx.scanConversations({ ownerConversationId: root.id }, 100), context)).items.length, 0)
  })
}

test('two independent foreground delegations start together before either gate is released', { timeout: 10000 }, async t => {
  let visits = 0
  let bothEntered!: () => void
  const entered = new Promise<void>(resolve => { bothEntered = resolve })
  let release!: () => void
  const released = new Promise<void>(resolve => { release = resolve })
  const gate = defineExtension({ name: 'parallel-gate', tools: [defineTool({
    name: 'ParallelGate', description: 'Wait until both independent delegates are running.', parameters: Type.Object({}), replay: 'safe',
    execute: async (_args, _api, ctx) => {
      if (++visits === 2) bothEntered()
      await new Promise<void>((resolve, reject) => {
        const abort = () => reject(new Error('Gate cancelled'))
        ctx.abortSignal?.addEventListener('abort', abort, { once: true })
        released.then(() => { ctx.abortSignal?.removeEventListener('abort', abort); resolve() }, reject)
      })
      return { output: [{ type: 'text', text: 'Released.' }] }
    },
  })] })
  const { harness, root } = await setup(t, [
    toolRound(delegate({ prompt: 'First independent task.' }, 'first'), delegate({ prompt: 'Second independent task.' }, 'second')),
    toolRound(fauxToolCall('ParallelGate', {})), toolRound(fauxToolCall('ParallelGate', {})),
    fauxAssistantMessage('First answer.'), fauxAssistantMessage('Second answer.'), fauxAssistantMessage('Collected both.'),
  ], SubagentPlugin.extension, [gate])
  const settled = run(root)
  await entered
  assert.equal(visits, 2)
  assert.equal((await harness.commit(tx => tx.scanConversations({ ownerConversationId: root.id }, 100), context)).items.length, 2)
  release()
  assert.equal((await settled).status, 'done')
  const output = await results(root)
  assert.equal(output.length, 2)
  assert.ok(output.every(result => !result.isError))
})

test('nested foreground delegation enforces absolute depth three', async t => {
  const { harness, root } = await setup(t, [
    toolRound(delegate({ prompt: 'depth 1' })), toolRound(delegate({ prompt: 'depth 2' })), toolRound(delegate({ prompt: 'depth 3' })),
    toolRound(delegate({ prompt: 'depth 4' })),
    fauxAssistantMessage('Depth limit reached.'), fauxAssistantMessage('Depth 2 finished.'), fauxAssistantMessage('Depth 1 finished.'), fauxAssistantMessage('Root finished.'),
  ])
  assert.equal((await run(root)).status, 'done')
  let parent = root.id
  for (let depth = 1; depth <= 3; depth++) {
    const children = await harness.commit(tx => tx.scanConversations({ ownerConversationId: parent }, 100), context)
    assert.equal(children.items.length, 1)
    parent = children.items[0]!.id
  }
  const deepest = (await harness.conversation(parent, context))!
  assert.ok(!(await deepest.agent(context)).tools.some(tool => tool.name === 'subagent'))
  assert.equal((await results(deepest))[0]!.isError, true)
  assert.equal((await harness.commit(tx => tx.scanConversations({ ownerConversationId: parent }, 100), context)).items.length, 0)
})

async function runningChild(t: TestContext) {
  let entered!: () => void
  const started = new Promise<void>(resolve => { entered = resolve })
  const slow = defineExtension({ name: 'slow', tools: [defineTool({
    name: 'slow', parameters: Type.Object({}), description: 'Wait until aborted.',
    execute: async (_args, _api, callContext) => {
      entered()
      await new Promise<void>((_resolve, reject) => {
        if (callContext.abortSignal?.aborted) reject(new Error('Aborted'))
        else callContext.abortSignal?.addEventListener('abort', () => reject(new Error('Aborted')), { once: true })
      })
      return {}
    },
  })] })
  const result = await setup(t, [toolRound(delegate({ prompt: 'Wait for work.' })), toolRound(fauxToolCall('slow', {}, { id: 'slow' })), fauxAssistantMessage('Child stopped.')], SubagentPlugin.extension, [slow])
  const settled = run(result.root)
  await started
  return { ...result, settled }
}
test('explicit foreground stop aborts the owned turn', { timeout: 10000 }, async t => {
  const { harness, root, settled } = await runningChild(t)
  const records = JSON.parse((await agents(harness, root)).output!) as { id: number }[]
  await agents(harness, root, `stop ${records[0]!.id}`)
  await settled
  assert.equal((await results(root))[0]!.isError, true)
})
test('parent abort stops foreground child through native ownership cleanup', { timeout: 10000 }, async t => {
  const { harness, root, settled } = await runningChild(t)
  await root.abort(context)
  assert.equal((await settled).status, 'unanswered')
  await SubagentPlugin.afterInterrupt!({ harness, conversation: root, context })
  await harness.waitForIdle(context)
})
test('/agents rejects foreign conversations and malformed commands', async t => {
  const { harness, root } = await setup(t, [])
  assert.equal((await agents(harness, root)).output, 'No subagents.')
  const foreign = await harness.createConversation({ ownership: { kind: 'ownerless' } }, context)
  await assert.rejects(agents(harness, root, `stop ${foreign.id}`), /Unknown subagent/)
  await assert.rejects(agents(harness, root, 'stop'), /Usage:/)
  await assert.rejects(agents(harness, root, 'stop 1 extra'), /Usage:/)
})
