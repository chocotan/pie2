import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { test, type TestContext } from 'node:test'
import { PassThrough, Readable, Writable } from 'node:stream'
import { ndJsonStream, client, methods, type ClientCapabilities, type CreateElicitationRequest, type CreateElicitationResponse, type RequestPermissionRequest, type RequestPermissionResponse, type SessionNotification } from '@agentclientprotocol/sdk'
import { createModels } from '@earendil-works/pi-ai/models'
import { fauxAssistantMessage, fauxProvider, fauxThinking, fauxText, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import { startAcp } from '../src/acp.ts'
import { listSessions } from '../src/sessions.ts'
import { openHost } from '../src/host.ts'

async function setup(t: TestContext, options: { capabilities?: ClientCapabilities; permission?: (params: RequestPermissionRequest) => Promise<RequestPermissionResponse>; elicitation?: (params: CreateElicitationRequest) => Promise<CreateElicitationResponse>; disablePlugins?: string[]; pluginSource?: string } = {}) {
  const cwd = await mkdtemp(join(tmpdir(), 'pie2-acp-'))
  const a = new PassThrough()
  const b = new PassThrough()
  const faux = fauxProvider({ models: [{ id: 'faux-1', reasoning: true }, { id: 'faux-2', reasoning: true, input: ['text'] }] })
  const models = createModels()
  models.setProvider(faux.provider)
  const updates: SessionNotification[] = []
  const permissions: RequestPermissionRequest[] = []
  const configured: string[] = []
  const pluginPath = join(cwd, 'acp-test-plugin.ts')
  if (options.pluginSource) await writeFile(pluginPath, options.pluginSource)
  const server = startAcp({ cwd, pluginPaths: options.pluginSource ? [pluginPath] : undefined, disablePlugins: options.disablePlugins, input: b, output: a, configureModels: async params => {
    configured.push(params?.cwd ?? '')
    return { models, model: { provider: 'faux', modelId: 'faux-1' }, thinkingLevel: 'low', webSearch: {} }
  } })
  const app = client({ name: 'acp-test' })
    .onNotification(methods.client.session.update, ({ params }) => { updates.push(params) })
    .onRequest(methods.client.session.requestPermission, ({ params }) => {
      permissions.push(params)
      return options.permission?.(params) ?? { outcome: { outcome: 'selected', optionId: 'allow_once' } }
    })
  if (options.elicitation) app.onRequest(methods.client.elicitation.create, ({ params }) => options.elicitation!(params))
  const connection = app.connect(ndJsonStream(Writable.toWeb(b) as WritableStream<Uint8Array>, Readable.toWeb(a) as ReadableStream<Uint8Array>))
  t.after(async () => {
    b.end()
    connection.close()
    await server
    a.destroy()
    for (const session of await listSessions(cwd)) await rm(dirname(session.path), { recursive: true, force: true })
    await rm(cwd, { recursive: true, force: true })
  })
  const request = connection.agent.request.bind(connection.agent)
  const initialized = await request(methods.agent.initialize, { protocolVersion: 1, clientCapabilities: options.capabilities })
  return { cwd, faux, models, connection, request, updates, permissions, configured, initialized, server,
    end: async () => { b.end(); connection.close(); await server },
    newSession: () => request(methods.agent.session.new, { cwd, mcpServers: [] }),
    prompt: (sessionId: string, text = 'hello') => request(methods.agent.session.prompt, { sessionId, prompt: [{ type: 'text', text }] }),
  }
}
const text = (updates: SessionNotification[], kind = 'agent_message_chunk') => updates.flatMap(({ update }) =>
  (update.sessionUpdate === 'agent_message_chunk' || update.sessionUpdate === 'agent_thought_chunk' || update.sessionUpdate === 'user_message_chunk') && update.sessionUpdate === kind && update.content.type === 'text' ? [update.content.text] : []).join('')

test('ACP initializes without config or storage and streams thinking/text once', { timeout: 8000 }, async t => {
  const env = await setup(t)
  assert.deepEqual(env.configured, [])
  assert.equal(env.initialized.protocolVersion, 1)
  assert.equal(env.initialized.agentCapabilities?.loadSession, true)
  assert.deepEqual(env.initialized.authMethods, [])
  const first = await env.newSession()
  const second = await env.newSession()
  assert.notEqual(first.sessionId, second.sessionId)
  assert.equal(first.modes?.currentModeId, 'build')
  assert.ok(first.configOptions?.some(option => option.id === 'model'))
  env.faux.setResponses([fauxAssistantMessage([fauxThinking('Consider the request carefully.'), fauxText('Hello from the native host.')])])
  assert.equal((await env.prompt(first.sessionId)).stopReason, 'end_turn')
  assert.equal(text(env.updates), 'Hello from the native host.')
  assert.equal(text(env.updates, 'agent_thought_chunk'), 'Consider the request carefully.')
  assert.equal(text(env.updates, 'user_message_chunk'), 'hello')
  assert.deepEqual(env.configured, [env.cwd, env.cwd])
})

test('ACP denies file writes for cancelled, unknown and rejected permission options', { timeout: 8000 }, async t => {
  let selected = 'reject_once'
  const env = await setup(t, { permission: async () => selected === 'cancelled' ? { outcome: { outcome: 'cancelled' } } : { outcome: { outcome: 'selected', optionId: selected } } })
  const { sessionId } = await env.newSession()
  for (const choice of ['reject_once', 'unknown-option', 'cancelled', 'reject_always', 'allow_once']) {
    selected = choice
    env.faux.setResponses([
      fauxAssistantMessage(fauxToolCall('write', { path: 'blocked.txt', content: 'do not write' }), { stopReason: 'toolUse' }),
      fauxAssistantMessage('Permission handled.'),
    ])
    await env.prompt(sessionId)
    await assert.rejects(readFile(join(env.cwd, 'blocked.txt')), { code: 'ENOENT' })
  }
  assert.equal(env.permissions.length, 4, 'reject_always is scoped to this session/tool name')
  assert.ok(env.updates.some(item => item.update.sessionUpdate === 'tool_call_update' && item.update.status === 'failed'))
})

test('ACP tool approval executes and plan guard rejects writes before requesting permission', { timeout: 8000 }, async t => {
  const env = await setup(t)
  const { sessionId } = await env.newSession()
  env.faux.setResponses([fauxAssistantMessage(fauxToolCall('write', { path: 'ok.txt', content: 'approved' }), { stopReason: 'toolUse' }), fauxAssistantMessage('Saved.')])
  await env.prompt(sessionId)
  assert.equal(await readFile(join(env.cwd, 'ok.txt'), 'utf8'), 'approved')
  await env.request(methods.agent.session.setMode, { sessionId, modeId: 'plan' })
  env.faux.setResponses([fauxAssistantMessage(fauxToolCall('write', { path: 'blocked.txt', content: 'blocked' }), { stopReason: 'toolUse' }), fauxAssistantMessage('Still planning.')])
  await env.prompt(sessionId)
  await assert.rejects(readFile(join(env.cwd, 'blocked.txt')), { code: 'ENOENT' })
  assert.equal(env.permissions.length, 1)
})

test('ACP permission wait can be cancelled, busy prompt rejected and other sessions run', { timeout: 8000 }, async t => {
  let permissionStarted!: () => void
  const started = new Promise<void>(resolve => { permissionStarted = resolve })
  const env = await setup(t, { permission: async () => { permissionStarted(); return new Promise(() => {}) } })
  const first = await env.newSession()
  const second = await env.newSession()
  env.faux.setResponses([fauxAssistantMessage(fauxToolCall('write', { path: 'cancelled.txt', content: 'never' }), { stopReason: 'toolUse' })])
  const running = env.prompt(first.sessionId)
  await started
  await assert.rejects(env.prompt(first.sessionId), /busy/)
  env.faux.setResponses([fauxAssistantMessage('Independent session works.')])
  assert.equal((await env.prompt(second.sessionId)).stopReason, 'end_turn')
  await env.connection.agent.notify(methods.agent.session.cancel, { sessionId: first.sessionId })
  assert.equal((await running).stopReason, 'cancelled')
  await assert.rejects(readFile(join(env.cwd, 'cancelled.txt')), { code: 'ENOENT' })
  env.faux.setResponses([fauxAssistantMessage('After cancellation.')])
  assert.equal((await env.prompt(first.sessionId)).stopReason, 'end_turn')
})

test('ACP close releases SQLite lock, load replays history and validates IDs/workspaces', { timeout: 8000 }, async t => {
  const env = await setup(t)
  const { sessionId } = await env.newSession()
  env.faux.setResponses([fauxAssistantMessage('Persisted reply.')])
  await env.prompt(sessionId, 'Persisted question.')
  await env.request(methods.agent.session.close, { sessionId })
  await assert.rejects(env.prompt(sessionId), /not found/i)
  env.updates.length = 0
  const loaded = await env.request(methods.agent.session.load, { sessionId, cwd: env.cwd, mcpServers: [] })
  assert.equal(loaded.modes?.currentModeId, 'build')
  assert.equal(text(env.updates), 'Persisted reply.')
  assert.equal(text(env.updates, 'user_message_chunk'), 'Persisted question.')
  const other = await mkdtemp(join(tmpdir(), 'pie2-acp-other-'))
  t.after(() => rm(other, { recursive: true, force: true }))
  await assert.rejects(env.request(methods.agent.session.load, { sessionId, cwd: other, mcpServers: [] }), /different workspace|not found/i)
  for (const id of ['../session', '/tmp/unsafe.sqlite', '..', 'name.sqlite']) await assert.rejects(env.request(methods.agent.session.load, { sessionId: id, cwd: env.cwd, mcpServers: [] }), /opaque/)
  assert.ok((await env.request(methods.agent.session.list, { cwd: env.cwd })).sessions.some(item => item.sessionId === sessionId))
})

test('ACP exposes model/thinking/mode config and rejects unsupported input and MCP', { timeout: 8000 }, async t => {
  const env = await setup(t)
  const { sessionId } = await env.newSession()
  const changed = await env.request(methods.agent.session.setConfigOption, { sessionId, configId: 'model', value: 'faux/faux-2' })
  assert.ok(changed.configOptions.some(item => item.id === 'model' && item.currentValue === 'faux/faux-2'))
  await env.request(methods.agent.session.setConfigOption, { sessionId, configId: 'thinking', value: 'high' })
  await env.request(methods.agent.session.setConfigOption, { sessionId, configId: 'mode', value: 'plan' })
  await assert.rejects(env.request(methods.agent.session.setMode, { sessionId, modeId: 'anything' }), /Unknown mode/)
  await assert.rejects(env.request(methods.agent.session.setConfigOption, { sessionId, configId: 'thinking', value: 'nonsense' }), /Unknown configuration/)
  await assert.rejects(env.request(methods.agent.session.prompt, { sessionId, prompt: [{ type: 'image', mimeType: 'image/png', data: 'AAAA' }] }), /does not support image/)
  await assert.rejects(env.request(methods.agent.session.prompt, { sessionId, prompt: [{ type: 'audio', mimeType: 'audio/wav', data: 'AAAA' }] }), /Unsupported prompt content/)
  await assert.rejects(env.request(methods.agent.session.new, { cwd: env.cwd, mcpServers: [{ name: 'unsupported', command: 'anything', args: [], env: [] }] }), /MCP/)
  await assert.rejects(env.request('unknown/method', {}), /not found/i)
  env.faux.setResponses([context => {
    assert.ok(JSON.stringify(context.messages).includes('embedded context'))
    return fauxAssistantMessage('Read embedded text.')
  }])
  await env.request(methods.agent.session.prompt, { sessionId, prompt: [{ type: 'resource', resource: { uri: 'file:///test.txt', text: 'embedded context' } }] })
})

test('ACP absent elicitation support never fabricates a question answer or plan approval', { timeout: 8000 }, async t => {
  const env = await setup(t)
  const { sessionId } = await env.newSession()
  await env.request(methods.agent.session.setMode, { sessionId, modeId: 'plan' })
  env.faux.setResponses([
    fauxAssistantMessage(fauxToolCall('exit_plan_mode', { plan: '# Complete plan\nInspect and test.' }), { stopReason: 'toolUse' }),
    fauxAssistantMessage('Awaiting explicit plan approval.'),
  ])
  await env.prompt(sessionId)
  const result = await env.request(methods.agent.session.load, { sessionId, cwd: env.cwd, mcpServers: [] })
  assert.equal(result.modes?.currentModeId, 'plan')
  assert.ok(JSON.stringify(env.updates).includes('does not support elicitation'))
})

test('ACP NDJSON handles malformed messages and initializes without credentials', { timeout: 8000 }, async () => {
  const input = new PassThrough()
  const output = new PassThrough()
  let configureCalls = 0
  const received: Record<string, unknown>[] = []
  let buffer = ''
  output.on('data', chunk => { buffer += chunk.toString(); let index: number; while ((index = buffer.indexOf('\n')) >= 0) { received.push(JSON.parse(buffer.slice(0, index))); buffer = buffer.slice(index + 1) } })
  const server = startAcp({ input, output, configureModels: async () => { configureCalls++; throw new Error('must not read credentials') } })
  input.write('{broken\n')
  input.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1 } }) + '\n')
  await new Promise<void>(resolve => { const onData = () => { if (received.some(item => item.id === 1)) { output.off('data', onData); resolve() } }; output.on('data', onData); onData() })
  input.end()
  await server
  assert.equal(configureCalls, 0)
  assert.ok(received.some(item => (item.error as { code?: number })?.code === -32700))
  assert.ok(received.some(item => item.id === 1 && item.result))
})

test('ACP elicitation forms preserve single/multi/custom answers with stable question IDs', { timeout: 8000 }, async t => {
  let requests = 0
  const env = await setup(t, { capabilities: { elicitation: { form: {} } }, elicitation: async params => {
    requests++
    assert.equal(params.mode, 'form')
    assert.ok('requestedSchema' in params)
    return { action: 'accept', content: { q0: '1', q1: ['0', '1'], q2: 'free response', custom3: 'specific feedback' } }
  } })
  const { sessionId } = await env.newSession()
  env.faux.setResponses([
    fauxAssistantMessage(fauxToolCall('ask_user_question', { questions: [
      { id: 'single', question: 'Choose one', options: [{ label: 'A' }, { label: 'B' }] },
      { id: 'multi', question: 'Choose several', multi_select: true, options: [{ label: 'C' }, { label: 'D' }] },
      { id: 'free', question: 'Write a response' },
      { id: 'custom', question: 'Any alternative?', options: [{ label: 'E' }, { label: 'F' }] },
    ] }), { stopReason: 'toolUse' }),
    context => {
      const result = context.messages.findLast(message => message.role === 'toolResult')
      assert.ok(result?.role === 'toolResult')
      const value = JSON.parse(result.content.flatMap(block => block.type === 'text' ? [block.text] : []).join(''))
      assert.deepEqual(value.answers, [
        { id: 'single', selected: ['B'] }, { id: 'multi', selected: ['C', 'D'] },
        { id: 'free', selected: [], custom: 'free response' }, { id: 'custom', selected: [], custom: 'specific feedback' },
      ])
      return fauxAssistantMessage('Received human answers.')
    },
  ])
  assert.equal((await env.prompt(sessionId)).stopReason, 'end_turn')
  assert.equal(requests, 1)
})

test('ACP concurrent load has one open and explicit busy response; EOF releases active hosts', { timeout: 8000 }, async t => {
  let asking!: () => void
  const asked = new Promise<void>(resolve => { asking = resolve })
  const env = await setup(t, { permission: async () => { asking(); return new Promise(() => {}) } })
  const { sessionId } = await env.newSession()
  await env.request(methods.agent.session.close, { sessionId })
  const loads = await Promise.allSettled([
    env.request(methods.agent.session.load, { sessionId, cwd: env.cwd, mcpServers: [] }),
    env.request(methods.agent.session.load, { sessionId, cwd: env.cwd, mcpServers: [] }),
  ])
  assert.equal(loads.filter(result => result.status === 'fulfilled').length, 1)
  const rejected = loads.find(result => result.status === 'rejected')
  assert.ok(rejected?.status === 'rejected' && /busy/.test(String(rejected.reason)))
  env.faux.setResponses([fauxAssistantMessage(fauxToolCall('write', { path: 'never.txt', content: 'not approved' }), { stopReason: 'toolUse' })])
  const running = env.prompt(sessionId).catch(() => {})
  await asked
  await env.end()
  await running
  const saved = (await listSessions(env.cwd)).find(item => item.id === sessionId)!
  const reopened = await openHost({ cwd: env.cwd, session: saved.path, models: env.models, model: { provider: 'faux', modelId: 'faux-1' } })
  await reopened.close()
  await assert.rejects(readFile(join(env.cwd, 'never.txt')), { code: 'ENOENT' })
})

test('ACP supported images and resource links reach the model with their original types', { timeout: 8000 }, async t => {
  const env = await setup(t)
  const { sessionId } = await env.newSession()
  let inspected = false
  env.faux.setResponses([context => {
    const message = context.messages.findLast(message => message.role === 'user')
    assert.ok(message?.role === 'user' && Array.isArray(message.content))
    assert.ok(message.content.some(block => block.type === 'image' && block.mimeType === 'image/png' && block.data === 'AAAA'))
    assert.ok(message.content.some(block => block.type === 'text' && block.text.includes('https://example.test/docs')))
    inspected = true
    return fauxAssistantMessage('Received image and reference.')
  }])
  const result = await env.request(methods.agent.session.prompt, { sessionId, prompt: [
    { type: 'image', mimeType: 'image/png', data: 'AAAA' },
    { type: 'resource_link', name: 'Docs', uri: 'https://example.test/docs' },
  ] })
  assert.equal(result.stopReason, 'end_turn')
  assert.equal(inspected, true)
})

test('ACP declined plan review stays read-only; explicit form approval updates client mode', { timeout: 8000 }, async t => {
  let approve = false
  const env = await setup(t, { capabilities: { elicitation: { form: {} } }, elicitation: async () => approve
    ? { action: 'accept', content: { q0: '0' } } : { action: 'decline' } })
  const { sessionId } = await env.newSession()
  env.faux.setResponses([
    fauxAssistantMessage(fauxToolCall('enter_plan_mode', {}), { stopReason: 'toolUse' }),
    fauxAssistantMessage(fauxToolCall('exit_plan_mode', { plan: '# Complete plan\nInspect and test.' }), { stopReason: 'toolUse' }),
    fauxAssistantMessage('Remain in planning.'),
  ])
  await env.prompt(sessionId)
  assert.ok(env.updates.some(({ update }) => update.sessionUpdate === 'current_mode_update' && update.currentModeId === 'plan'))
  assert.equal((await env.request(methods.agent.session.load, { sessionId, cwd: env.cwd, mcpServers: [] })).modes?.currentModeId, 'plan')
  approve = true
  env.updates.length = 0
  env.faux.setResponses([
    fauxAssistantMessage(fauxToolCall('exit_plan_mode', { plan: '# Complete plan\nInspect and test.' }), { stopReason: 'toolUse' }),
    fauxAssistantMessage('Approved; ready to build.'),
  ])
  await env.prompt(sessionId)
  assert.ok(env.updates.some(({ update }) => update.sessionUpdate === 'current_mode_update' && update.currentModeId === 'build'))
  assert.ok(env.updates.some(({ update }) => update.sessionUpdate === 'config_option_update' && update.configOptions.some(option => option.id === 'mode' && option.currentValue === 'build')))
})

test('ACP cancellation stops pending elicitation without accepting an answer', { timeout: 8000 }, async t => {
  let asking!: () => void
  const started = new Promise<void>(resolve => { asking = resolve })
  const env = await setup(t, { capabilities: { elicitation: { form: {} } }, elicitation: async () => { asking(); return new Promise(() => {}) } })
  const { sessionId } = await env.newSession()
  env.faux.setResponses([fauxAssistantMessage(fauxToolCall('ask_user_question', { questions: [{ id: 'pending', question: 'Wait for explicit input' }] }), { stopReason: 'toolUse' })])
  const running = env.prompt(sessionId)
  await started
  await env.connection.agent.notify(methods.agent.session.cancel, { sessionId })
  assert.equal((await running).stopReason, 'cancelled')
})

test('ACP nested tools and inherited subagent tools require their own permission', { timeout: 8000 }, async t => {
  const durable = pathToFileURL(resolve('node_modules/@earendil-works/pi-durable/dist/index.js')).href
  const pluginSource = `import { defineExtension, defineTool } from ${JSON.stringify(durable)}
export default () => ({ name: 'nestedFixture', extension: defineExtension({ name: 'nestedFixture', tools: [defineTool({
  name: 'nested_fixture', description: 'Try a nested write.', parameters: { type: 'object', properties: {}, additionalProperties: false },
  execute: async (_args, api, context) => {
    const result = await api.executeTool('write', { path: 'nested-denied.txt', content: 'never' }, context)
    return { output: [{ type: 'text', text: JSON.stringify(result) }], isError: result.isError }
  }
})] }) })`
  const env = await setup(t, { pluginSource, permission: async params => ({ outcome: { outcome: 'selected', optionId: params.toolCall.name === 'write' ? 'reject_once' : 'allow_once' } }) })
  const { sessionId } = await env.newSession()
  env.faux.setResponses([
    fauxAssistantMessage(fauxToolCall('nested_fixture', {}), { stopReason: 'toolUse' }),
    fauxAssistantMessage('Nested write denied.'),
  ])
  await env.prompt(sessionId)
  assert.deepEqual(env.permissions.map(item => item.toolCall.name), ['nested_fixture', 'write'])
  await assert.rejects(readFile(join(env.cwd, 'nested-denied.txt')), { code: 'ENOENT' })
  const toolIds = new Set(env.updates.flatMap(({ update }) => update.sessionUpdate === 'tool_call' ? [update.toolCallId] : []))
  assert.ok(env.permissions.every(permission => toolIds.has(permission.toolCall.toolCallId)))
  env.permissions.length = 0
  env.faux.setResponses([
    fauxAssistantMessage(fauxToolCall('subagent', { description: 'Check inherited permissions', prompt: 'Try a write.', run_in_background: false }), { stopReason: 'toolUse' }),
    fauxAssistantMessage(fauxToolCall('write', { path: 'child-denied.txt', content: 'never' }), { stopReason: 'toolUse' }),
    fauxAssistantMessage('Child write denied.'),
    fauxAssistantMessage('Collected child result.'),
  ])
  await env.prompt(sessionId)
  assert.deepEqual(env.permissions.map(item => item.toolCall.name), ['subagent', 'write'])
  await assert.rejects(readFile(join(env.cwd, 'child-denied.txt')), { code: 'ENOENT' })
})

test('ACP model errors return RPC errors instead of successful end_turn', { timeout: 8000 }, async t => {
  const env = await setup(t)
  const { sessionId } = await env.newSession()
  env.faux.setResponses([fauxAssistantMessage('', { stopReason: 'error', errorMessage: 'Private provider credentials should never appear' })])
  await assert.rejects(env.prompt(sessionId), error => error instanceof Error && !error.message.includes('Private provider') && /did not complete|failed/.test(error.message))
})
