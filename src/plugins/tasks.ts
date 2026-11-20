import { Type } from '@earendil-works/pi-ai'
import {
  defineDoc, defineExtension, defineTool, GenerationTask, hook, LiveDoc, section,
  type ConversationId, type EntryId, type Harness,
} from '@earendil-works/pi-durable'
import type { Context } from '@earendil-works/chord/context'
import { text, type Plugin } from '../plugin.ts'

export type TodoItem = {
  content: string
  status: 'pending' | 'in_progress' | 'completed'
}
type TodoState = { todos: TodoItem[] | null; lastInputEntryId: EntryId | null }
export const TodoDoc = defineDoc<TodoState>({
  kind: 'pie2.todos', version: 1, scope: 'conversation', history: 'rewindable', fork: 'asOf',
  initial: () => ({ todos: null, lastInputEntryId: null }),
  checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 31,
})
const WriteReceipt = defineDoc<{ output: string | null }>({
  kind: 'pie2.todo-write-receipt', version: 1, scope: 'task',
  initial: () => ({ output: null }), checkpointWhen: () => false,
})
const policy = 'Record and update a structured task list for the current work with todo_write. Send the ENTIRE list every call — it REPLACES the previous list (there are no partial updates, no per-item edits). Use it to plan multi-step work and show progress: add one todo per concrete step before you start. Mark every todo being actively worked on in_progress — several at once when work genuinely runs in parallel (e.g. concurrent subagents or background commands), one for sequential work; while work remains, at least one task should be in_progress. Mark a todo completed the moment it is done (do not batch completions), and allow no in_progress item only once all work is complete. Skip the list for trivial single-step tasks. Statuses: pending (not started), in_progress (being worked on now), completed (finished).'
const parameters = Type.Object({
  todos: Type.Array(Type.Object({
    content: Type.String({ description: 'What the task is — a short imperative line.' }),
    status: Type.Union([Type.Literal('pending'), Type.Literal('in_progress'), Type.Literal('completed')]),
  }, { additionalProperties: false }), { description: 'The COMPLETE task list, replacing any previous list.' }),
}, { additionalProperties: false })
function normalize(todos: TodoItem[]): TodoItem[] {
  const seen = new Set<string>()
  return todos.map(item => {
    const content = item.content.trim()
    if (!content) throw new Error('Invalid todo: content must be a non-empty string')
    if (seen.has(content)) throw new Error(`Invalid todos: duplicate content ${JSON.stringify(content)}`)
    seen.add(content)
    return { content, status: item.status }
  })
}
function formatTodos(todos: readonly TodoItem[] | null) {
  return todos?.length ? todos.map(item => `- [${item.status}] ${item.content}`).join('\n') : 'No tasks.'
}

export function createTasksPlugin(getHarness: () => Harness): Plugin {
  async function lastInput(id: ConversationId, context: Context): Promise<EntryId | null> {
    const harness = getHarness()
    const live = await harness.snapshot(LiveDoc, id, context)
    if (!live?.run) return (await harness.snapshot(TodoDoc, id, context))?.lastInputEntryId ?? null
    const admitted = new Set<EntryId>()
    let input: EntryId | null = null
    for (const submissionId of live.run.inputs) {
      const record = await (await harness.submission(submissionId, context))?.status(context)
      if (record?.type !== 'input' || record.entry === undefined) continue
      admitted.add(record.entry)
      if (input === null || record.entry < input) input = record.entry
    }
    const view = await (await harness.conversation(id, context))?.context(context)
    // Native automatic continuations start a logical turn; passive notices and steering do not.
    return view?.entries.findLast(entry => entry.kind === 'pi.user' && entry.byTaskId !== undefined &&
      !admitted.has(entry.id) && entry.id > (input ?? 0))?.id ?? input
  }
  return {
    name: 'tasks',
    extension: defineExtension({
      name: 'tasks',
      tools: [defineTool({
        name: 'todo_write', description: policy, parameters, replay: 'safe', executionMode: 'sequential',
        execute: async (args, api, context) => text(await api.commit(async tx => {
          const receipt = await tx.doc(WriteReceipt, api.taskId)
          if (receipt.output !== null) return receipt.output
          const todos = normalize(args.todos)
          const state = await tx.doc(TodoDoc, api.conversationId)
          state.todos = todos
          receipt.output = JSON.stringify({
            todos,
            counts: {
              pending: todos.filter(todo => todo.status === 'pending').length,
              inProgress: todos.filter(todo => todo.status === 'in_progress').length,
              completed: todos.filter(todo => todo.status === 'completed').length,
            },
          }, null, 2)
          return receipt.output
        }, context)),
      })],
      sections: [
        section('task_policy', () => policy),
        section('todos', async (input, context) => {
          const state = await input.read.snapshot(TodoDoc, input.conversationId, context)
          if (!state?.todos?.length || state.lastInputEntryId !== await lastInput(input.conversationId, context)) return undefined
          return formatTodos(state.todos)
        }),
      ],
      hooks: [hook(GenerationTask, {
        beforeRequest: async (_request, api, context) => {
          const inputId = await lastInput(api.conversationId, context)
          await getHarness().commit(async tx => {
            const state = await tx.doc(TodoDoc, api.conversationId)
            if (state.lastInputEntryId === inputId) return
            state.todos = null
            state.lastInputEntryId = inputId
          }, context)
          return undefined
        },
      })],
    }),
    commands: {
      tasks: async (args, { harness, conversation, context }) => {
        if (args.trim()) throw new Error('Usage: /tasks')
        const state = await harness.snapshot(TodoDoc, conversation.id, context)
        return { output: formatTodos(state?.lastInputEntryId === await lastInput(conversation.id, context) ? state?.todos ?? null : null) }
      },
    },
  }
}
