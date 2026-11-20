import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { createServer, type IncomingHttpHeaders } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { fileURLToPath } from 'node:url'

const bin = fileURLToPath(new URL('../bin/pie2.mjs', import.meta.url))
const durableModule = import.meta.resolve('@earendil-works/pi-durable')

async function workspace(t: TestContext) {
  const cwd = await mkdtemp(join(tmpdir(), 'pie2-cli-'))
  t.after(() => rm(cwd, { recursive: true, force: true }))
  return cwd
}

function cli(t: TestContext, cwd: string, args: string[], input = '') {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolveResult, reject) => {
    const child = spawn(process.execPath, [bin, ...args], {
      cwd, signal: t.signal, timeout: 7_000, killSignal: 'SIGKILL',
      env: { HOME: cwd, PATH: process.env.PATH, NODE_NO_WARNINGS: '1', PIE2_API_KEY: 'test' },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk })
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk })
    child.on('error', reject)
    child.on('close', code => resolveResult({ code, stdout, stderr }))
    child.stdin.on('error', error => { if ((error as NodeJS.ErrnoException).code !== 'EPIPE') reject(error) })
    child.stdin.end(input)
  })
}

type Request = { method: string | undefined; url: string | undefined; headers: IncomingHttpHeaders; body: Record<string, any> }

async function modelServer(t: TestContext, failure = false) {
  const requests: Request[] = []
  const server = createServer(async (request, response) => {
    try {
      let body = ''
      for await (const chunk of request) body += chunk
      requests.push({ method: request.method, url: request.url, headers: request.headers, body: JSON.parse(body) })
      if (failure) {
        response.writeHead(400, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: { message: 'Mock model rejected this request', type: 'invalid_request_error' } }))
        return
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      const chunk = (delta: object, finish_reason: string | null) => ({
        id: 'chatcmpl-pie2-test', object: 'chat.completion.chunk', created: 1, model: 'test',
        choices: [{ index: 0, delta, finish_reason }],
      })
      response.write(`data: ${JSON.stringify(chunk({ role: 'assistant', content: 'Mock answer.' }, null))}\n\n`)
      response.write(`data: ${JSON.stringify(chunk({}, 'stop'))}\n\n`)
      response.end('data: [DONE]\n\n')
    } catch (error) {
      response.writeHead(500)
      response.end(String(error))
    }
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => new Promise<void>((resolveClose, reject) => {
    server.closeAllConnections()
    server.close(error => error ? reject(error) : resolveClose())
  }))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  return { url: `http://127.0.0.1:${address.port}/v1`, requests }
}

function modelArgs(cwd: string, url: string) {
  return ['--base-url', url, '--provider', 'local', '--model', 'test', '--session', join(cwd, 'session.sqlite')]
}

test('install subcommand bypasses invalid config and ACP rejects incompatible CLI modes without creating sessions', { timeout: 10_000 }, async t => {
  const cwd = await workspace(t)
  await mkdir(join(cwd, '.pie2'))
  await writeFile(join(cwd, '.pie2', 'config.json'), 'broken config')
  const help = await cli(t, cwd, ['install', '--help'])
  assert.equal(help.code, 0, help.stderr)
  assert.match(help.stdout, /Usage: pie2 install/)
  const invalidInstall = await cli(t, cwd, ['install', '--unknown'])
  assert.notEqual(invalidInstall.code, 0)
  assert.match(invalidInstall.stderr, /Unknown install option/)
  for (const args of [['--acp', '-p', 'prompt'], ['acp', '--json'], ['acp', '--resume'], ['--acp', '--session', ''], ['acp', 'extra prompt']]) {
    const result = await cli(t, cwd, args)
    assert.notEqual(result.code, 0)
    assert.match(result.stderr, /ACP mode accepts protocol requests/)
    assert.equal(result.stdout, '')
  }
  assert.deepEqual(await readdir(join(cwd, '.pie2')), ['config.json'])
})

test('CLI makes a complete local OpenAI-compatible request and prints the final answer', { timeout: 10_000 }, async t => {
  const cwd = await workspace(t)
  const server = await modelServer(t)
  const result = await cli(t, cwd, [...modelArgs(cwd, server.url), '-p', 'Say hello from the CLI'])
  assert.equal(result.code, 0, result.stderr)
  assert.equal(result.stdout, 'Mock answer.\n')
  assert.equal(server.requests.length, 1)
  const request = server.requests[0]!
  assert.equal(request.method, 'POST')
  assert.equal(request.url, '/v1/chat/completions')
  assert.equal(request.headers.authorization, 'Bearer test')
  assert.equal(request.body.model, 'test')
  assert.equal(request.body.stream, true)
  assert.ok(request.body.messages.some((message: any) => message.role === 'user' && JSON.stringify(message.content).includes('Say hello from the CLI')))
  const tools = request.body.tools.map((tool: any) => tool.function.name)
  for (const name of ['create_goal', 'get_goal', 'update_goal', 'todo_write', 'subagent', 'job_list', 'job_output', 'job_kill', 'Skill',
    'read_image', 'glob', 'grep', 'ask_user_question', 'enter_plan_mode', 'exit_plan_mode', 'web_search', 'workflow', 'ralph']) assert.ok(tools.includes(name), `${name} is offered to the model`)
  for (const name of ['GoalSet', 'TaskCreate', 'Agent', 'AgentStatus', 'job_status', 'job_start']) assert.ok(!tools.includes(name), `${name} is not a public DSH tool`)
})

test('CLI reads stdin and emits parseable JSON events containing the assistant answer', { timeout: 10_000 }, async t => {
  const cwd = await workspace(t)
  const server = await modelServer(t)
  const result = await cli(t, cwd, [...modelArgs(cwd, server.url), '--json'], '  Request from stdin\n')
  assert.equal(result.code, 0, result.stderr)
  const events = result.stdout.trim().split('\n').map(line => JSON.parse(line))
  assert.ok(events.length > 1)
  const answer = events.find(event => event.type === 'message_end' && event.entry.kind === 'pi.assistant')
  assert.ok(answer, result.stdout)
  assert.equal(answer.entry.model[0].content.find((part: any) => part.type === 'text').text, 'Mock answer.')
  assert.equal(server.requests.length, 1)
  assert.ok(server.requests[0]!.body.messages.some((message: any) => message.role === 'user' && JSON.stringify(message.content).includes('Request from stdin')))
})

test('CLI returns nonzero and reports model errors', { timeout: 10_000 }, async t => {
  const cwd = await workspace(t)
  const server = await modelServer(t, true)
  const result = await cli(t, cwd, [...modelArgs(cwd, server.url), '-p', 'Fail this request'])
  assert.equal(result.code, 1, result.stderr)
  assert.match(result.stderr, /Mock model rejected this request/)
  assert.equal(server.requests.length, 1)
  assert.equal(result.stdout, '')
})

test('help and invalid input do not create a session or persistent home directory', { timeout: 10_000 }, async t => {
  const cwd = await workspace(t)
  const session = join(cwd, 'persistent', 'session.sqlite')
  const help = await cli(t, cwd, ['--help', '--session', session])
  assert.equal(help.code, 0, help.stderr)
  assert.match(help.stdout, /Usage: pie2/)
  assert.deepEqual(await readdir(cwd), [])
  const missing = await cli(t, cwd, ['--session', session])
  assert.equal(missing.code, 1)
  assert.match(missing.stderr, /Supply a prompt/)
  assert.deepEqual(await readdir(cwd), [])
  const invalid = await cli(t, cwd, ['--unknown-option'])
  assert.equal(invalid.code, 1)
  assert.match(invalid.stderr, /unknown-option/)
  assert.deepEqual(await readdir(cwd), [])
})

test('CLI handles interruption signals without closing storage under an active wait', { timeout: 10_000 }, async t => {
  const cwd = await workspace(t)
  for (const [signal, expectedCode] of [['SIGINT', 130], ['SIGTERM', 143]] as const) {
    let started!: () => void
    const ready = new Promise<void>(resolveReady => { started = resolveReady })
    const server = createServer(async (request, response) => {
      for await (const _chunk of request) { /* consume the request before signalling readiness */ }
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write('data: {"id":"waiting","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}\n\n')
      started()
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    t.after(() => { server.closeAllConnections(); server.close() })
    const address = server.address()
    assert.ok(address && typeof address !== 'string')
    const child = spawn(process.execPath, [bin, '--provider', 'local', '--model', 'test', '--base-url', `http://127.0.0.1:${address.port}/v1`, '--session', join(cwd, `${signal}.sqlite`), '-p', 'Wait for interruption'], {
      cwd, signal: t.signal, timeout: 7_000, killSignal: 'SIGKILL',
      env: { HOME: cwd, PATH: process.env.PATH, NODE_NO_WARNINGS: '1', PIE2_API_KEY: 'test' }, stdio: ['ignore', 'pipe', 'pipe'],
    })
    let errors = ''
    child.stderr.setEncoding('utf8').on('data', chunk => { errors += chunk })
    child.stdout.resume()
    const exited = once(child, 'close')
    await ready
    child.kill(signal)
    const [code] = await exited
    assert.equal(code, expectedCode, errors)
    assert.doesNotMatch(errors, /closed|SessionFailed/)
    server.closeAllConnections()
    await new Promise<void>(resolveClose => server.close(() => resolveClose()))
  }
})

test('CLI starts with one config.json without model flags', { timeout: 10_000 }, async t => {
  const cwd = await workspace(t)
  const server = await modelServer(t)
  const dir = join(cwd, '.pie2')
  await mkdir(dir)
  await writeFile(join(dir, 'config.json'), JSON.stringify({
    defaultProvider: 'configured', defaultModel: 'configured-model', defaultThinkingLevel: 'off',
    providers: {
      configured: { baseUrl: server.url, api: 'openai-completions', apiKey: 'configuration-key', headers: { 'X-Configured': 'yes' }, models: [{ id: 'configured-model', name: 'Configured Model', contextWindow: 32000, maxTokens: 2000 }] },
    },
  }))
  const result = await cli(t, cwd, ['--session', join(cwd, 'session.sqlite'), '-p', 'Use the configured model'])
  assert.equal(result.code, 0, result.stderr)
  assert.equal(result.stdout, 'Mock answer.\n')
  assert.equal(server.requests[0]!.body.model, 'configured-model')
  assert.equal(server.requests[0]!.headers.authorization, 'Bearer configuration-key')
  assert.equal(server.requests[0]!.headers['x-configured'], 'yes')
  assert.doesNotMatch(result.stdout + result.stderr, /configuration-key/)
})

test('list-models lists metadata without credentials, stdin EOF, or opening SQLite', { timeout: 10_000 }, async t => {
  const cwd = await workspace(t)
  const dir = join(cwd, '.pie2')
  await mkdir(dir)
  await writeFile(join(dir, 'config.json'), JSON.stringify({
    defaultProvider: 'listing', defaultModel: 'listed-model',
    providers: {
      listing: { baseUrl: 'https://api.example.com/v1', api: 'openai-completions', apiKey: '$UNCONFIGURED_PIE2_TEST_KEY', models: [{ id: 'listed-model', name: 'Listed Model' }] },
    },
  }))
  const child = spawn(process.execPath, [bin, '--list-models', '--json'], {
    cwd, signal: t.signal, timeout: 7_000, killSignal: 'SIGKILL',
    env: { HOME: cwd, PATH: process.env.PATH, NODE_NO_WARNINGS: '1' }, stdio: ['pipe', 'pipe', 'pipe'],
  })
  let output = ''
  let errors = ''
  child.stdout.setEncoding('utf8').on('data', chunk => { output += chunk })
  child.stderr.setEncoding('utf8').on('data', chunk => { errors += chunk })
  const [code] = await once(child, 'close')
  child.stdin.destroy()
  assert.equal(code, 0, errors)
  const entries = JSON.parse(output) as { provider: string; id: string; name: string }[]
  assert.ok(entries.some(model => model.provider === 'listing' && model.id === 'listed-model' && model.name === 'Listed Model'))
  assert.doesNotMatch(output, /apiKey|UNCONFIGURED_PIE2_TEST_KEY|api\.example\.com/)
  assert.deepEqual(await readdir(dir), ['config.json'])
  assert.deepEqual(await readdir(cwd), ['.pie2'])
})

test('invalid model configuration fails without leaking values or creating a session', { timeout: 10_000 }, async t => {
  const cwd = await workspace(t)
  const dir = join(cwd, '.pie2')
  await mkdir(dir)
  await writeFile(join(dir, 'config.json'), '{"providers":{"test":{"apiKey":"do-not-print-this-key",}}}')
  const result = await cli(t, cwd, ['-p', 'Read config'])
  assert.equal(result.code, 1)
  assert.match(result.stderr, /Invalid JSON.*config.json/)
  assert.doesNotMatch(result.stdout + result.stderr, /do-not-print-this-key/)
  assert.deepEqual(await readdir(cwd), ['.pie2'])
})

test('CLI starts fresh sessions by default and only continues when explicitly requested', { timeout: 10_000 }, async t => {
  const cwd = await workspace(t)
  const plugin = join(cwd, 'session-note.mjs')
  await writeFile(plugin, `import { defineDoc, defineExtension } from ${JSON.stringify(durableModule)}
const Note = defineDoc({kind:'test.note',version:1,scope:'conversation',history:'latest',fork:'initial',initial:()=>({value:''}),checkpointWhen:()=>false})
export default {name:'session-note',extension:defineExtension({name:'session-note'}),commands:{note:async(args,{harness,conversation,context})=>{if(args)await conversation.commit(async tx=>{(await tx.doc(Note,conversation.id)).value=args},context);return {output:(await harness.snapshot(Note,conversation.id,context))?.value||'(empty)'}}}}
`)
  const args = ['--provider', 'local', '--model', 'test', '--base-url', 'http://127.0.0.1:1/v1', '--plugin', plugin]
  const first = await cli(t, cwd, [...args, '-p', '/note First session task'])
  assert.equal(first.code, 0, first.stderr)
  const second = await cli(t, cwd, [...args, '-p', '/note Second session task'])
  assert.equal(second.code, 0, second.stderr)
  const key = createHash('sha256').update(cwd).digest('hex').slice(0, 24)
  const sessionDir = join(cwd, '.pie2', 'sessions', key)
  const files = (await readdir(sessionDir)).filter(name => name.endsWith('.sqlite')).sort()
  assert.equal(files.length, 2)
  const continued = await cli(t, cwd, [...args, '--continue', '-p', '/note'])
  assert.equal(continued.code, 0, continued.stderr)
  assert.match(continued.stdout, /Second session task/)
  assert.doesNotMatch(continued.stdout, /First session task/)
  const resumed = await cli(t, cwd, [...args, '--session', join(sessionDir, files[0]!), '-p', '/note'])
  assert.equal(resumed.code, 0, resumed.stderr)
  assert.match(resumed.stdout, /First session task/)
  assert.doesNotMatch(resumed.stdout, /Second session task/)
  assert.equal((await readdir(sessionDir)).filter(name => name.endsWith('.sqlite')).length, 2)
})

test('session selection flags reject ambiguous and noninteractive picker requests', { timeout: 10_000 }, async t => {
  const cwd = await workspace(t)
  const conflict = await cli(t, cwd, ['--session', join(cwd, 'state.sqlite'), '--continue', '-p', '/tasks'])
  assert.equal(conflict.code, 1)
  assert.match(conflict.stderr, /only one of/)
  const picker = await cli(t, cwd, ['--resume', '-p', '/tasks'])
  assert.equal(picker.code, 1)
  assert.match(picker.stderr, /interactive terminal/)
  assert.deepEqual(await readdir(cwd), [])
})

test('statusBar exposes current session information and can be disabled independently', { timeout: 10_000 }, async t => {
  const cwd = await workspace(t)
  const args = ['--provider', 'local', '--model', 'test', '--base-url', 'http://127.0.0.1:1/v1']
  const result = await cli(t, cwd, [...args, '-p', '/status'])
  assert.equal(result.code, 0, result.stderr)
  assert.match(result.stdout, /Session: .*\.sqlite/)
  assert.ok(result.stdout.includes(`Directory: ${cwd}`))
  assert.match(result.stdout, /Model: local\/test/)
  assert.match(result.stdout, /State: ready/)
  assert.match(result.stdout, /Tokens \(session\): input 0, output 0/)
  assert.doesNotMatch(result.stdout, /apiKey|Authorization|Bearer/)
  const disabled = await cli(t, cwd, [...args, '--disable-plugin', 'statusBar', '-p', '/status'])
  assert.equal(disabled.code, 1)
  assert.match(disabled.stderr, /Unknown command: \/status/)
})

test('CLI loads an external plugin factory and executes its registered command', { timeout: 10_000 }, async t => {
  const cwd = await workspace(t)
  const plugin = join(cwd, 'plugin.mjs')
  await writeFile(plugin, `import { defineExtension } from ${JSON.stringify(durableModule)}\nexport default async ({ cwd }) => ({\n  name: 'external-test', extension: defineExtension({ name: 'external-test' }),\n  commands: { greeting: async args => ({ output: JSON.stringify({ message: 'Hello ' + args, cwd }) }) }\n})\n`)
  const result = await cli(t, cwd, [
    '--plugin', plugin, '--provider', 'local', '--model', 'test', '--base-url', 'http://127.0.0.1:1/v1',
    '--session', join(cwd, 'session.sqlite'), '-p', '/greeting plugin user',
  ])
  assert.equal(result.code, 0, result.stderr)
  assert.deepEqual(JSON.parse(result.stdout), { message: 'Hello plugin user', cwd })
})
