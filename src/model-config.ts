import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { Type, type Static } from 'typebox'
import { Value } from 'typebox/value'
import { ModelInputLimitsSchema, ModelThinkingLevelSchema, ThinkingLevelMapSchema } from '@earendil-works/pi-ai/providers/model-schema'
import { ProviderCompatSchema } from '@earendil-works/pi-ai/providers/compat-schema'

const nonempty = Type.String({ minLength: 1, pattern: '\\S' })
const headerValues = Type.Record(Type.String({ pattern: "^[!#$%&'*+.^_`|~0-9A-Za-z-]+$" }), Type.String({ pattern: '^[^\\r\\n]*$' }))
const api = Type.Enum(['openai-completions', 'openai-responses', 'anthropic-messages'])
const cost = Type.Object({
  input: Type.Optional(Type.Number({ minimum: 0 })), output: Type.Optional(Type.Number({ minimum: 0 })),
  cacheRead: Type.Optional(Type.Number({ minimum: 0 })), cacheWrite: Type.Optional(Type.Number({ minimum: 0 })),
}, { additionalProperties: false })
const modelFields = {
  name: Type.Optional(nonempty), reasoning: Type.Optional(Type.Boolean()),
  input: Type.Optional(Type.Array(Type.Union([Type.Literal('text'), Type.Literal('image')]), { minItems: 1, uniqueItems: true })),
  contextWindow: Type.Optional(Type.Integer({ minimum: 1 })), maxTokens: Type.Optional(Type.Integer({ minimum: 1 })),
  cost: Type.Optional(cost), compat: Type.Optional(ProviderCompatSchema),
  thinkingLevelMap: Type.Optional(ThinkingLevelMapSchema), inputLimits: Type.Optional(ModelInputLimitsSchema),
  headers: Type.Optional(headerValues), samplingParams: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
}
const modelSchema = Type.Object({
  id: nonempty, api: Type.Optional(api), baseUrl: Type.Optional(nonempty), ...modelFields,
}, { additionalProperties: false })
const overrideSchema = Type.Object(modelFields, { additionalProperties: false })
const providerSchema = Type.Object({
  name: Type.Optional(nonempty), baseUrl: Type.Optional(nonempty), api: Type.Optional(api),
  apiKey: Type.Optional(nonempty), headers: Type.Optional(headerValues), authHeader: Type.Optional(Type.Boolean()),
  compat: Type.Optional(ProviderCompatSchema), models: Type.Optional(Type.Array(modelSchema)),
  modelOverrides: Type.Optional(Type.Record(Type.String(), overrideSchema)),
}, { additionalProperties: false })
const configSchema = Type.Object({
  $schema: Type.Optional(Type.String()), providers: Type.Optional(Type.Record(nonempty, providerSchema)),
  defaultProvider: Type.Optional(nonempty), defaultModel: Type.Optional(nonempty),
  defaultThinkingLevel: Type.Optional(ModelThinkingLevelSchema),
  webSearch: Type.Optional(Type.Object({ endpoint: Type.Optional(nonempty),
    timeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: 120000 })),
  }, { additionalProperties: false })),
}, { additionalProperties: false })

export type ModelConfig = Static<typeof modelSchema>
export type ProviderConfig = Static<typeof providerSchema>
export type ModelSettings = Pick<Static<typeof configSchema>, 'defaultProvider' | 'defaultModel' | 'defaultThinkingLevel'>

async function readConfig(path: string): Promise<Static<typeof configSchema> | undefined> {
  let content: string
  try { content = await readFile(path, 'utf8') }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error }
  let value: unknown
  try { value = JSON.parse(content) } catch { throw new Error(`Invalid JSON in ${path}`) }
  if (!Value.Check(configSchema, value)) {
    const locations = [...Value.Errors(configSchema, value)].map(error => error.instancePath || '/').slice(0, 5)
    throw new Error(`Invalid configuration in ${path}: ${locations.join(', ')}`)
  }
  return value as Static<typeof configSchema>
}

export function mergeModel<T extends Omit<ModelConfig, 'id'> & { id?: string }>(base: T, overlay: Omit<ModelConfig, 'id'> & { id?: string }): T {
  return {
    ...base, ...overlay,
    ...(base.cost || overlay.cost ? { cost: { ...base.cost, ...overlay.cost } } : {}),
    ...(base.compat || overlay.compat ? { compat: { ...base.compat, ...overlay.compat } } : {}),
    ...(base.headers || overlay.headers ? { headers: { ...base.headers, ...overlay.headers } } : {}),
  }
}

export async function readModelConfiguration(options: { cwd?: string; configDir?: string }) {
  const directory = resolve(options.configDir ?? process.env.PIE2_CONFIG_DIR ?? join(homedir(), '.pie2'))
  const directories = [...new Set([directory, resolve(options.cwd ?? process.cwd(), '.pie2')])]
  const providers: Record<string, ProviderConfig> = Object.create(null)
  let settings: ModelSettings = {}
  let webSearch: NonNullable<Static<typeof configSchema>['webSearch']> = {}
  for (const dir of directories) {
    const definitions = await readConfig(join(dir, 'config.json'))
    const { providers: _providers, $schema: _schema, webSearch: search, ...selection } = definitions ?? {}
    webSearch = { ...webSearch, ...search }
    for (const [id, next] of Object.entries(definitions?.providers ?? {})) {
      const previous = providers[id] ?? {}
      const models = new Map((previous.models ?? []).map(model => [model.id, model]))
      const seen = new Set<string>()
      for (const model of next.models ?? []) {
        if (seen.has(model.id)) throw new Error(`Duplicate model ID for provider ${id} in ${join(dir, 'config.json')}`)
        seen.add(model.id)
        models.set(model.id, mergeModel(models.get(model.id) ?? { id: model.id }, model))
      }
      const overrides = { ...previous.modelOverrides }
      for (const [name, value] of Object.entries(next.modelOverrides ?? {})) overrides[name] = mergeModel(overrides[name] ?? {}, value)
      providers[id] = { ...previous, ...next, headers: { ...previous.headers, ...next.headers }, models: [...models.values()], modelOverrides: overrides }
    }
    settings = { ...settings, ...selection }
  }
  return { providers, settings, webSearch }
}

export function resolveConfigValue(value: string, label: string): string {
  if (value.startsWith('!')) throw new Error(`${label}: shell command values are not supported; use a literal or $ENV_VAR`)
  const resolved = value.replace(/\$\$|\$!|\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (match, braced, bare) => {
    if (match === '$$') return '$'
    if (match === '$!') return '!'
    const name: string = braced ?? bare
    const result = process.env[name]
    if (!result) throw new Error(`${label}: missing environment variable ${name}`)
    return result
  })
  if (/[\r\n]/.test(resolved)) throw new Error(`${label}: newlines are not allowed`)
  return resolved
}

export function resolveHeaders(headers: Record<string, string> | undefined): Record<string, string> {
  return Object.fromEntries(Object.entries(headers ?? {}).map(([name, value]) => [name, resolveConfigValue(value, `Header ${name}`)]))
}
