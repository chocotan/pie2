import { resolve } from 'node:path'
import { withoutAbortSignal, type Context } from '@earendil-works/chord/context'
import { Type } from '@earendil-works/pi-ai'
import {
  defineDoc, defineExtension, defineTask, defineTool, GenerationTask, hook, LiveDoc, section, wrapTool,
  type ConversationId, type EntryId, type Harness, type TaskId, type ToolRegistration,
} from '@earendil-works/pi-durable'
import { createBashTool } from '@earendil-works/pi-durable/tools'
import { text, type Plugin } from '../plugin.ts'
import type { bashParameters } from './coding.ts'

const OUTPUT_BYTES = 50 * 1024
const WAIT_MS = 30_000
const MAX_WAIT_MS = 600_000
export type BackgroundJob = {
  id: TaskId
  command: string
  description: string
  timeout: number | null
  workdir: string | null
  status: 'queued' | 'running' | 'stopping' | 'completed' | 'failed' | 'killed' | 'interrupted'
  createdAt: number
  startedAt: number | null
  finishedAt: number | null
  exitCode: number | null
  output: string
  outputBytes: number
  cursor: number
  truncated: boolean
  error: string | null
  reported: boolean
  delivery: 'wake' | 'inject' | 'skip' | null
}
export const BackgroundDoc = defineDoc<{ jobs: BackgroundJob[] }>({
  kind: 'pie2.background', version: 1, scope: 'conversation', history: 'latest', fork: 'initial',
  initial: () => ({ jobs: [] }), checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 31,
})
const DeliveryDoc = defineDoc<{ human: number | null; wakes: number }>({
  kind: 'pie2.background-delivery', version: 1, scope: 'conversation', history: 'latest', fork: 'initial',
  initial: () => ({ human: null, wakes: 0 }), checkpointWhen: () => false,
})
const OutputReceipt = defineDoc<{ output: string | null }>({
  kind: 'pie2.background-output', version: 1, scope: 'task',
  initial: () => ({ output: null }), checkpointWhen: () => false,
})
const StartReceipt = defineDoc<{ id: TaskId | null }>({
  kind: 'pie2.background-start', version: 1, scope: 'task',
  initial: () => ({ id: null }), checkpointWhen: () => false,
})
type JobInput = { command: string; description: string; timeout: number | null; workdir: string | null }
type Checkpoint = { phase: 'run' } | { phase: 'report' }
const active = (job: BackgroundJob) => ['queued', 'running', 'stopping'].includes(job.status)
function tail(value: string, limit = OUTPUT_BYTES) {
  const bytes = Buffer.from(value)
  if (bytes.length <= limit) return { output: value, truncated: false }
  let start = bytes.length - limit
  while ((bytes[start]! & 0xc0) === 0x80) start++
  return { output: bytes.subarray(start).toString('utf8'), truncated: true }
}
function expectJob(jobs: readonly BackgroundJob[], id: number) {
  const job = jobs.find(item => item.id === id)
  if (!job) throw new Error(`Unknown background job in this conversation: ${id}`)
  return job
}
function parseId(id: string) {
  if (!/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(Number(id))) throw new Error('Invalid job_id: expected a non-empty native job id string')
  return Number(id)
}
function publicJob(job: BackgroundJob) {
  return {
    id: String(job.id), kind: 'bash', label: job.description,
    status: job.status === 'queued' ? 'running' : job.status === 'interrupted' ? 'failed' : job.status,
    ...(job.error ? { detail: job.error } : job.exitCode !== null ? { detail: `exit code: ${job.exitCode}` } : {}),
    startedAt: job.startedAt ?? job.createdAt,
    ...(job.finishedAt === null ? {} : { finishedAt: job.finishedAt }),
  }
}

export function createBackgroundPlugin(getHarness: () => Harness): Plugin {
  const waiters = new Map<number, number>()
  const JobTask = defineTask<JobInput, Checkpoint, null, {}>({
    name: 'pie2.background-job', version: 1,
    initial: () => ({ phase: 'run' }),
    phases: {
      run: async (_task, runtime, context) => {
        let interrupted = false
        await runtime.commit(async tx => {
          const job = expectJob((await tx.doc(BackgroundDoc, runtime.conversationId)).jobs, runtime.taskId)
          // A shell command is an external side effect: a resumed invocation must never execute it again.
          if (job.startedAt !== null) {
            interrupted = true
            job.status = 'interrupted'
            job.finishedAt = runtime.now()
            job.error = 'Process interrupted by shutdown or restart; command was not replayed.'
            return { status: 'running', checkpoint: { phase: 'report' } }
          }
          job.status = 'running'
          job.startedAt = runtime.now()
        }, context)
        if (interrupted) return

        let output = ''
        let outputBytes = 0
        let truncated = false
        let cancelTimer: (() => void) | undefined
        let pending = Promise.resolve()
        const persist = () => {
          const snapshot = { output, outputBytes, truncated }
          pending = pending.then(() => runtime.commit(async tx => {
            Object.assign(expectJob((await tx.doc(BackgroundDoc, runtime.conversationId)).jobs, runtime.taskId), snapshot)
            return undefined
          }, context)).catch(error => { if (!runtime.signal.aborted) runtime.report(error) })
        }
        let exitCode: number | null = null
        let error: string | null = null
        try {
          const env = await runtime.env(context)
          if (!env) throw new Error('Background jobs require an execution environment')
          const result = await env.exec(_task.input.command, {
            ...(_task.input.timeout === null ? {} : { timeout: _task.input.timeout }),
            ...(_task.input.workdir === null ? {} : { cwd: _task.input.workdir }),
            onOutput: chunk => {
              outputBytes += Buffer.byteLength(chunk)
              const retained = tail(output + chunk)
              output = retained.output
              truncated ||= retained.truncated
              if (!cancelTimer) cancelTimer = runtime.setTimer(() => {
                cancelTimer = undefined
                persist()
              }, 100)
            },
          }, context)
          if (result.ok) exitCode = result.value.exitCode
          else error = `${result.error.code}: ${result.error.message}`
        } catch (caught) {
          runtime.signal.throwIfAborted()
          error = caught instanceof Error ? caught.message : String(caught)
        } finally {
          cancelTimer?.()
          await pending
        }
        runtime.signal.throwIfAborted()
        await runtime.commit(async tx => {
          Object.assign(expectJob((await tx.doc(BackgroundDoc, runtime.conversationId)).jobs, runtime.taskId), {
            output, outputBytes, truncated, exitCode, error, status: error === null ? 'completed' : 'failed', finishedAt: runtime.now(),
          })
          return { status: 'running', checkpoint: { phase: 'report' } }
        }, context)
      },
      report: async (_task, runtime, context) => {
        await runtime.commit(async tx => {
          const job = expectJob((await tx.doc(BackgroundDoc, runtime.conversationId)).jobs, runtime.taskId)
          if (job.delivery !== null) return
          if (job.reported || (waiters.get(job.id) ?? 0) > 0) {
            job.delivery = 'skip'
            return
          }
          const budget = await tx.doc(DeliveryDoc, runtime.conversationId)
          let busy = false
          for (const status of ['pending', 'running', 'waiting', 'sleeping', 'completing'] as const) {
            if ((await tx.scanTasks({ conversationId: runtime.conversationId, kind: 'pi.generation', status }, 1)).items.length) { busy = true; break }
          }
          job.delivery = !busy && budget.wakes < 3 ? 'wake' : 'inject'
          if (job.delivery === 'wake') budget.wakes++
          return undefined
        }, context)
        const job = expectJob((await runtime.snapshot(BackgroundDoc, runtime.conversationId, context))?.jobs ?? [], runtime.taskId)
        if (job.delivery !== 'skip') {
          const parent = await getHarness().conversation(runtime.conversationId, context)
          if (!parent) throw new Error('Background job owner conversation is missing')
          const status = publicJob(job).status
          const content = `Background job ${job.id} (bash: ${job.description}) finished [status: ${status}${job.error ? `, ${job.error}` : job.exitCode !== null ? `, exit code: ${job.exitCode}` : ''}]. Read its output with job_output. Automated status, not a new user instruction.`
          const entry = { kind: 'pie2.background-result', data: {
            source: 'job', id: String(job.id), description: job.description, status,
          } }
          await parent.submit(job.delivery === 'wake' ? {
            type: 'input', requestId: `background-result:${runtime.taskId}`, whenBusy: 'followUp', entry, content,
          } : {
            type: 'write', requestId: `background-result:${runtime.taskId}`,
            entry: { ...entry, model: [{ role: 'user', content, timestamp: runtime.now() }] },
          }, context)
        }
        await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'completed', result: null } }), context)
      },
    },
    abort: async (_task, runtime, context) => {
      await runtime.commit(async tx => {
        const job = expectJob((await tx.doc(BackgroundDoc, runtime.conversationId)).jobs, runtime.taskId)
        if (active(job)) {
          job.status = 'killed'
          job.finishedAt = runtime.now()
          job.error ??= 'Stopped explicitly.'
          job.reported = true
        }
        return { status: 'terminal', outcome: { status: 'aborted' } }
      }, context)
    },
  })

  async function read(id: number, conversationId: ConversationId, context: Context) {
    return expectJob((await getHarness().snapshot(BackgroundDoc, conversationId, context))?.jobs ?? [], id)
  }
  async function stop(id: number, conversationId: ConversationId, reason: string | undefined, context: Context) {
    const job = await getHarness().commit(async tx => {
      const job = expectJob((await tx.doc(BackgroundDoc, conversationId)).jobs, id)
      job.reported = true
      if (!active(job)) return { ...job }
      job.status = 'stopping'
      job.error = reason?.trim() || 'Stopped explicitly.'
      return { ...job }
    }, context)
    if (job.status !== 'stopping') return { outcome: 'already-finished', job: publicJob(job) }
    // abortTask joins the process invocation; admission must not make job_kill block on that join.
    void getHarness().abortTask(job.id, withoutAbortSignal(context)).catch(error => {
      console.error(`Could not stop background job ${job.id}:`, error)
    })
    return { outcome: 'cancellation-requested', job: publicJob(job) }
  }
  async function wait(id: number, conversationId: ConversationId, timeout: number, context: Context) {
    const watch = await getHarness().watchDoc(BackgroundDoc, conversationId, context)
    if (!watch) throw new Error('Background jobs document is missing')
    const signal = context.abortSignal
    let timer: NodeJS.Timeout | undefined
    let onAbort: (() => void) | undefined
    try {
      await new Promise<void>((resolve, reject) => {
        onAbort = () => reject(signal?.reason ?? new Error('wait aborted'))
        signal?.addEventListener('abort', onAbort, { once: true })
        if (signal?.aborted) { onAbort(); return }
        const check = (state: typeof watch.value) => {
          try { if (!active(expectJob(state?.jobs ?? [], id))) resolve() }
          catch (error) { reject(error) }
        }
        timer = setTimeout(resolve, timeout)
        check(watch.value)
        watch.start(async state => { check(state) })
      })
    } finally {
      if (timer) clearTimeout(timer)
      if (onAbort) signal?.removeEventListener('abort', onAbort)
      await watch.stop()
    }
  }
  async function output(id: number, conversationId: ConversationId, shouldWait: boolean, timeout: number, context: Context, taskId?: TaskId) {
    await read(id, conversationId, context)
    if (taskId) {
      const receipt = await getHarness().snapshot(OutputReceipt, taskId, context)
      if (receipt?.output !== null && receipt?.output !== undefined) return text(receipt.output)
    }
    if (shouldWait) waiters.set(id, (waiters.get(id) ?? 0) + 1)
    try {
      if (shouldWait) await wait(id, conversationId, timeout, context)
      return await getHarness().commit(async tx => {
        const receipt = taskId ? await tx.doc(OutputReceipt, taskId) : undefined
        if (receipt?.output !== null && receipt?.output !== undefined) return text(receipt.output)
        const job = expectJob((await tx.doc(BackgroundDoc, conversationId)).jobs, id)
        const bytes = Buffer.from(job.output)
        const end = job.outputBytes ?? bytes.length
        const start = end - bytes.length
        const cursor = job.cursor ?? 0
        const lost = cursor < start
        const delta = bytes.subarray(Math.max(0, cursor - start)).toString('utf8')
        job.cursor = end
        if (!active(job)) job.reported = true
        const status = publicJob(job)
        const suffix = `\n[status: ${status.status}${status.detail ? `, ${status.detail}` : ''}]`
        const notice = lost ? '\n[output truncated; unread output dropped from memory]' : ''
        const body = (delta || '(no new output)').replace(/\n$/, '')
        const fitted = tail(body, OUTPUT_BYTES - Buffer.byteLength(notice + suffix)).output
        const rendered = fitted + notice + suffix
        if (receipt) receipt.output = rendered
        return text(rendered)
      }, context)
    } finally {
      if (shouldWait) {
        const remaining = waiters.get(id)! - 1
        if (remaining) waiters.set(id, remaining)
        else waiters.delete(id)
      }
    }
  }
  const idSchema = Type.String({ minLength: 1, description: 'Job id returned by bash(run_in_background: true).' })
  return {
    name: 'background',
    extension: defineExtension({
      name: 'background', tasks: [JobTask],
      hooks: [hook(GenerationTask, {
        beforeRequest: async (_request, api, context) => {
          const harness = getHarness()
          const entries: EntryId[] = []
          const live = await api.snapshot(LiveDoc, api.conversationId, context)
          for (const id of live?.run?.inputs ?? []) {
            const record = await (await harness.submission(id, context))?.status(context)
            if (record?.type === 'input' && record.status === 'placed') entries.push(record.entry)
          }
          await harness.commit(async tx => {
            let human: number | null = null
            for (const id of entries) if ((await tx.entry(id))?.kind === 'pi.user') human = Math.max(human ?? 0, id)
            if (human === null) return
            const budget = await tx.doc(DeliveryDoc, api.conversationId)
            if (budget.human !== human) { budget.human = human; budget.wakes = 0 }
          }, context)
          return undefined
        },
      })],
      wraps: [wrapTool<ToolRegistration>(createBashTool(), original => defineTool({
        ...original, prepareArguments: undefined,
        description: `${original.description} Set run_in_background: true for long-running independent commands: returns a job id immediately; collect with job_output and stop with job_kill. No timeout applies to background commands.`,
        parameters: Type.Object({
          ...(original.parameters as typeof bashParameters).properties,
          run_in_background: Type.Optional(Type.Boolean({ default: false, description: 'Return a job id immediately; collect with job_output and stop with job_kill. No timeout applies.' })),
        }, { additionalProperties: false }),
        structuredOutputSchema: Type.Union([
          original.structuredOutputSchema!, Type.Object({ kind: Type.Literal('background'), jobId: Type.String() }),
        ]),
        execute: async ({ run_in_background, ...args }, api, context) => {
          if (run_in_background !== true) return original.execute(args, api, context)
          if (!args.command.trim()) throw new Error('Command must not be blank')
          if (!args.description.trim()) throw new Error('Description must not be blank')
          const workdir = args.workdir === undefined ? undefined : resolve(api.env?.cwd ?? (await api.agent(context)).cwd ?? process.cwd(), args.workdir)
          const result = await api.executeTool('job_start', { command: args.command, description: args.description.trim(), ...(workdir === undefined ? {} : { workdir }) }, context, { key: 'background' })
          return { isError: result.isError, structuredOutput: result.structuredOutput, output: [{ type: 'text' as const,
            text: result.isError ? result.diagnostics.map(item => item.message).join('\n') : JSON.stringify(result.structuredOutput),
          }] }
        },
      }))],
      sections: [section('background_jobs', () => 'Track every background job id you start with bash(run_in_background: true). Use background mode for long-running independent commands; short commands can stay foreground. Completion notices arrive automatically — do not busy-poll or sleep; keep working on independent steps and do not duplicate running work. Before giving a final answer, collect every still-relevant job with job_output (wait: true only when genuinely blocked), and job_kill jobs that stopped mattering. Ordinary abort leaves jobs running. Shutdown interrupts processes; interrupted commands are never replayed.')],
      tools: [
        defineTool({
          name: 'job_start', callers: ['tools'], description: 'Private background bash bridge.',
          parameters: Type.Object({
            command: Type.String({ minLength: 1, maxLength: 131072 }),
            description: Type.String({ minLength: 1, maxLength: 400 }),
            workdir: Type.Optional(Type.String({ minLength: 1 })),
          }, { additionalProperties: false }),
          structuredOutputSchema: Type.Object({ kind: Type.Literal('background'), jobId: Type.String() }),
          replay: 'safe', executionMode: 'sequential',
          execute: async (args, api, context) => {
            if (!args.command.trim() || !args.description.trim()) throw new Error('Command and description must not be blank')
            const id = await api.commit(async tx => {
              const receipt = await tx.doc(StartReceipt, api.taskId)
              if (receipt.id !== null) return receipt.id
              const state = await tx.doc(BackgroundDoc, api.conversationId)
              if (state.jobs.filter(active).length >= 10) throw new Error('Background job limit reached (10); stop an unneeded job or wait for completion')
              const input = { command: args.command, description: args.description.trim(), timeout: null, workdir: args.workdir ?? null }
              const id = await tx.createTask(JobTask, input, {
                conversationId: api.conversationId, ownership: { kind: 'conversation' }, background: true,
              })
              state.jobs.push({ ...input, id, status: 'queued', createdAt: api.now(), startedAt: null, finishedAt: null, exitCode: null,
                output: '', outputBytes: 0, cursor: 0, truncated: false, error: null, reported: false, delivery: null })
              receipt.id = id
              return id
            }, context)
            const result = { kind: 'background', jobId: String(id) }
            return { ...text(result), structuredOutput: result }
          },
        }),
        defineTool({
          name: 'job_list', description: 'List your running and finished background jobs with ids, kinds, labels, and statuses.',
          parameters: Type.Object({}, { additionalProperties: false }), replay: 'safe',
          execute: async (_args, api, context) => text(((await api.snapshot(BackgroundDoc, api.conversationId, context))?.jobs ?? []).map(publicJob)),
        }),
        defineTool({
          name: 'job_output', description: 'Read only new output since the previous read (at most 50 KiB). Every response ends with [status: ...]. Non-blocking unless wait: true; a timed-out or cancelled wait leaves the job alive.',
          parameters: Type.Object({ job_id: idSchema, wait: Type.Optional(Type.Boolean()), timeout_ms: Type.Optional(Type.Number({ exclusiveMinimum: 0 })) }, { additionalProperties: false }),
          replay: 'safe', executionMode: 'sequential',
          execute: async (args, api, context) => {
            const timeout = args.timeout_ms ?? WAIT_MS
            if (!Number.isFinite(timeout) || timeout <= 0) throw new Error('Wait timeout must be a positive finite number of milliseconds')
            return output(parseId(args.job_id), api.conversationId, args.wait === true, Math.min(timeout, MAX_WAIT_MS), context, api.taskId)
          },
        }),
        defineTool({
          name: 'job_kill', description: 'Request cancellation and return immediately. The job becomes killed only once its process tree actually stops.',
          parameters: Type.Object({ job_id: idSchema, reason: Type.Optional(Type.String()) }, { additionalProperties: false }), replay: 'safe',
          execute: async (args, api, context) => text(await stop(parseId(args.job_id), api.conversationId, args.reason, context)),
        }),
      ],
    }),
    commands: {
      jobs: async (args, { conversation, context }) => {
        const command = args.trim()
        if (!command || command === 'list') return { output: JSON.stringify(((await getHarness().snapshot(BackgroundDoc, conversation.id, context))?.jobs ?? []).map(publicJob), null, 2) }
        const match = /^(get|output|stop)\s+([1-9]\d*)$/.exec(command)
        if (!match || !Number.isSafeInteger(Number(match[2]))) throw new Error('Usage: /jobs [list|get <id>|output <id>|stop <id>]')
        const id = Number(match[2])
        if (match[1] === 'output') {
          const result = await output(id, conversation.id, false, WAIT_MS, context)
          return { output: result.output[0]!.text }
        }
        return { output: JSON.stringify(match[1] === 'stop' ? await stop(id, conversation.id, undefined, context) : publicJob(await read(id, conversation.id, context)), null, 2) }
      },
    },
  }
}
