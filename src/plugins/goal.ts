import { createHash, randomUUID } from 'node:crypto'
import { Type } from 'typebox'
import {
  defineDoc, defineExtension, defineTool, GenerationTask, hook, InboxDoc, LiveDoc, section,
  type ConversationId, type EntryId, type Harness, type JsonObject, type TaskId, type Tx,
} from '@earendil-works/pi-durable'
import { text, type Plugin } from '../plugin.ts'

type Goal = {
  id: string
  revision: number
  objective: string
  phase: 'active' | 'paused' | 'blocked' | 'complete'
  maxGoalRounds: number
  roundsStarted: number
  createdAt: number
  updatedAt: number
  blockedReason?: { code: string; message: string }
}
type GoalState = { goal: Goal | null }
export const GoalDoc = defineDoc<GoalState>({
  kind: 'pie2.goal', version: 2, scope: 'conversation', history: 'rewindable', fork: 'asOf',
  initial: () => ({ goal: null }), migrate: migrateGoal,
  checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 31,
})
function migrateGoal(state: JsonObject, version: number): GoalState {
  if (version !== 1) throw new Error(`Unsupported Goal document version ${version}`)
  const old = state.goal
  if (old === null) return { goal: null }
  if (!old || typeof old !== 'object' || Array.isArray(old) || typeof old.objective !== 'string' ||
      !['active', 'paused', 'blocked', 'completed'].includes(String(old.status)) ||
      typeof old.rounds !== 'number' || !Number.isSafeInteger(old.rounds) || old.rounds < 0 || typeof old.maxRounds !== 'number') {
    throw new Error('Cannot migrate malformed legacy Goal document')
  }
  // Legacy goals had no identity or timestamps; keep historical reads stable and leave unknown dates at zero.
  const hash = createHash('sha256').update(`pie2.goal.v1\0${old.objective}`).digest('hex')
  const id = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`
  const goal: Goal = {
    id, revision: 1, objective: objective(old.objective), phase: old.status === 'completed' ? 'complete' : old.status as Goal['phase'],
    roundsStarted: old.rounds, maxGoalRounds: roundCap(old.maxRounds), createdAt: 0, updatedAt: 0,
  }
  if (goal.phase === 'blocked') goal.blockedReason = {
    code: goal.roundsStarted >= goal.maxGoalRounds ? 'round-limit' : 'legacy-blocked',
    message: goal.roundsStarted >= goal.maxGoalRounds ? `Goal reached its configured limit of ${goal.maxGoalRounds} rounds.` : 'Goal was blocked in the previous version; ask the user how to continue.',
  }
  return { goal }
}
type Round = { goalId: string; revision: number; round: number; prompt: string; sourceTask: TaskId; entryId: EntryId | null }
const RoundDoc = defineDoc<{ pending: Round | null }>({
  kind: 'pie2.goal-round', version: 1, scope: 'conversation', history: 'rewindable', fork: 'asOf',
  initial: () => ({ pending: null }), checkpointWhen: () => true,
})
type Source = { kind: 'human' } | { kind: 'none' } | { kind: 'goal'; goalId: string; revision: number; round: number }
const SourceDoc = defineDoc<{ source: Source | null }>({
  kind: 'pie2.goal-source', version: 1, scope: 'task',
  initial: () => ({ source: null }), checkpointWhen: () => false,
})
const Receipt = defineDoc<{ value: string | null; wrapup: string | null }>({
  kind: 'pie2.goal-receipt', version: 2, scope: 'task',
  initial: () => ({ value: null, wrapup: null }), checkpointWhen: () => false,
})
const YieldReceipt = defineDoc<{ decided: boolean; continuation: string | null }>({
  kind: 'pie2.goal-yield', version: 2, scope: 'task',
  initial: () => ({ decided: false, continuation: null }), checkpointWhen: () => false,
})
const actions = ['edit', 'pause', 'resume', 'complete', 'blocked'] as const
type Update = {
  goal_id: string; revision: number; action: typeof actions[number]
  objective?: string; max_goal_rounds?: number; blocked_reason?: string
}
const policy = 'Use goal tools for one long-running completion objective in the current session. create_goal may infer goal intent from a direct human request in any language; do not create a goal for routine single-turn work. Call get_goal before update_goal and copy its exact goal_id and revision. After session resume or fork, an active goal is disarmed: when a human asks to continue or resume in any wording or language, use update_goal action resume to rearm it. Mark complete only when the objective is actually achieved. Mark blocked only after the same blocking condition persists for at least 3 consecutive goal rounds, and report that concrete condition in blocked_reason; difficulty, uncertainty, or useful remaining work is not blocked.'

function objective(value: string) {
  if (!value.trim()) throw new Error('Goal objective must not be blank')
  return value.trim()
}
function roundCap(value: number) {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error('max_goal_rounds must be a positive safe integer')
  return value
}
function create(state: GoalState, description: string, cap = 256) {
  if (state.goal && state.goal.phase !== 'complete') throw new Error('A goal already exists; clear or resume it first')
  const now = Date.now()
  state.goal = {
    id: randomUUID(), revision: 1, objective: objective(description), phase: 'active',
    maxGoalRounds: roundCap(cap), roundsStarted: 0, createdAt: now, updatedAt: now,
  }
  return state.goal
}
function mutate(goal: Goal, args: Update, armed: boolean) {
  if (goal.id !== args.goal_id || goal.revision !== args.revision) throw new Error('Stale goal ref; call get_goal and use the exact current goal_id and revision')
  const hasObjective = args.objective !== undefined && args.objective !== ''
  const hasCap = args.max_goal_rounds !== undefined && args.max_goal_rounds !== 0
  const hasReason = args.blocked_reason !== undefined && args.blocked_reason !== ''
  if (args.action !== 'edit' && (hasObjective || hasCap)) throw new Error('objective and max_goal_rounds are valid only with action edit')
  if (args.action !== 'blocked' && hasReason) throw new Error('blocked_reason is valid only with action blocked')
  switch (args.action) {
    case 'edit':
      if (!hasObjective && !hasCap) throw new Error('Goal edit requires objective and/or max_goal_rounds')
      if (hasObjective) goal.objective = objective(args.objective!)
      if (hasCap) goal.maxGoalRounds = roundCap(args.max_goal_rounds!)
      break
    case 'pause':
      if (goal.phase !== 'active') throw new Error('Only an active goal can be paused')
      goal.phase = 'paused'
      break
    case 'resume':
      if (goal.phase === 'complete' || (goal.phase === 'active' && armed)) throw new Error('Goal cannot resume: already complete or active and armed')
      if (goal.roundsStarted >= goal.maxGoalRounds) throw new Error('Goal exhausted its round limit; edit max_goal_rounds before resuming')
      goal.phase = 'active'
      delete goal.blockedReason
      break
    case 'complete':
      if (goal.phase === 'complete') throw new Error('Goal is already complete')
      goal.phase = 'complete'
      delete goal.blockedReason
      break
    case 'blocked':
      if (goal.phase !== 'active') throw new Error('Only an active goal can be blocked')
      if (!args.blocked_reason?.trim()) throw new Error('blocked_reason is required with action blocked')
      goal.phase = 'blocked'
      goal.blockedReason = { code: 'model-reported', message: args.blocked_reason.trim() }
      break
  }
  goal.revision++
  goal.updatedAt = Math.max(Date.now(), goal.updatedAt)
  return goal
}
function wrapup(goal: Goal) {
  const blocked = goal.phase === 'blocked'
  const tag = blocked ? 'goal_blocked' : 'goal_complete'
  return `<${tag}>\nObjective: ${JSON.stringify(goal.objective)}\n${blocked ? `Blocked: ${JSON.stringify(goal.blockedReason?.message)}\n` : ''}The goal is marked ${goal.phase} and this autonomous run is ending. Write the closing message to the user now: ${blocked ? 'state what has been completed, describe the concrete blocking condition and what you tried, and say exactly what you need from the user to continue' : 'state the outcome, summarize what was done and how it was verified, and point to concrete results (files, commits, or other artifacts)'}. Report only what earlier rounds and tool results in this session actually establish; when a detail is not in the session, say so instead of inventing it. Address the user directly. Do not call any more tools in this run; further work waits for the user's next instruction.\n</${tag}>`
}
function roundPrompt(goal: Goal, round: number) {
  return `<goal_round>\nObjective: ${JSON.stringify(goal.objective)}\nRound: ${round}/${goal.maxGoalRounds}\n\nContinue working toward the objective in this same session. Treat the current workspace, tool results, and durable session state as authoritative; inspect them instead of assuming earlier narration is still current. Make concrete progress and verify the result. Before claiming completion, gather evidence that the whole objective is achieved, call get_goal, and use update_goal to mark it complete. If work remains, leave the goal active for the next round. Follow the configured goal-tool policy before reporting a blocker.\n</goal_round>`
}
async function sourceForTool(tx: Tx, id: ConversationId, taskId: TaskId): Promise<Source> {
  if ((await tx.conversation(id))?.owner) throw new Error('Goal mutations require a top-level agent; subagents cannot change goals')
  let task = await tx.task(taskId)
  while (task) {
    if (task.kind === GenerationTask.definition.name) return (await tx.doc(SourceDoc, task.id)).source ?? { kind: 'none' }
    task = task.owner === undefined ? undefined : await tx.task(task.owner)
  }
  return { kind: 'none' }
}
function authorize(source: Source, goal?: Goal | null, action?: Update['action']) {
  if (source.kind === 'human') return
  if ((action === 'complete' || action === 'blocked') && source.kind === 'goal' && goal &&
      source.goalId === goal.id && source.revision === goal.revision && source.round === goal.roundsStarted) {
    if (action === 'blocked' && goal.roundsStarted < 3) throw new Error(`blocked requires at least 3 consecutive goal rounds; current round is ${goal.roundsStarted}`)
    return
  }
  throw new Error('This goal operation requires a direct human turn on a top-level agent; complete and blocked also allow the exact current goal round')
}

export function createGoalPlugin(getHarness: () => Harness): Plugin {
  // Activation is intentionally process-local: restoring durable state never authorizes more rounds.
  const armed = new Set<ConversationId>()
  const value = (goal: Goal | null, id: ConversationId) => goal ? {
    goal: { id: goal.id, revision: goal.revision, objective: goal.objective, phase: goal.phase,
      roundsStarted: goal.roundsStarted, maxGoalRounds: goal.maxGoalRounds,
      ...(goal.blockedReason ? { blockedReason: goal.blockedReason } : {}) },
    activation: armed.has(id) ? 'armed' : 'disarmed',
  } : { goal: null }
  const activate = (id: ConversationId, action: string) => {
    if (action === 'create' || action === 'resume') armed.add(id)
    else if (action !== 'edit') armed.delete(id)
  }
  const extension = defineExtension({
    name: 'goal',
    tools: [
      defineTool({
        name: 'get_goal', description: 'Read the current same-session goal, its exact id/revision, objective, phase, continuation rounds, round limit, blocker reason, and activation. Call before update_goal.',
        parameters: Type.Object({}), replay: 'safe',
        execute: async (_args, api, context) => text(value((await api.snapshot(GoalDoc, api.conversationId, context))?.goal ?? null, api.conversationId)),
      }),
      defineTool({
        name: 'create_goal', description: 'Create one persisted same-session completion goal when the current direct human request is a long-running objective. Infer intent without requiring the user to say create a goal. Skip routine single-turn work. Rejects non-human and subagent authority.',
        parameters: Type.Object({ objective: Type.String(), max_goal_rounds: Type.Optional(Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER })) }),
        replay: 'safe', executionMode: 'sequential',
        execute: async (args, api, context) => {
          let changed = false
          const serialized = await api.commit(async tx => {
            const receipt = await tx.doc(Receipt, api.taskId)
            if (receipt.value !== null) return receipt.value
            authorize(await sourceForTool(tx, api.conversationId, api.taskId))
            const goal = create(await tx.doc(GoalDoc, api.conversationId), args.objective, args.max_goal_rounds)
            receipt.value = JSON.stringify(goal)
            changed = true
            return receipt.value
          }, context)
          if (changed) activate(api.conversationId, 'create')
          return text(value(JSON.parse(serialized), api.conversationId))
        },
      }),
      defineTool({
        name: 'update_goal', description: 'Update the exact current goal revision. edit, pause, and resume require a direct top-level human request. complete and blocked also allow the exact current automatic goal round. blocked requires at least 3 goal rounds for autonomous calls; explain the persistent concrete blocker. Resume never renews the round budget: edit the cap first.',
        parameters: Type.Object({
          goal_id: Type.String({ minLength: 1 }), revision: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
          action: Type.Union(actions.map(action => Type.Literal(action))), objective: Type.Optional(Type.String()),
          max_goal_rounds: Type.Optional(Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })), blocked_reason: Type.Optional(Type.String()),
        }), replay: 'safe', executionMode: 'sequential',
        execute: async (args, api, context) => {
          let changed = false
          const result = await api.commit(async tx => {
            const receipt = await tx.doc(Receipt, api.taskId)
            if (receipt.value !== null) return { serialized: receipt.value, wrapup: receipt.wrapup }
            const source = await sourceForTool(tx, api.conversationId, api.taskId)
            const { goal } = await tx.doc(GoalDoc, api.conversationId)
            if (!goal) throw new Error('No current goal')
            authorize(source, goal, args.action)
            mutate(goal, args, armed.has(api.conversationId))
            receipt.value = JSON.stringify(goal)
            if (source.kind === 'goal' && (args.action === 'complete' || args.action === 'blocked')) receipt.wrapup = wrapup(goal)
            changed = true
            return { serialized: receipt.value, wrapup: receipt.wrapup }
          }, context)
          if (changed) activate(api.conversationId, args.action)
          const output = text(value(JSON.parse(result.serialized), api.conversationId))
          if (result.wrapup) output.output.push({ type: 'text', text: result.wrapup })
          return output
        },
      }),
    ],
    sections: [section('goal_policy', () => policy), section('goal', async (input, context) => {
      const goal = (await input.read.snapshot(GoalDoc, input.conversationId, context))?.goal
      return goal ? JSON.stringify(value(goal, input.conversationId)) : undefined
    })],
    hooks: [hook(GenerationTask, {
      beforeRequest: async (_request, api, context) => {
        const harness = getHarness()
        const task = await harness.getTask(api.taskId, context)
        if (!task || task.state.status === 'terminal' || task.state.status === 'completing') return
        const checkpoint = task.state.checkpoint
        if (!checkpoint || typeof checkpoint !== 'object' || Array.isArray(checkpoint) || typeof checkpoint.cutoff !== 'number') return
        const conversation = await harness.conversation(api.conversationId, context)
        const view = await conversation!.context(context, { at: checkpoint.cutoff as EntryId })
        const pending = (await api.snapshot(RoundDoc, api.conversationId, context))?.pending
        const roundEntry = pending ? view.entries.findLast(entry => entry.kind === 'pi.user' && entry.byTaskId === pending.sourceTask &&
          entry.model?.some(message => message.role === 'user' && message.content === pending.prompt)) : undefined
        const roundBoundary = pending?.entryId ?? roundEntry?.id ?? 0
        let human = false
        // A notice within a human turn does not revoke that turn; original inputs before an auto round do not authorize it.
        const live = await api.snapshot(LiveDoc, api.conversationId, context)
        for (const id of live?.run?.inputs ?? []) {
          const submission = await harness.submission(id, context)
          const record = await submission?.status(context)
          if (record?.type === 'input' && record.status === 'placed' && record.entry > roundBoundary &&
              view.entries.some(entry => entry.id === record.entry && entry.kind === 'pi.user')) { human = true; break }
        }
        await harness.commit(async tx => {
          const grant = await tx.doc(SourceDoc, api.taskId)
          await tx.doc(GoalDoc, api.conversationId)
          if (grant.source !== null) return
          grant.source = { kind: 'none' }
          if ((await tx.conversation(api.conversationId))?.owner) return
          if (human) { grant.source = { kind: 'human' }; return }
          const state = await tx.doc(RoundDoc, api.conversationId)
          const round = state.pending
          // A continuation must match both our durable reservation and the task that actually appended it.
          if (round && roundEntry?.byTaskId === round.sourceTask && roundEntry.model?.some(message => message.role === 'user' && message.content === round.prompt)) {
            const { goal } = await tx.doc(GoalDoc, api.conversationId)
            if (!goal || goal.id !== round.goalId || goal.revision !== round.revision || goal.phase !== 'active') return
            if (round.entryId === null) {
              if (!armed.has(api.conversationId) || goal.roundsStarted + 1 !== round.round || round.round > goal.maxGoalRounds) return
              goal.roundsStarted = round.round
              round.entryId = roundEntry.id
            }
            if (round.entryId === roundEntry.id && goal.roundsStarted === round.round) {
              grant.source = { kind: 'goal', goalId: round.goalId, revision: round.revision, round: round.round }
            }
          }
        }, context)
        return undefined
      },
      afterResponse: (answer, api) => {
        if (answer.stopReason !== 'stop' && answer.stopReason !== 'toolUse') armed.delete(api.conversationId)
      },
      onYield: async (answer, api, context) => {
        if (answer.stopReason !== 'stop' || !armed.has(api.conversationId)) return
        const continuation = await getHarness().commit(async tx => {
          const receipt = await tx.doc(YieldReceipt, api.taskId)
          const { goal } = await tx.doc(GoalDoc, api.conversationId)
          if (!goal || goal.phase !== 'active' || !armed.has(api.conversationId)) return null
          if (receipt.decided) {
            const pending = (await tx.doc(RoundDoc, api.conversationId)).pending
            return pending?.sourceTask === api.taskId && pending.goalId === goal.id && pending.revision === goal.revision ? receipt.continuation : null
          }
          receipt.decided = true
          if ((await tx.doc(InboxDoc, api.conversationId)).items.length > 0) return null
          if (goal.roundsStarted >= goal.maxGoalRounds) {
            goal.phase = 'blocked'
            goal.blockedReason = { code: 'round-limit', message: `Goal reached its configured limit of ${goal.maxGoalRounds} rounds.` }
            goal.revision++
            goal.updatedAt = Math.max(Date.now(), goal.updatedAt)
            armed.delete(api.conversationId)
            return null
          }
          const round = goal.roundsStarted + 1
          receipt.continuation = roundPrompt(goal, round)
          ;(await tx.doc(RoundDoc, api.conversationId)).pending = {
            goalId: goal.id, revision: goal.revision, round, prompt: receipt.continuation, sourceTask: api.taskId, entryId: null,
          }
          return receipt.continuation
        }, context)
        return continuation === null ? undefined : { continue: continuation }
      },
    })],
  })
  return {
    name: 'goal', extension,
    interrupt: async ctx => {
      armed.delete(ctx.conversation.id)
      await ctx.conversation.commit(async tx => {
        const { goal } = await tx.doc(GoalDoc, ctx.conversation.id)
        if (goal?.phase === 'active') mutate(goal, { goal_id: goal.id, revision: goal.revision, action: 'pause' }, false)
      }, ctx.context)
    },
    commands: {
      goal: async (args, ctx) => {
        const input = args.trim()
        const control = input.toLowerCase()
        const action = control === 'clear' || control === 'pause' || control === 'resume' ? control : /^edit(?:\s|$)/i.test(input) ? 'edit' : 'create'
        if (!input) {
          await ctx.conversation.commit(async tx => { await tx.doc(GoalDoc, ctx.conversation.id) }, ctx.context)
          const goal = (await ctx.harness.snapshot(GoalDoc, ctx.conversation.id, ctx.context))?.goal
          return { output: goal ? `Goal ${goal.id} · revision ${goal.revision}\n${goal.objective}\n${goal.phase} · rounds ${goal.roundsStarted}/${goal.maxGoalRounds}\nActivation: ${armed.has(ctx.conversation.id) ? 'armed' : 'disarmed'}${goal.blockedReason ? `\nBlocked (${goal.blockedReason.code}): ${goal.blockedReason.message}` : ''}` : 'No goal.' }
        }
        let operation = action
        let missing = false
        await ctx.conversation.commit(async tx => {
          if ((await tx.conversation(ctx.conversation.id))?.owner) throw new Error('Goal commands require a top-level agent')
          const state = await tx.doc(GoalDoc, ctx.conversation.id)
          if (action === 'clear') {
            missing = state.goal === null
            state.goal = null
          } else if (action === 'edit' && state.goal?.phase === 'complete') {
            create(state, input.slice(4).trim())
            operation = 'create'
          } else if (action === 'edit' || action === 'pause' || action === 'resume') {
            if (!state.goal) throw new Error('No current goal')
            mutate(state.goal, { goal_id: state.goal.id, revision: state.goal.revision, action,
              ...(action === 'edit' ? { objective: input.slice(4).trim() } : {}),
            }, armed.has(ctx.conversation.id))
          } else create(state, input)
        }, ctx.context)
        activate(ctx.conversation.id, operation)
        return { output: missing ? 'No goal to clear.' : `Goal ${operation}.`, ...((operation === 'create' || operation === 'resume') ? { prompt: 'Read get_goal and work toward the active objective; inspect the workspace, make concrete progress and verify the result.' } : {}) }
      },
    },
  }
}
