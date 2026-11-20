import assert from 'node:assert/strict'
import { test } from 'node:test'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { createModels, createProvider } from '@earendil-works/pi-ai/models'
import { fauxProvider } from '@earendil-works/pi-ai/providers/faux'
import { AgentDoc, createRegistry, Harness, MemoryStorage } from '@earendil-works/pi-durable'
import { createModelsPlugin, getModelOptions, getThinkingOptions } from '../src/plugins/models.ts'

const context = BACKGROUND_CONTEXT
const secret = 'test-only-secret-never-print'

async function open() {
  const models = createModels()
  for (const id of ['alpha', 'beta', 'locked', 'broken']) {
    const faux = fauxProvider({ provider: id, models: id === 'alpha' ? [
      { id: 'reason', reasoning: true }, { id: 'plain' }, { id: 'vendor/slash' },
      { id: 'shared', reasoning: true }, { id: 'beta/shared' },
      { id: 'extended', reasoning: true }, { id: 'restricted', reasoning: true },
    ] : [{ id: 'shared', reasoning: true }] })
    models.setProvider(createProvider({
      id,
      models: faux.models.map(model => ({ ...model,
        ...(model.id === 'extended' ? { thinkingLevelMap: { xhigh: 'xhigh', max: 'max' } } : {}),
        ...(model.id === 'restricted' ? { thinkingLevelMap: { minimal: null, low: null } } : {}),
      })),
      auth: { apiKey: { name: id, resolve: async () => {
        if (id === 'broken') throw new Error(secret)
        return id === 'locked' ? undefined : { auth: { apiKey: secret, headers: { 'x-test-secret': secret } } }
      } } },
      api: { stream: faux.provider.stream, streamSimple: faux.provider.streamSimple },
    }))
  }
  const plugin = createModelsPlugin(models)
  const registry = createRegistry()
  registry.install(plugin.extension)
  const harness = await Harness.open(new MemoryStorage(), { models, registry }, context)
  const conversation = await harness.root(context)
  await conversation.configure({ model: { provider: 'alpha', modelId: 'reason' }, thinkingLevel: 'high' }, context)
  const env = { harness, conversation, context }
  return {
    ...env, models, plugin,
    model: (args = '') => plugin.commands!.model!(args, env),
    thinking: (args = '') => plugin.commands!.thinking!(args, env),
    state: () => harness.snapshot(AgentDoc, conversation.id, context),
  }
}

test('model command reads current model and only authenticated options without exposing auth', async t => {
  const env = await open()
  t.after(() => env.harness.close(context))
  assert.equal(env.plugin.name, 'models')
  assert.equal(env.plugin.extension.name, 'models')
  assert.equal(env.plugin.extension.tools?.length ?? 0, 0)
  const before = await env.state()
  const output = (await env.model()).output!
  assert.match(output, /Current model: alpha\/reason/)
  assert.match(output, /Usage: \/model/)
  assert.match(output, /beta\/shared/)
  assert.doesNotMatch(output, /locked\/|broken\/|test-only-secret/)
  const options = await getModelOptions(env.models)
  assert.ok(options.some(option => option.value === 'alpha/vendor/slash'))
  assert.ok(options.every(option => option.label && typeof option.description === 'string'))
  assert.ok(options.every(option => !option.value.startsWith('locked/') && !option.value.startsWith('broken/')))
  assert.ok(!JSON.stringify(options).includes(secret))
  assert.deepEqual(await env.state(), before)
})

test('model command supports qualified names, slash-containing ids and unique bare ids', async t => {
  const env = await open()
  t.after(() => env.harness.close(context))
  await env.model('  alpha/vendor/slash  ')
  assert.deepEqual((await env.state())?.model, { provider: 'alpha', modelId: 'vendor/slash' })
  assert.equal((await env.state())?.thinkingLevel, 'off')
  await env.model('reason')
  assert.deepEqual((await env.state())?.model, { provider: 'alpha', modelId: 'reason' })
  await env.model('vendor/slash')
  assert.deepEqual((await env.state())?.model, { provider: 'alpha', modelId: 'vendor/slash' })
  await env.model('beta/shared')
  assert.deepEqual((await env.state())?.model, { provider: 'beta', modelId: 'shared' })
})

test('unknown, ambiguous and unauthenticated model selections preserve session settings', async t => {
  const env = await open()
  t.after(() => env.harness.close(context))
  const before = await env.state()
  await assert.rejects(env.model('absent'), /Unknown model: absent/)
  await assert.rejects(env.model('shared'), /Ambiguous model: shared.*alpha\/shared.*beta\/shared/)
  await assert.rejects(env.model('locked/shared'), /No authentication configured for locked\/shared/)
  await assert.rejects(env.model('broken/shared'), error => {
    assert.match((error as Error).message, /Unable to resolve authentication/)
    assert.ok(!(error as Error).message.includes(secret))
    return true
  })
  assert.deepEqual(await env.state(), before)
})

test('model changes atomically persist supported thinking levels and clamp unavailable levels', async t => {
  const env = await open()
  t.after(() => env.harness.close(context))
  await env.model('extended')
  await env.thinking('max')
  assert.equal((await env.state())?.thinkingLevel, 'max')
  assert.match((await env.model('reason')).output!, /thinking: high/)
  assert.equal((await env.state())?.thinkingLevel, 'high')
  await env.thinking('low')
  await env.model('restricted')
  assert.equal((await env.state())?.thinkingLevel, 'medium')
  await env.model('plain')
  const state = await env.state()
  assert.deepEqual(state?.model, { provider: 'alpha', modelId: 'plain' })
  assert.equal(state?.thinkingLevel, 'off')
})

test('thinking reads levels and rejects unknown or unsupported values without changing state', async t => {
  const env = await open()
  t.after(() => env.harness.close(context))
  const before = await env.state()
  assert.match((await env.thinking()).output!, /Thinking: high\nSupported: off, minimal, low, medium, high/)
  assert.deepEqual((await getThinkingOptions(env.models, env.conversation, context)).map(option => option.value), ['off', 'minimal', 'low', 'medium', 'high'])
  for (const value of ['xhigh', 'max']) await assert.rejects(env.thinking(value), /not supported/)
  for (const value of ['HIGH', 'highest', 'low extra']) await assert.rejects(env.thinking(value), /Unknown thinking level/)
  assert.deepEqual(await env.state(), before)
  await env.thinking('  minimal  ')
  assert.equal((await env.state())?.thinkingLevel, 'minimal')
  await env.model('extended')
  assert.deepEqual((await getThinkingOptions(env.models, env.conversation, context)).map(option => option.value), ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
  await env.thinking('xhigh')
  assert.equal((await env.state())?.thinkingLevel, 'xhigh')
  await env.thinking('max')
  assert.equal((await env.state())?.thinkingLevel, 'max')
  await env.model('restricted')
  await assert.rejects(env.thinking('low'), /not supported.*Supported: off, medium, high/)
})

test('non-reasoning models only support off and missing current models fail clearly', async t => {
  const env = await open()
  t.after(() => env.harness.close(context))
  await env.model('plain')
  assert.deepEqual((await getThinkingOptions(env.models, env.conversation, context)).map(option => option.value), ['off'])
  for (const level of ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']) await assert.rejects(env.thinking(level), /not supported.*Supported: off/)
  await env.thinking('off')
  assert.equal((await env.state())?.thinkingLevel, 'off')
  await env.conversation.configure({ model: null }, context)
  await assert.rejects(env.thinking(), /No current model/)
  await assert.rejects(getThinkingOptions(env.models, env.conversation, context), /No current model/)
  assert.match((await env.model()).output!, /Current model: \(none\)/)
})
