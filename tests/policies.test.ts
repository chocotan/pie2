import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { createModels } from '@earendil-works/pi-ai/models'
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai/providers/faux'
import { getCurrentSystemPrompt, getCurrentTools } from '@earendil-works/pi-ai/utils/transcript'
import { createRegistry, Harness, MemoryStorage, type Extension } from '@earendil-works/pi-durable'
import { createCodingPlugin } from '../src/plugins/coding.ts'
import { createTasksPlugin } from '../src/plugins/tasks.ts'
import { createGoalPlugin } from '../src/plugins/goal.ts'
import { SubagentPlugin } from '../src/plugins/subagent.ts'
import { createBackgroundPlugin } from '../src/plugins/background.ts'
import { createFilesPlugin } from '../src/plugins/files.ts'
import { createWebPlugin } from '../src/plugins/web.ts'
import { createAskUserPlugin } from '../src/plugins/ask-user.ts'
import { createPlanPlugin } from '../src/plugins/plan.ts'
import { createWorkflowPlugin } from '../src/plugins/workflow.ts'
import { createRalphPlugin } from '../src/plugins/ralph.ts'
import { createUserInteraction } from '../src/interaction.ts'

async function setup(t: TestContext) {
  const cwd = await mkdtemp(join(tmpdir(), 'pie2-policies-'))
  t.after(() => rm(cwd, { recursive: true, force: true }))
  const models = createModels()
  const faux = fauxProvider()
  models.setProvider(faux.provider)
  const registry = createRegistry()
  let harness: Harness
  const interaction = createUserInteraction()
  t.after(() => interaction.close())
  const plugins = [await createCodingPlugin(cwd), createTasksPlugin(() => harness), createGoalPlugin(() => harness), SubagentPlugin, createBackgroundPlugin(() => harness),
    createFilesPlugin(), createWebPlugin(), createAskUserPlugin(interaction), createPlanPlugin(() => harness, interaction), createWorkflowPlugin(), createRalphPlugin()]
  for (const plugin of plugins) registry.install(plugin.extension)
  harness = await Harness.open(new MemoryStorage(), { models, registry }, context)
  t.after(() => harness.close(context))
  const root = await harness.root(context, { agent: { model: { provider: 'faux', modelId: 'faux-1' }, cwd } })
  async function request() {
    let prompt = ''
    let tools = getCurrentTools([])
    faux.setResponses([request => {
      prompt = getCurrentSystemPrompt(request.messages)
      tools = getCurrentTools(request.messages)
      return fauxAssistantMessage('Done.')
    }])
    const settled = await (await root.submit({ type: 'input', content: 'Describe the available workflow; do not execute any tools.' }, context)).wait(context)
    assert.equal(settled.status, 'done')
    return { prompt, tools }
  }
  return { root, request, plugins }
}

test('fresh model requests include all four DSH policies and only their public tool protocols', { timeout: 10000 }, async t => {
  const env = await setup(t)
  const { prompt, tools } = await env.request()
  for (const tag of ['task_policy', 'subagent_policy', 'background_jobs', 'goal_policy', 'files_policy', 'web_search_policy', 'ask_user_policy', 'workflow_policy', 'ralph_policy']) assert.ok(prompt.includes(`<${tag}>`), `${tag} is available before any state has been created`)
  assert.ok(!prompt.includes('<plan_policy>'), 'read-only planning rules appear only after entering plan mode')
  assert.match(prompt, /ENTIRE list/i)
  assert.match(prompt, /trivial single-step/i)
  assert.match(prompt, /background by default/i)
  assert.match(prompt, /do not (?:busy-poll|poll)/i)
  assert.match(prompt, /get_goal/)
  assert.match(prompt, /update_goal/)
  const names = tools.map(tool => tool.name)
  for (const name of ['todo_write', 'subagent', 'send_message', 'interrupt_agent', 'create_goal', 'get_goal', 'update_goal', 'bash', 'job_list', 'job_output', 'job_kill',
    'read_image', 'glob', 'grep', 'web_search', 'ask_user_question', 'enter_plan_mode', 'exit_plan_mode', 'workflow', 'ralph']) assert.ok(names.includes(name), `${name} is declared`)
  for (const name of ['TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet', 'Agent', 'AgentStatus', 'AgentStop', 'GoalSet', 'GoalGet', 'GoalUpdate', 'job_start', 'job_status']) assert.ok(!names.includes(name), `${name} is not a public alias`)
  const delegation = tools.find(tool => tool.name === 'subagent')!
  const params = delegation.parameters as { properties: Record<string, { default?: unknown }> }
  assert.equal(params.properties.run_in_background?.default, true)
  const bash = tools.find(tool => tool.name === 'bash')!
  const bashParams = bash.parameters as { required?: string[]; properties: Record<string, unknown> }
  assert.ok(bashParams.required?.includes('description'))
  assert.ok('timeoutMs' in bashParams.properties)
  assert.ok('workdir' in bashParams.properties)
  assert.ok('run_in_background' in bashParams.properties)
  assert.ok(!('timeout' in bashParams.properties))
})

for (const [name, section, withdrawn] of [
  ['tasks', 'task_policy', ['todo_write']],
  ['subagent', 'subagent_policy', ['subagent', 'send_message', 'interrupt_agent']],
  ['goal', 'goal_policy', ['get_goal', 'create_goal', 'update_goal']],
  ['background', 'background_jobs', ['job_list', 'job_output', 'job_kill']],
  ['files', 'files_policy', ['read_image', 'glob', 'grep']],
  ['web', 'web_search_policy', ['web_search']],
  ['askUser', 'ask_user_policy', ['ask_user_question']],
  ['plan', 'plan_policy', ['enter_plan_mode', 'exit_plan_mode']],
  ['workflow', 'workflow_policy', ['workflow']],
  ['ralph', 'ralph_policy', ['ralph']],
] as const) {
  test(`removing ${name} withdraws its policy and model tools`, { timeout: 10000 }, async t => {
    const env = await setup(t)
    await env.request()
    const extension = env.plugins.find(plugin => plugin.name === name)!.extension as Extension
    await env.root.configure({ extensions: { remove: [extension] } }, context)
    const { prompt, tools } = await env.request()
    assert.ok(!prompt.includes(`<${section}>`))
    for (const tool of withdrawn) assert.ok(!tools.some(entry => entry.name === tool))
    if (name === 'background') {
      const parameters = tools.find(tool => tool.name === 'bash')!.parameters as { properties: Record<string, unknown>; required?: string[] }
      assert.ok(!('run_in_background' in parameters.properties))
      assert.ok(parameters.required?.includes('description'))
      assert.ok('timeoutMs' in parameters.properties && 'workdir' in parameters.properties)
      assert.ok(!('timeout' in parameters.properties))
      assert.ok(prompt.includes('<bash_policy>'))
    }
  })
}
