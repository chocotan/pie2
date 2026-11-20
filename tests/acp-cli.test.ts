import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { fileURLToPath } from 'node:url'

const bin = fileURLToPath(new URL('../bin/pie2.mjs', import.meta.url))
const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`

async function findAcpx() {
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    const executable = join(directory, 'acpx')
    if (await access(executable, constants.X_OK).then(() => true, () => false)) return executable
  }
}

async function fixture(t: TestContext) {
  const acpx = await findAcpx()
  if (!acpx) {
    t.skip('Local acpx is not installed; real-client ACP interoperability requires acpx on PATH (no network installation).')
    return
  }
  const root = await mkdtemp(join(tmpdir(), 'pie2-acpx-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const cwd = join(root, "workspace with spaces and ' quote")
  const home = join(root, 'home')
  const configDir = join(root, 'config')
  await Promise.all([mkdir(cwd), mkdir(join(home, '.acpx'), { recursive: true }), mkdir(configDir)])
  const requests: { messages: { role: string; content: unknown }[] }[] = []
  const server = createServer(async (request, response) => {
    try {
      let body = ''
      for await (const chunk of request) body += chunk
      requests.push(JSON.parse(body))
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      const send = (delta: object, finish_reason: string | null = null) => response.write(`data: ${JSON.stringify({
        id: `chatcmpl-acpx-${requests.length}`, object: 'chat.completion.chunk', created: 1, model: 'acp-test',
        choices: [{ index: 0, delta, finish_reason }],
      })}\n\n`)
      if (requests.length === 1) {
        send({ role: 'assistant', reasoning_content: 'Inspecting ' })
        send({ reasoning_content: 'permissions.' })
        send({ tool_calls: [{ index: 0, id: 'call-write', type: 'function', function: {
          name: 'write', arguments: JSON.stringify({ path: 'acp-output.txt', content: 'approved output' }),
        } }] })
        send({}, 'tool_calls')
      } else {
        const result = requests.at(-1)!.messages.find(message => message.role === 'tool')
        const denied = /denied|permission|reject/i.test(JSON.stringify(result?.content))
        send({ role: 'assistant', content: denied ? 'Write ' : 'Tool ' })
        send({ content: denied ? 'refused.' : 'finished.' })
        send({}, 'stop')
      }
      response.end('data: [DONE]\n\n')
    } catch (error) {
      response.writeHead(500)
      response.end(String(error))
    }
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => new Promise<void>((resolve, reject) => {
    server.closeAllConnections()
    server.close(error => error ? reject(error) : resolve())
  }))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  await writeFile(join(configDir, 'config.json'), JSON.stringify({
    defaultProvider: 'local', defaultModel: 'acp-test', defaultThinkingLevel: 'high',
    providers: { local: { baseUrl: `http://127.0.0.1:${address.port}/v1`, api: 'openai-completions', apiKey: 'test-only',
      models: [{ id: 'acp-test', reasoning: true, contextWindow: 32000, maxTokens: 2000 }] } },
  }))
  return {
    cwd, requests,
    async run(permission: '--approve-all' | '--deny-all') {
      const command = `${shellQuote(process.execPath)} ${shellQuote(bin)} acp`
      const child = spawn(acpx, ['--agent', command, '--cwd', cwd, '--ttl', '0', permission, '--format', 'json', 'exec', 'Write acp-output.txt, then report the result.'], {
        cwd, env: { HOME: home, PIE2_CONFIG_DIR: configDir, PATH: process.env.PATH, NODE_NO_WARNINGS: '1' },
        stdio: ['ignore', 'pipe', 'pipe'], signal: t.signal, timeout: 8000, killSignal: 'SIGKILL', detached: process.platform !== 'win32',
      })
      t.after(() => {
        if (!child.pid) return
        try { process.kill(process.platform === 'win32' ? child.pid : -child.pid, 'SIGKILL') }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error }
      })
      let stdout = ''
      let stderr = ''
      child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk })
      child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk })
      const [code, signal] = await once(child, 'close')
      assert.equal(signal, null, `acpx was killed: ${signal}\n${stderr}\n${stdout}`)
      assert.ok(stdout.trim(), `acpx emitted no JSON messages: ${stderr}`)
      const messages = stdout.trim().split('\n').map(line => {
        const message = JSON.parse(line)
        assert.equal(message.jsonrpc, '2.0', `Non-ACP stdout: ${line}`)
        return message
      })
      const updates = messages.filter(message => message.method === 'session/update').map(message => message.params.update)
      return { code, stderr, stdout, messages, updates }
    },
  }
}

test('local acpx exec receives thinking, text and tool lifecycle without replaying streamed content', { timeout: 10_000 }, async t => {
  const setup = await fixture(t)
  if (!setup) return
  const result = await setup.run('--approve-all')
  assert.equal(result.code, 0, result.stderr + result.stdout)
  assert.equal(setup.requests.length, 2)
  const text = (kind: string) => result.updates.filter(update => update.sessionUpdate === kind).map(update => update.content.text).join('')
  assert.equal(text('agent_thought_chunk'), 'Inspecting permissions.')
  assert.equal(text('agent_message_chunk'), 'Tool finished.')
  const calls = result.updates.filter(update => update.sessionUpdate === 'tool_call' && update.name === 'write')
  assert.equal(calls.length, 1, result.stdout)
  const id = calls[0].toolCallId
  assert.match(id, /^task-\d+$/)
  assert.ok(result.messages.some(message => message.method === 'session/request_permission' && message.params.toolCall.toolCallId === id))
  assert.equal(calls[0].kind, 'edit')
  assert.match(calls[0].title, /write.*acp-output\.txt/)
  assert.ok(result.updates.some(update => update.sessionUpdate === 'tool_call_update' && update.toolCallId === id && update.status === 'completed'), result.stdout)
  assert.ok(result.messages.some(message => message.result?.stopReason === 'end_turn'), result.stdout)
  assert.equal(await readFile(join(setup.cwd, 'acp-output.txt'), 'utf8'), 'approved output')
})

test('local acpx deny-all blocks file mutation and delivers denial back to the model', { timeout: 10_000 }, async t => {
  const setup = await fixture(t)
  if (!setup) return
  const result = await setup.run('--deny-all')
  // acpx 0.12 reports fully denied permission requests with exit 5, even after a normal end_turn.
  assert.equal(result.code, 5, result.stderr + result.stdout)
  const request = result.messages.find(message => message.method === 'session/request_permission')
  assert.ok(request, result.stdout)
  const id = request.params.toolCall.toolCallId
  assert.ok(result.messages.some(message => message.result?.outcome?.optionId === 'reject_once'), result.stdout)
  await assert.rejects(readFile(join(setup.cwd, 'acp-output.txt'), 'utf8'), { code: 'ENOENT' })
  assert.equal(setup.requests.length, 2, result.stderr + result.stdout)
  const denied = setup.requests[1]!.messages.find(message => message.role === 'tool')
  assert.ok(denied, 'The follow-up model request must contain the tool rejection')
  assert.match(JSON.stringify(denied.content), /denied|permission|reject/i)
  assert.ok(result.updates.some(update => update.toolCallId === id && update.status === 'failed'), result.stdout)
  const text = result.updates.filter(update => update.sessionUpdate === 'agent_message_chunk').map(update => update.content.text).join('')
  assert.equal(text, 'Write refused.')
})
