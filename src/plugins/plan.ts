import type { Context } from '@earendil-works/chord/context'
import { Type } from 'typebox'
import {
  AssistantEntry, defineDoc, defineExtension, defineTool, hook, section, ToolTask,
  type ConversationId, type EntryId, type Harness, type Tx,
} from '@earendil-works/pi-durable'
import type { UserInteraction } from '../interaction.ts'
import { text, type Plugin } from '../plugin.ts'

type PlanState = { mode: 'plan' | 'build'; revision: number; plan?: string; updatedAt: number }
export const PlanDoc = defineDoc<PlanState>({
  kind: 'pie2.plan', version: 1, scope: 'conversation', history: 'rewindable', fork: 'asOf',
  initial: () => ({ mode: 'build', revision: 0, updatedAt: 0 }),
  checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 31,
})
const Receipt = defineDoc<{ result: string | null; reviewRevision: number | null }>({
  kind: 'pie2.plan-receipt', version: 1, scope: 'task',
  initial: () => ({ result: null, reviewRevision: null }), checkpointWhen: () => false,
})
const allowed = new Set([
  'read', 'read_image', 'glob', 'grep', 'web_search', 'Skill', 'ask_user_question',
  'get_goal', 'job_list', 'job_output', 'job_kill', 'interrupt_agent',
  'enter_plan_mode', 'exit_plan_mode',
])
const policy = `Planning mode is active. Inspect the repository using reads and searches, then prepare an actionable plan with the objective, concrete changes, edge cases, tests and acceptance criteria. Resolve discoverable facts yourself; ask the user only about material choices. Do not implement, edit files, run shell commands, create implementation todos, delegate, or start jobs/workflows. Non-allowlisted tools, including nested calls, are blocked by the runtime. Imperative requests and conversational agreement (including yes) are not plan approval. Submit the COMPLETE markdown plan starting with a # title through exit_plan_mode as the only and final tool call in your response. Its dedicated human review must explicitly approve before implementation starts in a later step; rejection, feedback, cancellation, or an unavailable UI leave planning active. The user may explicitly use /plan off to leave. Previously started background work is not paused or rolled back by entering plan mode; use the stop controls if needed.`
const notice = 'Previously started background work is not paused or rolled back; stop it separately if needed.'
const approve = 'Approve'
const reviewId = 'plan-review'

async function requireRoot(tx: Tx, id: ConversationId) {
  const conversation = await tx.conversation(id)
  if (!conversation || conversation.owner) throw new Error('Plan mode changes require a top-level conversation; subagents cannot change the parent mode')
}
async function rootId(harness: Harness, id: ConversationId, context: Context): Promise<ConversationId> {
  return harness.commit(async tx => {
    let conversation = await tx.conversation(id)
    if (!conversation) throw new Error('Plan mode conversation is missing')
    while (conversation.owner) {
      conversation = await tx.conversation(conversation.owner.conversationId)
      if (!conversation) throw new Error('Plan mode parent conversation is missing')
    }
    return conversation.id
  }, context)
}
function change(state: PlanState, mode: PlanState['mode']) {
  state.mode = mode
  state.revision++
  state.updatedAt = Date.now()
}
function result(serialized: string) {
  const value = JSON.parse(serialized)
  return { ...text(value), ...(value.error ? { isError: true } : {}) }
}

/** State and reviews are durable; tools and commands are thin entry points into those transitions. */
export function createPlanPlugin(getHarness: () => Harness, interaction: UserInteraction): Plugin {
  return {
    name: 'plan',
    extension: defineExtension({
      name: 'plan',
      tools: [
        defineTool({
          name: 'enter_plan_mode',
          description: 'Enter persistent read-only planning mode for the top-level session. Shell, mutation and delegation tools are blocked until a dedicated plan review approves or the human explicitly uses /plan off. Already-running background work is not paused.',
          parameters: Type.Object({}, { additionalProperties: false }), replay: 'safe', executionMode: 'sequential',
          execute: async (_args, api, context) => result(await api.commit(async tx => {
            await requireRoot(tx, api.conversationId)
            const receipt = await tx.doc(Receipt, api.taskId)
            if (receipt.result !== null) return receipt.result
            const state = await tx.doc(PlanDoc, api.conversationId)
            change(state, 'plan')
            receipt.result = JSON.stringify({ mode: state.mode, revision: state.revision, notice })
            return receipt.result
          }, context)),
        }),
        defineTool({
          name: 'exit_plan_mode',
          description: 'In plan mode, present the COMPLETE markdown plan starting with a # title for explicit human review. Only a dedicated Approve selection leaves plan mode; ordinary chat agreement, feedback, dismissal and unavailable UI never approve. Make this the only and final tool call of the response.',
          parameters: Type.Object({ plan: Type.String({ minLength: 1, maxLength: 131072 }) }, { additionalProperties: false }),
          replay: 'safe', executionMode: 'sequential',
          execute: async (args, api, context) => {
            if (!/^#\s+\S/.test(args.plan.trim())) throw new Error('The complete markdown plan must start with a # heading')
            const review = await api.commit(async tx => {
              await requireRoot(tx, api.conversationId)
              const receipt = await tx.doc(Receipt, api.taskId)
              if (receipt.result !== null) return { result: receipt.result, revision: receipt.reviewRevision }
              const task = await tx.task(api.taskId)
              const input = task?.input
              // A nested wrapper cannot approve on behalf of its own model-issued call.
              if (task?.kind !== ToolTask.definition.name || !input || typeof input !== 'object' || Array.isArray(input) ||
                  input.kind !== 'model' || typeof input.assistant !== 'number') {
                throw new Error('exit_plan_mode must be called directly as the only and final tool call in the assistant response; nested plan review is not allowed')
              }
              const source = await tx.entry(input.assistant as EntryId)
              const calls = source?.model?.flatMap(message => message.role === 'assistant' ? message.content.filter(item => item.type === 'toolCall') : []) ?? []
              if (!AssistantEntry.is(source) || source.conversationId !== api.conversationId || calls.length !== 1 ||
                  calls[0]!.name !== 'exit_plan_mode' || calls[0]!.id !== api.callId || input.callId !== api.callId) {
                throw new Error('exit_plan_mode must be the only and final tool call in the assistant response; submit the plan alone in a new response')
              }
              const state = await tx.doc(PlanDoc, api.conversationId)
              if (state.mode !== 'plan') throw new Error('exit_plan_mode requires active plan mode')
              if (receipt.reviewRevision === null) {
                state.plan = args.plan.trim()
                change(state, 'plan')
                receipt.reviewRevision = state.revision
              }
              return { result: null, revision: receipt.reviewRevision }
            }, context)
            if (review.result !== null) return result(review.result)
            let approved = false
            let feedback = 'Keep planning; revise the plan and request review again.'
            let error: string | undefined
            try {
              const answers = await interaction.ask([{
                id: reviewId, header: 'Plan review',
                question: `${args.plan.trim()}\n\nApprove this complete plan and switch to build mode?`,
                options: [
                  { label: approve, description: 'Leave plan mode and implement this plan from the next step.' },
                  { label: 'Keep planning', description: 'Stay in plan mode and revise the plan.' },
                ],
              }], context)
              const answer = answers.length === 1 ? answers[0] : undefined
              approved = answer?.id === reviewId && answer.selected.length === 1 && answer.selected[0] === approve && answer.custom === undefined
              feedback = approved ? 'Plan approved. Implement it starting with the next step.' : answer?.custom ?? feedback
            } catch (cause) {
              error = `Plan review unavailable or cancelled; no approval granted. Stay in plan mode or use /plan off. ${cause instanceof Error ? cause.message : String(cause)}`
              feedback = error
            }
            context.abortSignal?.throwIfAborted()
            return result(await api.commit(async tx => {
              context.abortSignal?.throwIfAborted()
              await requireRoot(tx, api.conversationId)
              const receipt = await tx.doc(Receipt, api.taskId)
              if (receipt.result !== null) return receipt.result
              const state = await tx.doc(PlanDoc, api.conversationId)
              if (state.mode !== 'plan' || state.revision !== review.revision || state.plan !== args.plan.trim()) {
                approved = false
                error = 'Plan review is stale: session mode or plan changed during review. Present the current plan again.'
                feedback = error
              }
              if (approved) change(state, 'build')
              receipt.result = JSON.stringify({ approved, mode: state.mode, revision: state.revision, feedback, ...(error ? { error } : {}) })
              return receipt.result
            }, context))
          },
        }),
      ],
      sections: [section('plan_policy', async (input, context) => {
        const id = await rootId(getHarness(), input.conversationId, context)
        return (await input.read.snapshot(PlanDoc, id, context))?.mode === 'plan' ? policy : undefined
      })],
      hooks: [hook(ToolTask, {
        beforeTool: async (call, api, context) => {
          const id = await rootId(getHarness(), api.conversationId, context)
          if ((await api.snapshot(PlanDoc, id, context))?.mode === 'plan' && !allowed.has(call.name)) {
            return { block: `Plan mode forbids ${call.name}. Only read/search/review and stop controls are allowed; obtain explicit plan approval or ask the human to use /plan off.` }
          }
          return undefined
        },
      })],
    }),
    commands: {
      plan: async (args, ctx) => {
        const action = args.trim().toLowerCase() || 'status'
        if (!['on', 'off', 'status'].includes(action)) throw new Error('Usage: /plan [on|off|status]')
        const value = await ctx.conversation.commit(async tx => {
          await requireRoot(tx, ctx.conversation.id)
          const state = await tx.doc(PlanDoc, ctx.conversation.id)
          if (action !== 'status') change(state, action === 'on' ? 'plan' : 'build')
          return JSON.stringify(state)
        }, ctx.context)
        const state: PlanState = JSON.parse(value)
        return { output: `Plan mode ${state.mode === 'plan' ? 'on' : 'off'} · revision ${state.revision}${state.mode === 'plan' ? `\n${notice}` : ''}${action === 'status' && state.plan ? `\n\n${state.plan}` : ''}` }
      },
    },
  }
}
