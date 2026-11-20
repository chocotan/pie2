import { Type } from '@earendil-works/pi-ai'
import {
  AssistantEntry, InboxDoc, configure, defineDoc, defineExtension, defineTask, defineTool, section,
  type ConversationId, type Cursor, type EntryId, type EntryRecord, type TaskId, type ToolExecutionApi, type Tx,
} from '@earendil-works/pi-durable'
import { text, type CommandContext, type Plugin } from '../plugin.ts'

type ResultStatus = 'completed' | 'failed' | 'aborted' | 'interrupted'
type Message = { id: string; prompt: string; state: 'queued' | 'active' | 'parked' | 'done' }
type SubagentMetadata = {
  description: string; depth: number; background?: boolean; status?: 'queued' | 'running' | ResultStatus; result?: string
  runners?: TaskId[]; generation?: number; reported?: EntryId[]; lastResultRunnerId?: TaskId
  messages?: Message[]; interruptTaskId?: TaskId
}
export const SubagentDoc = defineDoc<SubagentMetadata>({
  kind: 'pie2.subagent', version: 2, scope: 'conversation', history: 'latest', fork: 'initial',
  initial: () => ({ description: '', depth: 0 }), checkpointWhen: () => false,
  migrate: value => {
    const { taskId: _taskId, ...metadata } = value
    // Version 1 only allowed direct children; its native runners and receipts remain authoritative.
    return { ...metadata, description: typeof value.description === 'string' ? value.description : '', depth: 1 } as SubagentMetadata
  },
})
const SpawnReceipt = defineDoc<{ childId: ConversationId | null; runTaskId: TaskId | null; interrupted?: boolean }>({
  kind: 'pie2.subagent-spawn', version: 1, scope: 'task',
  initial: () => ({ childId: null, runTaskId: null }), checkpointWhen: () => false,
})
function bounded(value: string) {
  const bytes = Buffer.from(value)
  if (bytes.length <= 50_000) return value
  let end = 49_950
  while ((bytes[end]! & 0xc0) === 0x80) end--
  return `${bytes.subarray(0, end).toString('utf8')}\n[truncated at 50 KB]`
}
function answerText(answer: EntryRecord | undefined) {
  return (answer?.model ?? []).flatMap(message => message.role === 'assistant'
    ? message.content.flatMap(block => block.type === 'text' ? [block.text] : []) : []).join('\n')
}
function withPartialText(error: string, answer: EntryRecord | undefined) {
  const partial = answerText(answer)
  return bounded(partial ? `${error}\nPartial output before the run ended:\n${partial}` : error)
}
function responseFailure(answer: EntryRecord | undefined) {
  const message = answer?.model?.findLast(message => message.role === 'assistant')
  return message?.role === 'assistant' && ['length', 'error', 'aborted'].includes(message.stopReason)
    ? `Subagent run ended abnormally (${message.stopReason})${message.errorMessage ? `: ${message.errorMessage}` : ''}` : undefined
}
async function liveWork(tx: Tx, child: ConversationId) {
  const ids: TaskId[] = []
  for (const kind of ['pie2.subagent-runner', 'pie2.background-job', 'pie2.subagent-interrupt']) {
    let cursor: Cursor | undefined
    do {
      const page = await tx.scanTasks({ conversationId: child, kind }, 100, cursor)
      ids.push(...page.items.filter(task => task.state.status !== 'terminal').map(task => task.id))
      cursor = page.next
    } while (cursor)
  }
  return ids
}
type ReadApi = Pick<ToolExecutionApi, 'conversation' | 'waitForTask' | 'snapshot' | 'watchDoc'>
// A child's final answer includes turns woken by descendants, not its first idle response.
async function settleDescendants(api: ReadApi, child: ConversationId, generation: number, scan: () => Promise<TaskId[]>, context: CommandContext['context']) {
  const watch = await api.watchDoc(SubagentDoc, child, context)
  let interrupt!: () => void
  const interrupted = new Promise<void>(resolve => { interrupt = resolve })
  const changed = () => (watch?.value?.generation ?? 0) !== generation
  watch?.start(async () => { if (changed()) interrupt() })
  try {
    if (changed()) return
    const handle = await api.conversation(child, context)
    if (!handle) throw new Error(`Subagent conversation not found: ${child}`)
    while (!changed()) {
      const ids = await scan()
      if (ids.length) {
        await Promise.race([Promise.all(ids.map(id => api.waitForTask(id, context))), interrupted])
        if (changed()) return
      }
      await Promise.race([handle.waitForIdle(context), interrupted])
      if (changed() || !(await scan()).length) return
    }
  } finally { await watch?.stop() }
}
async function latestAnswer(tx: Tx, child: ConversationId, fallback?: EntryId, minEntryId?: EntryId) {
  let cursor: Cursor | undefined
  do {
    const page = await tx.scanEntries({ conversationId: child, order: 'descending', ...(minEntryId === undefined ? {} : { minEntryId }) }, 100, cursor)
    const answer = page.items.find(entry => entry.kind === AssistantEntry.kind && entry.model?.some(message => message.role === 'assistant' && message.stopReason !== 'toolUse'))
    if (answer) return answer
    cursor = page.next
  } while (cursor)
  return fallback === undefined ? undefined : await tx.entry(AssistantEntry, fallback)
}

// A terminal background anchor keeps the child identity across message reporters and ordinary parent aborts.
const Anchor = defineTask<null, { phase: 'done' }, null>({
  name: 'pie2.subagent-anchor', version: 1, initial: () => ({ phase: 'done' }),
  phases: { done: (_task, runtime, context) => runtime.commit(() => ({ status: 'terminal', outcome: { status: 'completed', result: null } }), context) },
  abort: (_task, runtime, context) => runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), context),
})
type RunnerState = { phase: 'deliver' } | { phase: 'report'; status: ResultStatus; result: string; notify: boolean }
type RunnerInput = {
  child: ConversationId; prompt: string; generation: number; messageId?: string; previous?: TaskId; interruptTaskId?: TaskId
  notification?: { requestId: string; sourceId: ConversationId; description: string; status: ResultStatus }
}
const Runner = defineTask<RunnerInput, RunnerState, null>({
  name: 'pie2.subagent-runner', version: 1, initial: () => ({ phase: 'deliver' }),
  phases: {
    deliver: async (runner, runtime, context) => {
      const { child, generation, previous, interruptTaskId } = runner.input
      let status: ResultStatus = 'aborted'
      let result = 'Subagent turn interrupted.'
      let answer: EntryId | undefined
      let failureEntry: EntryId | undefined
      try {
        if (interruptTaskId !== undefined) await runtime.waitForTask(interruptTaskId, context)
        if (previous !== undefined) await runtime.waitForTask(previous, context)
        let admitted = false
        await runtime.commit(async tx => {
          const metadata = await tx.doc(SubagentDoc, child)
          if ((metadata.generation ?? 0) !== generation) return
          const message = metadata.messages?.find(message => message.id === (runner.input.messageId ?? String(runner.id)))
          if (message) {
            const existing = await tx.submissionByRequest(child, `subagent:${runner.id}`)
            message.state = existing?.status === 'queued' ? 'queued' : 'active'
          }
          metadata.status = 'running'
          admitted = true
          return undefined
        }, context)
        if (admitted) {
          const handle = await runtime.conversation(child, context)
          if (!handle) throw new Error(`Subagent conversation not found: ${child}`)
          const submission = await handle.submit({
            type: 'input', content: runner.input.prompt, whenBusy: 'followUp', requestId: runner.input.notification?.requestId ?? `subagent:${runner.id}`,
            entry: runner.input.notification === undefined ? { kind: 'pie2.coordinator-message', data: { senderConversationId: runtime.conversationId } } : {
              kind: 'pie2.background-result', data: { source: 'subagent', id: runner.input.notification.sourceId, description: runner.input.notification.description, status: runner.input.notification.status },
            },
          }, context)
          const settled = await submission.wait(context)
          if (settled.status === 'done' && settled.type === 'input') {
            status = 'completed'
            answer = settled.answer
            await settleDescendants(runtime, child, generation, async () => {
              let ids: TaskId[] = []
              await runtime.commit(async tx => { ids = await liveWork(tx, child); return undefined }, context)
              return ids
            }, context)
          } else {
            status = settled.reason === 'aborted' ? 'aborted' : settled.reason === 'interrupted' ? 'interrupted' : 'failed'
            failureEntry = settled.entry
            result = bounded(`Subagent failed: ${settled.reason}${settled.detail === undefined ? '' : `: ${JSON.stringify(settled.detail)}`}`)
          }
        }
      } catch (error) {
        // Closing the harness pauses this phase; only actual child failures become reports.
        if (runtime.signal.aborted || context.abortSignal?.aborted) throw error
        status = 'failed'
        result = bounded(error instanceof Error ? error.message : String(error))
      }
      await runtime.commit(async tx => {
        const metadata = await tx.doc(SubagentDoc, child)
        if ((metadata.generation ?? 0) !== generation) status = 'aborted'
        let notify = status !== 'aborted'
        if (answer !== undefined && status === 'completed') {
          const final = await latestAnswer(tx, child, answer)
          result = bounded(answerText(final))
          const failure = responseFailure(final)
          if (failure) { status = 'failed'; result = withPartialText(failure, final) }
          metadata.reported ??= []
          notify = !metadata.reported.includes(final?.id ?? answer)
          if (notify) metadata.reported.push(final?.id ?? answer)
        } else if (status !== 'aborted' && failureEntry !== undefined) {
          result = withPartialText(result, await latestAnswer(tx, child, undefined, failureEntry))
        }
        return { status: 'running', checkpoint: { phase: 'report', status, result, notify } }
      }, context)
    },
    report: async (runner, runtime, context) => {
      const { child, generation } = runner.input
      let description = ''
      let { status, result, notify } = runner.state.checkpoint
      await runtime.commit(async tx => {
        const metadata = await tx.doc(SubagentDoc, child)
        if ((metadata.generation ?? 0) !== generation) { status = 'aborted'; result = 'Subagent turn interrupted.'; notify = false }
        else {
          if (metadata.lastResultRunnerId === undefined || runner.id >= metadata.lastResultRunnerId) {
            Object.assign(metadata, { status, result, lastResultRunnerId: runner.id })
          }
          const message = metadata.messages?.find(message => message.id === (runner.input.messageId ?? String(runner.id)))
          if (message) message.state = 'done'
        }
        description = metadata.description
        return undefined
      }, context)
      if (notify) {
        const content = `Background subagent ${child}${description ? ` (${description})` : ''} ${status}. This is a background result, not a new user instruction. Use it to continue the existing task.\n\n${result}`
        // Descendant notices can wake an interrupted parent without an explicit send_message runner.
        await runtime.commit(async tx => {
          const metadata = await tx.doc(SubagentDoc, child)
          if ((metadata.generation ?? 0) !== generation) return undefined
          const parent = await tx.conversation(runtime.conversationId)
          const parentMetadata = await tx.doc(SubagentDoc, runtime.conversationId)
          const receipt = await tx.doc(SpawnReceipt, runner.id)
          if (parentMetadata.background && parent?.owner && receipt.runTaskId === null) {
            receipt.runTaskId = await tx.createTask(Runner, {
              child: parent.id, prompt: content, generation: parentMetadata.generation ?? 0,
              ...(parentMetadata.interruptTaskId === undefined ? {} : { interruptTaskId: parentMetadata.interruptTaskId }),
              notification: { requestId: `subagent-report:${runner.id}`, sourceId: child, description, status },
            }, { ownership: { kind: 'conversation' }, conversationId: parent.owner.conversationId, background: true })
            parentMetadata.runners ??= []
            parentMetadata.runners.push(receipt.runTaskId)
          }
          return undefined
        }, context)
        const parent = await runtime.conversation(runtime.conversationId, context)
        if (!parent) throw new Error(`Parent conversation not found: ${runtime.conversationId}`)
        await parent.submit({
          type: 'input', whenBusy: 'followUp', requestId: `subagent-report:${runner.id}`,
          entry: { kind: 'pie2.background-result', data: { source: 'subagent', id: child, description, status } },
          content,
        }, context)
      }
      await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'completed', result: null } }), context)
    },
  },
  abort: async (runner, runtime, context) => {
    await runtime.commit(async tx => {
      const metadata = await tx.doc(SubagentDoc, runner.input.child)
      if ((metadata.generation ?? 0) === runner.input.generation) Object.assign(metadata, { status: 'aborted', result: 'Subagent stopped.' })
      return { status: 'terminal', outcome: { status: 'aborted' } }
    }, context)
  },
})
async function queueMessage(tx: Tx, parent: ConversationId, child: ConversationId, prompt: string, messageId?: string) {
  const metadata = await tx.doc(SubagentDoc, child)
  const runTaskId = await tx.createTask(Runner, {
    child, prompt, generation: metadata.generation ?? 0,
    ...(messageId === undefined ? {} : { messageId }),
    ...(metadata.runners?.at(-1) === undefined ? {} : { previous: metadata.runners.at(-1)! }),
    ...(metadata.interruptTaskId === undefined ? {} : { interruptTaskId: metadata.interruptTaskId }),
  }, { ownership: { kind: 'conversation' }, conversationId: parent, background: true })
  metadata.runners ??= []
  metadata.runners.push(runTaskId)
  metadata.messages ??= []
  if (messageId === undefined) metadata.messages.push({ id: String(runTaskId), prompt, state: 'queued' })
  else metadata.messages.find(message => message.id === messageId)!.state = 'queued'
  metadata.status = 'queued'
  return runTaskId
}
async function subagents(tx: Tx, parent: ConversationId, agentId?: number) {
  const records = []
  let cursor: Cursor | undefined
  do {
    const page = await tx.scanConversations({ ownerConversationId: parent }, 100, cursor)
    for (const child of page.items) {
      if (agentId !== undefined && child.id !== agentId) continue
      const metadata = await tx.doc(SubagentDoc, child.id)
      const owner = child.owner ? await tx.task(child.owner.taskId) : undefined
      let status: string = metadata.status ?? 'unknown'
      if (metadata.background && !metadata.messages?.some(message => message.state === 'parked')) {
        for (const id of metadata.runners ?? []) {
          const task = await tx.task(id)
          if (task?.state.status === 'terminal' || task?.state.status === 'completing') continue
          status = task?.state.status === 'pending' ? 'queued' : task?.state.status ?? 'unknown'
          if (status !== 'queued') break
        }
      } else if (!metadata.background && owner?.state.status === 'terminal' && owner.state.outcome.status !== 'completed') {
        status = owner.state.outcome.status === 'aborted' ? 'aborted' : 'failed'
      }
      records.push({
        id: child.id, description: metadata.description, background: metadata.background ?? false,
        runTaskId: metadata.runners?.at(-1) ?? child.owner?.taskId ?? null, status,
        queuedMessages: metadata.messages?.filter(message => message.state === 'queued' || message.state === 'parked').length ?? 0,
        ...(agentId === undefined || metadata.result === undefined ? {} : { result: metadata.result }),
      })
    }
    cursor = page.next
  } while (cursor)
  return records
}
async function reconcileSubagents({ harness, conversation, context }: CommandContext, agentId?: number) {
  return harness.commit(tx => subagents(tx, conversation.id, agentId), context)
}
async function requireChild(tx: Tx, parent: ConversationId, id: number, descendants = false) {
  const target = await tx.conversation(id as ConversationId)
  let candidate = target
  while (candidate?.owner) {
    if (candidate.owner.conversationId === parent) return target!.id
    if (!descendants) break
    candidate = await tx.conversation(candidate.owner.conversationId)
  }
  throw new Error(`Unknown subagent in this conversation: ${id}`)
}
async function restoreMessages(tx: Tx, child: ConversationId) {
  const metadata = await tx.doc(SubagentDoc, child)
  if (metadata.messages !== undefined) return metadata
  metadata.messages = []
  for (const id of metadata.runners ?? []) {
    const task = await tx.task(id)
    if (!task || typeof task.input !== 'object' || task.input === null || !('prompt' in task.input) || typeof task.input.prompt !== 'string') continue
    const submission = await tx.submissionByRequest(child, `subagent:${id}`)
    const state = task.state.status === 'terminal' || submission?.status === 'done' || submission?.status === 'unanswered' ? 'done'
      : submission?.status === 'placed' ? 'active' : 'queued'
    metadata.messages.push({ id: String(id), prompt: task.input.prompt, state })
  }
  return metadata
}
async function sendMessage(tx: Tx, parent: ConversationId, id: number, message: string) {
  if (!message.trim()) throw new Error('Subagent message must not be blank')
  const child = await requireChild(tx, parent, id)
  const metadata = await restoreMessages(tx, child)
  if (!metadata.background) throw new Error('Only background subagents accept follow-up messages')
  for (const parked of metadata.messages?.filter(message => message.state === 'parked') ?? []) {
    await queueMessage(tx, parent, child, parked.prompt, parked.id)
  }
  return { child, runTaskId: await queueMessage(tx, parent, child, message) }
}
// Terminal request receipts prevent a paused admission from reviving an interrupted turn or posting a late report.
async function cancelRequests(tx: Tx, requests: { conversationId: ConversationId; requestId: string }[]) {
  const records = await Promise.all(requests.map(request => tx.submissionByRequest(request.conversationId, request.requestId)))
  for (const [index, request] of requests.entries()) {
    const existing = records[index]
    if (!existing) await tx.createSubmission({ type: 'input', ...request, status: 'unanswered', reason: 'aborted' })
    else if (existing.status === 'queued') {
      const inbox = await tx.doc(InboxDoc, request.conversationId)
      inbox.items = inbox.items.filter(item => item.id !== existing.id)
      tx.settleSubmission(existing.id, { status: 'unanswered', reason: 'aborted' })
    }
  }
}
const Interrupt = defineTask<{ child: ConversationId; runners: TaskId[] }, { phase: 'stop' }, null>({
  name: 'pie2.subagent-interrupt', version: 1, initial: () => ({ phase: 'stop' }),
  phases: { stop: async (task, runtime, context) => {
    const handle = await runtime.conversation(task.input.child, context)
    if (handle) await handle.abort(context)
    for (const id of task.input.runners) await runtime.waitForTask(id, context)
    await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'completed', result: null } }), context)
  } },
  abort: (_task, runtime, context) => runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), context),
})
async function stopSubagent(api: Pick<ToolExecutionApi, 'commit'>, parent: ConversationId, id: number, context: CommandContext['context'], requestTaskId?: TaskId) {
  await api.commit(async tx => {
    const receipt = requestTaskId === undefined ? undefined : await tx.doc(SpawnReceipt, requestTaskId)
    if (receipt?.interrupted) return
    const child = await requireChild(tx, parent, id, true)
    if (receipt) receipt.interrupted = true
    const metadata = await restoreMessages(tx, child)
    const runners: TaskId[] = []
    const requests: { conversationId: ConversationId; requestId: string }[] = []
    for (const id of metadata.runners ?? []) {
      const task = await tx.task(id)
      if (task && task.state.status !== 'terminal') {
        runners.push(id)
        const input = task.input as RunnerInput
        requests.push({ conversationId: child, requestId: input.notification?.requestId ?? `subagent:${id}` })
      }
    }
    const owner = (await tx.conversation(child))?.owner
    const foreground = owner ? await tx.task(owner.taskId) : undefined
    if (!runners.length && (metadata.background || foreground?.state.status === 'terminal')) return
    if (metadata.interruptTaskId !== undefined && (await tx.task(metadata.interruptTaskId))?.state.status !== 'terminal') return
    const directParent = owner!.conversationId
    metadata.generation = (metadata.generation ?? 0) + 1
    Object.assign(metadata, { status: 'interrupted', result: 'Subagent turn interrupted.' })
    for (const message of metadata.messages ?? []) {
      if (message.state === 'queued') message.state = 'parked'
      else if (message.state === 'active') message.state = 'done'
    }
    await cancelRequests(tx, [...requests, ...runners.map(runner => ({
      conversationId: directParent, requestId: `subagent-report:${runner}`,
    }))])
    metadata.interruptTaskId = await tx.createTask(Interrupt, { child, runners }, {
      ownership: { kind: 'conversation' }, conversationId: directParent, background: true,
    })
  }, context)
  return { accepted: true }
}
function parseId(id: string) {
  if (!/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(Number(id))) throw new Error(`Unknown subagent: ${id}`)
  return Number(id)
}
const agentIdSchema = Type.String({ minLength: 1 })
const messageSchema = Type.String({ minLength: 1, maxLength: 131072 })
export const SubagentPlugin: Plugin = {
  name: 'subagent',
  extension: defineExtension({
    name: 'subagent', tasks: [Runner, Anchor, Interrupt],
    sections: [section('subagent_policy', () => 'Use subagent for focused independent research, scoped implementation or analysis that benefits from its own context; skip delegation for trivial work. Use subagent in the background by default. Start independent delegations together in one assistant message and continue useful work while they run. Set run_in_background: false only when your next action depends on that subagent\'s result. Give each child a complete, standalone prompt: it does not see this conversation. Do not duplicate delegated work or assign overlapping file edits. When a background run settles, the runtime sends you a notice containing its outcome and final assistant message; do not busy-poll or sleep waiting. Use send_message to give a child later work in the same conversation; it queues after its current turn. interrupt_agent only stops its current turn: queued messages remain parked until a later send_message and its published children keep running. Collect and verify delegated results before claiming the overall task is complete. Delegation has an absolute maximum depth of 3.')],
    tools: [defineTool({
      name: 'subagent',
      description: 'Delegate a self-contained task to a separate agent with its own context. Supply a complete standalone prompt: it does not see this conversation. Runs in the background by default, immediately returns a durable subagentId, and keeps its conversation for send_message follow-ups. Completion results are delivered automatically. Set run_in_background:false only when your next action depends on the result. Inherits model, thinking, tools, working directory and skills. Maximum delegation depth is 3; children cannot manage Goals.',
      parameters: Type.Object({
        description: Type.String({ minLength: 1, maxLength: 400, description: 'A short (3-5 word) description of the delegated task, for display.' }),
        prompt: messageSchema,
        run_in_background: Type.Optional(Type.Boolean({ default: true, description: 'Defaults to true. Set false to wait only when your next action depends on the result.' })),
      }, { additionalProperties: false }),
      structuredOutputSchema: Type.Union([
        Type.Object({ kind: Type.Literal('continuable'), subagentId: Type.String() }, { additionalProperties: false }),
        Type.Object({ kind: Type.Literal('foreground'), runId: Type.String(), output: Type.Array(Type.Object({ type: Type.Literal('text'), text: Type.String() })) }, { additionalProperties: false }),
      ]),
      replay: 'safe', executionMode: 'parallel',
      execute: async (args, api, context) => {
        if (!args.prompt.trim() || !args.description.trim()) throw new Error('Subagent prompt and description must not be blank')
        const background = args.run_in_background ?? true
        const parentAgent = await api.agent(context)
        const spawned = await api.commit(async tx => {
          const receipt = await tx.doc(SpawnReceipt, api.taskId)
          if (receipt.childId !== null) {
            const metadata = await tx.doc(SubagentDoc, receipt.childId)
            return { child: receipt.childId, runTaskId: receipt.runTaskId!, background: metadata.background ?? false }
          }
          const depth = (await tx.doc(SubagentDoc, api.conversationId)).depth + 1
          if (depth > 3) throw new Error(`Subagent depth ${depth} exceeds maxDepth 3`)
          const ownerTaskId = background ? await tx.createTask(Anchor, null, {
            ownership: { kind: 'conversation' }, conversationId: api.conversationId, background: true,
          }) : api.taskId
          const created = await tx.createConversation({ ownership: { kind: 'task', taskId: ownerTaskId } })
          await configure(tx, created.id, {
            model: parentAgent.model, thinkingLevel: parentAgent.thinkingLevel, cwd: parentAgent.cwd,
            extensions: parentAgent.extensions.filter(extension => extension.name !== 'goal'),
            tools: [...new Map([...parentAgent.tools, ...parentAgent.callable, ...parentAgent.deferred].filter(tool => depth < 3 || tool.name !== 'subagent').map(tool => [tool.name, tool])).values()],
            modelTools: parentAgent.tools.filter(tool => depth < 3 || tool.name !== 'subagent'),
            instructions: [parentAgent.instructions, 'Complete only the delegated task. Collect and verify descendant results before your final response. Report your result or blocker.'].filter(Boolean).join('\n\n'),
          })
          Object.assign(await tx.doc(SubagentDoc, created.id), { description: args.description, depth, background, status: background ? 'queued' : 'running' })
          const runTaskId = background ? await queueMessage(tx, api.conversationId, created.id, args.prompt) : api.taskId
          receipt.childId = created.id
          receipt.runTaskId = runTaskId
          return { child: created.id, runTaskId, background }
        }, context)
        const { child, runTaskId, background: runInBackground } = spawned
        const details = { conversationId: child, ...(runInBackground ? { background: true, runTaskId } : {}) }
        await api.details(details, context)
        if (runInBackground) {
          const result = { kind: 'continuable', subagentId: String(child) }
          return { ...text(result), structuredOutput: result, details }
        }
        try {
          const handle = await api.conversation(child, context)
          if (!handle) throw new Error(`Subagent conversation not found: ${child}`)
          const settled = await (await handle.submit({ type: 'input', content: args.prompt, requestId: `subagent:${api.taskId}`,
            entry: { kind: 'pie2.coordinator-message', data: { senderConversationId: api.conversationId } },
          }, context)).wait(context)
          if (settled.status !== 'done' || settled.type !== 'input') {
            const reason = settled.status === 'unanswered' ? `${settled.reason}${settled.detail === undefined ? '' : `: ${JSON.stringify(settled.detail)}`}` : settled.status
            const partial = settled.entry === undefined ? undefined : await api.commit(tx => latestAnswer(tx, child, undefined, settled.entry), context)
            throw new Error(withPartialText(`Subagent failed: ${reason}`, partial))
          }
          await settleDescendants(api, child, 0, () => api.commit(tx => liveWork(tx, child), context), context)
          if ((await api.snapshot(SubagentDoc, child, context))?.generation) throw new Error('Subagent turn interrupted.')
          const answer = await api.commit(tx => latestAnswer(tx, child, settled.answer), context)
          const failure = responseFailure(answer)
          if (failure) throw new Error(withPartialText(failure, answer))
          const output = [{ type: 'text' as const, text: bounded(answerText(answer)) }]
          await api.commit(async tx => { Object.assign(await tx.doc(SubagentDoc, child), { status: 'completed', result: output[0]!.text }) }, context)
          return { output, structuredOutput: { kind: 'foreground', runId: String(child), output }, details }
        } catch (error) {
          // Native cancellation invalidates this API; ownership cleanup handles foreground children.
          if (context.abortSignal?.aborted) throw error
          const result = error instanceof Error ? error.message : String(error)
          await api.commit(async tx => {
            const metadata = await tx.doc(SubagentDoc, child)
            if (metadata.status !== 'interrupted') Object.assign(metadata, { status: 'failed', result: bounded(result) })
          }, context)
          return { ...text(result), isError: true, details }
        }
      },
    }), defineTool({
      name: 'send_message', description: 'Send a message to a background subagent, continuing the same conversation. It becomes the next turn after current work; it cannot redirect work already underway. Returns only a messageId, not the answer. A failure means the message was NOT delivered. Sending after interrupt wakes the parked FIFO queue.',
      parameters: Type.Object({ subagent_id: agentIdSchema, message: messageSchema }, { additionalProperties: false }),
      structuredOutputSchema: Type.Object({ messageId: Type.String() }, { additionalProperties: false }),
      replay: 'safe', executionMode: 'sequential',
      execute: async (args, api, context) => {
        const sent = await api.commit(async tx => {
          const receipt = await tx.doc(SpawnReceipt, api.taskId)
          if (receipt.childId !== null) return { child: receipt.childId, runTaskId: receipt.runTaskId! }
          const sent = await sendMessage(tx, api.conversationId, parseId(args.subagent_id), args.message)
          receipt.childId = sent.child
          receipt.runTaskId = sent.runTaskId
          return sent
        }, context)
        const result = { messageId: String(sent.runTaskId) }
        return { ...text(result), structuredOutput: result, details: { conversationId: sent.child, background: true, runTaskId: sent.runTaskId } }
      },
    }), defineTool({
      name: 'interrupt_agent', description: 'Request cancellation of a background agent current turn. The target can be your direct child or a deeper descendant. Queued messages stay parked until a later send_message, and its published background children keep running. Returns as soon as accepted; a finished agent is an accepted no-op. The child remains available for follow-ups.',
      parameters: Type.Object({ agent_id: agentIdSchema }, { additionalProperties: false }),
      structuredOutputSchema: Type.Object({ accepted: Type.Boolean() }, { additionalProperties: false }),
      replay: 'safe', executionMode: 'sequential',
      execute: async (args, api, context) => {
        const result = await stopSubagent(api, api.conversationId, parseId(args.agent_id), context, api.taskId)
        return { ...text(result), structuredOutput: result }
      },
    })],
  }),
  afterInterrupt: async ctx => { await reconcileSubagents(ctx) },
  commands: {
    agents: async (args, ctx) => {
      const trimmed = args.trim()
      const send = /^send\s+([1-9]\d*)\s+([\s\S]+)$/.exec(trimmed)
      if (send) {
        const sent = await ctx.harness.commit(tx => sendMessage(tx, ctx.conversation.id, parseId(send[1]!), send[2]!), ctx.context)
        ctx.harness.resume()
        return { output: `Queued message ${sent.runTaskId} to subagent ${sent.child}.` }
      }
      const match = /^(get|stop)\s+([1-9]\d*)$/.exec(trimmed)
      if (trimmed && trimmed !== 'list' && !match) throw new Error('Usage: /agents [list | get <subagent-id> | stop <subagent-id> | send <subagent-id> <message>]')
      if (match?.[1] === 'stop') {
        await stopSubagent(ctx.harness, ctx.conversation.id, parseId(match[2]!), ctx.context)
        ctx.harness.resume()
        return { output: `Interrupt requested for subagent ${match[2]}; queued messages remain parked until a later send.` }
      }
      const children = await reconcileSubagents(ctx, match?.[1] === 'get' ? parseId(match[2]!) : undefined)
      if (match) {
        const child = children.find(item => item.id === Number(match[2]))
        if (!child) throw new Error(`Unknown subagent in this conversation: ${match[2]}`)
        return { output: JSON.stringify(child, null, 2) }
      }
      return { output: children.length ? JSON.stringify(children, null, 2) : 'No subagents.' }
    },
  },
}
