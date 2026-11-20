import assert from 'node:assert/strict'
import { test } from 'node:test'
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { createModels } from '@earendil-works/pi-ai/models'
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import { getCurrentSystemPrompt, getCurrentTools } from '@earendil-works/pi-ai/utils/transcript'
import type { AssistantMessage, JsonObject, ToolResultMessage } from '@earendil-works/pi-ai'
import { AssistantEntry, createRegistry, defineExtension, defineTool, GenerationTask, Harness, hook, MemoryStorage, ToolTask, type Conversation } from '@earendil-works/pi-durable'
import { Type } from 'typebox'
import { createTasksPlugin, TodoDoc, type TodoItem } from '../src/plugins/tasks.ts'

const todo = (content: string, status: TodoItem['status'] = 'pending'): TodoItem => ({ content, status })
async function open() {
  const models = createModels()
  const faux = fauxProvider()
  models.setProvider(faux.provider)
  const registry = createRegistry()
  let harness: Harness
  const plugin = createTasksPlugin(() => harness)
  registry.install(plugin.extension)
  harness = await Harness.open(new MemoryStorage(), { models, registry }, context)
  const conversation = await harness.root(context, { agent: { model: { provider: 'faux', modelId: 'faux-1' } } })
  return { registry, harness, conversation, context, plugin, faux }
}
async function runTool(harness: Harness, conversation: Conversation, args: JsonObject) {
  const taskId = await conversation.commit(async tx => {
    const message: AssistantMessage = {
      role: 'assistant', api: 'test', provider: 'test', model: 'test', timestamp: 0, stopReason: 'toolUse',
      content: [{ type: 'toolCall', id: 'call', name: 'todo_write', arguments: args }],
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    }
    const entry = await tx.appendEntry(AssistantEntry, conversation.id, { model: [message] })
    return tx.createTask(ToolTask, { kind: 'model', assistant: entry.id, callId: 'call' }, { ownership: { kind: 'conversation' } })
  }, context)
  const outcome = (await harness.waitForTask(taskId, context)).state.outcome
  assert.ok(outcome.status === 'completed' || outcome.status === 'failed', JSON.stringify(outcome))
  const resultRef = outcome.result
  assert.ok(resultRef && resultRef.kind === 'model')
  const result = await harness.commit(tx => tx.entry(resultRef.entryId), context)
  const message = result?.model?.[0] as ToolResultMessage
  assert.equal(message.role, 'toolResult')
  return { isError: message.isError, output: message.content.map(item => item.type === 'text' ? item.text : '').join('\n') }
}
const call = (todos: TodoItem[]) => fauxAssistantMessage(fauxToolCall('todo_write', { todos }), { stopReason: 'toolUse' })

test('todo_write is the only task tool and replaces the complete list with canonical contents and counts', { timeout: 10_000 }, async t => {
  const env = await open()
  t.after(() => env.harness.close(context))
  assert.deepEqual(env.plugin.extension.tools!.map(tool => tool.name), ['todo_write'])
  assert.equal((await env.plugin.commands!.tasks!('', env)).output, 'No tasks.')
  const first = await runTool(env.harness, env.conversation, { todos: [todo('  Implement  ', 'in_progress'), todo('Test'), todo('Research', 'completed')] })
  assert.equal(first.isError, false)
  assert.deepEqual(JSON.parse(first.output), {
    todos: [todo('Implement', 'in_progress'), todo('Test'), todo('Research', 'completed')],
    counts: { pending: 1, inProgress: 1, completed: 1 },
  })
  assert.match((await env.plugin.commands!.tasks!('', env)).output!, /\[in_progress\] Implement/)
  const second = await runTool(env.harness, env.conversation, { todos: [todo('Only new work')] })
  assert.equal(second.isError, false)
  assert.deepEqual((await env.harness.snapshot(TodoDoc, env.conversation.id, context))?.todos, [todo('Only new work')])
  const cleared = await runTool(env.harness, env.conversation, { todos: [] })
  assert.deepEqual(JSON.parse(cleared.output), { todos: [], counts: { pending: 0, inProgress: 0, completed: 0 } })
  assert.deepEqual((await env.harness.snapshot(TodoDoc, env.conversation.id, context))?.todos, [])
  assert.equal((await env.plugin.commands!.tasks!('', env)).output, 'No tasks.')
  for (const input of ['create New work', 'get 1', 'update {}']) await assert.rejects(env.plugin.commands!.tasks!(input, env), /Usage: \/tasks/)
})

test('todo_write rejects invalid lists atomically, including unknown nested fields and whitespace duplicates', { timeout: 10_000 }, async t => {
  const env = await open()
  t.after(() => env.harness.close(context))
  const write = (args: JsonObject) => runTool(env.harness, env.conversation, args)
  await write({ todos: [todo('Keep original')] })
  for (const invalid of [
    {}, { todos: null }, { todos: 'work' }, { todos: [todo('')] }, { todos: [todo('  \n ')] },
    { todos: [todo('Same'), todo(' Same ')] }, { todos: [{ content: 'Bad', status: 'cancelled' }] },
    { todos: [{ content: 'Missing status' }] }, { todos: [{ status: 'pending' }] },
    { todos: [{ content: 'Extended', status: 'pending', owner: 'worker' }] },
    { todos: [{ content: 'Nested', status: 'pending', subtasks: [] }] },
    { todos: [todo('Valid first'), todo('  ')] }, { todos: [], partial: true },
  ]) {
    const result = await write(invalid as JsonObject)
    assert.equal(result.isError, true, JSON.stringify(invalid))
    assert.deepEqual((await env.harness.snapshot(TodoDoc, env.conversation.id, context))?.todos, [todo('Keep original')])
  }
})

test('todo_write allows genuinely parallel in-progress items', { timeout: 10_000 }, async t => {
  const env = await open()
  t.after(() => env.harness.close(context))
  const todos = [todo('Independent agent work', 'in_progress'), todo('Background tests', 'in_progress')]
  const result = await runTool(env.harness, env.conversation, { todos })
  assert.equal(result.isError, false)
  assert.deepEqual(JSON.parse(result.output), { todos, counts: { pending: 0, inProgress: 2, completed: 0 } })
})

test('task-scoped write receipts return the original result without overwriting later writes on replay', { timeout: 10_000 }, async t => {
  const env = await open()
  t.after(() => env.harness.close(context))
  let repeats = 0
  env.registry.install(defineExtension({
    ...env.plugin.extension,
    tools: env.plugin.extension.tools!.map(tool => ({
      ...tool,
      execute: async (args, api, callContext) => {
        const first = await tool.execute(args, api, callContext)
        await api.commit(async tx => { (await tx.doc(TodoDoc, api.conversationId)).todos = [todo('Later write')] }, callContext)
        assert.deepEqual(await tool.execute(args, api, callContext), first)
        repeats++
        return first
      },
    })),
  }))
  const result = await runTool(env.harness, env.conversation, { todos: [todo('Original')] })
  assert.equal(result.isError, false)
  assert.deepEqual(JSON.parse(result.output).todos, [todo('Original')])
  assert.deepEqual((await env.harness.snapshot(TodoDoc, env.conversation.id, context))?.todos, [todo('Later write')])
  assert.equal(repeats, 1)
})

for (const source of ['notice', 'steer'] as const) {
  test(`${source} within a running turn preserves its Todo projection`, { timeout: 10000 }, async t => {
    const env = await open()
    t.after(() => env.harness.close(context))
    env.registry.install(defineExtension({ name: 'input-test', tools: [defineTool({
      name: 'inject_input', description: 'Add input during the current run.', parameters: Type.Object({}),
      execute: async () => {
        if (source === 'notice') await env.conversation.submit({ type: 'write', entry: {
          kind: 'plugin.notice', model: [{ role: 'user', content: 'A job completed.', timestamp: Date.now() }],
        } }, context)
        else await env.conversation.submit({ type: 'input', content: 'Also verify edge cases.', whenBusy: 'steer' }, context)
        return { output: [{ type: 'text', text: 'Input added.' }] }
      },
    })] }))
    const plan = [todo('Keep the current plan', 'in_progress')]
    env.faux.setResponses([
      call(plan), fauxAssistantMessage(fauxToolCall('inject_input', {}), { stopReason: 'toolUse' }),
      async request => {
        assert.match(getCurrentSystemPrompt(request.messages), /<todos>[\s\S]*Keep the current plan/)
        assert.deepEqual((await env.harness.snapshot(TodoDoc, env.conversation.id, context))?.todos, plan)
        return fauxAssistantMessage('Done.')
      },
    ])
    const settled = await (await env.conversation.submit({ type: 'input', content: 'Perform this multi-step work.', }, context)).wait(context)
    assert.equal(settled.status, 'done')
    assert.deepEqual((await env.harness.snapshot(TodoDoc, env.conversation.id, context))?.todos, plan)
  })
}

test('new inputs clear the current-turn projection but tool steps in one run retain it', { timeout: 10_000 }, async t => {
  const env = await open()
  t.after(() => env.harness.close(context))
  let afterWrite = false
  env.faux.setResponses([
    request => {
      assert.match(getCurrentSystemPrompt(request.messages), /<task_policy>/)
      assert.doesNotMatch(getCurrentSystemPrompt(request.messages), /<todos>/)
      return call([todo('Current step', 'in_progress'), todo('Next step')])
    },
    async request => {
      assert.match(getCurrentSystemPrompt(request.messages), /<todos>[\s\S]*Current step/)
      assert.deepEqual((await env.harness.snapshot(TodoDoc, env.conversation.id, context))?.todos, [todo('Current step', 'in_progress'), todo('Next step')])
      afterWrite = true
      return call([todo('Current step', 'completed'), todo('Next step', 'in_progress')])
    },
    request => {
      assert.match(getCurrentSystemPrompt(request.messages), /\[completed\] Current step/)
      return fauxAssistantMessage('This turn finished.')
    },
  ])
  const first = await (await env.conversation.submit({ type: 'input', content: 'Do two steps' }, context)).wait(context)
  assert.equal(first.status, 'done')
  assert.ok(afterWrite)
  const firstInput = (await env.harness.snapshot(TodoDoc, env.conversation.id, context))?.lastInputEntryId
  assert.ok(firstInput)
  assert.match((await env.plugin.commands!.tasks!('', env)).output!, /Next step/)
  env.faux.setResponses([async request => {
    assert.doesNotMatch(getCurrentSystemPrompt(request.messages), /<todos>/)
    const state = await env.harness.snapshot(TodoDoc, env.conversation.id, context)
    assert.equal(state?.todos, null)
    assert.notEqual(state?.lastInputEntryId, firstInput)
    assert.equal((await env.plugin.commands!.tasks!('', env)).output, 'No tasks.')
    return fauxAssistantMessage('A new turn.')
  }])
  assert.equal((await (await env.conversation.submit({ type: 'input', content: 'A separate request' }, context)).wait(context)).status, 'done')
})

test('automatic continuation inputs also reset Todo once without clearing following tool steps', { timeout: 10_000 }, async t => {
  const env = await open()
  t.after(() => env.harness.close(context))
  let yielded = false
  env.registry.install(defineExtension({
    name: 'test-round', hooks: [hook(GenerationTask, {
      onYield: () => {
        if (yielded) return
        yielded = true
        return { continue: 'Next automatic round' }
      },
    })],
  }))
  env.faux.setResponses([
    call([todo('Previous round', 'completed')]), fauxAssistantMessage('Round complete.'),
    async request => {
      assert.doesNotMatch(getCurrentSystemPrompt(request.messages), /<todos>/)
      assert.equal((await env.harness.snapshot(TodoDoc, env.conversation.id, context))?.todos, null)
      return call([todo('Automatic round', 'in_progress')])
    },
    request => {
      assert.match(getCurrentSystemPrompt(request.messages), /<todos>[\s\S]*Automatic round/)
      return fauxAssistantMessage('Finished.')
    },
  ])
  assert.equal((await (await env.conversation.submit({ type: 'input', content: 'Start rounds' }, context)).wait(context)).status, 'done')
  assert.equal(env.faux.state.callCount, 4)
})

test('native requests include the task policy and tool by default and remove both when disabled', { timeout: 10_000 }, async t => {
  const env = await open()
  t.after(() => env.harness.close(context))
  env.faux.setResponses([request => {
    const prompt = getCurrentSystemPrompt(request.messages)
    assert.match(prompt, /<task_policy>/)
    assert.match(prompt, /multi-step work/)
    assert.match(prompt, /trivial single-step tasks/)
    assert.match(prompt, /genuinely runs in parallel/)
    assert.deepEqual(getCurrentTools(request.messages).map(tool => tool.name), ['todo_write'])
    return fauxAssistantMessage('Policy available.')
  }])
  assert.equal((await (await env.conversation.submit({ type: 'input', content: 'First request' }, context)).wait(context)).status, 'done')
  await env.conversation.configure({ extensions: { remove: [env.plugin.extension] } }, context)
  env.faux.setResponses([request => {
    assert.doesNotMatch(getCurrentSystemPrompt(request.messages), /<task_policy>|<todos>/)
    assert.deepEqual(getCurrentTools(request.messages), [])
    return fauxAssistantMessage('Plugin disabled.')
  }])
  assert.equal((await (await env.conversation.submit({ type: 'input', content: 'Second request' }, context)).wait(context)).status, 'done')
})
