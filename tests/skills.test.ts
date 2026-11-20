import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test, { type TestContext } from 'node:test'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import type { PromptInput, ToolExecutionApi } from '@earendil-works/pi-durable'
import type { CommandContext, Plugin } from '../src/plugin.ts'
import { createSkillsPlugin } from '../src/plugins/skills.ts'

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'pie2-skills-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const cwd = join(root, 'project')
  const home = join(root, 'home')
  await mkdir(cwd, { recursive: true })
  await mkdir(home, { recursive: true })
  return { cwd, home, root }
}

async function skill(path: string, metadata: string, body = '# Full instructions\nRead references/example.md.') {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `---\n${metadata}\n---\n${body}\n`)
}

async function catalog(plugin: Plugin) {
  return await plugin.extension.sections![0]!.render({} as PromptInput, BACKGROUND_CONTEXT) ?? ''
}

async function command(plugin: Plugin, name: string, args = '') {
  return plugin.commands![name]!(args, {} as CommandContext)
}

async function invoke(plugin: Plugin, name: string) {
  return plugin.extension.tools![0]!.execute({ name }, {} as ToolExecutionApi, BACKGROUND_CONTEXT)
}

function output(result: Awaited<ReturnType<typeof invoke>>) {
  return result.output?.map(item => item.type === 'text' ? item.text : '').join('') ?? ''
}

test('discovers default and extra directories recursively, advertising only metadata', async t => {
  const options = await fixture(t)
  const paths = [
    join(options.cwd, '.agents/skills/group/project/SKILL.md'),
    join(options.cwd, '.pi/skills/local/SKILL.md'),
    join(options.home, '.agents/skills/user/SKILL.md'),
    join(options.home, '.pi/agent/skills/legacy/SKILL.md'),
    join(options.cwd, 'extras/nested/custom/SKILL.md'),
  ]
  for (const [index, path] of paths.entries()) await skill(path, `name: skill-${index}\ndescription: Description ${index}`)
  const plugin = await createSkillsPlugin({ ...options, directories: ['extras'] })
  const advertised = await catalog(plugin)
  for (const [index, path] of paths.entries()) {
    assert.ok(advertised.includes(`skill-${index}`))
    assert.ok(advertised.includes(path))
  }
  assert.ok(!advertised.includes('Full instructions'))
  assert.ok((await command(plugin, 'skills')).output!.includes('skill-4'))
})

test('project skills take precedence over duplicate user and extra skills', async t => {
  const options = await fixture(t)
  await skill(join(options.cwd, '.agents/skills/a/SKILL.md'), 'name: shared\ndescription: Project wins', 'Project body')
  await skill(join(options.home, '.agents/skills/b/SKILL.md'), 'name: shared\ndescription: User loses', 'User body')
  await skill(join(options.cwd, 'extras/c/SKILL.md'), 'name: shared\ndescription: Extra loses', 'Extra body')
  const plugin = await createSkillsPlugin({ ...options, directories: ['extras'] })
  assert.ok((await catalog(plugin)).includes('Project wins'))
  assert.ok(!(await catalog(plugin)).includes('User loses'))
  assert.ok(output(await invoke(plugin, 'shared')).includes('Project body'))
  assert.ok((await command(plugin, 'skills')).output!.includes('duplicate shared'))
})

test('parses multiline YAML descriptions and reads fresh full instructions on demand', async t => {
  const options = await fixture(t)
  const path = join(options.cwd, '.pi/skills/writer/SKILL.md')
  await skill(path, 'name: writer\ndescription: >\n  Write clear text\n  and edit prose.')
  const plugin = await createSkillsPlugin(options)
  assert.ok((await catalog(plugin)).includes('Write clear text and edit prose.'))
  await skill(path, 'name: writer\ndescription: Updated', '# Updated body')
  const loaded = output(await invoke(plugin, 'writer'))
  assert.ok(loaded.includes('# Updated body'))
  assert.ok(loaded.includes(`Resolve all relative paths against: ${dirname(path)}`))
  assert.ok(loaded.includes('---\nname: writer'))
})

test('explicit skill commands append the request, and handle usage and unknown names', async t => {
  const options = await fixture(t)
  await skill(join(options.cwd, '.agents/skills/review/SKILL.md'), 'name: review\ndescription: Review code')
  const plugin = await createSkillsPlugin(options)
  const result = await command(plugin, 'skill', 'review check src/main.ts\nand tests')
  assert.ok(result.prompt!.includes('# Full instructions'))
  assert.ok(result.prompt!.endsWith('User request:\ncheck src/main.ts\nand tests'))
  assert.match((await command(plugin, 'skill')).output!, /Usage:/)
  assert.match((await command(plugin, 'skill', '../../secret')).output!, /Unknown skill/)
  assert.equal((await invoke(plugin, 'missing')).isError, true)
})

test('disabled skills are hidden from the model and available through explicit commands', async t => {
  const options = await fixture(t)
  await skill(join(options.cwd, '.agents/skills/manual/SKILL.md'), 'name: manual\ndescription: Manual only\ndisable-model-invocation: true')
  const plugin = await createSkillsPlugin(options)
  assert.equal(await catalog(plugin), '')
  assert.equal((await invoke(plugin, 'manual')).isError, true)
  assert.ok((await command(plugin, 'skill', 'manual requested')).prompt!.includes('# Full instructions'))
  assert.ok((await command(plugin, 'skills')).output!.includes('manual (explicit only)'))
})

test('follows symlinked skill directories and terminates cycles without duplicates', async t => {
  const options = await fixture(t)
  const root = join(options.cwd, '.agents/skills')
  const external = join(options.root, 'external')
  await skill(join(external, 'linked/SKILL.md'), 'name: linked\ndescription: Linked directory')
  await mkdir(root, { recursive: true })
  await symlink(external, join(root, 'external'), 'dir')
  await symlink(root, join(external, 'cycle'), 'dir')
  await symlink(join(external, 'linked'), join(root, 'second-link'), 'dir')
  const plugin = await createSkillsPlugin(options)
  assert.equal((await catalog(plugin)).match(/"name":"linked"/g)?.length, 1)
  assert.ok(output(await invoke(plugin, 'linked')).includes('# Full instructions'))
  assert.ok(!(await command(plugin, 'skills')).output!.includes('duplicate'))
})

test('rejects invalid metadata, malformed YAML, and oversized skills with diagnostics', async t => {
  const options = await fixture(t)
  const root = join(options.cwd, '.pi/skills')
  await skill(join(root, 'bad-name/SKILL.md'), 'name: Invalid_Name\ndescription: Bad')
  await skill(join(root, 'missing-description/SKILL.md'), 'name: missing-description')
  await skill(join(root, 'bad-description/SKILL.md'), 'name: bad-description\ndescription: [not, text]')
  await skill(join(root, 'bad-yaml/SKILL.md'), 'name: [broken\ndescription: Bad')
  await skill(join(root, 'bad-flag/SKILL.md'), 'name: bad-flag\ndescription: Bad\ndisable-model-invocation: "true"')
  await skill(join(root, 'huge/SKILL.md'), 'name: huge\ndescription: Huge', 'x'.repeat(256 * 1024))
  const plugin = await createSkillsPlugin(options)
  assert.equal(await catalog(plugin), '')
  const list = (await command(plugin, 'skills')).output!
  assert.match(list, /No skills found/)
  assert.match(list, /Invalid skill name/)
  assert.match(list, /Description must contain/)
  assert.match(list, /disable-model-invocation must be boolean/)
  assert.match(list, /256 KiB/)
})

test('reports file deletion during invocation instead of returning stale instructions', async t => {
  const options = await fixture(t)
  const path = join(options.cwd, '.pi/skills/temporary/SKILL.md')
  await skill(path, 'name: temporary\ndescription: Temporary skill')
  const plugin = await createSkillsPlugin(options)
  await rm(path)
  assert.equal((await invoke(plugin, 'temporary')).isError, true)
  assert.match((await command(plugin, 'skill', 'temporary')).output!, /ENOENT/)
})
