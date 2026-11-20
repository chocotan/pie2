import { createHash, randomUUID } from 'node:crypto'
import { readdir, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, isAbsolute, join, resolve } from 'node:path'

export interface SavedSession {
  id: string
  path: string
  updatedAt: number
}

async function workspaceKey(cwd: string) {
  const canonical = await realpath(resolve(cwd))
  return createHash('sha256').update(canonical).digest('hex').slice(0, 24)
}

export async function createSessionPath(cwd: string, sessionRoot = join(homedir(), '.pie2', 'sessions')): Promise<string> {
  const key = await workspaceKey(cwd)
  return join(resolve(sessionRoot), key, `${new Date().toISOString().replace(/[:.]/g, '-')}_${randomUUID()}.sqlite`)
}

export async function listSessions(cwd: string, sessionRoot = join(homedir(), '.pie2', 'sessions')): Promise<SavedSession[]> {
  const key = await workspaceKey(cwd)
  const root = resolve(sessionRoot)
  const directory = join(root, key)
  const entries = await readdir(directory, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error
    return []
  })
  const paths = entries.filter(entry => entry.isFile() && entry.name.endsWith('.sqlite')).map(entry => join(directory, entry.name))
  paths.push(join(root, `${key}.sqlite`))
  const sessions = await Promise.all(paths.map(async path => {
    const info = await stat(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error
      return undefined
    })
    return info?.isFile() ? { id: basename(path, '.sqlite'), path, updatedAt: info.mtimeMs } : undefined
  }))
  return sessions.filter((session): session is SavedSession => session !== undefined)
    .sort((a, b) => b.updatedAt - a.updatedAt || b.id.localeCompare(a.id))
}

export async function resolveSession(cwd: string, reference?: string, sessionRoot = join(homedir(), '.pie2', 'sessions')): Promise<string> {
  if (reference && isAbsolute(reference)) {
    const info = await stat(reference)
    if (!info.isFile()) throw new Error(`Not a session file: ${reference}`)
    return reference
  }
  const sessions = await listSessions(cwd, sessionRoot)
  const session = reference ? sessions.find(session => session.id === reference) : sessions[0]
  if (!session) throw new Error(reference ? `Session not found: ${reference}` : 'No saved sessions for this workspace.')
  return session.path
}
