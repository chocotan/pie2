import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { SessionUpdate } from '@agentclientprotocol/sdk'
import { fauxAssistantMessage, fauxThinking, fauxText, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import { ROOT_CONVERSATION_ID, type EntryRecord, type EntryId, type TaskId } from '@earendil-works/pi-durable'
import { AcpEvents } from '../src/acp-events.ts'

const task = (value: number) => value as TaskId
const entry = (id: number, message: ReturnType<typeof fauxAssistantMessage>): EntryRecord => ({ id: id as EntryId, conversationId: ROOT_CONVERSATION_ID, kind: 'pi.assistant', model: [message] })
const text = (updates: SessionUpdate[], kind: 'agent_message_chunk' | 'agent_thought_chunk') => updates.flatMap(update => update.sessionUpdate === kind && update.content.type === 'text' ? [update.content.text] : []).join('')

test('ACP stream projection deduplicates final messages and skips opaque thinking/signatures', async () => {
  const updates: SessionUpdate[] = []
  const events = new AcpEvents(async update => { updates.push(update) })
  const final = fauxAssistantMessage([fauxThinking('visible reasoning'), { ...fauxThinking('opaque-secret-data'), redacted: true, thinkingSignature: 'signature-secret' }, fauxText('Final answer')])
  await events.event({ type: 'message_start', message: fauxAssistantMessage('') })
  await events.event({ type: 'message_update', usage: final.usage, changes: [{ type: 'message', message: final }] })
  await events.entry(entry(1, final))
  await events.entry(entry(1, final))
  assert.equal(text(updates, 'agent_message_chunk'), 'Final answer')
  assert.equal(text(updates, 'agent_thought_chunk'), 'visible reasoning')
  assert.ok(!JSON.stringify(updates).includes('opaque-secret'))
  assert.ok(!JSON.stringify(updates).includes('signature-secret'))
})

test('ACP resumes an in-flight message from an overflow snapshot without losing or repeating deltas', async () => {
  const updates: SessionUpdate[] = []
  const events = new AcpEvents(async update => { updates.push(update) })
  await events.event({ type: 'message_start', message: fauxAssistantMessage('Hel') })
  await events.event({ type: 'snapshot', entries: [], tools: [], nestedTools: [], compactions: [], inbox: [], agent: {},
    usage: { models: {}, tools: {} }, generation: { attempt: 1, message: fauxAssistantMessage('Hello wor') } })
  const final = fauxAssistantMessage('Hello world')
  await events.event({ type: 'message_update', usage: final.usage, changes: [{ type: 'text_delta', contentIndex: 0, delta: 'ld' }] })
  await events.entry(entry(2, final))
  assert.equal(text(updates, 'agent_message_chunk'), 'Hello world')
})

test('ACP live snapshots keep the native permission tool ID instead of creating a history duplicate', async () => {
  const updates: SessionUpdate[] = []
  const events = new AcpEvents(async update => { updates.push(update) })
  const args = { path: 'README.md' }
  await events.pending('task-10', 'read', args)
  const call = entry(1, fauxAssistantMessage(fauxToolCall('read', args, { id: 'provider-read' })))
  const result: EntryRecord = { id: 2 as EntryId, conversationId: ROOT_CONVERSATION_ID, kind: 'pi.toolResult', byTaskId: task(10),
    model: [{ role: 'toolResult', toolCallId: 'provider-read', toolName: 'read', content: [{ type: 'text', text: 'Read content' }], isError: false, timestamp: 0 }] }
  await events.event({ type: 'snapshot', entries: [call, result], tools: [], nestedTools: [], compactions: [], inbox: [], agent: {}, usage: { models: {}, tools: {} } })
  assert.deepEqual(updates.flatMap(update => update.sessionUpdate === 'tool_call' ? [update.toolCallId] : []), ['task-10'])
  assert.ok(updates.some(update => update.sessionUpdate === 'tool_call_update' && update.toolCallId === 'task-10' && update.status === 'completed'))
})

test('ACP Job titles use native jobId receipts and hide internal job_start', async () => {
  const updates: SessionUpdate[] = []
  const events = new AcpEvents(async update => { updates.push(update) })
  const args = { command: 'npm test', description: 'Run tests', run_in_background: true }
  await events.event({ type: 'tool_execution_start', toolCallId: 'launch', taskId: task(20), toolName: 'bash', args })
  await events.event({ type: 'tool_execution_start', toolCallId: 'launch/background', taskId: task(21), parentTaskId: task(20), parentToolCallId: 'launch', toolName: 'job_start', args })
  await events.event({ type: 'tool_execution_end', toolCallId: 'launch/background', taskId: task(21), toolName: 'job_start', result: { taskId: task(21), isError: false, diagnostics: [], structuredOutput: { kind: 'background', jobId: '42' } } })
  await events.event({ type: 'tool_execution_end', toolCallId: 'launch', taskId: task(20), toolName: 'bash', result: { taskId: task(20), isError: false, diagnostics: [], structuredOutput: { kind: 'background', jobId: '42' } } })
  assert.equal(updates.filter(update => update.sessionUpdate === 'tool_call').length, 1)
  assert.ok(updates.some(update => update.sessionUpdate === 'tool_call_update' && update.title === 'Job #42 · Run tests'))
  assert.ok(!JSON.stringify(updates).includes('task-21'))
})

test('ACP nested tools show bounded structured results and diagnostics, with unique native IDs', async () => {
  const updates: SessionUpdate[] = []
  const events = new AcpEvents(async update => { updates.push(update) })
  for (const id of [10, 11]) {
    await events.event({ type: 'tool_execution_start', toolCallId: 'reused-provider-id', taskId: task(id), toolName: 'read', args: { path: 'file.txt', headers: { authorization: 'never-expose' } } })
    await events.event({ type: 'tool_execution_end', toolCallId: 'reused-provider-id', taskId: task(id), toolName: 'read', result: { taskId: task(id), isError: false, diagnostics: [{ severity: 'info', message: 'nested diagnostic' }], structuredOutput: { result: 'result-value', apiKey: 'never-expose' } } })
  }
  const ids = updates.flatMap(update => update.sessionUpdate === 'tool_call' ? [update.toolCallId] : [])
  assert.deepEqual(ids, ['task-10', 'task-11'])
  assert.ok(JSON.stringify(updates).includes('result-value'))
  assert.ok(JSON.stringify(updates).includes('nested diagnostic'))
  assert.ok(!JSON.stringify(updates).includes('never-expose'))
  await events.event({ type: 'tool_execution_update', toolCallId: 'reused-provider-id', taskId: task(11), toolName: 'read', output: { set: 'x'.repeat(100_000) } })
  assert.ok(JSON.stringify(updates.at(-1)).length < 17_000)
})
