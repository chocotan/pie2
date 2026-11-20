import { execFile } from 'node:child_process'
import { lstat, realpath } from 'node:fs/promises'
import { delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const root = fileURLToPath(new URL('../', import.meta.url))
const help = `Usage: pie2 install [--prefix <directory>]

Install the pie2 command using npm's global prefix (or --prefix).
This links the current installation; keep its directory in place.
No sudo, shell configuration changes, or registry publication is performed.

  --prefix <directory>  Choose the npm global installation directory
  -h, --help            Show this help without installing
`

async function npm(args: string[]) {
  const command = process.platform === 'win32' ? process.execPath : 'npm'
  const npmArgs = process.platform === 'win32'
    ? [join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'), ...args]
    : args
  return exec(command, npmArgs, { cwd: root, encoding: 'utf8', maxBuffer: 1024 * 1024 })
}

async function exists(path: string) {
  try { await lstat(path); return true }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

export async function installCommand(argv: string[]): Promise<void> {
  let prefix: string | undefined
  let showHelp = false
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!
    if (arg === '--help' || arg === '-h') showHelp = true
    else if (arg === '--prefix') {
      const value = argv[++index]
      if (prefix !== undefined || !value || value.startsWith('-') || value.includes('\0')) {
        throw new Error('Supply --prefix once with a non-empty directory.')
      }
      prefix = resolve(value)
    } else throw new Error(`Unknown install option: ${arg}`)
  }
  if (showHelp) { process.stdout.write(help); return }
  prefix ??= (await npm(['prefix', '--global'])).stdout.trim()
  if (!prefix) throw new Error('npm did not return a global prefix; use --prefix <directory>.')
  const binDir = process.platform === 'win32' ? prefix : join(prefix, 'bin')
  const packageDir = join(prefix, ...(process.platform === 'win32' ? [] : ['lib']), 'node_modules', 'pie2')
  const expectedBin = await realpath(join(root, 'bin/pie2.mjs'))
  const expectedRoot = await realpath(root)
  if (await exists(packageDir) && await realpath(packageDir) !== expectedRoot) {
    throw new Error(`Refusing to replace another installation at ${packageDir}. Remove it explicitly first.`)
  }
  for (const suffix of process.platform === 'win32' ? ['', '.cmd', '.ps1'] : ['']) {
    const command = join(binDir, `pie2${suffix}`)
    if (!await exists(command)) continue
    if (await realpath(command).catch(() => '') !== expectedBin) {
      throw new Error(`Refusing to overwrite an unrelated command at ${command}. Choose a different --prefix.`)
    }
  }
  const installedHere = await exists(packageDir) && !(await lstat(packageDir)).isSymbolicLink()
  if (!installedHere) {
    try {
      await npm(['install', '--global', '--prefix', prefix, '--install-links=false', '--ignore-scripts', '--offline', '--no-audit', '--no-fund', root])
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      throw new Error(`Could not install pie2 in ${prefix}. Check permissions or choose a writable --prefix. ${reason}`)
    }
  }
  process.stdout.write(`${installedHere ? 'Already installed' : 'Installed'} pie2: ${join(binDir, 'pie2')}\nLinked installation: ${expectedRoot}\nKeep this directory in place.\n`)
  if (!(process.env.PATH ?? '').split(delimiter).some(path => resolve(path) === resolve(binDir))) {
    process.stdout.write(`Add this directory to PATH: ${binDir}\n`)
  }
}
