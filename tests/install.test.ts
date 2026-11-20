import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const root = fileURLToPath(new URL('../', import.meta.url))
const installer = new URL('../src/install.ts', import.meta.url).href
const bin = join(root, 'bin/pie2.mjs')

async function workspace(t: TestContext) {
  const path = await mkdtemp(join(tmpdir(), 'pie2-install-'))
  t.after(() => rm(path, { recursive: true, force: true }))
  return path
}

function options(cwd: string) {
  return {
    cwd, encoding: 'utf8' as const, timeout: 7_000,
    env: { ...process.env, HOME: cwd, NODE_NO_WARNINGS: '1', npm_config_cache: join(cwd, 'npm cache') },
  }
}

function install(cwd: string, args: string[]) {
  return exec(process.execPath, ['--input-type=module', '-e',
    `const {installCommand} = await import(${JSON.stringify(installer)}); await installCommand(JSON.parse(process.argv[1]))`,
    JSON.stringify(args)], options(cwd))
}

test('install help and invalid arguments are side-effect free, even with invalid model config', async t => {
  const cwd = await workspace(t)
  await mkdir(join(cwd, '.pie2'))
  await writeFile(join(cwd, '.pie2/config.json'), 'broken config')
  const help = await install(cwd, ['--help'])
  assert.match(help.stdout, /Usage: pie2 install/)
  for (const args of [['--wat'], ['--prefix'], ['--prefix', '--help'], ['--prefix', 'one', '--prefix', 'two']]) {
    await assert.rejects(install(cwd, args), /Unknown install option|Supply --prefix/)
  }
  assert.deepEqual(await readdir(cwd), ['.pie2'])
})

test('install links a runnable source command using an isolated prefix with shell metacharacters', async t => {
  const cwd = await workspace(t)
  const prefix = join(cwd, 'space $(touch SHOULD_NOT_EXIST); prefix')
  const result = await install(cwd, ['--prefix', prefix])
  const command = join(prefix, 'bin/pie2')
  assert.match(result.stdout, /Installed pie2:/)
  assert.ok(result.stdout.includes(command))
  assert.match(result.stdout, /Keep this directory in place/)
  assert.equal(await realpath(command), await realpath(bin))
  const help = await exec(process.execPath, [command, '--help'], options(cwd))
  assert.match(help.stdout, /Usage: pie2/)
  assert.ok(!(await readdir(cwd)).includes('SHOULD_NOT_EXIST'))
  assert.ok(!(await readdir(cwd)).includes('.pie2'))
  const repeated = await install(cwd, ['--prefix', prefix])
  assert.match(repeated.stdout, /Installed pie2:/)
})

test('install refuses unrelated commands and other package installations', async t => {
  const cwd = await workspace(t)
  const prefix = join(cwd, 'prefix')
  await mkdir(join(prefix, 'bin'), { recursive: true })
  await writeFile(join(prefix, 'bin/pie2'), 'unrelated command')
  await assert.rejects(install(cwd, ['--prefix', prefix]), /Refusing to overwrite an unrelated command/)
  assert.equal(await readFile(join(prefix, 'bin/pie2'), 'utf8'), 'unrelated command')
  await rm(join(prefix, 'bin/pie2'))
  await mkdir(join(prefix, 'lib/node_modules/pie2'), { recursive: true })
  await assert.rejects(install(cwd, ['--prefix', prefix]), /Refusing to replace another installation/)
})

test('launcher keeps source edits live and reports source import failures without falling back', async t => {
  const cwd = await workspace(t)
  await mkdir(join(cwd, 'bin'))
  await mkdir(join(cwd, 'src'))
  await mkdir(join(cwd, 'dist'))
  await cp(bin, join(cwd, 'bin/pie2.mjs'))
  await writeFile(join(cwd, 'package.json'), '{"type":"module"}')
  await writeFile(join(cwd, 'dist/cli.js'), 'export async function main() { console.log("stale build") }')
  const source = join(cwd, 'src/cli.ts')
  await writeFile(source, 'export async function main(): Promise<void> { console.log("live source") }')
  assert.equal((await exec(process.execPath, [join(cwd, 'bin/pie2.mjs')], options(cwd))).stdout, 'live source\n')
  await writeFile(source, 'import "./missing-dependency.ts"; export async function main() {}')
  await assert.rejects(exec(process.execPath, [join(cwd, 'bin/pie2.mjs')], options(cwd)), error => {
    const result = error as Error & { stdout: string; stderr: string }
    assert.equal(result.stdout, '')
    assert.match(result.stderr, /missing-dependency/)
    return true
  })
})

test('distribution builds relative JavaScript imports and runs under node_modules without sources', { timeout: 10_000 }, async t => {
  const cwd = await workspace(t)
  await exec(process.execPath, [join(root, 'bin/build.mjs')], options(root))
  const built = await readFile(join(root, 'dist/cli.js'), 'utf8')
  assert.match(built, /\.\/models\.js/)
  assert.doesNotMatch(built, /(?:from|import\()\s*['"]\.\.?\/[^'"]+\.ts['"]/)
  const packed = await exec('npm', ['pack', '--dry-run', '--json', '--ignore-scripts', '--offline'], { ...options(cwd), cwd: root })
  const files: string[] = JSON.parse(packed.stdout)[0].files.map((file: { path: string }) => file.path)
  assert.ok(files.includes('dist/cli.js'))
  assert.ok(files.includes('bin/pie2.mjs'))
  assert.ok(files.includes('examples/config/config.json'))
  for (const file of files) {
    assert.match(file, /^(?:package\.json|README\.md|bin\/pie2\.mjs|dist\/.+\.js|examples\/config\/config\.json)$/)
  }
  const destination = join(cwd, 'node_modules/pie2')
  await mkdir(destination, { recursive: true })
  for (const name of ['package.json', 'bin', 'dist']) await cp(join(root, name), join(destination, name), { recursive: true })
  await symlink(join(root, 'node_modules'), join(destination, 'node_modules'), 'dir')
  for (const entry of ['bin/pie2.mjs', 'dist/cli.js']) {
    const result = await exec(process.execPath, [join(destination, entry), '--help'], options(cwd))
    assert.match(result.stdout, /Usage: pie2/)
    assert.doesNotMatch(result.stderr, /ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING/)
  }
  const prefix = join(cwd, 'global prefix')
  const globalRoot = join(prefix, 'lib/node_modules/pie2')
  await mkdir(join(prefix, 'bin'), { recursive: true })
  await cp(destination, globalRoot, { recursive: true })
  await symlink(join(globalRoot, 'bin/pie2.mjs'), join(prefix, 'bin/pie2'))
  const installedModule = new URL(`file://${join(globalRoot, 'dist/install.js')}`).href
  const repeated = await exec(process.execPath, ['--input-type=module', '-e',
    `const {installCommand}=await import(${JSON.stringify(installedModule)});await installCommand(["--prefix",process.argv[1]])`, prefix], options(cwd))
  assert.match(repeated.stdout, /Already installed pie2:/)
  assert.equal((await lstat(globalRoot)).isSymbolicLink(), false)
  assert.equal(await realpath(join(prefix, 'bin/pie2')), await realpath(join(globalRoot, 'bin/pie2.mjs')))
  assert.ok(!(await readdir(cwd)).includes('.pie2'))
})
