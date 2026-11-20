import assert from 'node:assert/strict'
import { test } from 'node:test'
import { BACKGROUND_CONTEXT as context, withAbortSignal } from '@earendil-works/chord/context'
import { createModels } from '@earendil-works/pi-ai/models'
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import { createRegistry, defineExtension, Harness, MemoryStorage } from '@earendil-works/pi-durable'
import { createUserInteraction, type UserQuestion } from '../src/interaction.ts'
import { createAskUserPlugin } from '../src/plugins/ask-user.ts'

const questions: UserQuestion[] = [{ id: 'mode', question: 'Which mode?', options: [{ label: 'Fast' }, { label: 'Thorough' }] }]

test('questions require an explicit valid answer; missing UI, duplicate IDs and invalid choices never grant approval', async () => {
  const interaction = createUserInteraction()
  await assert.rejects(interaction.ask(questions, context), /interactive terminal/)
  interaction.attach(async () => [{ id: 'mode', selected: ['Approve'] }])
  await assert.rejects(interaction.ask(questions, context), /invalid choice/)
  await assert.rejects(interaction.ask([...questions, ...questions], context), /unique/)
  interaction.attach(async () => [{ id: 'mode', selected: [] }])
  await assert.rejects(interaction.ask(questions, context), /not answered/)
  interaction.attach(async () => [{ id: 'mode', selected: ['Fast', 'Thorough'] }])
  await assert.rejects(interaction.ask(questions, context), /only one/)
  const multi = [{ ...questions[0]!, multiSelect: true }]
  assert.deepEqual(await interaction.ask(multi, context), [{ id: 'mode', selected: ['Fast', 'Thorough'] }])
  interaction.attach(async () => [{ id: 'mode', selected: [], custom: 'A different approach' }])
  assert.equal((await interaction.ask(questions, context))[0]!.custom, 'A different approach')
  interaction.close()
})

test('question batches serialize, a queued cancellation is immediate, and closing aborts the active UI', { timeout: 2000 }, async () => {
  const interaction = createUserInteraction()
  const seen: string[] = []
  let finish!: () => void
  const gate = new Promise<void>(resolve => { finish = resolve })
  interaction.attach(async (batch, ctx) => {
    seen.push(batch[0]!.id)
    await Promise.race([gate, new Promise<never>((_resolve, reject) => ctx.abortSignal!.addEventListener('abort', () => reject(new Error('UI aborted')), { once: true }))])
    return [{ id: batch[0]!.id, selected: ['Fast'] }]
  })
  const first = interaction.ask(questions, context)
  const controller = new AbortController()
  const second = interaction.ask([{ ...questions[0]!, id: 'queued' }], withAbortSignal(controller.signal, context))
  controller.abort()
  await assert.rejects(second, /cancelled/)
  assert.deepEqual(seen, ['mode'])
  finish()
  await first
  const active = interaction.ask([{ ...questions[0]!, id: 'closing' }], context)
  interaction.close()
  await assert.rejects(active, /cancelled/)
  await assert.rejects(interaction.ask(questions, context), /no answer or approval/)
})

test('native ask_user_question returns stable IDs and its receipt prevents asking twice on replay', { timeout: 5000 }, async t => {
  const models = createModels()
  const faux = fauxProvider()
  models.setProvider(faux.provider)
  const interaction = createUserInteraction()
  t.after(() => interaction.close())
  let asked = 0
  interaction.attach(async batch => { asked++; return [{ id: batch[0]!.id, selected: ['Fast'] }] })
  const plugin = createAskUserPlugin(interaction)
  const original = plugin.extension.tools![0]!
  const registry = createRegistry()
  registry.install(defineExtension({ ...plugin.extension, tools: [{ ...original, execute: async (args, api, ctx) => {
    const first = await original.execute(args, api, ctx)
    assert.deepEqual(await original.execute(args, api, ctx), first)
    return first
  } }] }))
  const harness = await Harness.open(new MemoryStorage(), { models, registry }, context)
  t.after(() => harness.close(context))
  const root = await harness.root(context, { agent: { model: { provider: 'faux', modelId: 'faux-1' } } })
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall('ask_user_question', { questions: [{ id: 'mode', question: 'Which mode?', options: [{ label: 'Fast' }, { label: 'Thorough' }] }] }), { stopReason: 'toolUse' }),
    fauxAssistantMessage('Using your selection.'),
  ])
  assert.equal((await (await root.submit({ type: 'input', content: 'Let me choose the implementation mode.' }, context)).wait(context)).status, 'done')
  const result = (await root.context(context)).messages.find(message => message.role === 'toolResult')
  assert.ok(result?.role === 'toolResult')
  assert.deepEqual(JSON.parse(result.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('')), { answers: [{ id: 'mode', selected: ['Fast'] }] })
  assert.equal(asked, 1)
})
