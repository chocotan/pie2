import type { Model, ProviderStreams } from '@earendil-works/pi-ai'
import { createModels, createProvider } from '@earendil-works/pi-ai/models'
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai'
import { deepseekProvider } from '@earendil-works/pi-ai/providers/deepseek'
import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import { openAIResponsesApi } from '@earendil-works/pi-ai/api/openai-responses.lazy'
import { anthropicMessagesApi } from '@earendil-works/pi-ai/api/anthropic-messages.lazy'
import { mergeModel, readModelConfiguration, resolveConfigValue, resolveHeaders } from './model-config.ts'

type Api = 'openai-completions' | 'openai-responses' | 'anthropic-messages'
const transports: Record<Api, () => ProviderStreams> = {
  'openai-completions': openAICompletionsApi, 'openai-responses': openAIResponsesApi, 'anthropic-messages': anthropicMessagesApi,
}
const defaults = new Map([['deepseek', 'deepseek-flash'], ['openai', 'gpt-4.1'], ['anthropic', 'claude-sonnet-4-5']])
const zeroCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }

function validateBaseUrl(value: string) {
  try {
    const url = new URL(value)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error()
  } catch { throw new Error('base URL must be HTTP(S) without embedded credentials') }
}

export async function configureModels(options: { cwd?: string; configDir?: string; provider?: string; model?: string; baseUrl?: string } = {}) {
  const { providers, settings, webSearch } = await readModelConfiguration(options)
  const provider = options.provider ?? process.env.PIE2_PROVIDER ?? settings.defaultProvider ?? 'deepseek'
  const modelId = options.model ?? process.env.PIE2_MODEL ??
    ((!settings.defaultProvider || settings.defaultProvider === provider) ? settings.defaultModel : undefined) ??
    defaults.get(provider) ?? providers[provider]?.models?.[0]?.id
  if (!modelId) throw new Error('Set defaultModel in config.json or supply --model for this provider')
  const models = createModels()
  for (const factory of [deepseekProvider, openaiProvider, anthropicProvider]) models.setProvider(factory())
  const baseUrl = options.baseUrl ?? process.env.PIE2_BASE_URL
  if (baseUrl) {
    validateBaseUrl(baseUrl)
    const previous = providers[provider] ?? {}
    providers[provider] = {
      ...previous, baseUrl, api: 'openai-completions',
      models: (previous.models ?? []).map(model => model.id === modelId ? { ...model, baseUrl, api: 'openai-completions' } : model),
    }
    if (!providers[provider]!.models!.some(model => model.id === modelId) && !models.getModel(provider, modelId)) {
      providers[provider]!.models!.push({ id: modelId })
    }
  }
  for (const [id, config] of Object.entries(providers)) {
    const builtin = models.getProvider(id)
    const catalogue = new Map<string, Model<Api>>()
    for (const entry of builtin?.getModels() ?? []) {
      const api = config.api ?? entry.api
      if (!(api in transports)) throw new Error(`Unsupported model API for provider ${id}`)
      catalogue.set(entry.id, {
        ...entry, api: api as Api, baseUrl: config.baseUrl ?? entry.baseUrl,
        compat: { ...entry.compat, ...config.compat },
      })
    }
    for (const entry of config.models ?? []) {
      const previous = catalogue.get(entry.id)
      const api = entry.api ?? config.api ?? previous?.api
      const url = entry.baseUrl ?? config.baseUrl ?? previous?.baseUrl ?? builtin?.baseUrl
      if (!api || !(api in transports) || !url) throw new Error(`Provider ${id} model ${entry.id} requires baseUrl and a supported api in config.json`)
      const combined = mergeModel(previous ?? { id: entry.id }, entry)
      catalogue.set(entry.id, {
        name: entry.id, reasoning: false, input: ['text'], contextWindow: 128000, maxTokens: 16384,
        ...combined, id: entry.id, api: api as Api, provider: id, baseUrl: url,
        cost: { ...zeroCost, ...previous?.cost, ...entry.cost },
        compat: { ...previous?.compat, ...config.compat, ...entry.compat },
      })
    }
    for (const [name, override] of Object.entries(config.modelOverrides ?? {})) {
      const previous = catalogue.get(name)
      if (previous) catalogue.set(name, { ...mergeModel(previous, override), id: name })
    }
    const definitions = [...catalogue.values()]
    for (const model of definitions) {
      validateBaseUrl(model.baseUrl)
      if (model.maxTokens > model.contextWindow) throw new Error(`Provider ${id} model ${model.id}: maxTokens exceeds contextWindow`)
      if (model.headers) model.headers = resolveHeaders(model.headers)
    }
    if (!builtin && !definitions.length) throw new Error(`Custom provider ${id} requires at least one model in config.json`)
    const api = Object.fromEntries([...new Set(definitions.map(model => model.api))].map(name => [name, transports[name]()]))
    models.setProvider(createProvider({
      id, name: config.name ?? builtin?.name ?? id, baseUrl: config.baseUrl ?? builtin?.baseUrl,
      models: definitions, api,
      auth: { apiKey: {
        name: config.name ?? id,
        resolve: async authContext => {
          const fallback = process.env.PIE2_API_KEY ?? process.env[`${id.toUpperCase().replaceAll('-', '_')}_API_KEY`]
          const key = config.apiKey === undefined ? fallback : resolveConfigValue(config.apiKey, `Provider ${id} apiKey`)
          const inherited = key ? { auth: { apiKey: key }, source: config.apiKey === undefined ? 'environment' : 'config.json' } : await builtin?.auth.apiKey?.resolve(authContext)
          const headers = resolveHeaders(config.headers)
          if (!inherited && !Object.keys(headers).length) return undefined
          return { auth: { ...inherited?.auth, headers: { ...inherited?.auth.headers, ...headers, ...(config.authHeader && key ? { Authorization: `Bearer ${key}` } : {}) } }, source: inherited?.source ?? 'config.json' }
        },
      } },
    }))
  }
  if (!models.getProvider(provider)) throw new Error('Unknown provider; define it in config.json or supply --base-url for an OpenAI-compatible endpoint')
  if (!models.getModel(provider, modelId)) throw new Error(`Unknown model ${provider}/${modelId}; define it in config.json or use --model`)
  const search = { ...webSearch, ...(webSearch.endpoint ? { endpoint: resolveConfigValue(webSearch.endpoint, 'Web search endpoint') } : {}) }
  if (search.endpoint) validateBaseUrl(search.endpoint)
  return { models, model: { provider, modelId }, thinkingLevel: settings.defaultThinkingLevel, webSearch: search }
}
