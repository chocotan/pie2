import assert from 'node:assert/strict'
import { stripVTControlCharacters } from 'node:util'
import { test } from 'node:test'
import { BACKGROUND_CONTEXT as context, withAbortSignal } from '@earendil-works/chord/context'
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import { createModels } from '@earendil-works/pi-ai/models'
import { createStatusBarPlugin } from '../src/plugins/statusbar.ts'
import type { Message } from '@earendil-works/pi-ai'
import type { AgentEvent, EntryRecord, SnapshotEvent, TaskId } from '@earendil-works/pi-durable'
import { Container, Input, Loader, ScrollView, visibleWidth, type Component, type Terminal, type TuiMouseEvent } from '@earendil-works/pi-tui'
import type { ActivityOverview, StatusBar } from '../src/plugin.ts'
import { TerminalUI, ToolRow } from '../src/tui.ts'

test('short transcript anchors above the composer instead of under the header', async t => {
  const env = setup()
  t.after(() => env.ui.stop())
  env.ui.showEvent({ type: 'entry_appended', entry: entry(1, { role: 'user', content: '第一句话', timestamp: 0 }) })
  const lines = screen(env.ui)
  const content = lines.findIndex(line => line.includes('第一句话'))
  const editor = lines.findIndex(line => line.includes('pie2>'))
  assert.ok(content > 10, `transcript should sit near the composer, got line ${content} of ${lines.length}`)
  assert.equal(editor - content, 2)
  assert.equal(lines[1]!.trim(), '')
})

test('thinking renders separately above the answer, including streamed deltas', async t => {
  const env = setup()
  t.after(() => env.ui.stop())
  const message = fauxAssistantMessage('')
  message.content = [{ type: 'thinking', thinking: '' }, { type: 'text', text: '' }]
  env.ui.showEvent({ type: 'message_start', message })
  env.ui.showEvent(update([
    { type: 'thinking_delta', contentIndex: 0, delta: '先分析输入' },
    { type: 'text_delta', contentIndex: 1, delta: '答案是 42' },
  ]))
  const lines = env.ui.tui.render(100).map(line => stripVTControlCharacters(line))
  const thinking = lines.findIndex(line => line.includes('先分析输入'))
  const answer = lines.findIndex(line => line.includes('答案是 42'))
  assert.ok(thinking >= 0)
  assert.ok(answer >= 0)
  assert.ok(thinking < answer)
  assert.ok(lines.findIndex(line => line.includes('▾ Thinking')) < thinking)
  assert.ok(env.ui.tui.render(100).some(line => line.includes('\x1b[2m') && line.includes('先分析输入')))
})

test('chat history scrolls with a persistent scrollbar and preserves manual reading position', t => {
  const { ui, terminal } = setup()
  t.after(() => ui.stop())
  const transcript = components(ui.tui).find(component => component instanceof ScrollView && component.primary) as ScrollView
  for (let i = 1; i <= 70; i++) ui.showEvent({ type: 'message_end', entry: entry(i, fauxAssistantMessage(`history-${i}`)) })
  assert.ok(screen(ui).some(line => line.includes('history-70')))
  assert.equal(transcript.scrollbar, 'always')
  assert.equal(transcript.isScrollbarVisible, true)
  assert.ok(transcript.scrollTop > 0)
  const before = transcript.scrollTop
  terminal.input('\x1b[5~')
  screen(ui)
  assert.ok(transcript.scrollTop < before)
  const reading = transcript.scrollTop
  ui.showEvent({ type: 'message_end', entry: entry(71, fauxAssistantMessage('new message while reading')) })
  screen(ui)
  assert.equal(transcript.scrollTop, reading)
  assert.equal(transcript.isFollowingEnd, false)
  ui.tui.scrollToBottom()
  assert.ok(screen(ui).some(line => line.includes('new message while reading')))
  assert.equal(transcript.isFollowingEnd, true)
  terminal.columns = 30
  terminal.rows = 16
  terminal.resize()
  const resized = screen(ui)
  assert.equal(resized.length, 16)
  assert.ok(resized.some(line => line.includes('pie2>')))
  assert.ok(resized.every(line => visibleWidth(line) <= 30))
})

test('completed and restored thinking collapses with preview and expands by click or Ctrl+O', t => {
  const { ui, terminal } = setup()
  t.after(() => ui.stop())
  const message = fauxAssistantMessage('')
  message.content = [{ type: 'thinking', thinking: 'First private step\nLast thinking preview' }, { type: 'text', text: 'Final answer' }]
  ui.showEvent({ type: 'message_start', message })
  assert.match(text(ui), /First private step/)
  ui.showEvent({ type: 'message_end', entry: entry(1, message) })
  assert.doesNotMatch(text(ui), /First private step/)
  assert.match(text(ui), /▸ Thinking · Last thinking preview/)
  terminal.input('\x0f')
  assert.match(text(ui), /First private step/)
  terminal.input('\x0f')
  assert.doesNotMatch(text(ui), /First private step/)
  const row = screen(ui).findIndex(line => line.includes('▸ Thinking'))
  assert.ok(row >= 0)
  terminal.input(`\x1b[<0;2;${row + 1}M`)
  terminal.input(`\x1b[<0;2;${row + 1}m`)
  assert.match(text(ui), /First private step/)
  ui.showSnapshot(snapshot([entry(1, message)]))
  assert.doesNotMatch(text(ui), /First private step/)
  assert.match(text(ui), /▸ Thinking · Last thinking preview/)
  const state = snapshot()
  state.run = { inputs: [] }
  state.generation = { attempt: 1, message }
  ui.showSnapshot(state)
  assert.match(text(ui), /First private step/)
  assert.match(text(ui), /▾ Thinking/)
})

test('thinking redactions never expose opaque payloads and user images retain their placeholder', t => {
  const { ui, terminal } = setup()
  t.after(() => ui.stop())
  const message = fauxAssistantMessage('Answer')
  message.content.unshift({ type: 'thinking', thinking: 'opaque payload', thinkingSignature: 'secret signature', redacted: true })
  ui.showSnapshot(snapshot([
    entry(1, { role: 'user', content: [{ type: 'image', data: 'private base64', mimeType: 'image/png' }], timestamp: 0 }),
    entry(2, message),
  ]))
  terminal.input('\x0f')
  assert.match(text(ui), /Thinking was not exposed by the provider/)
  assert.match(text(ui), /\[image\]/)
  assert.doesNotMatch(text(ui), /opaque payload|secret signature|private base64/)
})

function activityBar(state: ActivityOverview): StatusBar {
  return { render: () => ['model · thinking high · ready'], snapshot() {}, update() {}, setModel() {}, activity: () => state }
}

test('activity summary is always discoverable and Ctrl+T opens scrollable details without losing a draft', async t => {
  const state = { summary: 'Todo 1/2 · Goal active 2/5 · Agents 1/3 · Jobs 1/4', lines: Array.from({ length: 45 }, (_, i) => `activity-row-${i}`) }
  const env = setup({ statusBar: activityBar(state) })
  const { ui, terminal } = env
  t.after(() => ui.stop())
  ui.editor.setText('unsent draft')
  assert.match(text(ui), /▸ Todo 1\/2.*Agents 1\/3.*Jobs 1\/4/)
  assert.doesNotMatch(text(ui), /activity-row-/)
  terminal.input('\x14')
  const first = screen(ui)
  assert.ok(first.some(line => line.includes('▾ Todo')))
  assert.ok(first.some(line => line.includes('activity-row-0')))
  assert.ok(!first.some(line => line.includes('activity-row-12')))
  assert.equal(ui.editor.getText(), 'unsent draft')
  assert.equal(ui.editor.focused, false)
  const details = components(ui.tui).find(component => component instanceof ScrollView && !component.primary) as ScrollView
  const transcript = components(ui.tui).find(component => component instanceof ScrollView && component.primary) as ScrollView
  const outer = transcript.scrollTop
  terminal.input('\x1b[6~')
  assert.equal(details.scrollTop, details.viewportHeight)
  terminal.input('\x1b[F')
  assert.ok(screen(ui).some(line => line.includes('activity-row-44')))
  assert.equal(transcript.scrollTop, outer)
  terminal.input('\x1b')
  await flush()
  assert.doesNotMatch(text(ui), /activity-row-/)
  assert.equal(ui.editor.focused, true)
  assert.equal(ui.editor.getText(), 'unsent draft')
  assert.equal(env.interrupts, 0)
})

test('activity panel supports mouse opening and contains wheels at both edges while history stays still', t => {
  const state = { summary: 'Todo 0 · Goal — · Agents 1 · Jobs 1', lines: Array.from({ length: 30 }, (_, i) => `activity-item-${i}`) }
  const { ui, terminal } = setup({ statusBar: activityBar(state) })
  t.after(() => ui.stop())
  for (let i = 1; i <= 70; i++) ui.showEvent({ type: 'message_end', entry: entry(i, fauxAssistantMessage(`history-${i}`)) })
  const heading = screen(ui).findIndex(line => line.includes('▸ Todo'))
  terminal.input(`\x1b[<0;2;${heading + 1}M`)
  terminal.input(`\x1b[<0;2;${heading + 1}m`)
  const body = screen(ui).findIndex(line => line.includes('activity-item-0'))
  assert.ok(body >= 0)
  const details = components(ui.tui).find(component => component instanceof ScrollView && !component.primary) as ScrollView
  const transcript = components(ui.tui).find(component => component instanceof ScrollView && component.primary) as ScrollView
  const outer = transcript.scrollTop
  for (const edge of ['top', 'bottom']) {
    if (edge === 'top') details.scrollToStart()
    else details.scrollToEnd()
    screen(ui)
    const offset = details.scrollTop
    terminal.input(`\x1b[<${edge === 'top' ? 64 : 65};3;${body + 1}M`)
    assert.equal(details.scrollTop, offset)
    assert.equal(transcript.scrollTop, outer)
  }
  terminal.input(`\x1b[<0;3;${body + 1}M`)
  terminal.input(`\x1b[<0;3;${body + 1}m`)
  assert.equal(ui.editor.focused, false)
  terminal.input('x')
  assert.equal(ui.editor.focused, true)
  assert.equal(ui.editor.getText(), 'x')
})

test('expanded activity adapts to small terminal heights without covering the composer', t => {
  const state = { summary: 'Todo 0 · Goal — · Agents 1 · Jobs 1', lines: Array.from({ length: 40 }, (_, i) => `任务-${i}`) }
  const { ui, terminal } = setup({ statusBar: activityBar(state) })
  t.after(() => ui.stop())
  terminal.input('\x14')
  ui.showEvent({ type: 'run_start', inputs: [] })
  for (const rows of [40, 20, 12, 8]) {
    terminal.rows = rows
    terminal.columns = 36
    terminal.resize()
    const lines = screen(ui)
    assert.equal(lines.length, rows)
    assert.ok(lines.some(line => line.includes('pie2>')), `composer hidden at height ${rows}`)
    assert.ok(lines.every(line => visibleWidth(line) <= 36))
  }
})

test('human questions support single choice, multiple choice and freeform answers while retaining the draft', async t => {
  const { ui, terminal } = setup()
  t.after(() => ui.stop())
  ui.editor.setText('draft waiting for the agent')
  const one = ui.askUser([{ id: 'mode', header: 'Choose mode', question: 'Which implementation?', options: [{ label: 'Fast' }, { label: 'Thorough' }] }], context)
  assert.match(text(ui), /Choose mode.*1\/1/)
  terminal.input('\x1b[B')
  terminal.input('\r')
  assert.deepEqual(await one, [{ id: 'mode', selected: ['Thorough'] }])
  assert.equal(ui.editor.getText(), 'draft waiting for the agent')
  const alternative = ui.askUser([{ id: 'alternative', question: 'Choose or explain another option', options: [{ label: 'A' }, { label: 'B' }] }], context)
  terminal.input('\x1b[B')
  terminal.input('\x1b[B')
  terminal.input('\r')
  terminal.input('Use a different design')
  terminal.input('\r')
  assert.deepEqual(await alternative, [{ id: 'alternative', selected: [], custom: 'Use a different design' }])
  const many = ui.askUser([{ id: 'checks', question: 'Which checks?', multiSelect: true, options: [{ label: 'Types' }, { label: 'Tests' }, { label: 'Lint' }] }], context)
  terminal.input(' ')
  terminal.input('\x1b[B')
  terminal.input(' ')
  assert.match(text(ui), /\[x\] Types/)
  assert.match(text(ui), /\[x\] Tests/)
  terminal.input('\x1b[B')
  terminal.input('\x1b[B')
  terminal.input('\r')
  assert.deepEqual(await many, [{ id: 'checks', selected: ['Types', 'Tests'] }])
  const custom = ui.askUser([{ id: 'details', question: 'Any constraints?' }], context)
  terminal.input('Keep the API stable')
  terminal.input('\r')
  assert.deepEqual(await custom, [{ id: 'details', selected: [], custom: 'Keep the API stable' }])
  assert.equal(ui.editor.focused, true)
  assert.equal(ui.editor.getText(), 'draft waiting for the agent')
})

test('question dismissal, tool cancellation and shutdown never become answers or approval', async t => {
  const env = setup()
  t.after(() => env.ui.stop())
  const question = [{ id: 'approval', question: 'Approve?', options: [{ label: 'Approve' }, { label: 'Reject' }] }]
  const cancelled = assert.rejects(env.ui.askUser(question, context), /no answer or approval/)
  env.terminal.input('\x1b')
  await cancelled
  assert.equal(env.interrupts, 0)
  const controller = new AbortController()
  const aborted = assert.rejects(env.ui.askUser(question, withAbortSignal(controller.signal, context)), /no answer or approval/)
  controller.abort()
  await aborted
  assert.equal(env.ui.editor.focused, true)
  const closed = assert.rejects(env.ui.askUser(question, context), /no answer or approval/)
  env.ui.close()
  await closed
})

test('complete plans stay readable in a bounded question viewport with keyboard paging and resize', async t => {
  const { ui, terminal } = setup()
  t.after(() => ui.stop())
  ui.showEvent({ type: 'run_start', inputs: [] })
  const answer = ui.askUser([{ id: 'plan', header: 'Plan review',
    question: '# Full implementation plan\n\n' + Array.from({ length: 80 }, (_, i) => `- Implementation step ${i}`).join('\n'),
    options: [{ label: 'Approve' }, { label: 'Keep planning' }],
  }], context)
  screen(ui)
  const pane = components(ui.tui).find(component => component instanceof ScrollView && !component.primary) as ScrollView
  const before = pane.scrollTop
  terminal.input('\x1b[6~')
  assert.ok(pane.scrollTop > before)
  for (const rows of [30, 12, 8]) {
    terminal.rows = rows
    terminal.columns = 38
    terminal.resize()
    const lines = screen(ui)
    assert.equal(lines.length, rows)
    assert.ok(lines.some(line => line.includes('Approve')))
    assert.ok(lines.every(line => visibleWidth(line) <= 38))
  }
  terminal.input('\r')
  assert.deepEqual(await answer, [{ id: 'plan', selected: ['Approve'] }])
})

test('restored session status keeps the context anchor after UI initialization', async t => {
  const models = createModels()
  models.setProvider(fauxProvider().provider)
  const model = models.getModel('faux', 'faux-1')!
  const plugin = await createStatusBarPlugin({ cwd: '/tmp', session: '/tmp/session-12345678.sqlite', models })
  const { ui } = setup({ statusBar: plugin.statusBar })
  t.after(() => ui.stop())
  const message = fauxAssistantMessage('恢复的回答')
  message.provider = 'faux'
  message.model = 'faux-1'
  message.usage.input = Math.floor(model.contextWindow / 4)
  const state = snapshot([entry(1, message)])
  state.agent = { model: { provider: 'faux', modelId: 'faux-1' }, thinkingLevel: 'high' }
  state.usage.models['faux/faux-1'] = message.usage
  ui.showSnapshot(state)
  assert.match(text(ui, 140), /~25% ctx/)
  assert.match(text(ui, 140), /#12345678/)
  ui.showEvent({ type: 'usage_changed', usage: state.usage })
  assert.match(text(ui, 140), /~25% ctx/)
})

class FakeTerminal implements Terminal {
  columns = 100
  rows = 40
  starts = 0
  stops = 0
  writes: string[] = []
  input: (data: string) => void = () => {}
  resize: () => void = () => {}
  start(onInput: (data: string) => void, onResize: () => void) { this.starts++; this.input = onInput; this.resize = onResize }
  stop() { this.stops++ }
  write(data: string) { this.writes.push(data) }
  moveBy() {}
  hideCursor() {}
  showCursor() {}
  clearLine() {}
  clearFromCursor() {}
  clearScreen() {}
  drainInput() { return Promise.resolve() }
  kittyProtocolActive = false
  setTitle() {}
  setProgress() {}
  setProgramStatus() {}
}

function setup(options: Partial<ConstructorParameters<typeof TerminalUI>[0]> = {}) {
  const terminal = new FakeTerminal()
  const submitted: string[] = []
  let interrupts = 0
  let models = 0
  let thinking = 0
  const ui = new TerminalUI({
    cwd: '/tmp/项目', terminal,
    commands: [
      { name: 'model', description: 'Select model' }, { name: 'thinking', description: 'Thinking level' },
      { name: 'tasks', description: 'Tasks' }, { name: 'skill:research', description: 'Research skill' },
    ],
    onSubmit: async text => { submitted.push(text) },
    onInterrupt: async () => { interrupts++ }, onCycleModel: async () => { models++ }, onCycleThinking: async () => { thinking++ },
    ...options,
  })
  ui.start()
  return { ui, terminal, submitted, get interrupts() { return interrupts }, get models() { return models }, get thinking() { return thinking } }
}
const flush = () => new Promise<void>(resolve => setImmediate(resolve))
function screen(ui: TerminalUI): string[] {
  ui.tui.renderNow(true)
  return ui.tui.getScreenLines().map(line => stripVTControlCharacters(line))
}
const text = (ui: TerminalUI, width = 100) => stripVTControlCharacters(ui.tui.render(width).join('\n'))
function components(root: Component): Component[] {
  return [root, ...(root instanceof Container ? root.children.flatMap(components) : [])]
}
const entry = (id: number, message: Message): EntryRecord => ({ id: id as EntryRecord['id'], conversationId: 1 as EntryRecord['conversationId'], kind: `pi.${message.role}`, model: [message] })
const update = (changes: Extract<AgentEvent, { type: 'message_update' }>['changes']): AgentEvent => ({ type: 'message_update', usage: fauxAssistantMessage('').usage, changes })
const snapshot = (entries: EntryRecord[] = []): SnapshotEvent => ({ type: 'snapshot', entries, tools: [], nestedTools: [], compactions: [], inbox: [], agent: {}, usage: { models: {}, tools: {} } })

test('slash menu includes supplied commands and Escape closes it before interrupting', async t => {
  const env = setup()
  t.after(() => env.ui.stop())
  env.terminal.input('/')
  await flush()
  assert.equal(env.ui.editor.isShowingAutocomplete(), true)
  const menu = text(env.ui)
  assert.match(menu, /model\s+Select model/)
  assert.match(menu, /thinking\s+Thinking level/)
  assert.match(menu, /skill:research/)
  env.terminal.input('\x1b')
  await flush()
  assert.equal(env.ui.editor.isShowingAutocomplete(), false)
  assert.equal(env.interrupts, 0)
  env.terminal.input('\x1b')
  await flush()
  assert.equal(env.interrupts, 1)
})

test('submit clears the editor, preserves history, and handles errors inside the UI', async t => {
  const env = setup()
  t.after(() => env.ui.stop())
  env.terminal.input('你好 world')
  env.terminal.input('\r')
  await flush()
  assert.deepEqual(env.submitted, ['你好 world'])
  assert.equal(env.ui.editor.getText(), '')
  env.terminal.input('\x1b[A')
  assert.equal(env.ui.editor.getText(), '你好 world')
  const failed = setup({ onSubmit: async () => { throw new Error('request failed') } })
  t.after(() => failed.ui.stop())
  failed.terminal.input('test')
  failed.terminal.input('\r')
  await flush()
  assert.match(text(failed.ui), /request failed/)
})

test('picker filters by label, description, and model ID, forwards IME focus, selects and cancels', async t => {
  const { ui, terminal } = setup()
  t.after(() => ui.stop())
  const items = [
    { value: 'jkl/gpt-6', label: 'GPT 六', description: 'Deep reasoning' },
    { value: 'company/fast', label: '快速模型', description: '低延迟' },
  ]
  const selected = ui.select('Models', items, 'company/fast')
  assert.equal(ui.editor.focused, false)
  const search = components(ui.tui).find(component => component instanceof Input) as Input
  assert.ok(search)
  assert.equal(search.focused, true)
  terminal.input('gpt reasoning')
  assert.doesNotMatch(text(ui), /快速模型/)
  assert.match(text(ui), /GPT 六/)
  terminal.input('\r')
  assert.equal(await selected, 'jkl/gpt-6')
  assert.equal(ui.editor.focused, true)
  assert.equal(search.focused, false)
  const cancelled = ui.select('Thinking', items)
  terminal.input('nothing-matches')
  terminal.input('\r')
  terminal.input('\x1b')
  assert.equal(await cancelled, undefined)
  const ctrlCancelled = ui.select('Models', items)
  terminal.input('\x03')
  assert.equal(await ctrlCancelled, undefined)
})

test('model and thinking shortcuts invoke callbacks and status reflects changes', async t => {
  const env = setup()
  t.after(() => env.ui.stop())
  env.terminal.input('\x10')
  env.terminal.input('\x1b[Z')
  await flush()
  assert.equal(env.models, 1)
  assert.equal(env.thinking, 1)
  env.ui.setStatus('jkl/gpt-6', 'high')
  assert.match(text(env.ui), /jkl\/gpt-6 · thinking high · ready/)
  env.ui.showEvent({ type: 'run_start', inputs: [] })
  assert.match(text(env.ui), /working/)
  env.ui.showEvent({ type: 'run_end', inputs: [] })
  assert.match(text(env.ui), /ready/)
  env.terminal.input('\x03')
  await flush()
  assert.equal(env.interrupts, 1)
  assert.equal(env.terminal.stops, 0)
})

test('streamed deltas and whole-message replacements update one assistant message', t => {
  const { ui } = setup()
  t.after(() => ui.stop())
  const partial = fauxAssistantMessage('Hello')
  ui.showEvent({ type: 'message_start', message: partial })
  ui.showEvent(update([{ type: 'text_delta', contentIndex: 0, delta: ' world' }]))
  assert.match(text(ui), /Hello world/)
  assert.equal(partial.content[0]?.type === 'text' && partial.content[0].text, 'Hello')
  ui.showEvent(update([{ type: 'message', message: fauxAssistantMessage('Replaced') }]))
  ui.showEvent(update([{ type: 'block', contentIndex: 0, block: { type: 'text', text: '最终回答' } }]))
  const committed = entry(2, fauxAssistantMessage('最终回答'))
  ui.showEvent({ type: 'message_end', entry: committed })
  ui.showEvent({ type: 'message_end', entry: committed })
  assert.equal(text(ui).split('最终回答').length - 1, 1)
  assert.doesNotMatch(text(ui), /Assistant/)
  assert.doesNotMatch(text(ui), /Hello|Replaced/)
})

test('snapshot replaces history, restores agent status, live text, and running tools', t => {
  const { ui } = setup()
  t.after(() => ui.stop())
  ui.notify('obsolete')
  const state = snapshot([entry(1, { role: 'user', content: '恢复中文历史', timestamp: 0 })])
  state.agent = { model: { provider: 'jkl', modelId: 'gpt-6' }, thinkingLevel: 'high' }
  state.run = { inputs: [] }
  state.generation = { attempt: 1, message: fauxAssistantMessage('正在生成') }
  state.tools = [{ callId: 'shell', name: 'bash', status: 'running', output: 'live tool output' }]
  ui.showSnapshot(state)
  assert.doesNotMatch(text(ui), /obsolete/)
  assert.match(text(ui), /恢复中文历史/)
  assert.match(text(ui), /正在生成/)
  assert.match(text(ui), /jkl\/gpt-6 · thinking high/)
  assert.match(text(ui), /bash.*进行中/)
  ui.showSnapshot(state)
  assert.equal(text(ui).split('恢复中文历史').length - 1, 1)
  const failedTool = entry(3, { role: 'toolResult', toolCallId: 'failed', toolName: 'bash', content: [{ type: 'text', text: 'Bad command' }], isError: true, timestamp: 0 })
  state.entries = [...state.entries, failedTool]
  state.tools = [{ callId: 'failed', name: 'bash', status: 'done', entry: failedTool.id }]
  ui.showSnapshot(state)
  assert.match(text(ui), /bash.*失败/)
  const row = components(ui.tui).find(component => component instanceof ToolRow) as ToolRow
  row.expanded = true
  assert.match(text(ui), /Bad command/)
})

test('Chinese, markdown code, tool rows and selectors fit narrow terminal widths', async t => {
  const { ui, terminal } = setup()
  t.after(() => ui.stop())
  ui.setStatus('公司/中文模型名称特别长', 'high')
  ui.showEvent({ type: 'message_end', entry: entry(1, fauxAssistantMessage('中文段落测试。\n\n```ts\nconst value = "很长的中文代码内容"\n```')) })
  ui.showEvent({ type: 'tool_execution_start', toolCallId: 'x', toolName: 'Skill', args: { name: '中文技能' } })
  for (const width of [12, 20, 40]) {
    terminal.columns = width
    for (const line of ui.tui.render(width)) assert.ok(visibleWidth(line) <= width, `${visibleWidth(line)} > ${width}`)
  }
  const selection = ui.select('选择模型', [{ value: 'cn', label: '中文模型' }])
  for (const width of [12, 20]) for (const line of ui.tui.render(width)) assert.ok(visibleWidth(line) <= width)
  terminal.input('\x1b')
  await selection
})

test('close resolves selectors; stop is idempotent and removes the active loader', async () => {
  const { ui, terminal } = setup()
  ui.start()
  assert.equal(terminal.starts, 1)
  ui.showEvent({ type: 'run_start', inputs: [] })
  const loader = components(ui.tui).find(component => component instanceof Loader) as Loader
  assert.ok(loader)
  const selection = ui.select('Models', [{ value: 'one', label: 'One' }])
  ui.close()
  assert.equal(await selection, undefined)
  await ui.closed
  assert.equal(terminal.stops, 0, 'close leaves terminal restoration to stop')
  ui.stop()
  ui.stop()
  assert.equal(terminal.stops, 1)
  assert.equal(components(ui.tui).some(component => component instanceof Loader), false)
  assert.equal((loader as unknown as { intervalId: unknown }).intervalId, null)
  assert.equal(await ui.select('Already closed', []), undefined)
})

test('Ctrl+D exits only with empty editor and /exit and /quit close without submission', async () => {
  for (const command of ['/exit', '/quit', '']) {
    const env = setup()
    try {
      if (command) env.ui.editor.onSubmit!(command)
      else {
        env.terminal.input('draft')
        env.terminal.input('\x04')
        assert.equal(env.terminal.stops, 0)
        env.ui.editor.setText('')
        env.terminal.input('\x04')
      }
      await env.ui.closed
      assert.deepEqual(env.submitted, [])
    } finally { env.ui.stop() }
  }
})

test('background launch shows one Job title with its receipt ID and restores it from history', t => {
  const { ui } = setup()
  t.after(() => ui.stop())
  const args = { command: 'npm test', description: '运行测试', run_in_background: true }
  const call = entry(1, fauxAssistantMessage(fauxToolCall('bash', args, { id: 'launch' })))
  ui.showEvent({ type: 'message_end', entry: call })
  ui.showEvent({ type: 'tool_execution_start', toolCallId: 'launch', toolName: 'bash', args })
  assert.match(text(ui), /Job · 运行测试.*启动中/)
  ui.showEvent({ type: 'tool_execution_start', toolCallId: 'launch/background', parentToolCallId: 'launch', toolName: 'job_start', args })
  ui.showEvent({ type: 'tool_execution_end', toolCallId: 'launch/background', parentToolCallId: 'launch', toolName: 'job_start',
    result: { taskId: 2 as TaskId, structuredOutput: { kind: 'background', jobId: '42' }, isError: false, diagnostics: [] } })
  const receipt = entry(2, { role: 'toolResult', toolCallId: 'launch', toolName: 'bash',
    content: [{ type: 'text', text: JSON.stringify({ kind: 'background', jobId: '42' }) }], isError: false, timestamp: 0 })
  ui.showEvent({ type: 'tool_execution_end', toolCallId: 'launch', toolName: 'bash', entry: receipt })
  ui.showEvent({ type: 'message_end', entry: receipt })
  assert.match(text(ui), /Job #42 · 运行测试.*已启动/)
  assert.doesNotMatch(text(ui), /job_start|▸ bash/)
  assert.equal(components(ui.tui).filter(component => component instanceof ToolRow).length, 1)
  const state = snapshot([call, receipt])
  state.nestedTools = [{ callId: 'launch/background', parentCallId: 'launch', name: 'job_start',
    taskId: 2 as TaskId, parentTaskId: 1 as TaskId, arguments: args, status: 'done', summary: { isError: false } }]
  ui.showSnapshot(state)
  assert.match(text(ui), /Job #42 · 运行测试.*已启动/)
  assert.equal(components(ui.tui).filter(component => component instanceof ToolRow).length, 1)
})

test('Job controls show their operation and ID while foreground Bash keeps its own title', () => {
  for (const [name, args, title] of [
    ['job_output', { job_id: '42' }, 'Job #42 · 日志'],
    ['job_kill', { job_id: '42' }, 'Job #42 · 停止'],
    ['job_list', {}, 'Jobs · 列表'],
  ] as const) {
    const row = new ToolRow(name, () => {})
    row.start(args)
    assert.ok(stripVTControlCharacters(row.render(100)[0]!).includes(title))
  }
  const foreground = new ToolRow('bash', () => {})
  foreground.start({ command: 'echo test', description: '前台命令', run_in_background: false })
  foreground.finish(JSON.stringify({ kind: 'background', jobId: '999' }), 'done')
  assert.match(foreground.render(100)[0]!, /bash · 前台命令.*完成/)
  assert.doesNotMatch(foreground.render(100)[0]!, /Job|#999|已启动/)
  const failed = new ToolRow('bash', () => {})
  failed.start({ command: 'npm test', run_in_background: true })
  failed.finish('Job limit reached', 'failed')
  assert.match(failed.render(100)[0]!, /Job · npm test.*失败/)
  assert.doesNotMatch(failed.render(100)[0]!, /已启动|#undefined/)
})

test('background results become expandable status rows rather than user messages', t => {
  const { ui, terminal } = setup()
  t.after(() => ui.stop())
  const report: EntryRecord = {
    ...entry(90, { role: 'user', content: 'Background result: the child finished successfully.', timestamp: 0 }),
    kind: 'pie2.background-result', data: { source: 'subagent', id: 7, description: '检查认证模块', status: 'completed' },
  }
  ui.showEvent({ type: 'entry_appended', entry: report })
  ui.showEvent({ type: 'message_end', entry: report })
  assert.equal(components(ui.tui).filter(component => component instanceof ToolRow).length, 1)
  assert.match(text(ui), /Agent · 后台：检查认证模块.*完成/)
  assert.doesNotMatch(text(ui), /Background result|You/)
  terminal.input('\x0f')
  assert.match(text(ui), /Background result: the child finished successfully/)
  const stopped: EntryRecord = {
    ...entry(91, { role: 'user', content: 'Job was interrupted.', timestamp: 0 }),
    kind: 'pie2.background-result', data: { source: 'job', id: 8, description: 'build', status: 'interrupted' },
  }
  ui.showEvent({ type: 'entry_appended', entry: stopped })
  assert.match(text(ui), /Job #8 · 后台：build.*已中断/)
})

const click: TuiMouseEvent = { type: 'click', button: 'left', x: 1, y: 0, screenX: 1, screenY: 0, width: 100, height: 1, shift: false, alt: false, ctrl: false, clickCount: 1 }

test('tool and Skill rows show description and status, click expands bounded details', () => {
  let renders = 0
  const row = new ToolRow('Skill', () => { renders++ })
  row.start({ name: 'research', apiKey: 'hidden-key', headers: { Authorization: 'hidden-header' } })
  assert.match(row.render(100)[0]!, /Skill · research.*进行中/)
  row.finish('Loaded skill instructions\n' + 'x\n'.repeat(300), 'done', 120)
  assert.equal(row.render(100).length, 1)
  assert.match(row.render(100)[0]!, /完成 120ms/)
  assert.equal(row.handleMouse(click)?.handled, true)
  const expanded = stripVTControlCharacters(row.render(100).join('\n'))
  assert.match(expanded, /Loaded skill instructions/)
  assert.equal(row.render(100).length, 11)
  assert.doesNotMatch(expanded, /output truncated|hidden-key|hidden-header/)
  assert.match(expanded, /redacted/)
  assert.equal(renders, 1)
  row.detailsView.scrollToEnd()
  assert.match(stripVTControlCharacters(row.render(100).join('\n')), /output truncated/)
  row.handleMouse(click)
  assert.equal(row.render(100).length, 1)
  row.finish('bad command', 'failed')
  assert.match(stripVTControlCharacters(row.render(100)[0]!), /失败/)
  row.finish('cancelled', 'aborted')
  assert.match(row.render(100)[0]!, /已中断/)
})

test('tool events retain one expandable row, mark failures and aborts, and Ctrl+O toggles details', async t => {
  const { ui, terminal } = setup()
  t.after(() => ui.stop())
  ui.showEvent({ type: 'tool_execution_start', toolCallId: 'shell', toolName: 'bash', args: { command: 'rg README' } })
  ui.showEvent({ type: 'tool_execution_update', toolCallId: 'shell', toolName: 'bash', output: { append: 'first chunk' } })
  ui.showEvent({ type: 'tool_execution_update', toolCallId: 'shell', toolName: 'bash', output: { trimStart: 6, append: '\nnext chunk' }, details: { exitCode: 1 } })
  const result = entry(3, { role: 'toolResult', toolCallId: 'shell', toolName: 'bash', content: [{ type: 'text', text: 'No matches found' }], isError: true, timestamp: 0 })
  ui.showEvent({ type: 'tool_execution_end', toolCallId: 'shell', toolName: 'bash', entry: result })
  ui.showEvent({ type: 'message_start', message: result.model![0]! })
  ui.showEvent({ type: 'message_end', entry: result })
  assert.equal(components(ui.tui).filter(component => component instanceof ToolRow).length, 1)
  assert.doesNotMatch(text(ui), /No matches found/)
  assert.match(text(ui), /bash · rg README.*失败/)
  terminal.input('\x0f')
  await flush()
  assert.match(text(ui), /No matches found/)
  assert.match(text(ui), /exitCode/)
  terminal.input('\x0f')
  assert.doesNotMatch(text(ui), /No matches found/)
  ui.showEvent({ type: 'tool_execution_start', toolCallId: 'abort', toolName: 'bash', args: {} })
  ui.showEvent({ type: 'tool_execution_end', toolCallId: 'abort', toolName: 'bash' })
  assert.match(text(ui), /已中断/)
})

test('native alternate-screen mouse dispatch expands tool rows and stop restores terminal', t => {
  const { ui, terminal } = setup()
  t.after(() => ui.stop())
  ui.showEvent({ type: 'tool_execution_start', toolCallId: 'skill', toolName: 'Skill', args: { name: 'research' } })
  ui.showEvent({ type: 'tool_execution_update', toolCallId: 'skill', toolName: 'Skill', output: { set: 'Skill detail content' } })
  ui.tui.renderNow(true)
  const row = ui.tui.getScreenLines().findIndex(line => stripVTControlCharacters(line).includes('▸ Skill'))
  assert.ok(row >= 0, 'tool row should be visible in the viewport')
  terminal.input(`\x1b[<0;2;${row + 1}M`)
  terminal.input(`\x1b[<0;2;${row + 1}m`)
  ui.tui.renderNow(true)
  assert.match(text(ui), /Skill detail content/)
  ui.stop()
  const ansi = terminal.writes.join('')
  assert.match(ansi, /\x1b\[\?1049h/)
  assert.match(ansi, /\x1b\[\?1049l/)
})

test('expanded details cap wrapped screen rows and clamp their offset after output or width changes', () => {
  const row = new ToolRow('bash', () => {})
  row.finish('wrapped output '.repeat(120), 'done')
  row.expanded = true
  assert.equal(row.render(20).length, 11)
  assert.equal(row.detailsView.viewportHeight, 10)
  row.handleInput('\x1b[F')
  const narrowOffset = row.detailsView.scrollTop
  assert.ok(narrowOffset > 10)
  const wideLines = row.render(100)
  assert.equal(wideLines.length, 11)
  assert.ok(row.detailsView.scrollTop < narrowOffset, 'widening clamps the old wrapped offset')
  assert.ok(wideLines.slice(1).some(line => stripVTControlCharacters(line).trim()))
  row.finish('short replacement', 'done')
  assert.equal(row.render(100).length, 2)
  assert.equal(row.detailsView.scrollTop, 0)
  assert.equal(row.detailsView.viewportHeight, 1)
  assert.match(row.render(100).join('\n'), /short replacement/)
  row.finish(Array.from({ length: 40 }, (_, i) => `line-${i}`).join('\n'), 'done')
  row.render(100)
  assert.equal(row.detailsView.viewportHeight, 10)
  row.handleInput('\x1b[F')
  assert.ok(row.detailsView.scrollTop > 0)
  row.expanded = false
  row.expanded = true
  assert.equal(row.detailsView.scrollTop, 0)
  assert.match(row.render(100)[1]!, /line-0/)
})

test('native detail body focus supports arrows, paging, Home/End, Escape and typing back in the editor', async t => {
  const env = setup()
  const { ui, terminal } = env
  t.after(() => ui.stop())
  ui.showEvent({ type: 'tool_execution_start', toolCallId: 'scroll', toolName: 'bash', args: {} })
  ui.showEvent({ type: 'tool_execution_update', toolCallId: 'scroll', toolName: 'bash', output: { set: Array.from({ length: 50 }, (_, i) => `detail-${i}`).join('\n') } })
  const row = components(ui.tui).find(component => component instanceof ToolRow) as ToolRow
  terminal.input('\x0f')
  ui.tui.renderNow(true)
  assert.equal(row.detailsView.viewportHeight, 10)
  const focusBody = () => {
    ui.tui.renderNow(true)
    const heading = ui.tui.getScreenLines().findIndex(line => stripVTControlCharacters(line).includes('▾ bash'))
    assert.ok(heading >= 0)
    terminal.input(`\x1b[<0;3;${heading + 2}M`)
    terminal.input(`\x1b[<0;3;${heading + 2}m`)
    assert.equal(row.focused, true)
    assert.equal(ui.editor.focused, false)
  }
  focusBody()
  terminal.input('\x1b[B')
  assert.equal(row.detailsView.scrollTop, 1)
  terminal.input('\x1b[A')
  assert.equal(row.detailsView.scrollTop, 0)
  row.handleInput('\x1b[6~')
  assert.equal(row.detailsView.scrollTop, 10)
  row.handleInput('\x1b[5~')
  assert.equal(row.detailsView.scrollTop, 0)
  terminal.input('\x1b[F')
  assert.equal(row.detailsView.scrollTop, 40)
  terminal.input('\x1b[B')
  assert.equal(row.detailsView.scrollTop, 40)
  terminal.input('\x1b[H')
  assert.equal(row.detailsView.scrollTop, 0)
  terminal.input('\x1b')
  await flush()
  assert.equal(ui.editor.focused, true)
  assert.equal(row.focused, false)
  assert.equal(env.interrupts, 0)
  focusBody()
  terminal.input('/')
  await flush()
  assert.equal(ui.editor.focused, true)
  assert.equal(ui.editor.getText(), '/')
  assert.equal(ui.editor.isShowingAutocomplete(), true)
  terminal.input('\x1b')
  ui.editor.setText('')
  focusBody()
  terminal.input('draft')
  assert.equal(ui.editor.focused, true)
  assert.equal(ui.editor.getText(), 'draft')
  focusBody()
  terminal.input('\x0f')
  assert.equal(row.expanded, false)
  assert.equal(row.detailsView.scrollTop, 0)
  assert.equal(ui.editor.focused, true)
  assert.equal(env.interrupts, 0)
})

test('native PageUp and PageDown target focused details instead of the outer transcript', t => {
  const { ui, terminal } = setup()
  t.after(() => ui.stop())
  ui.showEvent({ type: 'tool_execution_start', toolCallId: 'paging', toolName: 'bash', args: {} })
  ui.showEvent({ type: 'tool_execution_update', toolCallId: 'paging', toolName: 'bash', output: { set: 'detail\n'.repeat(50) } })
  const row = components(ui.tui).find(component => component instanceof ToolRow) as ToolRow
  const transcript = components(ui.tui).find(component => component instanceof ScrollView && component.primary) as ScrollView
  terminal.input('\x0f')
  ui.tui.renderNow(true)
  ui.tui.setFocus(row)
  const outerOffset = transcript.scrollTop
  terminal.input('\x1b[6~')
  assert.equal(row.detailsView.scrollTop, 10)
  assert.equal(transcript.scrollTop, outerOffset)
  terminal.input('\x1b[5~')
  assert.equal(row.detailsView.scrollTop, 0)
  assert.equal(transcript.scrollTop, outerOffset)
})

for (const edge of ['top', 'bottom'] as const) {
  test(`native SGR wheels scroll only tool details and contain overscroll at the ${edge}`, t => {
    const { ui, terminal } = setup()
    t.after(() => ui.stop())
    for (let i = 1; i <= 70; i++) ui.showEvent({ type: 'message_end', entry: entry(i, fauxAssistantMessage(`history-${i}`)) })
    ui.showEvent({ type: 'tool_execution_start', toolCallId: 'scroll', toolName: 'bash', args: {} })
    ui.showEvent({ type: 'tool_execution_update', toolCallId: 'scroll', toolName: 'bash', output: { set: Array.from({ length: 50 }, (_, i) => `detail-${i}`).join('\n') } })
    const row = components(ui.tui).find(component => component instanceof ToolRow) as ToolRow
    const transcript = components(ui.tui).find(component => component instanceof ScrollView && component.primary) as ScrollView
    terminal.input('\x0f')
    ui.tui.renderNow(true)
    transcript.scrollBy(-3)
    ui.tui.renderNow(true)
    const heading = ui.tui.getScreenLines().findIndex(line => stripVTControlCharacters(line).includes('▾ bash'))
    assert.ok(heading >= 0 && heading + 2 < terminal.rows)
    const outerOffset = transcript.scrollTop
    assert.ok(outerOffset > 0)
    terminal.input(`\x1b[<65;3;${heading + 2}M`)
    assert.ok(row.detailsView.scrollTop > 0, 'wheel inside the details must move its native ScrollView')
    assert.equal(transcript.scrollTop, outerOffset)
    if (edge === 'top') row.detailsView.scrollToStart()
    else row.detailsView.scrollToEnd()
    ui.tui.renderNow(true)
    const detailOffset = row.detailsView.scrollTop
    terminal.input(`\x1b[<${edge === 'top' ? 64 : 65};3;${heading + 2}M`)
    assert.equal(row.detailsView.scrollTop, detailOffset)
    assert.equal(transcript.scrollTop, outerOffset, `overscroll at the ${edge} must not move transcript history`)
  })
}

test('consecutive assistant text is compact and tool-only turns leave no empty message rows', t => {
  const { ui } = setup()
  t.after(() => ui.stop())
  ui.showEvent({ type: 'message_end', entry: entry(1, { role: 'user', content: 'Question', timestamp: 0 }) })
  ui.showEvent({ type: 'message_start', message: fauxAssistantMessage('First response') })
  ui.showEvent({ type: 'message_end', entry: entry(2, fauxAssistantMessage('First response')) })
  const call = fauxAssistantMessage(fauxToolCall('bash', { command: 'pwd' }, { id: 'compact' }))
  ui.showEvent({ type: 'message_start', message: call })
  ui.showEvent({ type: 'message_end', entry: entry(3, call) })
  ui.showEvent({ type: 'tool_execution_start', toolCallId: 'compact', toolName: 'bash', args: { command: 'pwd' } })
  ui.showEvent({ type: 'message_end', entry: entry(4, fauxAssistantMessage('Second response')) })
  const lines = ui.tui.render(100).map(line => stripVTControlCharacters(line).trim())
  const start = lines.indexOf('You')
  const end = lines.indexOf('Second response')
  assert.ok(start >= 0 && end > start)
  assert.deepEqual(lines.slice(start, end + 1), ['You', 'Question', 'First response', '▸ bash · pwd  [进行中]', 'Second response'])
  assert.doesNotMatch(lines.join('\n'), /Assistant/)
})

test('layout adapts to light/dark terminals without hardcoded background fills and preserves responsive bottom panel', async t => {
  const state = { summary: 'Todo 1/2 · Goal active 2/5 · Agents 0 · Jobs 0', lines: ['Todo [completed] Layout', 'Todo [in_progress] Tools'] }
  const { ui, terminal } = setup({ statusBar: activityBar(state) })
  t.after(() => ui.stop())
  ui.setStatus('anthropic/claude-sonnet-4-5', 'high')

  // Empty state shows centered quick-start canvas and top activity strip with active preview
  const emptyLines = screen(ui)
  assert.ok(emptyLines.some(line => line.includes('/plan on') && line.includes('read-only planning mode')))
  assert.ok(emptyLines.some(line => line.includes('/agents') && line.includes('inspect & manage subagents')))
  const activityLine = emptyLines.find(line => line.includes('Todo 1/2'))!
  assert.ok(activityLine.includes('Todo: Tools'))
  assert.ok(activityLine.trimEnd().endsWith('Ctrl+T'))
  for (const raw of ui.tui.render(100)) assert.doesNotMatch(raw, /\x1b\[(?:38|48);2;|\x1b\[48;5;/)

  // At 80 columns, footer shortcuts fit cleanly without mid-word truncation
  terminal.columns = 80
  terminal.rows = 24
  terminal.resize()
  const narrow80 = screen(ui)
  const hintLine = narrow80.at(-1)!
  assert.match(hintLine, /\/ commands/)
  assert.match(hintLine, /Ctrl\+D exit/)
  assert.doesNotMatch(hintLine, /interr$|deta$/)

  // Typing a message dismisses the launch canvas and switches hints cleanly when picker opens
  ui.showEvent({ type: 'entry_appended', entry: entry(1, { role: 'user', content: 'Hello', timestamp: 0 }) })
  assert.doesNotMatch(text(ui), /read-only planning mode/)
  const picking = ui.select('Models', [{ value: 'a/b', label: 'Model B', description: 'Fast' }])
  assert.match(screen(ui).at(-1)!, /↑↓ select.*Esc cancel/)
  terminal.input('\x1b')
  await picking
})

test('tool rows show concise per-tool summaries, structured diff/todo/grep details, and preserve status badges', t => {
  const { ui } = setup()
  t.after(() => ui.stop())
  ui.showEvent({ type: 'tool_execution_start', toolCallId: 'r1', toolName: 'read', args: { path: 'src/tui.ts', offset: 10, limit: 50 } })
  ui.showEvent({ type: 'tool_execution_end', toolCallId: 'r1', toolName: 'read',
    entry: entry(1, { role: 'toolResult', toolCallId: 'r1', toolName: 'read', content: [{ type: 'text', text: 'const x = 1' }], isError: false, timestamp: 0 }),
    result: { taskId: 1 as TaskId, isError: false, diagnostics: [], durationMs: 12 } })
  ui.showEvent({ type: 'tool_execution_start', toolCallId: 'e1', toolName: 'edit', args: { path: 'src/tui.ts', edits: [{ oldText: 'a', newText: 'b' }] } })
  ui.showEvent({ type: 'tool_execution_end', toolCallId: 'e1', toolName: 'edit',
    entry: entry(2, { role: 'toolResult', toolCallId: 'e1', toolName: 'edit', content: [{ type: 'text', text: 'Updated src/tui.ts' }], isError: false, timestamp: 0 }),
    result: { taskId: 2 as TaskId, isError: false, diagnostics: [], durationMs: 25, details: { diff: '- 1 oldLine\n+ 1 newLine\n+ 2 extraLine' } } })
  ui.showEvent({ type: 'tool_execution_start', toolCallId: 'td1', toolName: 'todo_write',
    args: { todos: [{ content: 'Layout', status: 'completed' }, { content: 'Bottom panel', status: 'in_progress' }] } })
  ui.showEvent({ type: 'tool_execution_end', toolCallId: 'td1', toolName: 'todo_write',
    result: { taskId: 3 as TaskId, isError: false, diagnostics: [], durationMs: 4 } })
  ui.showEvent({ type: 'tool_execution_start', toolCallId: 'long1', toolName: 'bash', args: { command: `echo ${'x'.repeat(120)}` } })
  ui.showEvent({ type: 'tool_execution_end', toolCallId: 'long1', toolName: 'bash',
    entry: entry(4, { role: 'toolResult', toolCallId: 'long1', toolName: 'bash', content: [{ type: 'text', text: 'ok' }], isError: false, timestamp: 0 }),
    result: { taskId: 4 as TaskId, isError: false, diagnostics: [], durationMs: 99 } })

  const collapsed = text(ui, 80)
  assert.match(collapsed, /read · src\/tui\.ts \(L10-59\)  \[完成 12ms\]/)
  assert.match(collapsed, /edit · src\/tui\.ts \(\+2 -1\)  \[完成 25ms\]/)
  assert.match(collapsed, /todo · 1\/2 done · Bottom panel  \[完成 4ms\]/)
  assert.match(collapsed, /bash · echo x+…  \[完成 99ms\]/)

  for (const row of components(ui.tui).filter((c): c is ToolRow => c instanceof ToolRow)) row.expanded = true
  const expanded = text(ui, 100)
  assert.match(expanded, /│ const x = 1/)
  assert.doesNotMatch(expanded, /"diff":/)
  assert.match(expanded, /│ \+ 1 newLine/)
  assert.match(expanded, /│ ✓ Layout/)
  assert.match(expanded, /│ ▸ Bottom panel/)
  assert.match(expanded, /│ \$ echo/)
  assert.match(expanded, /│ x+/)
})

test('Working sits directly below the conversation, top strip surfaces live agent previews, and inspector preserves draft', async t => {
  const state: ActivityOverview = {
    summary: 'Todo 0 · Goal — · Agents 1/2 active · Jobs 0',
    lines: [
      'Todo: no tasks',
      'Goal: no goal',
      'Agent #7 [running] queued 0 · inspect parser module',
      'Agent #4 [completed] queued 0 · run unit tests',
      'Jobs: no background jobs',
    ],
  }
  let inspectAll = 0
  const inspectedIds: number[] = []
  const { ui, terminal } = setup({
    statusBar: activityBar(state),
    onInspectAgents: async () => { inspectAll++ },
    onInspectAgent: async id => { inspectedIds.push(id) },
  })
  t.after(() => ui.stop())

  ui.showEvent({ type: 'entry_appended', entry: entry(1, { role: 'user', content: 'Check progress', timestamp: 0 }) })
  ui.showEvent({ type: 'run_start', inputs: [] })

  const busyLines = screen(ui)
  const headerIdx = busyLines.findIndex(line => line.includes('pie2 ·'))
  const activityIdx = busyLines.findIndex(line => line.includes('Agents 1/2 active'))
  const transcriptIdx = busyLines.findIndex(line => line.includes('Check progress'))
  const workingIdx = busyLines.findIndex(line => line.includes('Working…'))
  const editorIdx = busyLines.findIndex(line => line.includes('pie2>'))

  assert.equal(activityIdx, headerIdx + 1, 'activity bar should dock at top under header')
  assert.ok(busyLines[activityIdx]!.includes('#7 inspect parser module'), 'collapsed bar should preview running agent beyond bare counts')
  assert.ok(busyLines[activityIdx]!.includes('/agents'), 'collapsed bar should advertise clickable /agents action')
  assert.equal(workingIdx, transcriptIdx + 1, 'Working… must sit directly below the conversation')
  assert.ok(activityIdx < transcriptIdx && workingIdx < editorIdx, 'no activity bar between Working… and composer')
  assert.equal(busyLines.join('\n').match(/Esc\s+interrupt/g)?.length, 1, 'the interrupt shortcut should appear only in the footer')

  // Clicking '/agents' triggers onInspectAgents; clicking an Agent row inside expanded Activity opens that agent
  const rawHeading = busyLines[activityIdx]!
  const clickCol = rawHeading.indexOf('/agents') + 2
  terminal.input(`\x1b[<0;${clickCol};${activityIdx + 1}M`)
  terminal.input(`\x1b[<0;${clickCol};${activityIdx + 1}m`)
  await flush()
  assert.equal(inspectAll, 1)

  terminal.input('\x14') // Ctrl+T expands top activity drawer
  const expandedLines = screen(ui)
  const agentRow = expandedLines.findIndex(line => line.includes('Agent #7 [running]'))
  assert.ok(agentRow > activityIdx)
  terminal.input(`\x1b[<0;5;${agentRow + 1}M`)
  terminal.input(`\x1b[<0;5;${agentRow + 1}m`)
  await flush()
  assert.deepEqual(inspectedIds, [7])

  terminal.input('\x09') // Tab while expanded opens agent selector
  await flush()
  assert.equal(inspectAll, 2)
  terminal.input('\x1b')

  // Scrollable inspector & inline prompt preserve composer draft and work seamlessly
  ui.editor.setText('keep this draft')
  const actionPromise = ui.inspect({
    title: 'Agent #7',
    badge: '[running]',
    content: Array.from({ length: 30 }, (_, i) => `Turn line ${i}`).join('\n\n'),
    actions: [{ key: 'r', label: 'Refresh' }, { key: 'x', label: 'Stop' }],
  })
  const inspectText = text(ui)
  assert.match(inspectText, /Agent #7.*\[running\]/)
  assert.match(inspectText, /\[r\] Refresh.*\[x\] Stop/)
  assert.equal(ui.editor.getText(), 'keep this draft')
  terminal.input('\x1b[6~') // PgDn scrolls inspector
  terminal.input('r')
  assert.equal(await actionPromise, 'r')

  const promptPromise = ui.prompt('Send message to Agent #7', 'Type instruction…')
  assert.match(text(ui), /Send message to Agent #7/)
  terminal.input('focus on tests')
  terminal.input('\r')
  assert.equal(await promptPromise, 'focus on tests')
  assert.equal(ui.editor.focused, true)
  assert.equal(ui.editor.getText(), 'keep this draft')
})
