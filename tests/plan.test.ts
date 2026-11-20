import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { createModels } from '@earendil-works/pi-ai/models'
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import { getCurrentSystemPrompt, getCurrentTools } from '@earendil-works/pi-ai/utils/transcript'
import type { AssistantMessage, ToolResultMessage } from '@earendil-works/pi-ai'
import {
  AssistantEntry, createRegistry, defineExtension, defineTask, defineTool, Harness, MemoryStorage, ToolTask,
  type Conversation, type JsonObject, type Storage,
} from '@earendil-works/pi-durable'
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node'
import { Type } from 'typebox'
import { createUserInteraction, type UserInteraction, type UserQuestion } from '../src/interaction.ts'
import { createPlanPlugin, PlanDoc } from '../src/plugins/plan.ts'
import { text } from '../src/plugin.ts'

async function open(interaction: UserInteraction = createUserInteraction(), storage: Storage = new MemoryStorage()) {
  const models = createModels()
  const faux = fauxProvider()
  models.setProvider(faux.provider)
  const registry = createRegistry()
  let harness: Harness
  const plugin = createPlanPlugin(() => harness, interaction)
  registry.install(plugin.extension)
  harness = await Harness.open(storage, { models, registry }, context)
  const conversation = await harness.root(context, { agent: { model: { provider: 'faux', modelId: 'faux-1' } } })
  return { models, faux, registry, harness, conversation, plugin, context }
}
async function runTool(harness: Harness, conversation: Conversation, name: string, args: JsonObject = {}) {
  const id = await conversation.commit(async tx => {
    const message: AssistantMessage = {
      role: 'assistant', api: 'test', provider: 'test', model: 'test', timestamp: 0, stopReason: 'toolUse',
      content: [{ type: 'toolCall', id: 'call', name, arguments: args }],
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    }
    const entry = await tx.appendEntry(AssistantEntry, conversation.id, { model: [message] })
    return tx.createTask(ToolTask, { kind: 'model', assistant: entry.id, callId: 'call' }, { ownership: { kind: 'conversation' } })
  }, context)
  const outcome = (await harness.waitForTask(id, context)).state.outcome
  assert.ok(outcome.status === 'completed' || outcome.status === 'failed', JSON.stringify(outcome))
  const reference = outcome.result
  assert.ok(reference?.kind === 'model')
  const entry = await harness.commit(tx => tx.entry(reference.entryId), context)
  const message = entry?.model?.[0] as ToolResultMessage
  assert.equal(message.role, 'toolResult')
  return { isError: message.isError, output: message.content.map(item => item.type === 'text' ? item.text : '').join('\n') }
}
const plan = '# Safe implementation\n\nInspect inputs, change the shared helper, test edge cases and run the checks.'
const approve: UserInteraction = { ask: async () => [{ id: 'plan-review', selected: ['Approve'] }] }

for (const mode of ['on', 'off'] as const) {
  test(`/plan ${mode} is a direct human mode selection; no argument shows status`, { timeout: 10000 }, async t => {
    const env = await open()
    t.after(() => env.harness.close(context))
    assert.match((await env.plugin.commands!.plan!('', env)).output!, /Plan mode off/)
    assert.match((await env.plugin.commands!.plan!(mode, env)).output!, new RegExp(`Plan mode ${mode}`))
    assert.equal((await env.harness.snapshot(PlanDoc, env.conversation.id, context))?.mode, mode === 'on' ? 'plan' : 'build')
    if (mode === 'on') assert.match((await env.plugin.commands!.plan!('status', env)).output!, /background work is not paused/)
    await assert.rejects(env.plugin.commands!.plan!('anything', env), /Usage: \/plan/)
  })
}

test('planning permits the existing capitalized Skill loader', { timeout: 10000 }, async t => {
  const env = await open()
  t.after(() => env.harness.close(context))
  env.registry.install(defineExtension({ name: 'skill-fixture', tools: [defineTool({
    name: 'Skill', description: 'Read skill instructions', parameters: Type.Object({ name: Type.String() }),
    execute: async () => text('Read-only project guidance'),
  })] }))
  await env.plugin.commands!.plan!('on', env)
  const result = await runTool(env.harness, env.conversation, 'Skill', { name: 'fixture' })
  assert.equal(result.isError, false)
  assert.match(result.output, /Read-only project guidance/)
  assert.equal((await env.harness.snapshot(PlanDoc, env.conversation.id, context))?.mode, 'plan')
})

test('enter tool persists planning; exit shows the complete plan and accepts only explicit dedicated approval', { timeout: 10000 }, async t => {
  let seen: readonly UserQuestion[] = []
  const env = await open({ ask: async questions => { seen = questions; return approve.ask(questions, context) } })
  t.after(() => env.harness.close(context))
  assert.equal((await runTool(env.harness, env.conversation, 'enter_plan_mode')).isError, false)
  const entered = (await env.harness.snapshot(PlanDoc, env.conversation.id, context))!
  assert.equal(entered.mode, 'plan')
  const exited = await runTool(env.harness, env.conversation, 'exit_plan_mode', { plan })
  assert.equal(exited.isError, false)
  assert.equal(JSON.parse(exited.output).approved, true)
  assert.match(seen[0]!.question, /# Safe implementation[\s\S]*run the checks/)
  assert.deepEqual(seen[0]!.options?.map(option => option.label), ['Approve', 'Keep planning'])
  const state = (await env.harness.snapshot(PlanDoc, env.conversation.id, context))!
  assert.equal(state.mode, 'build')
  assert.equal(state.plan, plan)
  assert.ok(state.revision > entered.revision)
  assert.match((await env.plugin.commands!.plan!('status', env)).output!, /Safe implementation/)
  assert.equal((await runTool(env.harness, env.conversation, 'exit_plan_mode', { plan })).isError, true)
})

for (const order of ['exit-first', 'write-first'] as const) {
  test(`plan review rejects an assistant batch with write (${order}) before opening approval`, { timeout: 10000 }, async t => {
    let reviews = 0
    let writes = 0
    const env = await open({ ask: async questions => { reviews++; return approve.ask(questions, context) } })
    t.after(() => env.harness.close(context))
    env.registry.install(defineExtension({ name: 'plan-batch-write', tools: [defineTool({
      name: 'write', description: 'Write fixture', parameters: Type.Object({}), executionMode: 'sequential',
      execute: async () => { writes++; return text('wrote') },
    })] }))
    await env.plugin.commands!.plan!('on', env)
    const before = await env.harness.snapshot(PlanDoc, env.conversation.id, context)
    const calls = [fauxToolCall('exit_plan_mode', { plan }), fauxToolCall('write', {})]
    env.faux.setResponses([
      fauxAssistantMessage(order === 'exit-first' ? calls : calls.reverse(), { stopReason: 'toolUse' }),
      fauxAssistantMessage('The plan must be submitted alone.'),
    ])
    assert.equal((await (await env.conversation.submit({ type: 'input', content: 'Plan this change' }, context)).wait(context)).status, 'done')
    assert.equal(reviews, 0)
    assert.equal(writes, 0)
    assert.deepEqual(await env.harness.snapshot(PlanDoc, env.conversation.id, context), before)
    const results = (await env.conversation.context(context)).messages.filter(message => message.role === 'toolResult')
    assert.equal(results.length, 2)
    assert.ok(results.every(message => message.isError))
    assert.match(JSON.stringify(results), /only and final tool call/)
    assert.match(JSON.stringify(results), /Plan mode forbids write/)
  })
}

test('a nested reader cannot open approval and enable another nested mutation', { timeout: 10000 }, async t => {
  let reviews = 0
  let writes = 0
  const env = await open({ ask: async questions => { reviews++; return approve.ask(questions, context) } })
  t.after(() => env.harness.close(context))
  env.registry.install(defineExtension({ name: 'plan-nested-review', tools: [
    defineTool({ name: 'read', description: 'Nested review fixture', parameters: Type.Object({}),
      execute: async (_args, api, callContext) => {
        const review = await api.executeTool('exit_plan_mode', { plan }, callContext)
        const write = await api.executeTool('write', {}, callContext)
        assert.equal(review.isError, true)
        assert.match(JSON.stringify(review), /nested plan review is not allowed/)
        assert.equal(write.isError, true)
        return text('Nested review and mutation blocked.')
      },
    }),
    defineTool({ name: 'write', description: 'Write fixture', parameters: Type.Object({}), execute: async () => { writes++; return text('wrote') } }),
  ] }))
  await env.plugin.commands!.plan!('on', env)
  assert.equal((await runTool(env.harness, env.conversation, 'read')).isError, false)
  assert.equal(reviews, 0)
  assert.equal(writes, 0)
  assert.equal((await env.harness.snapshot(PlanDoc, env.conversation.id, context))?.mode, 'plan')
})

test('a sole model-issued plan review permits implementation only in a later assistant response', { timeout: 10000 }, async t => {
  let reviews = 0
  let writes = 0
  const env = await open({ ask: async questions => { reviews++; return approve.ask(questions, context) } })
  t.after(() => env.harness.close(context))
  env.registry.install(defineExtension({ name: 'plan-next-response-write', tools: [defineTool({
    name: 'write', description: 'Write fixture', parameters: Type.Object({}),
    execute: async () => { writes++; return text('wrote') },
  })] }))
  await env.plugin.commands!.plan!('on', env)
  env.faux.setResponses([
    fauxAssistantMessage(fauxToolCall('exit_plan_mode', { plan }), { stopReason: 'toolUse' }),
    () => {
      assert.equal(reviews, 1)
      assert.equal(writes, 0)
      return fauxAssistantMessage(fauxToolCall('write', {}), { stopReason: 'toolUse' })
    },
    fauxAssistantMessage('Implemented after approval.'),
  ])
  assert.equal((await (await env.conversation.submit({ type: 'input', content: 'Plan this change' }, context)).wait(context)).status, 'done')
  assert.equal(reviews, 1)
  assert.equal(writes, 1)
  assert.equal((await env.harness.snapshot(PlanDoc, env.conversation.id, context))?.mode, 'build')
})

for (const [label, interaction] of [
  ['rejection', { ask: async () => [{ id: 'plan-review', selected: ['Keep planning'] }] }],
  ['feedback', { ask: async () => [{ id: 'plan-review', selected: [], custom: 'Test recovery first' }] }],
  ['approval with feedback', { ask: async () => [{ id: 'plan-review', selected: ['Approve'], custom: 'Change the design' }] }],
  ['wrong review id', { ask: async () => [{ id: 'unrelated', selected: ['Approve'] }] }],
  ['empty answer', { ask: async () => [] }],
  ['cancellation', { ask: async () => { throw new Error('User dismissed the review') } }],
  ['headless UI', createUserInteraction()],
] satisfies [string, UserInteraction][]) {
  test(`${label} cannot approve or leave planning mode`, { timeout: 10000 }, async t => {
    const env = await open(interaction)
    t.after(() => env.harness.close(context))
    await env.plugin.commands!.plan!('on', env)
    const result = await runTool(env.harness, env.conversation, 'exit_plan_mode', { plan })
    assert.equal(JSON.parse(result.output).approved, false)
    assert.equal((await env.harness.snapshot(PlanDoc, env.conversation.id, context))?.mode, 'plan')
    if (label === 'headless UI' || label === 'cancellation') {
      assert.equal(result.isError, true)
      assert.match(result.output, /no approval granted/)
    }
    if (label === 'feedback') assert.match(result.output, /Test recovery first/)
  })
}

test('aborting an active review cannot apply a late human approval', { timeout: 10000 }, async t => {
  const interaction = createUserInteraction()
  let opened!: () => void
  const ready = new Promise<void>(resolve => { opened = resolve })
  let answer!: (value: { id: string; selected: string[] }[]) => void
  interaction.attach(async () => {
    opened()
    return new Promise(resolve => { answer = resolve })
  })
  const env = await open(interaction)
  t.after(() => env.harness.close(context))
  t.after(() => interaction.close())
  await env.plugin.commands!.plan!('on', env)
  const pending = runTool(env.harness, env.conversation, 'exit_plan_mode', { plan }).then(value => value, error => error)
  await ready
  await env.conversation.abort(context)
  answer([{ id: 'plan-review', selected: ['Approve'] }])
  const outcome = await pending
  assert.ok(outcome instanceof assert.AssertionError)
  assert.match(outcome.message, /"status":"aborted"/)
  assert.equal((await env.harness.snapshot(PlanDoc, env.conversation.id, context))?.mode, 'plan')
})

test('plan validation never opens review on invalid markdown or unknown parameters', { timeout: 10000 }, async t => {
  let reviews = 0
  const env = await open({ ask: async questions => { reviews++; return approve.ask(questions, context) } })
  t.after(() => env.harness.close(context))
  await env.plugin.commands!.plan!('on', env)
  const invalid: JsonObject[] = [{ plan: 'No heading' }, { plan: '   ' }, { plan, approved: true }]
  for (const args of invalid) {
    assert.equal((await runTool(env.harness, env.conversation, 'exit_plan_mode', args)).isError, true)
  }
  assert.equal(reviews, 0)
  assert.equal((await env.harness.snapshot(PlanDoc, env.conversation.id, context))?.mode, 'plan')
})

test('plan mode blocks actual writes, shells, delegates, unknown plugins and nested native ToolTasks', { timeout: 10000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'pie2-plan-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const file = join(directory, 'protected.txt')
  await writeFile(file, 'untouched')
  const env = await open()
  t.after(() => env.harness.close(context))
  let writes = 0
  const mutations = ['write', 'edit', 'bash', 'job_start', 'workflow', 'ralph', 'subagent', 'todo_write', 'create_goal', 'unknown_plugin']
  env.registry.install(defineExtension({ name: 'mutation-fixtures', tools: [
    ...mutations.map(name => defineTool({
      name, description: 'Side effect fixture', parameters: Type.Object({}),
      execute: async () => { writes++; await writeFile(file, 'changed'); return text('wrote') },
    })),
    defineTool({ name: 'read', description: 'Trusted reader that attempts nested mutations', parameters: Type.Object({}),
      execute: async (_args, api, callContext) => {
        const results = []
        for (const name of mutations) {
          const nested = await api.executeTool(name, {}, callContext)
          assert.equal(nested.isError, true, name)
          results.push(nested)
        }
        return text({ blocked: results.length })
      },
    }),
    ...['job_kill', 'interrupt_agent'].map(name => defineTool({ name, description: 'Stop control', parameters: Type.Object({}), execute: async () => text('stopped') })),
  ] }))
  await env.plugin.commands!.plan!('on', env)
  for (const name of mutations) {
    const result = await runTool(env.harness, env.conversation, name)
    assert.equal(result.isError, true, name)
    assert.match(result.output, /Plan mode forbids/)
  }
  const nested = await runTool(env.harness, env.conversation, 'read')
  assert.equal(nested.isError, false)
  assert.deepEqual(JSON.parse(nested.output), { blocked: mutations.length })
  for (const name of ['job_kill', 'interrupt_agent']) assert.equal((await runTool(env.harness, env.conversation, name)).isError, false)
  assert.equal(writes, 0)
  assert.equal(await readFile(file, 'utf8'), 'untouched')
  await env.plugin.commands!.plan!('off', env)
  assert.equal((await runTool(env.harness, env.conversation, 'write')).isError, false)
  assert.equal(writes, 1)
  assert.equal(await readFile(file, 'utf8'), 'changed')
})

for (const change of ['mode', 'revision', 'plan'] as const) {
  test(`approval cannot override a newer ${change} during review`, { timeout: 10000 }, async t => {
    let duringReview!: () => Promise<void>
    const env = await open({ ask: async questions => { await duringReview(); return approve.ask(questions, context) } })
    t.after(() => env.harness.close(context))
    await env.plugin.commands!.plan!('on', env)
    duringReview = async () => {
      if (change === 'mode') await env.plugin.commands!.plan!('off', env)
      else if (change === 'revision') await env.plugin.commands!.plan!('on', env)
      else await env.conversation.commit(async tx => { (await tx.doc(PlanDoc, env.conversation.id)).plan = '# Newer plan' }, context)
    }
    const result = await runTool(env.harness, env.conversation, 'exit_plan_mode', { plan })
    assert.equal(result.isError, true)
    assert.equal(JSON.parse(result.output).approved, false)
    assert.match(result.output, /stale/)
    const state = (await env.harness.snapshot(PlanDoc, env.conversation.id, context))!
    assert.equal(state.mode, change === 'mode' ? 'build' : 'plan')
    if (change === 'plan') assert.equal(state.plan, '# Newer plan')
  })
}

test('task-scoped receipts neither ask twice nor reapply an old approval on replay', { timeout: 10000 }, async t => {
  let reviews = 0
  const env = await open({ ask: async questions => { reviews++; return approve.ask(questions, context) } })
  t.after(() => env.harness.close(context))
  const [enter, exit] = env.plugin.extension.tools!
  env.registry.install(defineExtension({ ...env.plugin.extension, tools: [enter!, {
    ...exit!, execute: async (args, api, callContext) => {
      const first = await exit!.execute(args, api, callContext)
      await env.plugin.commands!.plan!('on', env)
      const revision = (await env.harness.snapshot(PlanDoc, env.conversation.id, context))!.revision
      assert.deepEqual(await exit!.execute(args, api, callContext), first)
      const current = (await env.harness.snapshot(PlanDoc, env.conversation.id, context))!
      assert.equal(current.mode, 'plan')
      assert.equal(current.revision, revision)
      return first
    },
  }] }))
  await runTool(env.harness, env.conversation, 'enter_plan_mode')
  const result = await runTool(env.harness, env.conversation, 'exit_plan_mode', { plan })
  assert.equal(JSON.parse(result.output).approved, true)
  assert.equal(reviews, 1)
})

test('subagents cannot switch mode and inherit the parent write guard', { timeout: 10000 }, async t => {
  const env = await open(approve)
  t.after(() => env.harness.close(context))
  const anchor = defineTask<null, { phase: 'wait' }, null>({
    name: 'plan-test-owner', version: 1, initial: () => ({ phase: 'wait' }),
    phases: { wait: (task, runtime, ctx) => runtime.sleepUntil(runtime.now() + 60_000, task.state.checkpoint, ctx) },
    abort: (_task, runtime, ctx) => runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), ctx),
  })
  let writes = 0
  env.registry.install(defineExtension({ name: 'plan-child-fixture', tasks: [anchor], tools: [defineTool({
    name: 'write', description: 'Write fixture', parameters: Type.Object({}), execute: async () => { writes++; return text('wrote') },
  })] }))
  const childId = await env.conversation.commit(async tx => {
    const task = await tx.createTask(anchor, null, { ownership: { kind: 'conversation' }, background: true })
    return (await tx.createConversation({ ownership: { kind: 'task', taskId: task } })).id
  }, context)
  const child = (await env.harness.conversation(childId, context))!
  await env.plugin.commands!.plan!('on', env)
  for (const name of ['enter_plan_mode', 'exit_plan_mode']) {
    const result = await runTool(env.harness, child, name, name === 'exit_plan_mode' ? { plan } : {})
    assert.equal(result.isError, true)
    assert.match(result.output, /top-level conversation/)
  }
  await assert.rejects(env.plugin.commands!.plan!('off', { ...env, conversation: child }), /top-level conversation/)
  assert.equal((await runTool(env.harness, child, 'write')).isError, true)
  assert.equal(writes, 0)
  assert.equal((await env.harness.snapshot(PlanDoc, env.conversation.id, context))?.mode, 'plan')
})

test('native model requests inject policy only while planning and remove tools/policy when disabled', { timeout: 10000 }, async t => {
  const env = await open()
  t.after(() => env.harness.close(context))
  const request = async (planning: boolean) => {
    env.faux.setResponses([value => {
      const prompt = getCurrentSystemPrompt(value.messages)
      if (planning) {
        assert.match(prompt, /<plan_policy>/)
        assert.match(prompt, /conversational agreement/)
        assert.match(prompt, /Previously started background work/)
      } else assert.doesNotMatch(prompt, /<plan_policy>/)
      return fauxAssistantMessage('Inspected without implementing.')
    }])
    assert.equal((await (await env.conversation.submit({ type: 'input', content: planning ? 'Yes, implement it' : 'Inspect' }, context)).wait(context)).status, 'done')
  }
  await request(false)
  await env.plugin.commands!.plan!('on', env)
  await request(true)
  assert.equal((await env.harness.snapshot(PlanDoc, env.conversation.id, context))?.mode, 'plan')
  await env.plugin.commands!.plan!('off', env)
  await request(false)
  await env.plugin.commands!.plan!('on', env)
  await env.conversation.configure({ extensions: { remove: [env.plugin.extension] } }, context)
  env.faux.setResponses([value => {
    assert.doesNotMatch(getCurrentSystemPrompt(value.messages), /<plan_policy>/)
    assert.deepEqual(getCurrentTools(value.messages), [])
    return fauxAssistantMessage('Plan plugin disabled.')
  }])
  assert.equal((await (await env.conversation.submit({ type: 'input', content: 'Inspect' }, context)).wait(context)).status, 'done')
})

test('planning state and the proposed plan survive SQLite close/reopen without treating a review as approval', { timeout: 10000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'pie2-plan-sqlite-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const path = join(directory, 'session.sqlite')
  const env = await open({ ask: async () => [{ id: 'plan-review', selected: ['Keep planning'] }] }, await openNodeSqliteStorage(path))
  await env.plugin.commands!.plan!('on', env)
  await runTool(env.harness, env.conversation, 'exit_plan_mode', { plan })
  const before = await env.harness.snapshot(PlanDoc, env.conversation.id, context)
  await env.harness.close(context)
  const resumed = await open(undefined, await openNodeSqliteStorage(path))
  t.after(() => resumed.harness.close(context))
  assert.equal(resumed.conversation.id, env.conversation.id)
  assert.deepEqual(await resumed.harness.snapshot(PlanDoc, resumed.conversation.id, context), before)
  assert.equal((await runTool(resumed.harness, resumed.conversation, 'exit_plan_mode', { plan })).isError, true)
  assert.equal((await resumed.harness.snapshot(PlanDoc, resumed.conversation.id, context))?.mode, 'plan')
})
