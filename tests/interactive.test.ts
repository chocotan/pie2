import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:http'
import { once } from 'node:events'

const bin = fileURLToPath(new URL('../bin/pie2.mjs', import.meta.url))
const driver = fileURLToPath(new URL('./fixtures/pty-driver.py', import.meta.url))
const pythonAvailable = spawnSync('python3', ['--version']).status === 0
const skip = !pythonAvailable && 'python3 is required for real-terminal tests'
type Step = { send?: string; wait?: string }
type Observations = { code: number; observed: string[]; rawSeen: boolean; restored: boolean }
const command = (value: string) => `\x1b[200~${value}\x1b[201~\r`

async function fixture(t: TestContext, baseUrl = 'http://127.0.0.1:1/v1') {
  const root = await mkdtemp(join(tmpdir(), 'pie2-pty-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const cwd = join(root, 'workspace')
  const home = join(root, 'home')
  const config = join(home, '.pie2')
  await mkdir(join(cwd, '.pie2'), { recursive: true })
  await mkdir(config, { recursive: true })
  await writeFile(join(cwd, '.pie2', 'config.json'), JSON.stringify({
    defaultProvider: 'local', defaultModel: 'model-a', defaultThinkingLevel: 'off',
    providers: {
      local: {
        baseUrl, api: 'openai-completions', apiKey: 'test',
        models: ['model-a', 'model-b'].map(id => ({ id, name: id, reasoning: true, contextWindow: 32000, maxTokens: 2000 })),
      },
    },
  }))
  const env = {
    HOME: home, PATH: process.env.PATH, PIE2_CONFIG_DIR: config,
    TERM: 'xterm-256color', LANG: 'C.UTF-8', NODE_NO_WARNINGS: '1',
  }
  async function interact(steps: Step[], args: string[] = []) {
    const result = await new Promise<{ code: number | null; output: string; errors: string }>((resolveResult, reject) => {
      const child = spawn('python3', [driver], {
        cwd, env, signal: t.signal, timeout: 12_000, killSignal: 'SIGTERM', stdio: ['pipe', 'pipe', 'pipe'],
      })
      let output = ''
      let errors = ''
      child.stdout.setEncoding('utf8').on('data', chunk => { output += chunk })
      child.stderr.setEncoding('utf8').on('data', chunk => { errors += chunk })
      child.on('error', reject)
      child.on('close', code => resolveResult({ code, output, errors }))
      child.stdin.on('error', error => { if ((error as NodeJS.ErrnoException).code !== 'EPIPE') reject(error) })
      child.stdin.end(JSON.stringify({ argv: [process.execPath, bin, ...args], cwd, steps }))
    })
    assert.equal(result.code, 0, result.errors)
    const observations = JSON.parse(result.output) as Observations
    assert.equal(observations.code, 0)
    assert.equal(observations.rawSeen, true)
    assert.equal(observations.restored, true)
    assert.deepEqual(observations.observed, steps.flatMap(step => step.wait === undefined ? [] : [step.wait]))
  }
  async function sessions() {
    const root = join(config, 'sessions')
    const workspaces = await readdir(root, { withFileTypes: true })
    const entries = await Promise.all(workspaces.filter(entry => entry.isDirectory()).map(async entry => {
      const directory = join(root, entry.name)
      return (await readdir(directory)).filter(file => file.endsWith('.sqlite')).map(file => join(directory, file))
    }))
    return entries.flat().sort()
  }
  return { interact, sessions }
}

test('real terminal supports slash commands, filtered model/thinking pickers and keyboard shortcuts', { skip, timeout: 20_000 }, async t => {
  const { interact } = await fixture(t)
  await interact([
    { wait: 'local/model-a · thinking off · ready' },
    { send: '/', wait: '显示帮助' },
    { send: 'model', wait: '切换模型' },
    { send: '\r', wait: '选择模型' },
    { send: 'model-b', wait: 'Search: model-b' },
    { send: '\r', wait: 'local/model-b · thinking off · ready' },
    { send: command('/thinking high'), wait: 'local/model-b · thinking high · ready' },
    { send: command('/thinking'), wait: '选择 Thinking Level' },
    { send: 'low', wait: 'Search: low' },
    { send: '\r', wait: 'local/model-b · thinking low · ready' },
    { send: '\x10', wait: 'local/model-a · thinking low · ready' },
    { send: '\x1b[Z', wait: 'local/model-a · thinking medium · ready' },
    { send: command('/exit') },
  ])
})

test('real terminal exposes the activity panel and routes input back to the composer', { skip, timeout: 10_000 }, async t => {
  const { interact } = await fixture(t)
  await interact([
    { wait: 'Todo 0 · Goal — · Agents 0 · Jobs 0' },
    { send: '\x14', wait: 'Jobs: no background jobs' },
    { send: '\x1b', wait: '▸ Todo 0' },
    { send: command('/goal'), wait: 'No goal.' },
    { send: '\x14', wait: 'Goal: no goal' },
    { send: command('/exit') },
  ])
})

test('real terminal answers model questions and explicitly approves a complete plan', { skip, timeout: 10_000 }, async t => {
  const requests: { messages: { role: string; content?: unknown }[] }[] = []
  const server = createServer(async (request, response) => {
    let body = ''
    for await (const chunk of request) body += chunk
    const input = JSON.parse(body)
    const index = requests.push(input) - 1
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    const tool = index === 0 ? { name: 'ask_user_question', arguments: { questions: [{ id: 'mode', header: 'Choose implementation', question: 'Which implementation should I use?', options: [{ label: 'Fast' }, { label: 'Thorough' }] }] } }
      : index === 2 ? { name: 'exit_plan_mode', arguments: { plan: '# Local implementation plan\n\nInspect the module, make the scoped change, then run its tests.' } } : undefined
    const delta = tool ? { role: 'assistant', tool_calls: [{ index: 0, id: `call-${index}`, type: 'function', function: { name: tool.name, arguments: JSON.stringify(tool.arguments) } }] }
      : { role: 'assistant', content: index === 1 ? 'Choice recorded.' : 'Plan review accepted.' }
    const chunk = (value: object, finish: string | null) => JSON.stringify({ id: 'local-questions', object: 'chat.completion.chunk', created: 1,
      model: 'model-a', choices: [{ index: 0, delta: value, finish_reason: finish }] })
    response.write(`data: ${chunk(delta, null)}\n\n`)
    response.write(`data: ${chunk({}, tool ? 'tool_calls' : 'stop')}\n\n`)
    response.end('data: [DONE]\n\n')
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()) }))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const { interact } = await fixture(t, `http://127.0.0.1:${address.port}/v1`)
  await interact([
    { wait: 'local/model-a · thinking off · ready' },
    { send: command('Ask me to choose an implementation'), wait: 'Which implementation should I use?' },
    { send: '\x1b[B\r', wait: 'Choice recorded.' },
    { send: command('/plan on'), wait: 'Plan mode on' },
    { send: command('Prepare the implementation plan'), wait: 'Approve this complete plan' },
    { send: '\r', wait: 'Plan review accepted.' },
    { send: command('/plan'), wait: 'Plan mode off' },
    { send: command('/exit') },
  ])
  assert.equal(requests.length, 4)
  const choice = requests[1]!.messages.find(message => message.role === 'tool')
  assert.ok(JSON.stringify(choice).includes('Thorough'))
  assert.ok(requests[2]!.messages.some(message => ['system', 'developer'].includes(message.role) && JSON.stringify(message.content).includes('<plan_policy>')))
})

test('real terminal starts fresh by default and --resume restores the selected older session', { skip, timeout: 20_000 }, async t => {
  const { interact, sessions } = await fixture(t)
  await interact([
    { wait: 'local/model-a · thinking off · ready' },
    { send: command('/model local/model-b'), wait: 'local/model-b · thinking off · ready' },
    { send: command('/thinking high'), wait: 'local/model-b · thinking high · ready' },
    { send: command('/exit') },
  ])
  const first = await sessions()
  assert.equal(first.length, 1)
  await interact([
    { wait: 'local/model-a · thinking off · ready' },
    { send: command('/exit') },
  ])
  const fresh = await sessions()
  assert.equal(fresh.length, 2, 'a second launch must create another database')
  assert.ok(fresh.includes(first[0]!))
  const id = basename(first[0]!, '.sqlite')
  await interact([
    { wait: '恢复会话' },
    { send: id, wait: `Search: ${id}` },
    { send: '\r', wait: 'local/model-b · thinking high · ready' },
    { send: command('/exit') },
  ], ['--resume'])
  assert.deepEqual(await sessions(), fresh, 'resuming must reuse the selected database')
})
