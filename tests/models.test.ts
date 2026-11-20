import assert from 'node:assert/strict'
import { access, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { resolveConfigValue } from '../src/model-config.ts'
import { configureModels } from '../src/models.ts'

function environment(t: TestContext, values: Record<string, string | undefined>) {
  const previous = Object.fromEntries(Object.keys(values).map(name => [name, process.env[name]]))
  for (const [name, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  t.after(() => {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  })
}

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'pie2-models-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  environment(t, { PIE2_PROVIDER: undefined, PIE2_MODEL: undefined, PIE2_BASE_URL: undefined, PIE2_CONFIG_DIR: undefined, PIE2_API_KEY: undefined })
  const cwd = join(root, 'project')
  const configDir = join(root, 'global')
  const projectDir = join(cwd, '.pie2')
  await mkdir(projectDir, { recursive: true })
  await mkdir(configDir, { recursive: true })
  return { cwd, configDir, projectDir }
}

async function config(directory: string, value: unknown) {
  await writeFile(join(directory, 'config.json'), JSON.stringify(value))
}

test('web search configuration merges by field and expands endpoint variables without affecting model selection', async t => {
  const options = await fixture(t)
  environment(t, { PIE2_SEARCH_ENDPOINT: 'http://127.0.0.1:9009/search' })
  await config(options.configDir, { defaultProvider: 'openai', defaultModel: 'gpt-4.1', webSearch: { endpoint: '$PIE2_SEARCH_ENDPOINT', timeoutMs: 15000 } })
  await config(options.projectDir, { webSearch: { timeoutMs: 7000 } })
  const value = await configureModels(options)
  assert.deepEqual(value.webSearch, { endpoint: 'http://127.0.0.1:9009/search', timeoutMs: 7000 })
  assert.deepEqual(value.model, { provider: 'openai', modelId: 'gpt-4.1' })
  for (const invalid of [{ timeoutMs: 0 }, { timeoutMs: 120001 }, { timeoutMs: 1.5 }, { unexpected: true }]) {
    await config(options.projectDir, { webSearch: invalid })
    await assert.rejects(configureModels(options), /Invalid configuration/)
  }
  await config(options.projectDir, { webSearch: { endpoint: 'file:///tmp/private' } })
  await assert.rejects(configureModels(options), /HTTP/)
})

test('default model selections exist in all three built-in provider catalogues', async t => {
  const options = await fixture(t)
  for (const provider of ['deepseek', 'openai', 'anthropic']) {
    const configured = await configureModels({ ...options, provider })
    assert.ok(configured.models.getModel(provider, configured.model.modelId))
    assert.equal(configured.model.provider, provider)
  }
})

test('custom OpenAI-compatible endpoints expose the requested model and validate URLs', async t => {
  const options = await fixture(t)
  const configured = await configureModels({ ...options, provider: 'local', model: 'test', baseUrl: 'http://127.0.0.1:8080/v1' })
  assert.equal(configured.models.getModel('local', 'test')?.api, 'openai-completions')
  await assert.rejects(configureModels({ ...options, provider: 'local', model: 'test', baseUrl: 'file:///tmp/api' }), /HTTP/)
  await assert.rejects(configureModels({ ...options, provider: 'local', model: 'test', baseUrl: 'https://key:secret@example.com' }), error => {
    assert.ok(error instanceof Error)
    assert.match(error.message, /credentials/)
    assert.ok(!error.message.includes('secret'))
    return true
  })
  await assert.rejects(configureModels({ ...options, provider: 'unknown', model: 'test' }), /provider/)
})

test('project configuration selects a second provider and merges matching models without losing global fields', async t => {
  const options = await fixture(t)
  await config(options.configDir, { defaultProvider: 'gateway', defaultModel: 'shared', defaultThinkingLevel: 'low', providers: {
    gateway: {
      api: 'openai-completions', baseUrl: 'https://global.example/v1', apiKey: 'fixture-global-key',
      headers: { 'X-Global': 'retained', 'X-Shared': 'global' },
      models: [{ id: 'shared', name: 'Global model', reasoning: true, input: ['text', 'image'], contextWindow: 100000, maxTokens: 8000,
        cost: { input: 2, output: 4, cacheRead: 0.2 }, compat: { supportsStore: false }, thinkingLevelMap: { low: 'low', high: 'high' } }],
    },
  } })
  await config(options.projectDir, { defaultProvider: 'alternate', defaultModel: 'other', defaultThinkingLevel: 'high', providers: {
    gateway: {
      baseUrl: 'https://project.example/v1', headers: { 'X-Shared': 'project' },
      models: [{ id: 'shared', name: 'Project model', cost: { output: 5 }, compat: { supportsDeveloperRole: false } }],
    },
    alternate: { api: 'anthropic-messages', baseUrl: 'https://alternate.example', models: [{ id: 'other' }] },
  } })
  const configured = await configureModels(options)
  assert.deepEqual(configured.model, { provider: 'alternate', modelId: 'other' })
  assert.equal(configured.thinkingLevel, 'high')
  const merged = configured.models.getModel('gateway', 'shared')!
  assert.equal(merged.name, 'Project model')
  assert.equal(merged.baseUrl, 'https://project.example/v1')
  assert.equal(merged.reasoning, true)
  assert.deepEqual(merged.input, ['text', 'image'])
  assert.equal(merged.contextWindow, 100000)
  assert.equal(merged.maxTokens, 8000)
  assert.deepEqual(merged.cost, { input: 2, output: 5, cacheRead: 0.2, cacheWrite: 0 })
  assert.deepEqual(merged.compat, { supportsStore: false, supportsDeveloperRole: false })
  assert.deepEqual(merged.thinkingLevelMap, { low: 'low', high: 'high' })
  const auth = await configured.models.getAuth('gateway')
  assert.equal(auth?.auth.apiKey, 'fixture-global-key')
  assert.deepEqual(auth.auth.headers, { 'X-Global': 'retained', 'X-Shared': 'project' })
})

test('flags override environment and configuration while preserving configured model metadata', async t => {
  const options = await fixture(t)
  await config(options.configDir, { defaultProvider: 'openai', defaultModel: 'gpt-4.1', providers: {
    gateway: { api: 'openai-completions', baseUrl: 'https://configured.example/v1', apiKey: 'fixture-key', models: [
      { id: 'saved', contextWindow: 64000, maxTokens: 4096 },
      { id: 'flag', name: 'Flag model', reasoning: true, contextWindow: 96000, maxTokens: 8192, cost: { input: 1.5 } },
    ] },
  } })
  await config(options.projectDir, { defaultProvider: 'gateway', defaultModel: 'saved' })
  assert.deepEqual((await configureModels(options)).model, { provider: 'gateway', modelId: 'saved' })
  environment(t, { PIE2_PROVIDER: 'openai', PIE2_MODEL: 'gpt-4.1', PIE2_BASE_URL: 'https://environment.example/v1' })
  const fromEnvironment = await configureModels(options)
  assert.deepEqual(fromEnvironment.model, { provider: 'openai', modelId: 'gpt-4.1' })
  assert.equal(fromEnvironment.models.getModel('openai', 'gpt-4.1')?.baseUrl, 'https://environment.example/v1')
  const fromFlags = await configureModels({ ...options, provider: 'gateway', model: 'flag', baseUrl: 'https://flag.example/v1' })
  assert.deepEqual(fromFlags.model, { provider: 'gateway', modelId: 'flag' })
  const model = fromFlags.models.getModel('gateway', 'flag')!
  assert.equal(model.baseUrl, 'https://flag.example/v1')
  assert.equal(model.name, 'Flag model')
  assert.equal(model.reasoning, true)
  assert.equal(model.contextWindow, 96000)
  assert.equal(model.maxTokens, 8192)
  assert.equal(model.cost.input, 1.5)
  assert.equal((await fromFlags.models.getAuth('gateway'))?.auth.apiKey, 'fixture-key')
})

test('PIE2_CONFIG_DIR selects the global directory and an explicit configDir overrides it', async t => {
  const options = await fixture(t)
  environment(t, { PIE2_CONFIG_DIR: options.configDir })
  await config(options.configDir, { defaultProvider: 'openai', defaultModel: 'gpt-4.1' })
  assert.equal((await configureModels({ cwd: options.cwd })).model.provider, 'openai')
  const separate = join(options.cwd, 'separate')
  await mkdir(separate)
  assert.equal((await configureModels({ cwd: options.cwd, configDir: separate })).model.provider, 'deepseek')
})

test('modelOverrides merge across configuration layers and retain built-in model fields', async t => {
  const options = await fixture(t)
  const original = (await configureModels({ ...options, provider: 'openai' })).models.getModel('openai', 'gpt-4.1')!
  await config(options.configDir, { providers: {
    openai: { modelOverrides: { 'gpt-4.1': { maxTokens: 2048, cost: { input: 7 }, compat: { supportsStore: false } } } },
  } })
  await config(options.projectDir, { providers: {
    openai: { modelOverrides: { 'gpt-4.1': { name: 'Project override', cost: { output: 9 } } } },
  } })
  const configured = await configureModels({ ...options, provider: 'openai' })
  const model = configured.models.getModel('openai', 'gpt-4.1')!
  assert.equal(model.name, 'Project override')
  assert.equal(model.maxTokens, 2048)
  assert.equal(model.contextWindow, original.contextWindow)
  assert.deepEqual(model.input, original.input)
  assert.deepEqual(model.cost, { ...original.cost, input: 7, output: 9 })
  assert.deepEqual(model.compat, { ...original.compat, supportsStore: false })
})

test('literal and environment credentials and provider/model headers resolve through getAuth', async t => {
  const options = await fixture(t)
  environment(t, { PIE2_MODEL_TEST_KEY: 'fixture-env-key', PIE2_MODEL_TEST_HEADER: 'fixture-env-header' })
  await config(options.configDir, { providers: {
    literal: { api: 'openai-completions', baseUrl: 'https://literal.example', apiKey: 'fixture-literal-key', models: [{ id: 'literal' }] },
    variable: {
      api: 'openai-completions', baseUrl: 'https://variable.example', apiKey: '${PIE2_MODEL_TEST_KEY}', authHeader: true,
      headers: { 'X-Custom': '$PIE2_MODEL_TEST_HEADER', 'X-Shared': 'provider' },
      models: [{ id: 'variable', headers: { 'X-Model': '${PIE2_MODEL_TEST_HEADER}', 'X-Shared': 'model' } }],
    },
  } })
  const configured = await configureModels({ ...options, provider: 'variable', model: 'variable' })
  assert.equal((await configured.models.getAuth('literal'))?.auth.apiKey, 'fixture-literal-key')
  const model = configured.models.getModel('variable', 'variable')!
  const auth = await configured.models.getAuth(model)
  assert.equal(auth?.auth.apiKey, 'fixture-env-key')
  assert.deepEqual(auth.auth.headers, {
    'X-Custom': 'fixture-env-header', 'X-Shared': 'model', 'X-Model': 'fixture-env-header', Authorization: 'Bearer fixture-env-key',
  })
})

test('all three configured API types dispatch to their own endpoints without network access', async t => {
  const options = await fixture(t)
  const apis = ['openai-completions', 'openai-responses', 'anthropic-messages'] as const
  await config(options.configDir, { providers: {
    mixed: { baseUrl: 'https://dispatch.invalid', apiKey: 'fixture-dispatch-key', models: apis.map(api => ({ id: api, api })) },
  } })
  const configured = await configureModels({ ...options, provider: 'mixed', model: apis[0] })
  const expectedPaths = ['/chat/completions', '/responses', '/v1/messages']
  for (const [index, api] of apis.entries()) {
    const requests: Request[] = []
    const model = configured.models.getModel('mixed', api)!
    assert.equal(model.api, api)
    const result = await configured.models.completeSimple(model, { messages: [{ role: 'user', content: 'Offline probe', timestamp: 0 }] }, {
      fetch: async (input, init) => {
        requests.push(new Request(input, init))
        return new Response(JSON.stringify({ error: { type: 'invalid_request_error', message: 'offline dispatch probe' } }), {
          status: 400, headers: { 'content-type': 'application/json' },
        })
      },
    })
    assert.equal(requests.length, 1)
    assert.equal(new URL(requests[0]!.url).pathname, expectedPaths[index])
    assert.equal((await requests[0]!.json() as { model: string }).model, api)
    assert.equal(result.stopReason, 'error')
    assert.match(result.errorMessage!, /offline dispatch probe/)
  }
})

test('config values support environment expansion and escaping without executing commands', async t => {
  const options = await fixture(t)
  environment(t, { PIE2_MODEL_TEST_VALUE: 'expanded', PIE2_MODEL_TEST_MISSING: undefined, PIE2_MODEL_TEST_NEWLINE: 'bad\nvalue' })
  assert.equal(resolveConfigValue('literal', 'test'), 'literal')
  assert.equal(resolveConfigValue('$PIE2_MODEL_TEST_VALUE/${PIE2_MODEL_TEST_VALUE}', 'test'), 'expanded/expanded')
  assert.equal(resolveConfigValue('$$PIE2_MODEL_TEST_VALUE $!literal', 'test'), '$PIE2_MODEL_TEST_VALUE !literal')
  assert.throws(() => resolveConfigValue('$PIE2_MODEL_TEST_MISSING', 'test'), /missing environment variable PIE2_MODEL_TEST_MISSING/)
  assert.throws(() => resolveConfigValue('$PIE2_MODEL_TEST_NEWLINE', 'test'), /newlines/)
  const marker = join(options.cwd, 'must-not-exist')
  assert.throws(() => resolveConfigValue(`!touch ${marker}`, 'test'), /shell command values are not supported/)
  await assert.rejects(access(marker), { code: 'ENOENT' })
})

test('missing configured credential variables fail without leaking unrelated credentials', async t => {
  const options = await fixture(t)
  environment(t, { PIE2_MODEL_TEST_MISSING: undefined })
  await config(options.configDir, { providers: {
    gateway: { api: 'openai-completions', baseUrl: 'https://gateway.example', apiKey: '$PIE2_MODEL_TEST_MISSING',
      headers: { 'X-Secret': 'fixture-private-header' }, models: [{ id: 'test' }] },
  } })
  const configured = await configureModels({ ...options, provider: 'gateway', model: 'test' })
  await assert.rejects(configured.models.getAuth('gateway'), error => {
    assert.ok(error instanceof Error)
    assert.match(error.message, /PIE2_MODEL_TEST_MISSING/)
    assert.ok(!error.message.includes('fixture-private-header'))
    return true
  })
})

test('malformed JSON and invalid schemas report the config path without including secrets', async t => {
  const options = await fixture(t)
  const path = join(options.configDir, 'config.json')
  await writeFile(path, '{"apiKey":"fixture-private-key",')
  await assert.rejects(configureModels(options), error => {
    assert.ok(error instanceof Error)
    assert.ok(error.message.includes(path))
    assert.match(error.message, /Invalid JSON/)
    assert.ok(!error.message.includes('fixture-private-key'))
    return true
  })
  const invalid = [
    { api: 'unsupported-api' },
    { models: [{ id: 'test', contextWindow: 0 }] },
    { models: [{ id: 'test', maxTokens: 1.5 }] },
    { models: [{ id: 'test', input: ['audio'] }] },
    { headers: { 'X-Header': 'injected\r\nvalue' } },
  ]
  for (const fields of invalid) {
    await config(options.configDir, { providers: { gateway: { apiKey: 'fixture-private-key', ...fields } } })
    await assert.rejects(configureModels(options), error => {
      assert.ok(error instanceof Error)
      assert.ok(error.message.includes(path))
      assert.match(error.message, /Invalid configuration/)
      assert.ok(!error.message.includes('fixture-private-key'))
      return true
    })
  }
  await rm(path)
  await config(options.projectDir, { defaultThinkingLevel: 'unsupported' })
  await assert.rejects(configureModels(options), error => {
    assert.ok(error instanceof Error)
    assert.ok(error.message.includes(join(options.projectDir, 'config.json')))
    return true
  })
})

test('legacy files are ignored and malformed config.json never falls back to them', async t => {
  const options = await fixture(t)
  for (const directory of [options.configDir, options.projectDir]) {
    await writeFile(join(directory, 'models.json'), JSON.stringify({ providers: {
      legacy: { api: 'openai-completions', baseUrl: 'https://legacy.example/v1', models: [{ id: 'old' }] },
    } }))
    await writeFile(join(directory, 'settings.json'), JSON.stringify({ defaultProvider: 'legacy', defaultModel: 'old' }))
  }
  assert.equal((await configureModels(options)).model.provider, 'deepseek')
  await assert.rejects(configureModels({ ...options, provider: 'legacy', model: 'old' }), /Unknown provider/)
  await config(options.configDir, { defaultProvider: 'openai', defaultModel: 'gpt-4.1' })
  assert.deepEqual((await configureModels(options)).model, { provider: 'openai', modelId: 'gpt-4.1' })
  const path = join(options.projectDir, 'config.json')
  await writeFile(path, '{')
  await assert.rejects(configureModels(options), error => {
    assert.ok(error instanceof Error)
    assert.match(error.message, /Invalid JSON/)
    assert.ok(error.message.includes(path))
    return true
  })
})

test('token limits, duplicate model IDs, and unknown selections are rejected', async t => {
  const options = await fixture(t)
  const provider = { api: 'openai-completions', baseUrl: 'https://gateway.example', apiKey: 'fixture-private-key' }
  await config(options.configDir, { providers: { gateway: { ...provider, models: [{ id: 'test', contextWindow: 100, maxTokens: 101 }] } } })
  await assert.rejects(configureModels(options), /maxTokens exceeds contextWindow/)
  await config(options.configDir, { providers: { gateway: { ...provider, models: [{ id: 'duplicate' }, { id: 'duplicate' }] } } })
  await assert.rejects(configureModels(options), error => {
    assert.ok(error instanceof Error)
    assert.match(error.message, /Duplicate model ID/)
    assert.ok(error.message.includes(join(options.configDir, 'config.json')))
    assert.ok(!error.message.includes('fixture-private-key'))
    return true
  })
  await config(options.configDir, { providers: { gateway: { ...provider, models: [{ id: 'known' }] } } })
  await assert.rejects(configureModels({ ...options, provider: 'gateway', model: 'missing' }), /Unknown model gateway\/missing/)
  await assert.rejects(configureModels({ ...options, provider: 'unknown', model: 'missing' }), /Unknown provider/)
})
