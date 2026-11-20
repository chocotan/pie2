import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'
import { BACKGROUND_CONTEXT, withAbortSignal, type Context } from '@earendil-works/chord/context'
import { type FauxResponseStep } from '@earendil-works/pi-ai'
import { createModels } from '@earendil-works/pi-ai/models'
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import { createRegistry, defineExtension, Harness, LiveDoc, MemoryStorage, type Conversation, type JsonObject, type ToolExecutionApi } from '@earendil-works/pi-durable'
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node'
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node'
import { BackgroundDoc, createBackgroundPlugin, type BackgroundJob } from '../src/plugins/background.ts'
import { createCodingPlugin } from '../src/plugins/coding.ts'
import { createGoalPlugin, GoalDoc } from '../src/plugins/goal.ts'

const context = BACKGROUND_CONTEXT
const options = { timeout: 10000 }
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
const node = (source: string) => `${quote(process.execPath)} -e ${quote(source)}`
const toolRound = (name: string, args: JsonObject) => fauxAssistantMessage([fauxToolCall(name, name === 'bash' ? { description: 'Run the requested shell command', ...args } : args, { id: 'call' })], { stopReason: 'toolUse' })
const start = (command: string, extra: JsonObject = {}) => toolRound('bash', { command, run_in_background: true, ...extra })
const gated = (prefix = '', gate = 'gate') => node(`${prefix}; console.log('READY'); const timer = setInterval(() => { if (require('node:fs').existsSync(${JSON.stringify(gate)})) { clearInterval(timer); console.log('DONE') } }, 10)`)

async function setup(t: TestContext, responses: FauxResponseStep[], config: { replay?: boolean; sqlite?: boolean; replayReport?: boolean; replayOutput?: boolean } = {}) {
  const cwd = await mkdtemp(join(tmpdir(), 'pie2-background-'))
  t.after(() => rm(cwd, { recursive: true, force: true }))
  const faux = fauxProvider()
  faux.setResponses([...responses, ...Array.from({ length: 24 }, () => fauxAssistantMessage('Handled background result.'))])
  const models = createModels()
  models.setProvider(faux.provider)
  const registry = createRegistry()
  let harness!: Harness
  const plugin = createBackgroundPlugin(() => harness)
  const tools = plugin.extension.tools!.map(tool => {
    if (!(config.replay && tool.name === 'job_start') && !(config.replayOutput && tool.name === 'job_output')) return tool
    return { ...tool, execute: async (...args: Parameters<typeof tool.execute>) => {
      const first = await tool.execute(...args)
      assert.deepEqual(await tool.execute(...args), first)
      return first
    } }
  })
  let markReportAdmitted!: () => void
  const reportAdmitted = new Promise<void>(resolve => { markReportAdmitted = resolve })
  const tasks = plugin.extension.tasks!.map(task => {
    if (!config.replayReport) return task
    const report = task.definition.phases.report as (...args: unknown[]) => Promise<void>
    let replayed = false
    return { definition: { ...task.definition, phases: { ...task.definition.phases,
      report: async (...args: unknown[]) => {
        if (replayed) return report(...args)
        replayed = true
        const runtime = args[1] as { commit: (...args: unknown[]) => Promise<unknown>; signal: AbortSignal }
        let commits = 0
        const patched = { ...runtime, commit: async (...commitArgs: unknown[]) => {
          if (++commits === 1) return runtime.commit(...commitArgs)
          markReportAdmitted()
          await new Promise<never>((_resolve, reject) => {
            if (runtime.signal.aborted) reject(runtime.signal.reason)
            else runtime.signal.addEventListener('abort', () => reject(runtime.signal.reason), { once: true })
          })
        } }
        await report(args[0], patched, args[2])
      },
    } } }
  })
  registry.install((await createCodingPlugin(cwd)).extension)
  registry.install(defineExtension({ ...plugin.extension, tools, tasks }))
  const reports: unknown[] = []
  const open = async () => {
    harness = await Harness.open(config.sqlite ? await openNodeSqliteStorage(join(cwd, 'state.sqlite')) : new MemoryStorage(), {
      registry, models, env: ({ cwd: directory }) => new NodeExecutionEnv({ cwd: directory ?? cwd }),
      settings: { retry: { maxRetries: 0 } }, onReport: error => { reports.push(error) },
    }, context)
    return harness
  }
  await open()
  t.after(() => harness.close(context))
  const root = await harness.root(context, { agent: { model: { provider: 'faux', modelId: 'faux-1' }, cwd } })
  await harness.commit(async tx => { await tx.doc(BackgroundDoc, root.id) }, context)
  const call = (name: string, args: JsonObject, conversation = root, ctx: Context = context) => {
    const tool = plugin.extension.tools!.find(tool => tool.name === name)!
    return tool.execute(args, { conversationId: conversation.id, snapshot: harness.snapshot.bind(harness) } as ToolExecutionApi, ctx)
  }
  return { cwd, faux, root, plugin, registry, call, get harness() { return harness }, reports, reportAdmitted, reopen: open }
}
async function run(root: Conversation) {
  return (await root.submit({ type: 'input', content: 'Start the requested job and keep working.' }, context)).wait(context)
}
async function jobs(harness: Harness, root: Conversation) {
  return (await harness.snapshot(BackgroundDoc, root.id, context))!.jobs
}
async function results(root: Conversation) {
  return (await root.entries({ order: 'ascending' }, 100, undefined, context)).items
    .flatMap(entry => entry.model ?? []).filter(message => message.role === 'toolResult')
}
async function untilJob(harness: Harness, root: Conversation, predicate: (job: BackgroundJob) => boolean) {
  const watch = (await harness.watchDoc(BackgroundDoc, root.id, context))!
  try {
    const current = watch.value?.jobs.find(predicate)
    if (current) return current
    return await new Promise<BackgroundJob>(resolve => {
      watch.start(async state => {
        const job = state?.jobs.find(predicate)
        if (job) resolve(job)
      })
    })
  } finally { await watch.stop() }
}
async function notices(root: Conversation) {
  return (await root.entries({ order: 'ascending' }, 100, undefined, context)).items.filter(entry => entry.kind === 'pie2.background-result')
}
async function assertDead(pid: number) {
  // A killed descendant may briefly remain as an init-owned zombie on Linux.
  try { assert.match(await readFile(`/proc/${pid}/stat`, 'utf8'), /^\d+ \(.*\) Z /) }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
}
function body(result: Awaited<ReturnType<Awaited<ReturnType<typeof setup>>['call']>>) {
  const item = result.output![0]!
  assert.equal(item.type, 'text')
  return (item as { text: string }).text
}

test('background bash returns a string id immediately, persists live output, and sends one notice', options, async t => {
  const env = await setup(t, [start(gated(), { description: 'Wait for gate' }), fauxAssistantMessage('Parent can continue.')])
  assert.equal((await run(env.root)).status, 'done')
  const running = await untilJob(env.harness, env.root, job => job.output.includes('READY'))
  assert.equal(running.status, 'running')
  assert.equal(running.description, 'Wait for gate')
  assert.equal((await notices(env.root)).length, 0)
  const result = (await results(env.root))[0]!
  assert.deepEqual(JSON.parse((result.content[0] as { text: string }).text), { kind: 'background', jobId: String(running.id) })
  await writeFile(join(env.cwd, 'gate'), '')
  await env.harness.waitForTask(running.id, context)
  await env.harness.waitForIdle(context)
  const [completed] = await jobs(env.harness, env.root)
  assert.equal(completed!.status, 'completed')
  assert.equal(completed!.exitCode, 0)
  assert.match(completed!.output, /READY\nDONE/)
  assert.ok(completed!.startedAt! <= completed!.finishedAt!)
  const entries = await notices(env.root)
  assert.equal(entries.length, 1)
  assert.deepEqual(entries[0]!.data, { source: 'job', id: String(running.id), description: 'Wait for gate', status: 'completed' })
  assert.match(JSON.stringify(entries[0]!.model), /not a new user instruction/)
  assert.match(JSON.stringify(entries[0]!.model), /job_output/)
  assert.ok(!JSON.stringify(entries[0]!.model).includes('READY'))
  assert.deepEqual(env.reports, [])
})

test('output consumes a bounded UTF-8 tail, reports loss, and preserves its status suffix', options, async t => {
  const command = node("process.stdout.write('世'.repeat(40000) + 'STDOUT-END')")
  const env = await setup(t, [start(command)])
  await run(env.root)
  const [job] = await jobs(env.harness, env.root)
  await env.harness.waitForTask(job!.id, context)
  const completed = (await jobs(env.harness, env.root))[0]!
  assert.equal(completed.truncated, true)
  assert.ok(Buffer.byteLength(completed.output) <= 50 * 1024)
  assert.ok(!completed.output.includes('\ufffd'))
  const first = body(await env.call('job_output', { job_id: String(job!.id) }))
  assert.match(first, /STDOUT-END/)
  assert.match(first, /output truncated/)
  assert.match(first, /\[status: completed, exit code: 0\]$/)
  assert.ok(Buffer.byteLength(first) <= 50 * 1024)
  assert.ok(!first.includes('\ufffd'))
  assert.equal(body(await env.call('job_output', { job_id: String(job!.id) })), '(no new output)\n[status: completed, exit code: 0]')
})

test('nonzero shell exit is completed with exit code detail rather than an infrastructure failure', options, async t => {
  const env = await setup(t, [start('printf stdout; printf problem >&2; exit 7')])
  await run(env.root)
  const [job] = await jobs(env.harness, env.root)
  await env.harness.waitForTask(job!.id, context)
  const finished = (await jobs(env.harness, env.root))[0]!
  assert.equal(finished.status, 'completed')
  assert.equal(finished.exitCode, 7)
  assert.match(finished.output, /stdout/)
  assert.match(finished.output, /problem/)
  const list = JSON.parse(body(await env.call('job_list', {})))
  assert.equal(list[0].detail, 'exit code: 7')
  assert.match(body(await env.call('job_output', { job_id: String(job!.id) })), /\[status: completed, exit code: 7\]$/)
  await env.harness.waitForIdle(context)
  assert.equal((await notices(env.root)).length, 1)
})

test('kill requests cancellation immediately; killed means the process tree has stopped; ordinary abort keeps jobs alive', options, async t => {
  const command = node("const child = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(()=>{}, 1000)'], {stdio:'inherit'}); console.log('PIDS:' + process.pid + ':' + child.pid); setInterval(()=>{},1000)")
  const env = await setup(t, [start(command)])
  await run(env.root)
  const running = await untilJob(env.harness, env.root, job => job.output.includes('PIDS:'))
  await env.root.abort(context)
  assert.equal((await jobs(env.harness, env.root))[0]!.status, 'running')
  const response = JSON.parse(body(await env.call('job_kill', { job_id: String(running.id), reason: 'No longer needed' })))
  assert.equal(response.outcome, 'cancellation-requested')
  assert.equal(response.job.status, 'stopping')
  await env.harness.waitForTask(running.id, context)
  const stopped = (await jobs(env.harness, env.root))[0]!
  assert.equal(stopped.status, 'killed')
  assert.equal(stopped.error, 'No longer needed')
  assert.equal((await notices(env.root)).length, 0)
  const pids = /PIDS:(\d+):(\d+)/.exec(running.output)!
  await assertDead(Number(pids[1]))
  await assertDead(Number(pids[2]))
  assert.equal(JSON.parse(body(await env.call('job_kill', { job_id: String(running.id) }))).outcome, 'already-finished')
})

test('foreground-only bash timeout preserves streamed output and process cancellation', options, async t => {
  const env = await setup(t, [toolRound('bash', { command: node("console.log('PID:' + process.pid); setInterval(()=>{},1000)"), timeoutMs: 250 })])
  await env.root.configure({ extensions: { remove: [env.plugin.extension] } }, context)
  await run(env.root)
  assert.equal((await results(env.root))[0]!.isError, true)
  assert.match(JSON.stringify((await results(env.root))[0]!), /timed out/)
  const timedOut = JSON.stringify((await results(env.root))[0]!)
  assert.ok(!timedOut.includes('[exit code: 0]'))
  await assertDead(Number(/PID:(\d+)/.exec(timedOut)![1]))
  assert.equal((await jobs(env.harness, env.root)).length, 0)
})

test('background bash ignores foreground process timeouts', options, async t => {
  const env = await setup(t, [start(gated(), { timeoutMs: 1 }), fauxAssistantMessage('Working.')])
  await run(env.root)
  const running = await untilJob(env.harness, env.root, job => job.output.includes('READY'))
  assert.equal(running.status, 'running')
  await env.root.abort(context, { background: true })
  assert.equal((await jobs(env.harness, env.root))[0]!.status, 'killed')
})

test('replaying a private start reuses the native task and command executes once', options, async t => {
  const env = await setup(t, [start('printf x >> marker; printf finished')], { replay: true })
  await run(env.root)
  const all = await jobs(env.harness, env.root)
  assert.equal(all.length, 1)
  await env.harness.waitForTask(all[0]!.id, context)
  assert.equal(await readFile(join(env.cwd, 'marker'), 'utf8'), 'x')
})

test('all control tools and commands reject foreign jobs and malformed ids', options, async t => {
  const env = await setup(t, [start(gated())])
  await run(env.root)
  const running = await untilJob(env.harness, env.root, job => job.output.includes('READY'))
  const foreign = await env.harness.createConversation({ ownership: { kind: 'ownerless' } }, context)
  const ctx = { harness: env.harness, conversation: foreign, context }
  for (const command of ['get', 'output', 'stop']) await assert.rejects(env.plugin.commands!.jobs!(`${command} ${running.id}`, ctx), /Unknown background job in this conversation/)
  for (const name of ['job_output', 'job_kill']) await assert.rejects(env.call(name, { job_id: String(running.id) }, foreign), /Unknown background job in this conversation/)
  assert.deepEqual(JSON.parse(body(await env.call('job_list', {}, foreign))), [])
  for (const id of ['', '0', '1x', '9007199254740993']) await assert.rejects(env.call('job_output', { job_id: id }), /Invalid job_id/)
  for (const args of ['stop', 'get 0', 'output 1 extra', 'stop 9007199254740993', 'nonsense']) await assert.rejects(env.plugin.commands!.jobs!(args, ctx), /Usage:/)
  assert.equal((await jobs(env.harness, env.root))[0]!.status, 'running')
  await env.root.abort(context, { background: true })
})

test('public list/output/kill tools and /jobs commands inspect and stop native jobs', options, async t => {
  const env = await setup(t, [start(gated(), { description: 'Control test' })])
  await run(env.root)
  const running = await untilJob(env.harness, env.root, job => job.output.includes('READY'))
  const ctx = { harness: env.harness, conversation: env.root, context }
  const list = await env.plugin.commands!.jobs!('list', ctx)
  const get = await env.plugin.commands!.jobs!(`get ${running.id}`, ctx)
  assert.equal(JSON.parse(list.output!)[0].id, String(running.id))
  assert.equal(JSON.parse(get.output!).status, 'running')
  assert.ok(!('output' in JSON.parse(get.output!)))
  env.faux.setResponses([
    fauxAssistantMessage([
      fauxToolCall('job_list', {}, { id: 'list' }),
      fauxToolCall('job_output', { job_id: String(running.id) }, { id: 'output' }),
    ], { stopReason: 'toolUse' }),
    toolRound('job_kill', { job_id: String(running.id) }), fauxAssistantMessage('Stopped requested job.'),
  ])
  await run(env.root)
  await env.harness.waitForTask(running.id, context)
  const toolResults = await results(env.root)
  assert.equal(toolResults.length, 4)
  assert.ok(toolResults.every(result => !result.isError))
  assert.match(JSON.stringify(toolResults.find(result => result.toolCallId === 'output')!.content), /READY/)
  assert.equal((await jobs(env.harness, env.root))[0]!.status, 'killed')
  assert.equal((await notices(env.root)).length, 0)
})

test('blank command and invalid timeout fail without creating jobs; private start and old aliases are not model tools', options, async t => {
  const cases: JsonObject[] = [{ command: ' \n ' }, { command: 'true', timeoutMs: 0 }, { command: 'true', timeoutMs: -1 }]
  for (const args of cases) {
    const env = await setup(t, [toolRound('bash', { ...args, run_in_background: true })])
    await run(env.root)
    assert.equal((await results(env.root))[0]!.isError, true)
    assert.equal((await jobs(env.harness, env.root)).length, 0)
  }
  const env = await setup(t, [toolRound('job_start', { command: 'touch BAD', description: 'Should never execute' })])
  await run(env.root)
  assert.equal((await results(env.root))[0]!.isError, true)
  assert.equal((await jobs(env.harness, env.root)).length, 0)
  assert.ok(!env.plugin.extension.tools!.some(tool => tool.name === 'job_status'))
})

test('close/reopen stops the process, reports interruption as failed, and never repeats side effects', options, async t => {
  const env = await setup(t, [start(gated("require('node:fs').appendFileSync('marker', 'x'); console.log('PID:' + process.pid)"), { description: 'Interrupted work' })], { sqlite: true })
  await run(env.root)
  const running = await untilJob(env.harness, env.root, job => job.output.includes('READY'))
  await env.harness.close(context)
  await assertDead(Number(/PID:(\d+)/.exec(running.output)![1]))
  await env.reopen()
  const root = (await env.harness.conversation(env.root.id, context))!
  env.harness.resume()
  await env.harness.waitForTask(running.id, context)
  await env.harness.waitForIdle(context)
  const [interrupted] = await jobs(env.harness, root)
  assert.equal(interrupted!.status, 'interrupted')
  assert.equal(await readFile(join(env.cwd, 'marker'), 'utf8'), 'x')
  assert.equal((await notices(root)).length, 1)
  assert.equal(((await notices(root))[0]!.data as { status: string }).status, 'failed')
  assert.match(body(await env.call('job_output', { job_id: String(running.id) }, root)), /\[status: failed, .*interrupted.*\]$/)
  await env.harness.close(context)
  await env.reopen()
  const restored = (await env.harness.conversation(root.id, context))!
  env.harness.resume()
  await env.harness.waitForIdle(context)
  assert.equal((await notices(restored)).length, 1)
  assert.equal(await readFile(join(env.cwd, 'marker'), 'utf8'), 'x')
})

test('report retry after admission uses a fixed requestId and never duplicates notification', options, async t => {
  const env = await setup(t, [start('printf ok')], { sqlite: true, replayReport: true })
  await run(env.root)
  await env.reportAdmitted
  await env.harness.close(context)
  await env.reopen()
  const root = (await env.harness.conversation(env.root.id, context))!
  env.harness.resume()
  const [job] = await jobs(env.harness, root)
  await env.harness.waitForTask(job!.id, context)
  await env.harness.waitForIdle(context)
  assert.equal((await notices(root)).length, 1)
})

test('incremental reads consume only new output; replay of one read returns its original receipt', options, async t => {
  const env = await setup(t, [start(gated())], { replayOutput: true })
  await run(env.root)
  const running = await untilJob(env.harness, env.root, job => job.output.includes('READY'))
  env.faux.setResponses([toolRound('job_output', { job_id: String(running.id) }), fauxAssistantMessage('Read progress.')])
  await run(env.root)
  assert.match(JSON.stringify((await results(env.root)).at(-1)!.content), /READY/)
  assert.equal(body(await env.call('job_output', { job_id: String(running.id) })), '(no new output)\n[status: running]')
  await writeFile(join(env.cwd, 'gate'), '')
  await env.harness.waitForTask(running.id, context)
  const delta = body(await env.call('job_output', { job_id: String(running.id) }))
  assert.match(delta, /DONE/)
  assert.ok(!delta.includes('READY'))
  assert.match(delta, /\[status: completed, exit code: 0\]$/)
})

test('wait timeout is non-destructive and waits can be cancelled without killing the job', options, async t => {
  const env = await setup(t, [start(gated())])
  await run(env.root)
  const running = await untilJob(env.harness, env.root, job => job.output.includes('READY'))
  const first = body(await env.call('job_output', { job_id: String(running.id), wait: true, timeout_ms: 20 }))
  assert.match(first, /\[status: running\]$/)
  assert.equal((await jobs(env.harness, env.root))[0]!.status, 'running')
  const controller = new AbortController()
  const waiting = env.call('job_output', { job_id: String(running.id), wait: true }, env.root, withAbortSignal(controller.signal, context))
  controller.abort(new Error('User cancelled this wait'))
  await assert.rejects(waiting, /User cancelled/)
  assert.equal((await jobs(env.harness, env.root))[0]!.status, 'running')
  await env.root.abort(context, { background: true })
})

test('wait settles on completion and collecting a waited result suppresses redundant completion notices', options, async t => {
  const env = await setup(t, [start(gated())])
  await run(env.root)
  const running = await untilJob(env.harness, env.root, job => job.output.includes('READY'))
  const waiting = env.call('job_output', { job_id: String(running.id), wait: true, timeout_ms: 600_001 })
  await writeFile(join(env.cwd, 'gate'), '')
  assert.match(body(await waiting), /DONE\n\[status: completed, exit code: 0\]$/)
  await env.harness.waitForTask(running.id, context)
  assert.equal((await notices(env.root)).length, 0)
})

test('completion wakes at most three consecutive idle turns; human input resets the budget', options, async t => {
  const calls = Array.from({ length: 5 }, (_, index) => fauxToolCall('bash', { command: gated('', `gate-${index}`), description: 'Wait for an independent release gate', run_in_background: true }, { id: `job-${index}` }))
  const env = await setup(t, [fauxAssistantMessage(calls, { stopReason: 'toolUse' }), fauxAssistantMessage('Started five jobs.')])
  await run(env.root)
  const all = await jobs(env.harness, env.root)
  assert.equal(all.length, 5)
  for (let index = 0; index < 4; index++) {
    if (index === 2) {
      const goalPlugin = createGoalPlugin(() => env.harness)
      env.registry.install(goalPlugin.extension)
      await goalPlugin.commands!.goal!('Complete the existing work', { harness: env.harness, conversation: env.root, context })
      await env.root.commit(async tx => { (await tx.doc(GoalDoc, env.root.id)).goal!.maxGoalRounds = 1 }, context)
      const goal = (await env.harness.snapshot(GoalDoc, env.root.id, context))!.goal!
      env.faux.setResponses([
        fauxAssistantMessage('Collected the third result.'),
        toolRound('update_goal', { goal_id: goal.id, revision: goal.revision, action: 'complete' }),
        ...Array.from({ length: 10 }, () => fauxAssistantMessage('Goal is complete.')),
      ])
    }
    await writeFile(join(env.cwd, `gate-${index}`), '')
    await env.harness.waitForTask(all[index]!.id, context)
    await env.harness.waitForIdle(context)
    assert.equal((await jobs(env.harness, env.root))[index]!.delivery, index < 3 ? 'wake' : 'inject')
    if (index === 2) assert.equal((await env.harness.snapshot(GoalDoc, env.root.id, context))!.goal!.roundsStarted, 1)
  }
  assert.equal((await notices(env.root)).length, 4)
  await run(env.root)
  await writeFile(join(env.cwd, 'gate-4'), '')
  await env.harness.waitForTask(all[4]!.id, context)
  assert.equal((await jobs(env.harness, env.root))[4]!.delivery, 'wake')
})

test('completion while parent is busy injects at its next boundary without queuing another turn', options, async t => {
  const env = await setup(t, [start(gated())])
  await run(env.root)
  const running = await untilJob(env.harness, env.root, job => job.output.includes('READY'))
  env.faux.setResponses([toolRound('bash', { command: gated('', 'foreground-gate') }), fauxAssistantMessage('Foreground finished.')])
  const parent = run(env.root)
  const watch = (await env.harness.watchDoc(LiveDoc, env.root.id, context))!
  try {
    await new Promise<void>(resolve => {
      const check = () => { if (watch.value?.tools?.some(tool => tool.output?.includes('READY'))) resolve() }
      check()
      watch.start(async () => { check() })
    })
    await writeFile(join(env.cwd, 'gate'), '')
    await env.harness.waitForTask(running.id, context)
    assert.equal((await jobs(env.harness, env.root))[0]!.delivery, 'inject')
    assert.equal((await env.harness.inspect(context)).submissions.filter(item => item.conversationId === env.root.id && item.type === 'input' && item.status === 'queued').length, 0)
    await writeFile(join(env.cwd, 'foreground-gate'), '')
    await parent
    assert.equal((await notices(env.root)).length, 1)
  } finally { await watch.stop() }
})

test('removing background extension removes bash background advertising and its private controls', options, async t => {
  const env = await setup(t, [])
  const withBackground = await env.root.agent(context)
  const wrapped = withBackground.tools.find(tool => tool.name === 'bash')!
  assert.equal(wrapped.replay, 'unsafe')
  assert.ok('run_in_background' in (wrapped.parameters as { properties: Record<string, unknown> }).properties)
  assert.ok(!withBackground.tools.some(tool => tool.name === 'job_start' || tool.name === 'job_status'))
  await env.root.configure({ extensions: { remove: [env.plugin.extension] } }, context)
  const withoutBackground = await env.root.agent(context)
  const foreground = withoutBackground.tools.find(tool => tool.name === 'bash')!
  const parameters = foreground.parameters as { required: string[]; properties: Record<string, unknown> }
  assert.equal(foreground.replay, 'unsafe')
  assert.deepEqual(parameters.required, ['command', 'description'])
  assert.ok('timeoutMs' in parameters.properties)
  assert.ok('workdir' in parameters.properties)
  assert.ok(!('timeout' in parameters.properties))
  assert.ok(!('run_in_background' in parameters.properties))
  assert.ok(!foreground.description.includes('job_output'))
  assert.ok(withoutBackground.sections.some(section => section.key === 'bash_policy'))
  assert.ok(!withoutBackground.tools.some(tool => tool.name.startsWith('job_')))
})

for (const sample of [
  { name: 'normal exit', args: { command: 'printf ok' }, expected: /ok\\n\[exit code: 0\]/ },
  { name: 'nonzero exit', args: { command: 'printf stdout; printf stderr >&2; exit 7' }, expected: /stdoutstderr\\n\[exit code: 7\]/ },
  { name: 'workdir', args: { command: 'pwd', workdir: 'nested' }, expected: /nested\\n\\n\[exit code: 0\]/ },
] as { name: string; args: JsonObject; expected: RegExp }[]) {
  test(`foreground-only bash preserves DSH ${sample.name} semantics`, options, async t => {
    const env = await setup(t, [toolRound('bash', sample.args)])
    await mkdir(join(env.cwd, 'nested'))
    await env.root.configure({ extensions: { remove: [env.plugin.extension] } }, context)
    await run(env.root)
    const result = (await results(env.root))[0]!
    assert.equal(result.isError, false)
    assert.match(JSON.stringify(result.content), sample.expected)
    assert.equal((await jobs(env.harness, env.root)).length, 0)
    assert.deepEqual(env.reports, [])
  })
}

test('background bash honors workdir', options, async t => {
  const env = await setup(t, [start('pwd; printf once >> marker', { workdir: 'nested' }), fauxAssistantMessage('Started.')])
  await mkdir(join(env.cwd, 'nested'))
  await run(env.root)
  const [job] = await jobs(env.harness, env.root)
  await env.harness.waitForTask(job!.id, context)
  assert.equal(await readFile(join(env.cwd, 'nested', 'marker'), 'utf8'), 'once')
  assert.equal((await jobs(env.harness, env.root))[0]!.output.trim(), join(env.cwd, 'nested'))
})

test('foreground bash remains unsafe across restart and never repeats external side effects', options, async t => {
  const env = await setup(t, [toolRound('bash', { command: gated("require('node:fs').appendFileSync('marker', 'x'); console.log('PID:' + process.pid)") })], { sqlite: true })
  await env.root.configure({ extensions: { remove: [env.plugin.extension] } }, context)
  const pending = run(env.root).catch(error => error)
  const watch = (await env.harness.watchDoc(LiveDoc, env.root.id, context))!
  let output = ''
  try {
    await new Promise<void>(resolve => {
      const check = () => {
        output = watch.value?.tools?.map(tool => tool.output ?? '').join('\n') ?? ''
        if (output.includes('READY')) resolve()
      }
      check()
      watch.start(async () => { check() })
    })
  } finally { await watch.stop() }
  await env.harness.close(context)
  await pending
  await assertDead(Number(/PID:(\d+)/.exec(output)![1]))
  await env.reopen()
  const root = (await env.harness.conversation(env.root.id, context))!
  env.harness.resume()
  await env.harness.waitForIdle(context)
  assert.equal(await readFile(join(env.cwd, 'marker'), 'utf8'), 'x')
  assert.equal((await jobs(env.harness, root)).length, 0)
})
