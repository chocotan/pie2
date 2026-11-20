import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'
import { BACKGROUND_CONTEXT as context, withAbortSignal, type Context } from '@earendil-works/chord/context'
import { createModels } from '@earendil-works/pi-ai/models'
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import { getCurrentSystemPrompt, getCurrentTools } from '@earendil-works/pi-ai/utils/transcript'
import { createRegistry, Harness, MemoryStorage, type JsonObject, type ToolExecutionApi } from '@earendil-works/pi-durable'
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node'
import { createFilesPlugin } from '../src/plugins/files.ts'

const options = { timeout: 10_000 }
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9ZkAAAAASUVORK5CYII=', 'base64')
async function setup(t: TestContext) {
  const cwd = await mkdtemp(join(tmpdir(), 'pie2-files-'))
  t.after(() => rm(cwd, { recursive: true, force: true }))
  const models = createModels()
  const faux = fauxProvider({ models: [{ id: 'faux-1', input: ['text', 'image'] }] })
  models.setProvider(faux.provider)
  const plugin = createFilesPlugin()
  const api = { env: new NodeExecutionEnv({ cwd }), models, agent: async () => ({ cwd, model: { provider: 'faux', modelId: 'faux-1' } }) } as unknown as ToolExecutionApi
  const call = (name: string, args: JsonObject, ctx: Context = context) => plugin.extension.tools!.find(tool => tool.name === name)!.execute(args, api, ctx)
  const search = async (name: 'glob' | 'grep', args: JsonObject, ctx: Context = context) => {
    const result = await call(name, args, ctx)
    assert.equal(result.isError, undefined)
    const output = result.output!.find(item => item.type === 'text')!
    assert.equal(output.type, 'text')
    const value = JSON.parse(output.text)
    assert.deepEqual(result.structuredOutput, value)
    return value as { root: string; mode: string; paths: string[]; matches: { path: string; lineNumber: number; line: string; lineTruncated: boolean }[]; truncated: boolean; noMatches: boolean }
  }
  return { cwd, plugin, api, models, faux, call, search }
}
async function fixture(cwd: string) {
  await mkdir(join(cwd, 'src'), { recursive: true })
  await mkdir(join(cwd, 'ignored'))
  await writeFile(join(cwd, '.ignore'), 'ignored/\n')
  await writeFile(join(cwd, 'ignored', 'ignored.ts'), 'needle\n')
  await writeFile(join(cwd, '.hidden.ts'), 'needle\n')
  await writeFile(join(cwd, 'src', 'main.ts'), 'Header\nNeedle one\nneedle two\n-needle\na.b\naxb\n')
  await writeFile(join(cwd, 'src', 'other.js'), 'needle\n')
  await writeFile(join(cwd, 'src', 'data.bin'), Buffer.from('\0needle\0'))
  await writeFile(join(cwd, 'README.md'), 'Docs\n')
}

test('glob searches nested and workspace-relative paths with ripgrep ignore and explicit glob semantics', options, async t => {
  const env = await setup(t)
  await fixture(env.cwd)
  const result = await env.search('glob', { pattern: '**/*.ts' })
  assert.deepEqual(result.paths, ['.hidden.ts', 'src/main.ts'])
  assert.equal(result.root, env.cwd)
  assert.equal(result.noMatches, false)
  assert.equal(result.truncated, false)
  assert.deepEqual((await env.search('glob', { pattern: '*.{ts,js}', path: 'src' })).paths, ['main.ts', 'other.js'])
  assert.deepEqual((await env.search('glob', { pattern: '*.ts', path: join(env.cwd, 'src') })).paths, ['main.ts'])
  assert.deepEqual((await env.search('glob', { pattern: 'absent*' })).paths, [])
  assert.equal((await env.search('glob', { pattern: 'absent*' })).noMatches, true)
  const capped = await env.search('glob', { pattern: '*', limit: 1 })
  assert.equal(capped.paths.length, 1)
  assert.equal(capped.truncated, true)
  assert.equal(capped.noMatches, false)
  const exact = await env.search('glob', { pattern: 'src/main.ts', limit: 1 })
  assert.equal(exact.truncated, false)
})

test('glob preserves paths containing colons, newlines, Unicode, and option-looking names without shell interpretation', options, async t => {
  const env = await setup(t)
  const names = ['-option.ts', 'a:b.ts', 'line\nbreak.ts', '雪.ts', '$(touch pwned).ts']
  await Promise.all(names.map(name => writeFile(join(env.cwd, name), 'safe')))
  assert.deepEqual((await env.search('glob', { pattern: '*.ts' })).paths.sort(), names.sort())
  assert.deepEqual((await env.search('glob', { pattern: '-option.ts' })).paths, ['-option.ts'])
  assert.equal((await env.search('glob', { pattern: 'pwned' })).noMatches, true)
})

test('grep returns numbered matching lines, regex/fixed text, case options, and include filters', options, async t => {
  const env = await setup(t)
  await fixture(env.cwd)
  const result = await env.search('grep', { pattern: '^needle', ignoreCase: true, include: '*.ts' })
  assert.deepEqual(result.matches, [
    { path: '.hidden.ts', lineNumber: 1, line: 'needle', lineTruncated: false },
    { path: 'src/main.ts', lineNumber: 2, line: 'Needle one', lineTruncated: false },
    { path: 'src/main.ts', lineNumber: 3, line: 'needle two', lineTruncated: false },
  ])
  assert.equal(result.truncated, false)
  assert.equal(result.mode, 'content')
  assert.equal((await env.search('grep', { pattern: 'a.b', fixed: true, path: 'src/main.ts' })).matches.length, 1)
  assert.equal((await env.search('grep', { pattern: 'a.b', path: 'src/main.ts' })).matches.length, 2)
  assert.deepEqual((await env.search('grep', { pattern: '-needle', fixed: true })).matches.map(match => match.line), ['-needle'])
  assert.equal((await env.search('grep', { pattern: 'never matches' })).noMatches, true)
  const capped = await env.search('grep', { pattern: 'needle', ignoreCase: true, include: '*.ts', limit: 1 })
  assert.equal(capped.matches.length, 1)
  assert.equal(capped.truncated, true)
  assert.equal(capped.noMatches, false)
  assert.equal((await env.search('grep', { pattern: '^Header$', limit: 1 })).truncated, false)
})

test('grep file mode handles unusual filenames and skips ignored, hidden, and binary contents', options, async t => {
  const env = await setup(t)
  await fixture(env.cwd)
  await writeFile(join(env.cwd, 'a:\n雪.ts'), 'needle\n')
  const result = await env.search('grep', { pattern: 'needle', mode: 'files' })
  assert.deepEqual(result.paths, ['a:\n雪.ts', 'src/main.ts', 'src/other.js'])
  assert.deepEqual(result.matches, [])
  assert.equal((await env.search('grep', { pattern: 'needle', mode: 'files', path: 'src', include: '*.js' })).paths[0], 'other.js')
  assert.equal((await env.search('grep', { pattern: 'needle', mode: 'files', limit: 1 })).truncated, true)
  assert.equal((await env.search('grep', { pattern: 'absent', mode: 'files' })).noMatches, true)
})

test('search rejects missing paths, invalid regex/globs, blank arguments, and invalid limits rather than reporting no matches', options, async t => {
  const env = await setup(t)
  await fixture(env.cwd)
  for (const name of ['glob', 'grep'] as const) {
    await assert.rejects(env.search(name, { pattern: '*', path: 'missing' }), /ENOENT/)
    for (const args of [
      { pattern: '  ' }, { pattern: '*', path: '  ' }, { pattern: '*', path: 'bad\0path' },
      ...[0, -1, 1.5, Infinity, NaN, 1001].map(limit => ({ pattern: 'x', limit })),
      ...[0, -1, 1.5, Infinity, NaN, 120001].map(timeoutMs => ({ pattern: 'x', timeoutMs })),
    ] as JsonObject[]) await assert.rejects(env.call(name, args), /blank|NUL|integer/)
  }
  await assert.rejects(env.search('glob', { pattern: '*', path: 'README.md' }), /directory/)
  await assert.rejects(env.search('glob', { pattern: '[' }), /ripgrep failed/)
  await assert.rejects(env.search('grep', { pattern: '[' }), /regex parse error/)
  await assert.rejects(env.search('grep', { pattern: 'x', include: '  ' }), /include/)
  await assert.rejects(env.search('grep', { pattern: 'x', include: '[' }), /ripgrep failed/)
})

test('grep bounds huge UTF-8 line previews and raw records, never returning invalid partial JSON or characters', options, async t => {
  const env = await setup(t)
  await writeFile(join(env.cwd, 'unicode.txt'), `${'雪'.repeat(2000)}\n`)
  const preview = await env.search('grep', { pattern: '雪' })
  assert.equal(preview.matches.length, 1)
  assert.equal(preview.matches[0].lineTruncated, true)
  assert.equal(preview.matches[0].line.includes('\ufffd'), false)
  assert.ok(Buffer.byteLength(preview.matches[0].line) <= 2000)
  assert.equal(preview.truncated, true)
  await writeFile(join(env.cwd, 'huge.txt'), 'x'.repeat(600_000))
  const huge = await env.search('grep', { pattern: 'x', path: 'huge.txt' })
  assert.equal(huge.truncated, true)
  assert.equal(huge.noMatches, false)
  assert.deepEqual(huge.matches, [])
  await writeFile(join(env.cwd, 'many.txt'), Array.from({ length: 600 }, () => 'needle ' + '雪'.repeat(400)).join('\n'))
  const capped = await env.call('grep', { pattern: 'needle', path: 'many.txt', limit: 1000 })
  const output = capped.output![0]
  assert.equal(output.type, 'text')
  if (output.type === 'text') {
    assert.ok(Buffer.byteLength(output.text) < 50_000)
    assert.equal(JSON.parse(output.text).truncated, true)
    assert.equal(output.text.includes('\ufffd'), false)
  }
})

test('search respects cancellation before launch and during execution, and reports timeout separately', options, async t => {
  const env = await setup(t)
  await writeFile(join(env.cwd, 'large.txt'), 'abcdefghijklmno\n'.repeat(600_000))
  const aborted = new AbortController()
  aborted.abort(new Error('Cancelled before launch'))
  await assert.rejects(env.search('glob', { pattern: '*' }, withAbortSignal(aborted.signal, context)), /Cancelled before launch/)
  const controller = new AbortController()
  const pending = env.search('grep', { pattern: 'never matches' }, withAbortSignal(controller.signal, context))
  setImmediate(() => controller.abort(new Error('Cancelled search')))
  await assert.rejects(pending, /Cancelled search/)
  await assert.rejects(env.search('grep', { pattern: 'never matches', timeoutMs: 1 }), /timed out/)
})

test('search resolves agent cwd when no environment is installed and ignores external ripgrep configuration', options, async t => {
  const env = await setup(t)
  await writeFile(join(env.cwd, 'visible.ts'), 'needle\n')
  await writeFile(join(env.cwd, 'rg-config'), '--glob\n!*.ts\n')
  const previous = process.env.RIPGREP_CONFIG_PATH
  process.env.RIPGREP_CONFIG_PATH = join(env.cwd, 'rg-config')
  try {
    const tool = env.plugin.extension.tools!.find(tool => tool.name === 'glob')!
    const result = await tool.execute({ pattern: '*.ts' }, { ...env.api, env: undefined }, context)
    assert.deepEqual((result.structuredOutput as { paths: string[] }).paths, ['visible.ts'])
  } finally {
    if (previous === undefined) delete process.env.RIPGREP_CONFIG_PATH
    else process.env.RIPGREP_CONFIG_PATH = previous
  }
})

test('search reports a missing rg executable clearly', options, async t => {
  const env = await setup(t)
  const previous = process.env.PATH
  process.env.PATH = env.cwd
  try { await assert.rejects(env.search('glob', { pattern: '*' }), /Unable to run ripgrep.*ENOENT/) }
  finally {
    if (previous === undefined) delete process.env.PATH
    else process.env.PATH = previous
  }
})

test('read_image preserves attachments and diagnostics, rejects text disguised as PNG, and retains image safety limits', options, async t => {
  const env = await setup(t)
  await writeFile(join(env.cwd, 'image.png'), png)
  const result = await env.call('read_image', { path: 'image.png' })
  assert.equal(result.output![0].type, 'image')
  if (result.output![0].type === 'image') {
    assert.equal(result.output![0].mimeType, 'image/png')
    assert.deepEqual(Buffer.from(result.output![0].data, 'base64'), png)
  }
  assert.ok(result.diagnostics?.some(item => item.code === 'image'))
  env.models.setProvider(fauxProvider({ models: [{ id: 'faux-1', input: ['text'] }] }).provider)
  const textOnly = await env.call('read_image', { path: 'image.png' })
  assert.equal(textOnly.output![0].type, 'image')
  assert.ok(textOnly.diagnostics?.some(item => /does not support images/.test(item.message)))
  await writeFile(join(env.cwd, 'fake.png'), 'private text that must not be returned')
  await assert.rejects(env.call('read_image', { path: 'fake.png' }), /only accepts supported/)
  await assert.rejects(env.call('read_image', { path: 'missing.png' }), /ENOENT|not found/)
  await assert.rejects(env.call('read_image', { path: '  ' }), /blank/)
  const huge = Buffer.from(png)
  huge.writeUInt32BE(100000, 16)
  await writeFile(join(env.cwd, 'oversize.png'), huge)
  const tooLarge = await env.call('read_image', { path: 'oversize.png' })
  assert.equal(tooLarge.isError, true)
  assert.ok(tooLarge.diagnostics?.some(item => item.code === 'unsupported_image'))
  const cancelled = new AbortController()
  cancelled.abort(new Error('Cancelled image'))
  await assert.rejects(env.call('read_image', { path: 'image.png' }, withAbortSignal(cancelled.signal, context)), /Cancelled image/)
})

test('native plugin installs all three tools and policy, validates tool schemas, and returns image attachments to a vision model', options, async t => {
  const env = await setup(t)
  await writeFile(join(env.cwd, 'image.png'), png)
  const registry = createRegistry()
  registry.install(env.plugin.extension)
  const harness = await Harness.open(new MemoryStorage(), {
    models: env.models, registry, env: () => new NodeExecutionEnv({ cwd: env.cwd }), settings: { retry: { maxRetries: 0 } },
  }, context)
  t.after(() => harness.close(context))
  const root = await harness.root(context, { agent: { cwd: env.cwd, model: { provider: 'faux', modelId: 'faux-1' } } })
  env.faux.setResponses([
    request => {
      assert.match(getCurrentSystemPrompt(request.messages), /<files_policy>/)
      assert.deepEqual(getCurrentTools(request.messages).map(tool => tool.name), ['read_image', 'glob', 'grep'])
      return fauxAssistantMessage(fauxToolCall('read_image', { path: 'image.png' }), { stopReason: 'toolUse' })
    }, fauxAssistantMessage('Image received.'),
  ])
  assert.equal((await (await root.submit({ type: 'input', content: 'Inspect image' }, context)).wait(context)).status, 'done')
  const entries = (await root.entries({ order: 'ascending' }, 100, undefined, context)).items
  const imageResult = entries.flatMap(entry => entry.model ?? []).find(message => message.role === 'toolResult')
  assert.equal(imageResult?.content[0].type, 'image')
  env.faux.setResponses([
    fauxAssistantMessage(fauxToolCall('glob', { pattern: '*', limit: 0 }), { stopReason: 'toolUse' }), fauxAssistantMessage('Invalid input handled.'),
  ])
  assert.equal((await (await root.submit({ type: 'input', content: 'Try an invalid limit' }, context)).wait(context)).status, 'done')
  const results = (await root.entries({ order: 'ascending' }, 100, undefined, context)).items.flatMap(entry => entry.model ?? []).filter(message => message.role === 'toolResult')
  assert.equal(results.at(-1)?.isError, true)
  await root.configure({ extensions: { remove: [env.plugin.extension] } }, context)
  env.faux.setResponses([request => {
    assert.doesNotMatch(getCurrentSystemPrompt(request.messages), /<files_policy>/)
    assert.deepEqual(getCurrentTools(request.messages), [])
    return fauxAssistantMessage('Plugin removed.')
  }])
  assert.equal((await (await root.submit({ type: 'input', content: 'Check removal' }, context)).wait(context)).status, 'done')
})
