import { Type } from '@earendil-works/pi-ai'
import { defineDoc, defineExtension, defineTool, section, type JsonObject } from '@earendil-works/pi-durable'
import { text, type CommandContext, type Plugin } from '../plugin.ts'
import { runWorkflow, WorkflowDoc, type WorkflowLimits } from './workflow.ts'

type Json = import('@earendil-works/chord').JsonValue
export type RalphReport = { status: 'continue' | 'complete' | 'blocked'; summary: string; evidence: string[]; nextSteps: string[]; blocker: string }
export type RalphResult = { status: 'complete' | 'blocked' | 'budget-limited' | 'round-failed'; roundsStarted: number; report: RalphReport | null }
type RalphRun = { id: string; objective: string; maxRounds: number; status: 'running' | 'failed' | 'cancelled' | 'interrupted' | RalphResult['status']; result?: RalphResult; error?: string }
export const RalphDoc = defineDoc<{ runs: RalphRun[] }>({
  kind: 'pie2.ralph', version: 1, scope: 'conversation', history: 'latest', fork: 'initial',
  initial: () => ({ runs: [] }), checkpointWhen: () => false,
})
const RalphReceipt = defineDoc<{ result?: JsonObject }>({
  kind: 'pie2.ralph-receipt', version: 1, scope: 'task', initial: () => ({}), checkpointWhen: () => false,
})
const REPORT_LIMIT = 16_384
const REPORT_SCHEMA = {
  type: 'object', properties: {
    status: { type: 'string', enum: ['continue', 'complete', 'blocked'] }, summary: { type: 'string' },
    evidence: { type: 'array', items: { type: 'string' } }, nextSteps: { type: 'array', items: { type: 'string' } }, blocker: { type: 'string' },
  }, required: ['status', 'summary', 'evidence', 'nextSteps', 'blocker'], additionalProperties: false,
}
function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) }

export function validateRalphReport(value: unknown): RalphReport {
  const normalized = (text: unknown): text is string => typeof text === 'string' && !!text.length && text === text.trim()
  const list = (items: unknown): items is string[] => Array.isArray(items) && items.every(normalized)
  if (!record(value) || Object.keys(value).sort().join(',') !== 'blocker,evidence,nextSteps,status,summary'
    || !['continue', 'complete', 'blocked'].includes(String(value.status)) || !normalized(value.summary)
    || !list(value.evidence) || !list(value.nextSteps) || typeof value.blocker !== 'string' || value.blocker !== value.blocker.trim()) throw new Error('Invalid structured Ralph report')
  const report = value as RalphReport
  if (report.status === 'continue' && (!report.nextSteps.length || report.blocker)
    || report.status === 'complete' && (!report.evidence.length || report.nextSteps.length || report.blocker)
    || report.status === 'blocked' && !normalized(report.blocker)) throw new Error('Ralph report status conflicts with its evidence, nextSteps or blocker')
  if (JSON.stringify(report).length > REPORT_LIMIT) throw new Error(`Ralph handoff exceeds ${REPORT_LIMIT} characters`)
  return report
}

// Deployment-owned code: the caller controls only objective and budget, never the loop or completion predicate.
const SCRIPT = `
const schema = ${JSON.stringify(REPORT_SCHEMA)};
let previous = null;
phase('Fresh rounds');
for (let round = 1; round <= args.maxRounds; round++) {
  const prompt = [
    'You are one fresh worker in a Ralph loop. Do not call ralph or workflow. You have no parent conversation or previous child conversation.',
    'Immutable objective:\\n' + args.objective,
    'Round ' + round + ' / ' + args.maxRounds,
    'Inspect the shared workspace before acting; preserve existing changes. Complete concrete work and verify it. Workspace files are the long-term memory; confirm the previous report against them.',
    'Previous bounded report:\\n' + JSON.stringify(previous),
    'Return an exact JSON report. status=continue requires nonempty nextSteps and empty blocker. status=complete requires concrete evidence, no nextSteps and empty blocker. status=blocked requires a concrete blocker. Strings must be trimmed, summary nonempty; evidence and nextSteps must contain only nonempty strings. Do not claim independent certification; report what you verified.'
  ].join('\\n\\n');
  const report = await agent(prompt, {label: 'Ralph round ' + round, schema});
  if (report === null) return {status: 'round-failed', roundsStarted: round, report: previous};
  const normalized = s => typeof s === 'string' && s.length > 0 && s === s.trim();
  if (!normalized(report.summary) || !report.evidence.every(normalized) || !report.nextSteps.every(normalized)
    || report.blocker !== report.blocker.trim() || JSON.stringify(report).length > args.maxReportChars
    || report.status === 'continue' && (!report.nextSteps.length || report.blocker !== '')
    || report.status === 'complete' && (!report.evidence.length || report.nextSteps.length || report.blocker !== '')
    || report.status === 'blocked' && !normalized(report.blocker)) throw new Error('Invalid Ralph round report or oversized handoff');
  log('Round ' + round + ': ' + report.status + ' — ' + report.summary);
  if (report.status !== 'continue') return {status: report.status, roundsStarted: round, report};
  previous = report;
}
return {status: 'budget-limited', roundsStarted: args.maxRounds, report: previous};
`

export function createRalphPlugin(options: { maxRounds?: number; defaultRounds?: number; timeoutMs?: number } = {}): Plugin {
  const ceiling = options.maxRounds ?? 256
  const defaultRounds = options.defaultRounds ?? Math.min(64, ceiling)
  if (!Number.isSafeInteger(ceiling) || ceiling < 1 || ceiling > 256 || !Number.isSafeInteger(defaultRounds) || defaultRounds < 1 || defaultRounds > ceiling) throw new Error('Ralph round limits must be positive integers, default <= ceiling <= 256')
  const limits: WorkflowLimits = { concurrency: 1, maxAgents: ceiling, timeoutMs: options.timeoutMs ?? 3_600_000, maxResultChars: 50_000 }
  const runsFor = async (ctx: CommandContext) => ctx.harness.commit(async tx => {
    const doc = await tx.doc(RalphDoc, ctx.conversation.id)
    for (const run of doc.runs.filter(run => run.status === 'running')) {
      const task = await tx.task(Number(run.id) as import('@earendil-works/pi-durable').TaskId)
      if (task?.state.status === 'terminal') run.status = task.state.outcome.status === 'aborted' ? 'cancelled' : 'interrupted'
    }
    const workflows = await tx.doc(WorkflowDoc, ctx.conversation.id)
    return JSON.parse(JSON.stringify(doc.runs.map(run => ({ ...run, progress: workflows.runs.find(workflow => workflow.id === run.id)?.agents ?? [] })))) as (RalphRun & { progress: Json[] })[]
  }, ctx.context)
  return {
    name: 'ralph',
    extension: defineExtension({
      name: 'ralph',
      sections: [section('ralph_policy', () => 'Use ralph only when the direct human explicitly requests Ralph or fresh-agent iteration. Each round uses a new child, an immutable objective and a bounded structured handoff; only workspace files persist across child contexts. Worker completion is a report, not independent verification. Ordinary ongoing work belongs to Goal; ordinary delegation belongs to subagent.')],
      tools: [defineTool({
        name: 'ralph', description: `Run a foreground fresh-agent loop for one immutable objective. Each round starts a clean subagent context; only the shared workspace and a validated JSON report cross rounds. Stops on a worker completion report with evidence, a concrete blocker, failure or budget exhaustion. Default ${defaultRounds} rounds; deployment ceiling ${ceiling}. Only use on explicit human request. Cancellation stops the current child. Round receipts and the native script journal prevent completed rounds from running again during recovery.`,
        parameters: Type.Object({ objective: Type.String({ minLength: 1, maxLength: 32_768 }), maxRounds: Type.Optional(Type.Integer({ minimum: 1, maximum: ceiling })) }, { additionalProperties: false }),
        structuredOutputSchema: Type.Object({ runId: Type.String(), agentsStarted: Type.Integer(), result: Type.Unknown(), error: Type.Optional(Type.String()) }, { additionalProperties: false }),
        replay: 'safe', outputLimits: { maxBytes: 64_000, maxLines: 1500 },
        execute: async (args, api, context) => {
          if (!args.objective.trim()) throw new Error('Ralph objective must not be blank')
          const previous = await api.snapshot(RalphReceipt, api.taskId, context)
          if (previous?.result) return { ...text(previous.result), structuredOutput: previous.result, isError: typeof previous.result.error === 'string' || record(previous.result.result) && previous.result.result.status === 'round-failed' }
          const maxRounds = args.maxRounds ?? defaultRounds
          const id = String(api.taskId)
          await api.commit(async tx => {
            const doc = await tx.doc(RalphDoc, api.conversationId)
            if (!doc.runs.some(run => run.id === id)) doc.runs.push({ id, objective: args.objective, maxRounds, status: 'running' })
            const settled = doc.runs.filter(run => run.status !== 'running')
            if (settled.length > 20) doc.runs = doc.runs.filter(run => !settled.slice(0, -20).includes(run))
          }, context)
          const workflow = await runWorkflow({ meta: { name: 'ralph', description: args.objective.slice(0, 1000), phases: [{ title: 'Fresh rounds' }] },
            script: SCRIPT, args: { objective: args.objective, maxRounds, maxReportChars: REPORT_LIMIT } }, api, context, { ...limits, maxAgents: maxRounds })
          let result: RalphResult | undefined
          let error = workflow.error
          if (!error) {
            try {
              const value = workflow.result
              if (!record(value) || Object.keys(value).sort().join(',') !== 'report,roundsStarted,status'
                || !['complete', 'blocked', 'budget-limited', 'round-failed'].includes(String(value.status))
                || !Number.isSafeInteger(value.roundsStarted) || Number(value.roundsStarted) < 1 || Number(value.roundsStarted) > maxRounds) throw new Error('Invalid Ralph terminal result')
              const report = value.report === null ? null : validateRalphReport(value.report)
              const status = value.status as RalphResult['status']
              if (status === 'budget-limited' && (value.roundsStarted !== maxRounds || report?.status !== 'continue')
                || status === 'complete' && report?.status !== 'complete' || status === 'blocked' && report?.status !== 'blocked'
                || status === 'round-failed' && (value.roundsStarted === 1 ? report !== null : report?.status !== 'continue')) throw new Error('Ralph terminal status conflicts with its report')
              result = { status, roundsStarted: Number(value.roundsStarted), report }
            } catch (caught) { error = caught instanceof Error ? caught.message : String(caught) }
          }
          const output: JsonObject = { runId: id, agentsStarted: workflow.agentsStarted, result: (result ?? { status: 'failed', partial: workflow.partial }) as unknown as Json, ...(error ? { error } : {}) }
          await api.commit(async tx => {
            const run = (await tx.doc(RalphDoc, api.conversationId)).runs.find(run => run.id === id)!
            run.status = error ? 'failed' : result!.status
            if (result) run.result = result
            if (error) run.error = error
            ;(await tx.doc(RalphReceipt, api.taskId)).result = output
          }, context)
          return { ...text(output), structuredOutput: output, isError: !!error || result?.status === 'round-failed' }
        },
      })],
    }),
    afterInterrupt: async ctx => { await runsFor(ctx) },
    commands: { ralph: async (args, ctx) => {
      if (args.trim() && args.trim() !== 'status' && args.trim() !== 'list' && !/^(?:get\s+)?[1-9]\d*$/.test(args.trim())) throw new Error('Usage: /ralph [status | list | get <run-id>]')
      const runs = await runsFor(ctx)
      const id = /^(?:get\s+)?([1-9]\d*)$/.exec(args.trim())?.[1]
      const selected = id ? runs.find(run => run.id === id) : args.trim() === 'list' ? runs : runs.at(-1)
      if (id && !selected) throw new Error(`Unknown Ralph run: ${id}`)
      return { output: selected ? JSON.stringify(selected, null, 2) : 'No Ralph runs.' }
    } },
  }
}
