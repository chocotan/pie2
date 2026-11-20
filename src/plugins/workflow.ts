import { withAbortSignal, type Context } from '@earendil-works/chord/context'
import { Type } from '@earendil-works/pi-ai'
import { Value } from 'typebox/value'
import type { TSchema } from 'typebox'
import { CodemodeSandbox, type CodemodeRunOptions } from '@earendil-works/pi-codemode'
import { createCodemodeTool } from '@earendil-works/pi-durable/codemode'
import {
  defineDoc, defineExtension, defineTool, section,
  type JsonObject, type ToolExecutionApi, type ToolExecutionResult, type Tx, type ConversationId,
} from '@earendil-works/pi-durable'
import { text, type Plugin } from '../plugin.ts'

type Json = import('@earendil-works/chord').JsonValue
export type WorkflowMeta = { name: string; description: string; whenToUse?: string; phases?: { title: string; detail?: string }[] }
export type WorkflowLimits = { concurrency: number; maxAgents: number; timeoutMs: number; maxResultChars: number }
type AgentRecord = { seq: number; label: string; phase?: string; status: 'running' | 'completed' | 'failed'; output?: string }
export type WorkflowRun = {
  id: string; name: string; description: string; status: 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted'
  startedAt: number; phase: string; agents: AgentRecord[]; logs: string[]; result?: Json; error?: string
}
export const WorkflowDoc = defineDoc<{ runs: WorkflowRun[] }>({
  kind: 'pie2.workflows', version: 1, scope: 'conversation', history: 'latest', fork: 'initial',
  initial: () => ({ runs: [] }), checkpointWhen: () => false,
})
const WorkflowReceipt = defineDoc<{ value?: Json; error?: string; result?: JsonObject }>({
  kind: 'pie2.workflow-receipt', version: 1, scope: 'task', initial: () => ({}), checkpointWhen: () => false,
})
const DEFAULT_LIMITS: WorkflowLimits = { concurrency: 4, maxAgents: 128, timeoutMs: 300_000, maxResultChars: 50_000 }
const resultSchema = Type.Object({
  runId: Type.String(), agentsStarted: Type.Integer(), status: Type.String(), result: Type.Unknown(),
  error: Type.Optional(Type.String()), partial: Type.Array(Type.Object({ seq: Type.Integer(), label: Type.String(), phase: Type.Optional(Type.String()), status: Type.String(), output: Type.Optional(Type.String()) })),
}, { additionalProperties: false })
const metaSchema = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 100 }), description: Type.String({ minLength: 1, maxLength: 1000 }),
  whenToUse: Type.Optional(Type.String({ maxLength: 2000 })),
  phases: Type.Optional(Type.Array(Type.Object({ title: Type.String({ minLength: 1, maxLength: 200 }), detail: Type.Optional(Type.String({ maxLength: 1000 })) }, { additionalProperties: false }), { maxItems: 32 })),
}, { additionalProperties: false })

function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) }
function message(error: unknown) { return error instanceof Error ? error.message : String(error) }
function requiredString(value: unknown, name: string, max: number) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`${name} must be a non-empty string of at most ${max} characters`)
  return value
}
function json(value: unknown, max: number): Json {
  const encoded = JSON.stringify(value)
  if (encoded === undefined || encoded.length > max) throw new Error(`Workflow JSON result must fit within ${max} characters`)
  return JSON.parse(encoded)
}

const schemaShape = Type.Object({
  type: Type.Optional(Type.Union(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'].map(value => Type.Literal(value)))),
  properties: Type.Optional(Type.Record(Type.String(), Type.Unknown())), required: Type.Optional(Type.Array(Type.String())),
  additionalProperties: Type.Optional(Type.Boolean()), items: Type.Optional(Type.Unknown()),
  enum: Type.Optional(Type.Array(Type.Unknown(), { minItems: 1 })), const: Type.Optional(Type.Unknown()),
  oneOf: Type.Optional(Type.Array(Type.Unknown(), { minItems: 1 })),
}, { additionalProperties: false })

// TypeBox accepts arbitrary schema keywords, so reject unsupported constraints before using Value.Check.
function validateSchema(schema: unknown, depth = 0): asserts schema is TSchema {
  if (depth > 16 || !Value.Check(schemaShape, schema)) throw new Error('Unsupported workflow schema keyword or shape (maximum depth 16)')
  for (const child of Object.values(schema.properties ?? {})) validateSchema(child, depth + 1)
  if (schema.items !== undefined) validateSchema(schema.items, depth + 1)
  for (const child of schema.oneOf ?? []) validateSchema(child, depth + 1)
}

// A cap violation terminates the VM even if generated code catches the rejected SDK promise.
class WorkflowSandbox extends CodemodeSandbox {
  failure: AbortController
  constructor(failure: AbortController) { super({ memoryLimitBytes: 32 * 1024 * 1024 }); this.failure = failure }
  override start(code: string, options: CodemodeRunOptions) {
    const run = super.start(code, { ...options, signal: AbortSignal.any([...(options.signal ? [options.signal] : []), this.failure.signal]) })
    return { get finished() { return run.finished }, deliver: run.deliver.bind(run), result: run.result.then(result => {
      const fatal = this.failure.signal.aborted ? message(this.failure.signal.reason) : undefined
      this.failure.abort(new Error(result.ok ? 'Workflow script ended' : result.error.message))
      return fatal ? { ok: false as const, error: { kind: 'script' as const, message: fatal }, output: result.output, calls: result.calls } : result
    }) }
  }
}

export type WorkflowInput = { meta: WorkflowMeta; script: string; args?: JsonObject }
export type WorkflowResult = { runId: string; agentsStarted: number; status: WorkflowRun['status']; result: Json; error?: string; partial: AgentRecord[] }

/** Shared native engine for model-authored workflows and the deployment-owned Ralph loop. */
export async function runWorkflow(input: WorkflowInput, api: ToolExecutionApi, context: Context, limits: WorkflowLimits = DEFAULT_LIMITS): Promise<WorkflowResult> {
  requiredString(input.meta.name, 'Workflow name', 100)
  requiredString(input.meta.description, 'Workflow description', 1000)
  requiredString(input.script, 'Workflow script', 65_536)
  if (!Number.isInteger(limits.concurrency) || limits.concurrency < 1 || limits.concurrency > 16
    || !Number.isInteger(limits.maxAgents) || limits.maxAgents < 1 || limits.maxAgents > 256
    || !Number.isInteger(limits.timeoutMs) || limits.timeoutMs < 1 || limits.timeoutMs > 3_600_000
    || !Number.isInteger(limits.maxResultChars) || limits.maxResultChars < 1 || limits.maxResultChars > 100_000) throw new Error('Invalid workflow deployment limits')
  const previous = await api.snapshot(WorkflowReceipt, api.taskId, context)
  if (previous?.result) return previous.result as unknown as WorkflowResult
  const runId = String(api.taskId)
  const update = async (change: (run: WorkflowRun) => void) => api.commit(async tx => {
    const doc = await tx.doc(WorkflowDoc, api.conversationId)
    let run = doc.runs.find(run => run.id === runId)
    if (!run) {
      run = { id: runId, name: input.meta.name, description: input.meta.description, status: 'running', startedAt: api.now(), phase: '', agents: [], logs: [] }
      doc.runs.push(run)
      // Keep all active runs and the most recent 20 settled runs.
      const settled = doc.runs.filter(item => item.status !== 'running')
      if (settled.length > 20) doc.runs = doc.runs.filter(item => !settled.slice(0, -20).includes(item))
    }
    change(run)
    return JSON.parse(JSON.stringify(run)) as WorkflowRun
  }, context)
  const report = async () => {
    const run = await update(() => {})
    await api.details({ workflow: runId, name: run.name, phase: run.phase, status: run.status, agentsStarted: run.agents.length,
      agentsCompleted: run.agents.filter(agent => agent.status !== 'running').length }, context)
  }
  await update(run => { run.status = 'running' })
  await report()
  const failure = new AbortController()
  const executionContext = withAbortSignal(failure.signal, context)
  const sandbox = new WorkflowSandbox(failure)
  const fatal = (error: unknown): never => { failure.abort(error); throw error }
  let active = 0
  const waiting: (() => void)[] = []
  const calls = new Map<number, Promise<Json>>()
  let events = 0
  const engine = createCodemodeTool({ sandbox, models: false, globals: [{
    name: '__workflowAgent',
    execute: async raw => {
      try {
        if (!record(raw) || !Number.isSafeInteger(raw.seq) || Number(raw.seq) < 1 || Number(raw.seq) > limits.maxAgents) throw new Error(`Workflow agent cap is ${limits.maxAgents}`)
        const seq = Number(raw.seq)
        const prompt = requiredString(raw.prompt, 'Agent prompt', 100_000)
        const opts = raw.options ?? {}
        if (!record(opts) || Object.keys(opts).some(key => !['label', 'description', 'phase', 'schema'].includes(key))) throw new Error('Unsupported workflow agent option; allowed: label, description, phase, schema')
        const label = requiredString(opts.label ?? opts.description ?? `Agent ${seq}`, 'Agent label', 400)
        if (opts.phase !== undefined) requiredString(opts.phase, 'Agent phase', 200)
        if (opts.schema !== undefined) { validateSchema(opts.schema); if (!record(opts.schema) || opts.schema.type !== 'object') throw new Error('Workflow structured schema must have an object root') }
        if (calls.has(seq)) throw new Error('Duplicate workflow agent sequence')
        if (calls.size >= limits.maxAgents) throw new Error(`Workflow agent cap is ${limits.maxAgents}`)
        const promise = (async (): Promise<Json> => {
          if (active >= limits.concurrency) await new Promise<void>((resolve, reject) => {
            const wake = () => { executionContext.abortSignal?.removeEventListener('abort', abort); resolve() }
            const abort = () => { const index = waiting.indexOf(wake); if (index >= 0) waiting.splice(index, 1); reject(executionContext.abortSignal?.reason) }
            waiting.push(wake)
            if (executionContext.abortSignal?.aborted) abort()
            else executionContext.abortSignal?.addEventListener('abort', abort, { once: true })
          })
          executionContext.abortSignal?.throwIfAborted()
          active++
          try {
            await update(run => { if (!run.agents.some(agent => agent.seq === seq)) run.agents.push({ seq, label, ...(opts.phase === undefined ? {} : { phase: String(opts.phase) }), status: 'running' }) })
            await report()
            const requested = opts.schema === undefined ? prompt : `${prompt}\n\nReturn ONLY one JSON object matching this schema, without Markdown fences:\n${JSON.stringify(opts.schema)}`
            const result = await api.executeTool('subagent', { prompt: requested, description: label, run_in_background: false }, executionContext, { key: `workflow-agent-${seq}` })
            const value = result.structuredOutput
            const content = record(value) && value.kind === 'foreground' && Array.isArray(value.output)
              ? value.output.flatMap(block => record(block) && block.type === 'text' && typeof block.text === 'string' ? [block.text] : []).join('\n') : ''
            let output: Json = null
            let error: string | undefined
            if (result.isError || !content) error = result.diagnostics.map(diagnostic => diagnostic.message).join('\n') || (typeof value === 'string' ? value : 'Subagent returned no final output')
            else {
              try {
                output = opts.schema === undefined ? json(content, limits.maxResultChars) : json(JSON.parse(content), limits.maxResultChars)
                if (opts.schema !== undefined && !Value.Check(opts.schema as TSchema, output)) throw new Error('Child JSON does not match workflow schema')
              } catch (caught) { error = message(caught) }
            }
            await update(run => {
              const agent = run.agents.find(agent => agent.seq === seq)!
              Object.assign(agent, { status: error ? 'failed' : 'completed', output: (error ?? content).slice(0, 4000) })
            })
            await report()
            return error ? null : output
          } finally { active--; waiting.shift()?.() }
        })()
        calls.set(seq, promise)
        return await promise
      } catch (error) {
        if (executionContext.abortSignal?.aborted) throw error
        return fatal(error)
      }
    },
  }, {
    name: '__workflowEvent', execute: async raw => {
      try {
        if (++events > 1000) throw new Error('Workflow progress event cap is 1000')
        if (!record(raw) || !['phase', 'log'].includes(String(raw.kind))) throw new Error('Invalid workflow progress event')
        const value = requiredString(raw.value, 'Workflow progress', raw.kind === 'phase' ? 200 : 2000)
        if (raw.kind === 'phase' && input.meta.phases?.length && !input.meta.phases.some(phase => phase.title === value)) throw new Error(`Undeclared workflow phase: ${value}`)
        await update(run => { if (raw.kind === 'phase') run.phase = value; else { run.logs.push(value); run.logs = run.logs.slice(-100) } })
        api.output(`${raw.kind}: ${value}\n`)
        await report()
        return null
      } catch (error) { return fatal(error) }
    },
  }, {
    name: '__workflowFinish', execute: async value => {
      try {
        if (active || waiting.length) throw new Error('Workflow cannot complete while owned agents are still running')
        const bounded = json(value, limits.maxResultChars)
        await api.commit(async tx => { (await tx.doc(WorkflowReceipt, api.taskId)).value = bounded }, context)
        return null
      } catch (error) { return fatal(error) }
    },
  }] })
  const source = `// @options: ${JSON.stringify({ timeout_ms: limits.timeoutMs, max_output_tokens: Math.ceil(limits.maxResultChars / 4) })}\n` + `
const args = JSON.parse(${JSON.stringify(JSON.stringify(input.args ?? {}))});
let __agentSequence = 0;
const __work = [];
const __track = (promise, failedValue = () => false) => {
  const task = {collected: false, failed: false};
  const settled = Promise.resolve(promise).then(
    value => { task.failed = failedValue(value); return {ok: true, value}; },
    error => { task.failed = true; return {ok: false, error}; }
  );
  __work.push({task, settled});
  return {
    then(resolve, reject) {
      task.collected = true;
      return __track(settled.then(outcome => { if (!outcome.ok) throw outcome.error; return outcome.value; }).then(resolve, reject), failedValue);
    },
    catch(reject) { return this.then(undefined, reject); },
    finally(callback) {
      if (typeof callback !== 'function') return this.then();
      return this.then(value => Promise.resolve(callback()).then(() => value), error => Promise.resolve(callback()).then(() => { throw error; }));
    }
  };
};
const __missing = value => value === null || Array.isArray(value) && value.includes(null);
const agent = (prompt, options = {}) => __track(__workflowAgent({seq: ++__agentSequence, prompt, options}), value => value === null);
const phase = value => __track(__workflowEvent({kind: 'phase', value}));
const log = value => __track(__workflowEvent({kind: 'log', value}));
const parallel = thunks => __track(Promise.all(thunks.map(async thunk => { try { return await thunk(); } catch { return null; } })), __missing);
const pipeline = (items, ...stages) => __track(Promise.all(items.map(async (item, index) => {
  let value = item;
  for (const stage of stages) { try { value = await stage(value, item, index); } catch { return null; } if (value === null) return null; }
  return value;
})), __missing);
const __value = await (async () => {\n${input.script}\n})();
// Settling a callback can start more agents, so drain until the owned work list stops growing.
let __drained = 0;
while (__drained < __work.length) {
  const batch = __work.slice(__drained);
  __drained = __work.length;
  await Promise.all(batch.map(work => work.settled));
}
if (__work.some(work => work.task.failed && !work.task.collected)) throw new Error('Workflow ended with an uncollected failed delegation or callback');
await __workflowFinish(__value);
`
  try {
    // Only SDK globals are exposed. All actual child calls use the original ToolExecutionApi and its hooks.
    const native = await engine.execute({ code: source }, { ...api, agent: async ctx => ({ ...await api.agent(ctx), callable: [] }) }, context)
    const receipt = await api.snapshot(WorkflowReceipt, api.taskId, context)
    const error = native.isError ? (native.output ?? []).flatMap(block => block.type === 'text' ? [block.text] : []).join('\n').slice(0, 4000)
      : receipt?.value === undefined ? 'Workflow script must return a JSON value' : undefined
    const run = await update(run => {
      run.status = error ? 'failed' : 'completed'
      if (error) run.error = error
      else run.result = receipt!.value!
      for (const agent of run.agents) if (agent.status === 'running') agent.status = 'failed'
    })
    const result: WorkflowResult = { runId, agentsStarted: run.agents.length, status: run.status, result: error ? null : receipt!.value!, ...(error ? { error } : {}), partial: run.agents }
    await api.commit(async tx => { (await tx.doc(WorkflowReceipt, api.taskId)).result = result as unknown as JsonObject }, context)
    await report()
    return result
  } catch (error) {
    // Native ownership aborts every still-running nested tool and its foreground child. Closing the harness leaves the journal for replay.
    if (context.abortSignal?.aborted) throw error
    await update(run => { run.status = 'failed'; run.error = message(error).slice(0, 4000) })
    throw error
  } finally { failure.abort(new Error('Workflow ended')); await sandbox.close() }
}

export function workflowToolResult(result: WorkflowResult): ToolExecutionResult {
  return { ...text(result), structuredOutput: result as unknown as JsonObject, isError: result.status !== 'completed' }
}

async function reconcileRuns(tx: Tx, conversationId: ConversationId) {
  const doc = await tx.doc(WorkflowDoc, conversationId)
  for (const run of doc.runs.filter(run => run.status === 'running')) {
    const task = await tx.task(Number(run.id) as ToolExecutionApi['taskId'])
    if (task?.state.status === 'terminal') {
      run.status = task.state.outcome.status === 'aborted' ? 'cancelled' : 'interrupted'
      for (const agent of run.agents) if (agent.status === 'running') agent.status = 'failed'
    }
  }
  return JSON.parse(JSON.stringify(doc.runs)) as WorkflowRun[]
}

export function createWorkflowPlugin(limits: Partial<WorkflowLimits> = {}): Plugin {
  const resolved = { ...DEFAULT_LIMITS, ...limits }
  return {
    name: 'workflow',
    extension: defineExtension({
      name: 'workflow',
      sections: [section('workflow_policy', () => 'Use workflow only when the human explicitly requests a workflow or large multi-agent orchestration. For one or two independent delegations use subagent; skip orchestration for simple work. Scripts coordinate agents in a restricted JavaScript sandbox, while durable nested tool calls enforce cancellation and replay. Collect and verify results before claiming success.')],
      tools: [defineTool({
        name: 'workflow',
        description: 'Run a foreground plain-JavaScript orchestration body with top-level await and return a JSON value. Supply meta {name, description, phases?:[{title,detail?}]} separately and optional args object. SDK: agent(prompt,{label?,description?,phase?,schema?}) waits for a fresh subagent, returning final text or a validated object (schema supports type/properties/required/additionalProperties/items/enum/const/oneOf); child failure returns null. Promise.all fans out; parallel(thunks) maps ordinary failures to null; pipeline(items,...stages) advances items independently without a stage barrier. phase(title) and log(message) publish progress. No filesystem/network/Node APIs or arbitrary tools exist in the sandbox. Invalid SDK inputs and safety caps terminate the run, even if caught. Runs have bounded concurrency, total agents, output and a deadline. Failed runs retain partial child results; all started SDK work is drained before returning, and an uncollected delegation failure fails the workflow. Cancellation stops all owned foreground children.',
        parameters: Type.Object({ meta: metaSchema, script: Type.String({ minLength: 1, maxLength: 65_536 }), args: Type.Optional(Type.Record(Type.String(), Type.Unknown())) }, { additionalProperties: false }),
        structuredOutputSchema: resultSchema, replay: 'safe', outputLimits: { maxBytes: 128_000, maxLines: 3000 },
        execute: async (input, api, context) => workflowToolResult(await runWorkflow(input as WorkflowInput, api, context, resolved)),
      })],
    }),
    afterInterrupt: async ctx => { await ctx.harness.commit(tx => reconcileRuns(tx, ctx.conversation.id), ctx.context) },
    commands: { workflows: async (args, ctx) => {
      const match = /^(?:get\s+)?([1-9]\d*)$/.exec(args.trim())
      if (args.trim() && args.trim() !== 'list' && !match) throw new Error('Usage: /workflows [list | get <run-id>]')
      const runs = await ctx.harness.commit(tx => reconcileRuns(tx, ctx.conversation.id), ctx.context)
      const selected = match ? runs.find(run => run.id === match[1]) : runs
      if (selected === undefined) throw new Error(`Unknown workflow: ${match![1]}`)
      return { output: runs.length ? JSON.stringify(selected, null, 2) : 'No workflows.' }
    } },
  }
}
