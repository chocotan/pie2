import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { createModels } from '@earendil-works/pi-ai/models'
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai/providers/faux'
import { defineExtension, defineTask } from '@earendil-works/pi-durable'
import { openHost } from '../src/host.ts'
import type { Plugin } from '../src/plugin.ts'
import { GoalDoc } from '../src/plugins/goal.ts'
import { TodoDoc } from '../src/plugins/tasks.ts'

function modelOptions() {
  const models = createModels()
  const faux = fauxProvider()
  models.setProvider(faux.provider)
  return { models, model: { provider: 'faux', modelId: 'faux-1' }, faux }
}

const customPlugin: Plugin = {
  name: 'test-plugin',
  extension: defineExtension({ name: 'test-plugin' }),
  commands: { echo: async args => ({ output: `echo: ${args}` }) },
}

test('SQLite close/reopen restores the root, goal and task ledger without arming the goal', { timeout: 10_000 }, async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'pie2-host-'))
  t.after(() => rm(cwd, { recursive: true, force: true }))
  const options = { cwd, session: join(cwd, 'state', 'session.sqlite'), ...modelOptions() }
  const first = await openHost(options)
  t.after(() => first.close())
  const root = first.conversation.id
  await first.command('/goal Finish durable work')
  await first.conversation.commit(async tx => {
    const state = await tx.doc(TodoDoc, root)
    state.todos = [{ content: 'Build it', status: 'in_progress' }, { content: 'Check it', status: 'pending' }]
  }, first.context)
  const goal = await first.harness.snapshot(GoalDoc, root, first.context)
  const tasks = await first.harness.snapshot(TodoDoc, root, first.context)
  assert.match((await first.command('/goal')).output!, /Activation: armed/)
  await first.close()

  const reopened = await openHost(options)
  t.after(() => reopened.close())
  assert.equal(reopened.conversation.id, root)
  assert.deepEqual(await reopened.harness.snapshot(GoalDoc, root, reopened.context), goal)
  assert.deepEqual(await reopened.harness.snapshot(TodoDoc, root, reopened.context), tasks)
  assert.match((await reopened.command('/goal')).output!, /Activation: disarmed/)
  options.faux.setResponses([fauxAssistantMessage('Waiting for explicit resume.')])
  const settled = await (await reopened.conversation.submit({ type: 'input', content: 'Status?' }, reopened.context)).wait(reopened.context)
  assert.equal(settled.status, 'done')
  assert.deepEqual(await reopened.harness.snapshot(GoalDoc, root, reopened.context), goal)
  assert.equal((await reopened.harness.snapshot(TodoDoc, root, reopened.context))?.todos, null)
})

test('opening without an explicit session starts a fresh isolated task ledger', { timeout: 10_000 }, async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'pie2-host-fresh-'))
  const hosts: Awaited<ReturnType<typeof openHost>>[] = []
  t.after(async () => {
    for (const host of hosts) await host.close()
    if (hosts[0]) await rm(dirname(hosts[0].session), { recursive: true, force: true })
    await rm(cwd, { recursive: true, force: true })
  })
  const options = { cwd, ...modelOptions() }
  const first = await openHost(options)
  hosts.push(first)
  await first.conversation.commit(async tx => {
    (await tx.doc(TodoDoc, first.conversation.id)).todos = [{ content: 'First session only', status: 'in_progress' }]
  }, first.context)
  await first.command('/goal First session goal')
  await first.close()

  const second = await openHost(options)
  hosts.push(second)
  assert.notEqual(second.session, first.session)
  assert.deepEqual(await second.command('/tasks'), { output: 'No tasks.' })
  assert.match((await second.command('/goal')).output!, /No goal/i)
  await second.close()

  const resumed = await openHost({ ...options, session: first.session })
  hosts.push(resumed)
  assert.match((await resumed.command('/tasks')).output!, /First session only/)
})

test('explicitly resumed sessions retain model and thinking until a model override is requested', { timeout: 10_000 }, async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'pie2-host-model-'))
  const models = createModels()
  models.setProvider(fauxProvider({ models: [{ id: 'faux-1', reasoning: true }, { id: 'faux-2', reasoning: true }] }).provider)
  const options = { cwd, session: join(cwd, 'session.sqlite'), models, model: { provider: 'faux', modelId: 'faux-1' }, thinkingLevel: 'low' as const }
  const hosts: Awaited<ReturnType<typeof openHost>>[] = []
  t.after(async () => {
    for (const host of hosts) await host.close()
    await rm(cwd, { recursive: true, force: true })
  })
  const first = await openHost(options)
  hosts.push(first)
  assert.equal((await first.conversation.agent(first.context)).thinkingLevel, 'low')
  await first.command('/model faux/faux-2')
  await first.command('/thinking high')
  await first.close()

  const resumed = await openHost(options)
  hosts.push(resumed)
  const saved = await resumed.conversation.agent(resumed.context)
  assert.deepEqual(saved.model, { provider: 'faux', modelId: 'faux-2' })
  assert.equal(saved.thinkingLevel, 'high')
  await resumed.close()

  const overridden = await openHost({ ...options, overrideModel: true })
  hosts.push(overridden)
  const changed = await overridden.conversation.agent(overridden.context)
  assert.deepEqual(changed.model, options.model)
  assert.equal(changed.thinkingLevel, 'high')
})

test('host installs and disables plugins and dispatches explicit skill commands', { timeout: 10_000 }, async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'pie2-host-plugins-'))
  t.after(() => rm(cwd, { recursive: true, force: true }))
  const directory = join(cwd, '.agents', 'skills', 'host-test-skill')
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'SKILL.md'), '---\nname: host-test-skill\ndescription: Host test instructions\ndisable-model-invocation: true\n---\nFollow these test instructions.\n')
  const options = { cwd, session: join(cwd, 'session.sqlite'), ...modelOptions(), plugins: [customPlugin], disablePlugins: ['tasks'] }
  const host = await openHost(options)
  t.after(() => host.close())
  assert.ok(host.plugins.some(plugin => plugin.name === 'test-plugin'))
  assert.ok(!host.plugins.some(plugin => plugin.name === 'tasks'))
  assert.deepEqual(await host.command('/echo hello world'), { output: 'echo: hello world' })
  assert.deepEqual(await host.command('ordinary input'), { prompt: 'ordinary input' })
  await assert.rejects(host.command('/tasks'), /Unknown command: \/tasks/)
  const skill = await host.command('/skill:host-test-skill inspect this\nwith details')
  assert.match(skill.prompt!, /Follow these test instructions/)
  assert.match(skill.prompt!, /User request:\ninspect this\nwith details/)
  assert.deepEqual(skill, await host.command('/skill host-test-skill inspect this\nwith details'))
  await host.close()

  const disabled = await openHost({ ...options, disablePlugins: ['test-plugin', 'skills'] })
  t.after(() => disabled.close())
  await assert.rejects(disabled.command('/echo ignored'), /Unknown command: \/echo/)
  await assert.rejects(disabled.command('/skill:host-test-skill'), /Unknown command: \/skill/)
  assert.ok(disabled.plugins.some(plugin => plugin.name === 'tasks'))
})

test('ordinary interruption preserves background tasks and abort all stops them', { timeout: 10_000 }, async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'pie2-host-background-'))
  t.after(() => rm(cwd, { recursive: true, force: true }))
  let started!: () => void
  const running = new Promise<void>(resolveRunning => { started = resolveRunning })
  let cancelled = false
  const work = defineTask<null, { phase: 'work' }, null>({
    name: 'test.background-work', version: 1, initial: () => ({ phase: 'work' }),
    phases: { work: async (_task, runtime) => {
      started()
      await new Promise<void>(resolveCancelled => runtime.signal.addEventListener('abort', () => { cancelled = true; resolveCancelled() }, { once: true }))
    } },
    abort: (_task, runtime, context) => runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), context),
  })
  const plugin: Plugin = { name: 'background-test', extension: defineExtension({ name: 'background-test', tasks: [work] }) }
  const host = await openHost({ cwd, session: join(cwd, 'session.sqlite'), ...modelOptions(), plugins: [plugin] })
  t.after(() => host.close())
  const id = await host.conversation.commit(tx => tx.createTask(work, null, { ownership: { kind: 'conversation' }, background: true }), host.context)
  host.harness.resume()
  await running
  await host.interrupt()
  assert.equal(cancelled, false)
  assert.notEqual((await host.harness.getTask(id, host.context))?.state.status, 'terminal')
  await host.interrupt({ background: true })
  assert.equal(cancelled, true)
  assert.equal((await host.harness.waitForTask(id, host.context)).state.outcome.status, 'aborted')
})

test('conflicting plugin commands reject and release the session lock for the next open', { timeout: 10_000 }, async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'pie2-host-conflict-'))
  t.after(() => rm(cwd, { recursive: true, force: true }))
  const options = { cwd, session: join(cwd, 'session.sqlite'), ...modelOptions() }
  const conflicting: Plugin = { ...customPlugin, commands: { tasks: async () => ({ output: 'conflict' }) } }
  await assert.rejects(openHost({ ...options, plugins: [conflicting] }), /Duplicate command: \/tasks/)
  await assert.rejects(openHost({ ...options, plugins: [customPlugin, customPlugin] }), /Duplicate plugin: test-plugin/)
  const recovered = await openHost(options)
  t.after(() => recovered.close())
  assert.deepEqual(await recovered.command('/tasks'), { output: 'No tasks.' })
  await recovered.close()
  await recovered.close()
})
