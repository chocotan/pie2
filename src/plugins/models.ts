import type { Context } from '@earendil-works/chord/context'
import type { ModelThinkingLevel } from '@earendil-works/pi-ai'
import { clampThinkingLevel, getSupportedThinkingLevels, type Models } from '@earendil-works/pi-ai/models'
import { defineExtension, type Conversation } from '@earendil-works/pi-durable'
import type { Plugin } from '../plugin.ts'

type Option = { value: string; label: string; description: string }
const thinkingLevels: readonly ModelThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

export async function getModelOptions(models: Models): Promise<Option[]> {
  const available = (await Promise.all(models.getProviders().map(async provider => {
    try { return await models.getAvailable(provider.id) }
    catch { return [] }
  }))).flat()
  return available.map(model => ({
    value: `${model.provider}/${model.id}`,
    label: `${model.provider}/${model.id}`,
    description: `${model.name} · context ${model.contextWindow} · ${model.reasoning ? 'reasoning' : 'no thinking'}`,
  }))
}

async function currentModel(models: Models, conversation: Conversation, context: Context) {
  const agent = await conversation.agent(context)
  const model = agent.model && models.getModel(agent.model.provider, agent.model.modelId)
  if (!model) throw new Error('No current model is available. Use /model <provider/model> first.')
  return { agent, model }
}

export async function getThinkingOptions(models: Models, conversation: Conversation, context: Context): Promise<Option[]> {
  const { model } = await currentModel(models, conversation, context)
  return getSupportedThinkingLevels(model).map(level => ({
    value: level, label: level,
    description: level === 'off' ? 'Disable thinking' : `Thinking effort: ${level}`,
  }))
}

export function createModelsPlugin(models: Models): Plugin {
  return {
    name: 'models',
    extension: defineExtension({ name: 'models' }),
    commands: {
      model: async (args, { conversation, context }) => {
        const requested = args.trim()
        const agent = await conversation.agent(context)
        if (!requested) {
          const options = await getModelOptions(models)
          return { output: [
            `Current model: ${agent.model ? `${agent.model.provider}/${agent.model.modelId}` : '(none)'}`,
            'Usage: /model <provider/model | unique model id>',
            'Available models:',
            ...options.map(option => `  ${option.value}`),
            ...(!options.length ? ['  (none with configured authentication)'] : []),
          ].join('\n') }
        }
        const catalogue = models.getModels()
        const exact = catalogue.find(model => `${model.provider}/${model.id}` === requested)
        const matches = exact ? [exact] : catalogue.filter(model => model.id === requested)
        if (!matches.length) throw new Error(`Unknown model: ${requested}. Use /model to list available models.`)
        if (matches.length > 1) throw new Error(`Ambiguous model: ${requested}. Use one of: ${matches.map(model => `${model.provider}/${model.id}`).join(', ')}`)
        const model = matches[0]!
        let authenticated: boolean
        try { authenticated = !!await models.getAuth(model) }
        catch { throw new Error(`Unable to resolve authentication for ${model.provider}/${model.id}. Check provider configuration.`) }
        if (!authenticated) throw new Error(`No authentication configured for ${model.provider}/${model.id}. Check provider configuration.`)
        const thinkingLevel = clampThinkingLevel(model, agent.thinkingLevel)
        await conversation.configure({ model: { provider: model.provider, modelId: model.id }, thinkingLevel }, context)
        return { output: `Model: ${model.provider}/${model.id} · thinking: ${thinkingLevel}` }
      },
      thinking: async (args, { conversation, context }) => {
        const { agent, model } = await currentModel(models, conversation, context)
        const supported = getSupportedThinkingLevels(model)
        const requested = args.trim()
        if (!requested) return { output: `Thinking: ${clampThinkingLevel(model, agent.thinkingLevel)}\nSupported: ${supported.join(', ')}\nUsage: /thinking <level>` }
        if (!thinkingLevels.includes(requested as ModelThinkingLevel)) throw new Error(`Unknown thinking level: ${requested}. Expected: ${thinkingLevels.join(', ')}`)
        const thinkingLevel = requested as ModelThinkingLevel
        if (!supported.includes(thinkingLevel)) throw new Error(`Thinking level ${thinkingLevel} is not supported by ${model.provider}/${model.id}. Supported: ${supported.join(', ')}`)
        await conversation.configure({ thinkingLevel }, context)
        return { output: `Thinking: ${thinkingLevel}` }
      },
    },
  }
}
