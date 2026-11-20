import type { Context } from '@earendil-works/chord/context'
import type { AgentEvent, Conversation, Extension, Harness, SnapshotEvent } from '@earendil-works/pi-durable'

export interface ActivityOverview {
  summary: string
  lines: string[]
}

export interface StatusBar {
  render(width: number): string[]
  snapshot(snapshot: SnapshotEvent): void
  update(event: AgentEvent): void
  setModel(model: string, thinking: string): void
  activity?(): ActivityOverview
  refreshActivity?(): Promise<void>
  setRenderHook?(render?: () => void): void
}

export interface CommandContext {
  harness: Harness
  conversation: Conversation
  context: Context
}

export type CommandResult = { output?: string; prompt?: string }
export interface Plugin {
  name: string
  extension: Extension
  commands?: Record<string, (args: string, ctx: CommandContext) => Promise<CommandResult>>
  statusBar?: StatusBar
  interrupt?(ctx: CommandContext): Promise<void>
  afterInterrupt?(ctx: CommandContext): Promise<void>
}

export function text(value: unknown) {
  return { output: [{ type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] }
}
