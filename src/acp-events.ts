import type { AgentContext, SessionUpdate, ToolKind } from '@agentclientprotocol/sdk'
import { methods } from '@agentclientprotocol/sdk'
import type { AssistantMessage, Message } from '@earendil-works/pi-ai'
import type { AgentEvent, EntryRecord } from '@earendil-works/pi-durable'

const limit = 16_384
export const bounded = (text: string) => text.length <= limit ? text : `${text.slice(0, limit)}\n[truncated]`
export function toolKind(name: string): ToolKind {
  if (['read', 'read_image', 'Skill', 'job_output', 'job_list', 'get_goal'].includes(name)) return 'read'
  if (['glob', 'grep', 'web_search'].includes(name)) return 'search'
  if (['write', 'edit'].includes(name)) return 'edit'
  if (['bash', 'job_start', 'job_kill', 'subagent', 'workflow', 'ralph'].includes(name)) return 'execute'
  if (['enter_plan_mode', 'exit_plan_mode'].includes(name)) return 'switch_mode'
  if (name === 'todo_write') return 'think'
  return 'other'
}
export function toolTitle(name: string, args: Record<string, unknown> = {}): string {
  const job = name === 'job_start' || name === 'bash' && args.run_in_background === true
  const title = job ? 'Job' : name
  const detail = args.description ?? args.path ?? args.pattern ?? (job ? args.command : undefined)
  return bounded(`${title}${typeof detail === 'string' ? ` · ${detail.slice(0, 160)}` : ''}`)
}
export function safeInput(value: unknown, depth = 0): unknown {
  if (depth > 4) return '[truncated]'
  if (typeof value === 'string') return bounded(value)
  if (Array.isArray(value)) return value.slice(0, 30).map(item => safeInput(item, depth + 1))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).slice(0, 30).map(([key, item]) => [key,
    /api.?key|authorization|password|secret|token|headers|providers|env/i.test(key) ? '[redacted]' : safeInput(item, depth + 1),
  ]))
  return value
}
function textOf(message: Message): string {
  if (typeof message.content === 'string') return message.content
  return message.content.map(block => block.type === 'text' ? block.text : '').join('\n')
}

/** Projection only: scheduling, cancellation and permissions remain with the native host. */
export class AcpEvents {
  private seenEntries = new Set<number>()
  private tools = new Map<string, { name: string; args: Record<string, unknown>; output: string; hidden?: boolean }>()
  private blocks: AssistantMessage['content'] = []
  private sent = new Map<number, string>()
  private active = false
  private historyTools = new Map<string, string>()
  private eventId(event: { taskId?: number; toolCallId: string }) { return event.taskId === undefined ? event.toolCallId : `task-${event.taskId}` }
  private send: (update: SessionUpdate) => Promise<void>
  constructor(send: (update: SessionUpdate) => Promise<void>) { this.send = send }
  async pending(id: string, name: string, args: Record<string, unknown>, parentId?: string) {
    if (this.tools.has(id)) return
    const parent = parentId && this.tools.get(parentId)
    const hidden = name === 'job_start' && !!parent && parent.name === 'bash' && parent.args.run_in_background === true
    this.tools.set(id, { name, args, output: '', hidden })
    if (!hidden) await this.send({ sessionUpdate: 'tool_call', toolCallId: id, title: toolTitle(name, args), name,
      kind: toolKind(name), status: 'pending', rawInput: safeInput(args),
      _meta: { 'pie2.toolName': name, ...(parentId ? { 'pie2.parentToolCallId': parentId } : {}) } })
  }
  private async chunks(blocks: AssistantMessage['content']) {
    for (const [index, block] of blocks.entries()) {
      if (block.type !== 'text' && block.type !== 'thinking' || block.type === 'thinking' && block.redacted) continue
      const value = block.type === 'text' ? block.text : block.thinking
      const previous = this.sent.get(index) ?? ''
      const delta = value.startsWith(previous) ? value.slice(previous.length) : value
      if (delta) await this.send({ sessionUpdate: block.type === 'text' ? 'agent_message_chunk' : 'agent_thought_chunk', content: { type: 'text', text: delta } })
      this.sent.set(index, value)
    }
  }
  async entry(entry: EntryRecord, history = false) {
    if (this.seenEntries.has(entry.id)) return
    this.seenEntries.add(entry.id)
    for (const message of entry.model ?? []) {
      if (message.role === 'assistant') {
        if (!this.active) this.sent.clear()
        await this.chunks(message.content)
        for (const block of message.content) if (history && block.type === 'toolCall') {
          const id = `history-${entry.id}-${block.id}`
          this.historyTools.set(block.id, id)
          this.tools.set(id, { name: block.name, args: block.arguments, output: '' })
          await this.send({ sessionUpdate: 'tool_call', toolCallId: id, name: block.name,
            title: toolTitle(block.name, block.arguments), kind: toolKind(block.name), status: 'pending', rawInput: safeInput(block.arguments) })
        }
        this.active = false
        this.sent.clear()
      } else if (message.role === 'user') {
        if (typeof message.content === 'string') await this.send({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: message.content } })
        else for (const block of message.content) await this.send({ sessionUpdate: 'user_message_chunk', content: block })
      } else if (message.role === 'toolResult') {
        const id = history ? this.historyTools.get(message.toolCallId) ?? message.toolCallId : entry.byTaskId === undefined ? message.toolCallId : `task-${entry.byTaskId}`
        if (!this.tools.has(id)) {
          this.tools.set(id, { name: message.toolName, args: {}, output: '' })
          await this.send({ sessionUpdate: 'tool_call', toolCallId: id, name: message.toolName,
            title: toolTitle(message.toolName), kind: toolKind(message.toolName), status: 'pending' })
        }
        await this.finish(id, textOf(message), message.isError)
      }
    }
  }
  private async finish(id: string, text: string, error: boolean) {
    const tool = this.tools.get(id)
    if (tool?.hidden) return
    if (tool) tool.output = bounded(text)
    const structured = (() => { try { return JSON.parse(text) as { jobId?: string } } catch { return undefined } })()
    const job = tool && (tool.name === 'job_start' || tool.name === 'bash' && tool.args.run_in_background === true)
    const jobId = structured?.jobId
    await this.send({ sessionUpdate: 'tool_call_update', toolCallId: id, status: error ? 'failed' : 'completed',
      ...(job && jobId ? { title: `Job #${jobId} · ${String(tool.args.description ?? 'background command').slice(0, 160)}` } : {}),
      content: [{ type: 'content', content: { type: 'text', text: bounded(text) } }] })
  }
  async event(event: AgentEvent) {
    switch (event.type) {
      case 'snapshot':
        for (const entry of event.entries) await this.entry(entry)
        if (event.generation?.message) {
          this.blocks = structuredClone(event.generation.message.content)
          this.active = true
          await this.chunks(this.blocks)
        }
        break
      case 'message_start':
        if (event.message.role === 'assistant') { this.blocks = structuredClone(event.message.content); this.sent.clear(); this.active = true; await this.chunks(this.blocks) }
        break
      case 'message_update':
        for (const change of event.changes) {
          if (change.type === 'message') { this.blocks = structuredClone(change.message.content); this.active = true }
          else if ('block' in change) this.blocks[change.contentIndex] = structuredClone(change.block)
          else if (change.type === 'text_delta') { const block = this.blocks[change.contentIndex]; if (block?.type === 'text') block.text += change.delta }
          else if (change.type === 'thinking_delta') { const block = this.blocks[change.contentIndex]; if (block?.type === 'thinking') block.thinking += change.delta }
        }
        await this.chunks(this.blocks)
        break
      case 'message_end': case 'entry_appended': await this.entry(event.entry); break
      case 'tool_execution_start': {
        const parent = event.parentToolCallId && this.tools.get(event.parentTaskId === undefined ? event.parentToolCallId : `task-${event.parentTaskId}`)
        const hidden = event.toolName === 'job_start' && !!parent && parent.name === 'bash' && parent.args.run_in_background === true
        const id = this.eventId(event)
        const exists = this.tools.has(id)
        this.tools.set(id, { name: event.toolName, args: event.args, output: '', hidden })
        if (!hidden) await this.send({ sessionUpdate: exists ? 'tool_call_update' : 'tool_call', toolCallId: id,
          title: toolTitle(event.toolName, event.args), name: event.toolName, kind: toolKind(event.toolName), status: 'in_progress', rawInput: safeInput(event.args),
          _meta: { 'pie2.toolName': event.toolName, ...(event.parentToolCallId ? { 'pie2.parentToolCallId': event.parentToolCallId } : {}) } })
        break
      }
      case 'tool_execution_update': {
        const id = this.eventId(event)
        const tool = this.tools.get(id)
        if (!tool || tool.hidden || !event.output) break
        tool.output = bounded('set' in event.output ? event.output.set : tool.output.slice(event.output.trimStart ?? 0) + (event.output.append ?? ''))
        await this.send({ sessionUpdate: 'tool_call_update', toolCallId: id,
          content: [{ type: 'content', content: { type: 'text', text: tool.output } }] })
        break
      }
      case 'tool_execution_end': {
        const message = event.entry?.model?.find(message => message.role === 'toolResult')
        const nested = event.result
        if (event.entry) this.seenEntries.add(event.entry.id)
        const id = this.eventId(event)
        if (!this.tools.has(id)) await this.pending(id, event.toolName, {}, event.parentTaskId === undefined ? event.parentToolCallId : `task-${event.parentTaskId}`)
        const output = message ? textOf(message) : nested?.structuredOutput === undefined ? this.tools.get(id)?.output ?? '' : JSON.stringify(safeInput(nested.structuredOutput))
        const diagnostics = nested?.diagnostics?.map(item => item.message).join('\n') ?? ''
        await this.finish(id, [output, diagnostics].filter(Boolean).join('\n'), message?.isError ?? nested?.isError ?? true)
        break
      }
    }
  }
}

export const sessionSender = (client: AgentContext, sessionId: string) => (update: SessionUpdate) => client.notify(methods.client.session.update, { sessionId, update })
