import assert from 'node:assert/strict'
import { test } from 'node:test'
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { createModels } from '@earendil-works/pi-ai/models'
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type FauxResponseStep } from '@earendil-works/pi-ai/providers/faux'
import {
  createRegistry, defineDoc, defineExtension, defineTask, defineTool, GenerationTask, Harness, hook, MemoryStorage,
  type GenerationHooks, type JsonObject, wrapTool,
} from '@earendil-works/pi-durable'
import { Type } from 'typebox'
import { createGoalPlugin, GoalDoc } from '../src/plugins/goal.ts'

async function setup() {
  const models = createModels()
  const faux = fauxProvider()
  models.setProvider(faux.provider)
  const registry = createRegistry()
  let harness: Harness
  const plugin = createGoalPlugin(() => harness)
  registry.install(plugin.extension)
  harness = await Harness.open(new MemoryStorage(), { models, registry, settings: { retry: { enabled: false } } }, context)
  const conversation = await harness.root(context, { agent: { model: { provider: 'faux', modelId: 'faux-1' } } })
  return { faux, registry, plugin, harness, conversation, context }
}
type Env = Awaited<ReturnType<typeof setup>>
const call = (name: string, args: JsonObject) => fauxAssistantMessage(fauxToolCall(name, args), { stopReason: 'toolUse' })
const reply = (message = 'Done.') => fauxAssistantMessage(message)
async function goal(env: Env) { return (await env.harness.snapshot(GoalDoc, env.conversation.id, context))?.goal ?? null }
async function command(env: Env, args = '') { return env.plugin.commands!.goal!(args, env) }
async function run(env: Env, responses: FauxResponseStep[], entry?: { kind: string }) {
  env.faux.setResponses(responses)
  return (await env.conversation.submit({ type: 'input', content: '请完成这个多步骤目标并验证。', ...(entry ? { entry } : {}) }, context)).wait(context)
}
function update(env: Env, action: string, args: JsonObject = {}): FauxResponseStep {
  return async () => {
    const current = await goal(env)
    return call('update_goal', { goal_id: current!.id, revision: current!.revision, action, ...args })
  }
}
async function results(env: Env, name: string) {
  return (await env.conversation.context(context)).messages.filter(message => message.role === 'toolResult' && message.toolName === name)
}
async function paused(env: Env) {
  await command(env, 'Implement and verify the feature')
  await command(env, 'pause')
}

for (const status of ['active', 'paused', 'blocked', 'completed'] as const) {
  test(`legacy ${status} Goal migrates once without losing objective or spent budget`, async t => {
    const env = await setup()
    t.after(() => env.harness.close(context))
    const LegacyDoc = defineDoc<{ goal: { objective: string; status: string; rounds: number; maxRounds: number } | null }>({
      kind: 'pie2.goal', version: 1, scope: 'conversation', history: 'rewindable', fork: 'asOf',
      initial: () => ({ goal: null }), checkpointWhen: () => true,
    })
    await env.conversation.commit(async tx => {
      const doc = await tx.doc(LegacyDoc, env.conversation.id)
      doc.goal = { objective: 'Keep the existing work', status, rounds: status === 'blocked' ? 20 : 4, maxRounds: 20 }
    }, context)
    const before = await goal(env)
    assert.deepEqual(await goal(env), before, 'read-only migration must have stable identity')
    const output = (await command(env)).output!
    assert.match(output, /Activation: disarmed/)
    const current = (await goal(env))!
    assert.equal(current.objective, 'Keep the existing work')
    assert.equal(current.maxGoalRounds, 20)
    assert.equal(current.roundsStarted, status === 'blocked' ? 20 : 4)
    assert.equal(current.phase, status === 'completed' ? 'complete' : status)
    assert.equal(current.createdAt, 0)
    assert.equal(current.updatedAt, 0)
    assert.equal(current.id, before!.id)
    assert.match(current.id, /^[0-9a-f-]{36}$/)
    if (status === 'blocked') {
      assert.equal(current.blockedReason?.code, 'round-limit')
      await assert.rejects(command(env, 'resume'), /edit max_goal_rounds/)
    }
    await assert.rejects(env.harness.snapshot(LegacyDoc, env.conversation.id, context), /newer version 2/)
  })
}

test('Goal exposes only the DSH tools and always injects policy before any goal exists', async t => {
  const env = await setup()
  t.after(() => env.harness.close(context))
  assert.deepEqual(env.plugin.extension.tools!.map(tool => tool.name), ['get_goal', 'create_goal', 'update_goal'])
  await run(env, [transcript => {
    const prompt = JSON.stringify(transcript)
    assert.match(prompt, /goal_policy/)
    assert.match(prompt, /any language/)
    assert.match(prompt, /routine single-turn/)
    assert.match(prompt, /get_goal before update_goal/)
    assert.match(prompt, /disarmed/)
    assert.match(prompt, /3 consecutive/)
    return reply()
  }])
  assert.equal(await goal(env), null)
})

function installNoticeTool(env: Env) {
  env.registry.install(defineExtension({ name: 'notice-test', tools: [defineTool({
    name: 'inject_notice', description: 'Inject a passive background notice.', parameters: Type.Object({}),
    execute: async (_args, api, callContext) => {
      await env.conversation.submit({ type: 'write', entry: { kind: 'plugin.notice', model: [{ role: 'user', content: 'Background status changed.', timestamp: api.now() }] } }, callContext)
      return { output: [{ type: 'text', text: 'Notice injected.' }] }
    },
  })] }))
}

test('a passive notice within a direct human turn does not revoke human Goal authority', async t => {
  const env = await setup()
  t.after(() => env.harness.close(context))
  installNoticeTool(env)
  await run(env, [call('inject_notice', {}), call('create_goal', { objective: 'Complete the human request' }), update(env, 'complete'), reply()])
  const created = (await results(env, 'create_goal'))[0]
  assert.ok(created?.role === 'toolResult' && !created.isError)
  assert.equal((await goal(env))!.phase, 'complete')
})

test('a passive notice within an automatic round keeps only exact-round Goal authority', async t => {
  const env = await setup()
  t.after(() => env.harness.close(context))
  installNoticeTool(env)
  await run(env, [
    call('create_goal', { objective: 'Finish verified work', max_goal_rounds: 2 }), reply('Progress.'),
    call('inject_notice', {}), update(env, 'edit', { objective: 'Must not widen authority' }), update(env, 'complete'), reply(),
  ])
  const changed = await results(env, 'update_goal')
  assert.ok(changed[0]?.role === 'toolResult' && changed[0].isError)
  assert.ok(changed[1]?.role === 'toolResult' && !changed[1].isError)
  assert.equal((await goal(env))!.objective, 'Finish verified work')
  assert.equal((await goal(env))!.phase, 'complete')
})

test('direct human intent can create a UUID goal with a 256-round default and complete it', async t => {
  const env = await setup()
  t.after(() => env.harness.close(context))
  await run(env, [call('create_goal', { objective: '  实现功能并验证  ' }), call('get_goal', {}), update(env, 'complete'), reply()])
  const current = (await goal(env))!
  assert.match(current.id, /^[0-9a-f-]{36}$/)
  assert.equal(current.objective, '实现功能并验证')
  assert.equal(current.maxGoalRounds, 256)
  assert.equal(current.roundsStarted, 0)
  assert.equal(current.phase, 'complete')
  assert.equal(current.revision, 2)
  assert.ok(current.createdAt <= current.updatedAt)
  const reads = await results(env, 'get_goal')
  assert.match(JSON.stringify(reads), /armed/)
})

test('update_goal rejects stale IDs and revisions without changing state', async t => {
  const env = await setup()
  t.after(() => env.harness.close(context))
  await paused(env)
  const current = (await goal(env))!
  await run(env, [
    call('update_goal', { goal_id: 'wrong', revision: current.revision, action: 'complete' }),
    call('update_goal', { goal_id: current.id, revision: current.revision - 1, action: 'complete' }), reply(),
  ])
  assert.deepEqual(await goal(env), current)
  const updates = await results(env, 'update_goal')
  assert.equal(updates.length, 2)
  assert.ok(updates.every(result => result.role === 'toolResult' && result.isError))
  assert.match(JSON.stringify(updates), /Stale goal ref/)
})

test('edit preserves phase, budget spent and activation; pause/resume/complete enforce transitions', async t => {
  const env = await setup()
  t.after(() => env.harness.close(context))
  await paused(env)
  await run(env, [update(env, 'edit', { objective: 'Revised objective', max_goal_rounds: 5 }), reply()])
  assert.equal((await goal(env))!.phase, 'paused')
  assert.equal((await goal(env))!.revision, 3)
  assert.equal((await goal(env))!.maxGoalRounds, 5)
  assert.match((await command(env)).output!, /disarmed/)
  await assert.rejects(command(env, 'pause'), /active/)
  assert.ok((await command(env, 'resume')).prompt)
  await assert.rejects(command(env, 'resume'), /armed/)
  await run(env, [update(env, 'complete'), reply()])
  assert.equal((await goal(env))!.phase, 'complete')
  await assert.rejects(command(env, 'resume'), /complete/)
})

test('completed goals can be replaced; other phases require clear, and clear preserves no current goal', async t => {
  const env = await setup()
  t.after(() => env.harness.close(context))
  await paused(env)
  await assert.rejects(command(env, 'Replacement goal'), /already exists/)
  const oldId = (await goal(env))!.id
  await run(env, [update(env, 'complete'), reply()])
  assert.ok((await command(env, 'Replacement goal')).prompt)
  assert.notEqual((await goal(env))!.id, oldId)
  assert.equal((await goal(env))!.revision, 1)
  assert.equal((await goal(env))!.roundsStarted, 0)
  await command(env, 'clear')
  assert.equal(await goal(env), null)
  assert.equal((await command(env)).output, 'No goal.')
  assert.equal((await command(env, 'clear')).output, 'No goal to clear.')
})

test('human Goal controls match whole input and editing a completed goal creates a fresh goal', async t => {
  const env = await setup()
  t.after(() => env.harness.close(context))
  await command(env, 'Verify the feature')
  const original = (await goal(env))!
  await assert.rejects(command(env, 'clear the tests'), /already exists/)
  assert.deepEqual(await goal(env), original)
  await command(env, 'PAUSE')
  assert.equal((await goal(env))!.phase, 'paused')
  await command(env, 'ReSuMe')
  assert.equal((await goal(env))!.phase, 'active')
  await run(env, [update(env, 'complete'), reply()])
  const result = await command(env, 'EDIT Verify the next feature')
  assert.ok(result.prompt)
  const next = (await goal(env))!
  assert.notEqual(next.id, original.id)
  assert.equal(next.objective, 'Verify the next feature')
  assert.equal(next.phase, 'active')
  assert.equal(next.revision, 1)
  assert.equal(next.roundsStarted, 0)
  assert.match((await command(env)).output!, /Activation: armed/)
  await command(env, 'clear')
  await command(env, 'pause the dev server')
  assert.equal((await goal(env))!.objective, 'pause the dev server')
})

test('automatic rounds are admitted once, keep revision stable, and block at the round limit', async t => {
  const env = await setup()
  t.after(() => env.harness.close(context))
  await run(env, [
    call('create_goal', { objective: 'Finish the work', max_goal_rounds: 1 }), reply('Progress.'),
    async transcript => {
      const current = (await goal(env))!
      assert.equal(current.roundsStarted, 1)
      assert.equal(current.revision, 1)
      assert.match(JSON.stringify(transcript), /<goal_round>/)
      assert.match(JSON.stringify(transcript), /Make concrete progress and verify/)
      return reply('More remains.')
    },
  ])
  const current = (await goal(env))!
  assert.equal(current.roundsStarted, 1)
  assert.equal(current.maxGoalRounds, 1)
  assert.equal(current.revision, 2)
  assert.equal(current.phase, 'blocked')
  assert.equal(current.blockedReason?.code, 'round-limit')
  assert.match((await command(env)).output!, /disarmed/)
  await assert.rejects(command(env, 'resume'), /edit max_goal_rounds/)
  assert.equal((await goal(env))!.roundsStarted, 1)
  await run(env, [update(env, 'edit', { max_goal_rounds: 2 }), reply()])
  assert.equal((await goal(env))!.phase, 'blocked')
  assert.equal((await goal(env))!.roundsStarted, 1)
  await command(env, 'resume')
  assert.equal((await goal(env))!.phase, 'active')
  assert.equal((await goal(env))!.blockedReason, undefined)
  await command(env, 'pause')
})

test('automatic rounds cannot create, edit, pause or resume goals, but can complete the exact goal', async t => {
  const env = await setup()
  t.after(() => env.harness.close(context))
  await run(env, [
    call('create_goal', { objective: 'Finish the work', max_goal_rounds: 2 }), reply('Progress.'),
    call('create_goal', { objective: 'Another goal' }), update(env, 'edit', { objective: 'Wrong' }),
    update(env, 'pause'), update(env, 'resume'), update(env, 'complete'), reply('Verified complete.'),
  ])
  const creates = await results(env, 'create_goal')
  assert.ok(creates[1]?.role === 'toolResult' && creates[1].isError)
  const updates = await results(env, 'update_goal')
  assert.equal(updates.length, 4)
  assert.ok(updates.slice(0, 3).every(result => result.role === 'toolResult' && result.isError))
  assert.ok(updates[3]?.role === 'toolResult' && !updates[3].isError)
  assert.match(JSON.stringify(updates[3]), /<goal_complete>/)
  assert.match(JSON.stringify(updates[3]), /Do not call any more tools/)
  assert.match(JSON.stringify(updates[3]), /actually establish/)
  assert.equal((await goal(env))!.phase, 'complete')
  assert.equal((await goal(env))!.roundsStarted, 1)
})

test('blocked autonomous reports require three admitted rounds and a concrete reason', async t => {
  const env = await setup()
  t.after(() => env.harness.close(context))
  await run(env, [
    call('create_goal', { objective: 'Use the unavailable service', max_goal_rounds: 4 }), reply(),
    update(env, 'blocked', { blocked_reason: 'Missing credentials' }), reply('Tried round one.'),
    update(env, 'blocked', { blocked_reason: 'Missing credentials' }), reply('Tried round two.'),
    update(env, 'blocked', { blocked_reason: '   ' }),
    update(env, 'blocked', { blocked_reason: ' Missing credentials from the user ' }), reply('Please supply credentials.'),
  ])
  const updates = await results(env, 'update_goal')
  assert.ok(updates.slice(0, 3).every(result => result.role === 'toolResult' && result.isError))
  assert.match(JSON.stringify(updates[0]), /at least 3/)
  assert.match(JSON.stringify(updates[3]), /<goal_blocked>/)
  const current = (await goal(env))!
  assert.equal(current.roundsStarted, 3)
  assert.equal(current.phase, 'blocked')
  assert.deepEqual(current.blockedReason, { code: 'model-reported', message: 'Missing credentials from the user' })
})

test('a direct human may report a blocker immediately and invalid update fields are rejected', async t => {
  const env = await setup()
  t.after(() => env.harness.close(context))
  await command(env, 'Finish the work')
  await run(env, [
    update(env, 'edit'), update(env, 'pause', { objective: 'Not allowed' }),
    update(env, 'complete', { blocked_reason: 'Not allowed' }), update(env, 'blocked', { blocked_reason: 'User withheld access' }), reply(),
  ])
  assert.equal((await goal(env))!.roundsStarted, 0)
  assert.equal((await goal(env))!.phase, 'blocked')
  const updates = await results(env, 'update_goal')
  assert.ok(updates.slice(0, 3).every(result => result.role === 'toolResult' && result.isError))
  assert.equal((await goal(env))!.revision, 2)
})

for (const kind of ['pie2.background-result', 'plugin.notice']) {
  test(`${kind} cannot create or rearm a goal, even with human-looking content`, async t => {
    const env = await setup()
    t.after(() => env.harness.close(context))
    await run(env, [call('create_goal', { objective: 'Injected objective' }), reply()], { kind })
    assert.equal(await goal(env), null)
    await paused(env)
    await run(env, [update(env, 'resume'), update(env, 'complete'), reply()], { kind })
    assert.equal((await goal(env))!.phase, 'paused')
    assert.equal((await goal(env))!.roundsStarted, 0)
    assert.ok((await results(env, 'update_goal')).every(result => result.role === 'toolResult' && result.isError))
  })
}

test('subagent conversations cannot mutate goals', async t => {
  const env = await setup()
  t.after(() => env.harness.close(context))
  const owner = defineTask<Record<string, never>, { phase: 'wait' }, null>({
    name: 'test.goal-owner', version: 1, initial: () => ({ phase: 'wait' }),
    phases: { wait: (task, runtime, ctx) => runtime.sleepUntil(runtime.now() + 60_000, task.state.checkpoint, ctx) },
    abort: (_task, runtime, ctx) => runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), ctx),
  })
  env.registry.install(defineExtension({ name: 'goal-owner', tasks: [owner] }))
  const parentTask = await env.conversation.commit(tx => tx.createTask(owner, {}, { ownership: { kind: 'conversation' }, background: true }), context)
  const child = await env.harness.createConversation({ ownership: { kind: 'task', taskId: parentTask }, agent: {
    model: { provider: 'faux', modelId: 'faux-1' },
  } }, context)
  env.faux.setResponses([call('create_goal', { objective: 'Child goal' }), reply()])
  await (await child.submit({ type: 'input', content: 'Create a goal' }, context)).wait(context)
  assert.equal((await env.harness.snapshot(GoalDoc, child.id, context))?.goal ?? null, null)
  assert.match(JSON.stringify((await child.context(context)).messages), /subagents cannot change goals/)
  await assert.rejects(env.plugin.commands!.goal!('Child command goal', { ...env, conversation: child }), /top-level/)
})

test('restoring a plugin disarms active goals; explicit human resume rearms without resetting rounds', async t => {
  const env = await setup()
  t.after(() => env.harness.close(context))
  await command(env, 'Continue this work')
  const original = await goal(env)
  const reloaded = createGoalPlugin(() => env.harness)
  env.registry.install(reloaded.extension)
  env.plugin = reloaded
  await run(env, [reply('Status only.')])
  assert.deepEqual(await goal(env), original)
  assert.match((await command(env)).output!, /active.*rounds 0\/256.*Activation: disarmed/s)
  await run(env, [update(env, 'resume'), reply('Continue.'), update(env, 'complete'), reply('Complete.')])
  assert.equal((await goal(env))!.roundsStarted, 1)
  assert.equal((await goal(env))!.revision, 3)
  assert.equal((await goal(env))!.phase, 'complete')
})

test('interrupt pauses an active goal and model errors only disarm it', async t => {
  const env = await setup()
  t.after(() => env.harness.close(context))
  await command(env, 'Continue this work')
  await env.plugin.interrupt!(env)
  assert.equal((await goal(env))!.phase, 'paused')
  assert.equal((await goal(env))!.revision, 2)
  await command(env, 'resume')
  await run(env, [fauxAssistantMessage('', { stopReason: 'error', errorMessage: 'Unavailable' })])
  assert.equal((await goal(env))!.phase, 'active')
  assert.match((await command(env)).output!, /disarmed/)
})

test('queued human input takes priority without spending an automatic round', async t => {
  const env = await setup()
  t.after(() => env.harness.close(context))
  await command(env, 'Do the work')
  await run(env, [async () => {
    await env.conversation.submit({ type: 'input', content: 'Stop and finish here', whenBusy: 'followUp' }, context)
    return reply('Handing over.')
  }, update(env, 'complete'), reply()])
  await env.conversation.waitForIdle(context)
  assert.equal((await goal(env))!.roundsStarted, 0)
  assert.equal((await goal(env))!.phase, 'complete')
})

test('replaying request and yield hooks does not double-admit a round or spend reserved rounds', async t => {
  const env = await setup()
  t.after(() => env.harness.close(context))
  const handlers = env.plugin.extension.hooks![0]!.handlers as GenerationHooks
  let repeated = 0
  env.registry.install(defineExtension({ ...env.plugin.extension, hooks: [hook(GenerationTask, {
    ...handlers,
    beforeRequest: async (request, api, ctx) => {
      await handlers.beforeRequest(request, api, ctx)
      await handlers.beforeRequest(request, api, ctx)
      return undefined
    },
    onYield: async (answer, api, ctx) => {
      const first = await handlers.onYield(answer, api, ctx)
      const second = await handlers.onYield(answer, api, ctx)
      assert.deepEqual(first, second)
      if (first) {
        repeated++
        assert.equal((await goal(env))!.roundsStarted, 0, 'reservation alone must not spend a round')
      }
      return first
    },
  })] }))
  await run(env, [call('create_goal', { objective: 'Do the work', max_goal_rounds: 1 }), reply(), call('get_goal', {}), update(env, 'complete'), reply()])
  assert.equal(repeated, 1)
  assert.equal((await goal(env))!.roundsStarted, 1)
  assert.equal((await goal(env))!.revision, 2)
})

test('an automatic round loses completion authority when a human edits its revision', async t => {
  const env = await setup()
  t.after(() => env.harness.close(context))
  await run(env, [
    call('create_goal', { objective: 'Original objective', max_goal_rounds: 1 }), reply(),
    async () => {
      await command(env, 'edit Revised objective')
      const current = (await goal(env))!
      return call('update_goal', { goal_id: current.id, revision: current.revision, action: 'complete' })
    }, reply(),
  ])
  const updates = await results(env, 'update_goal')
  assert.ok(updates[0]?.role === 'toolResult' && updates[0].isError)
  assert.match(JSON.stringify(updates[0]), /exact current goal round/)
  assert.equal((await goal(env))!.objective, 'Revised objective')
  assert.equal((await goal(env))!.phase, 'blocked')
  assert.equal((await goal(env))!.roundsStarted, 1)
})

test('input queued after reservation supersedes the automatic prompt without consuming budget', async t => {
  const env = await setup()
  t.after(() => env.harness.close(context))
  const handlers = env.plugin.extension.hooks![0]!.handlers as GenerationHooks
  let queued = false
  env.registry.install(defineExtension({ ...env.plugin.extension, hooks: [hook(GenerationTask, {
    ...handlers,
    onYield: async (answer, api, ctx) => {
      const result = await handlers.onYield(answer, api, ctx)
      if (result && !queued) {
        queued = true
        await env.conversation.submit({ type: 'input', content: 'Finish here', whenBusy: 'followUp' }, ctx)
      }
      return result
    },
  })] }))
  await command(env, 'Do the work')
  await run(env, [reply('Progress.'), update(env, 'complete'), reply()])
  await env.conversation.waitForIdle(context)
  assert.ok(queued)
  assert.equal((await goal(env))!.roundsStarted, 0)
  assert.equal((await goal(env))!.phase, 'complete')
})

test('mutation receipts prevent duplicate goals and revisions and never rearm a restored plugin', async t => {
  const env = await setup()
  t.after(() => env.harness.close(context))
  let replays = 0
  env.registry.install(defineExtension({ name: 'goal-replay-test', wraps: [
    ...['create_goal', 'update_goal'].map(name => wrapTool(env.plugin.extension.tools!.find(item => item.name === name)!, tool => ({
      ...tool,
      execute: async (args, api, ctx) => {
        const first = await tool.execute(args, api, ctx)
        const second = await tool.execute(args, api, ctx)
        assert.deepEqual(first, second)
        replays++
        if (name === 'create_goal') {
          const restored = createGoalPlugin(() => env.harness)
          const replay = await restored.extension.tools!.find(item => item.name === name)!.execute(args, api, ctx)
          assert.match(JSON.stringify(replay), /disarmed/)
        }
        return first
      },
    }))),
  ] }))
  await run(env, [call('create_goal', { objective: 'Do the work' }), update(env, 'complete'), reply()])
  assert.equal(replays, 2)
  assert.equal((await goal(env))!.revision, 2)
  assert.equal((await goal(env))!.roundsStarted, 0)
})

test('nested goal calls inherit the enclosing generation source', async t => {
  const env = await setup()
  t.after(() => env.harness.close(context))
  env.registry.install(defineExtension({ name: 'nested-goal-test', tools: [defineTool({
    name: 'nested_goal', description: 'Exercise a nested goal tool call.', parameters: Type.Object({}), replay: 'safe',
    execute: async (_args, api, ctx) => {
      const result = await api.executeTool('create_goal', { objective: 'Nested work' }, ctx)
      return { output: [{ type: 'text', text: JSON.stringify(result) }] }
    },
  })] }))
  await run(env, [call('nested_goal', {}), update(env, 'complete'), reply()])
  assert.equal((await goal(env))!.phase, 'complete')
})
