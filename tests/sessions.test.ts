import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, realpath, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { createSessionPath, listSessions, resolveSession } from '../src/sessions.ts'

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'pie2-sessions-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const cwd = join(directory, 'workspace')
  await mkdir(cwd)
  return { directory, cwd, root: join(directory, 'sessions') }
}

test('session paths are unique, canonicalize the workspace and do not create files', async t => {
  const { directory, cwd, root } = await fixture(t)
  const alias = join(directory, 'alias')
  await symlink(cwd, alias)
  const first = await createSessionPath(cwd, root)
  const second = await createSessionPath(alias, root)
  const key = createHash('sha256').update(await realpath(cwd)).digest('hex').slice(0, 24)
  assert.equal(dirname(first), join(root, key))
  assert.equal(dirname(second), dirname(first))
  assert.notEqual(first, second)
  assert.match(basename(first), /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z_[\da-f-]{36}\.sqlite$/)
  await assert.rejects(stat(root), { code: 'ENOENT' })
  assert.deepEqual(await listSessions(cwd, root), [])
  await assert.rejects(resolveSession(cwd, undefined, root), /No saved sessions/)
})

test('lists workspace databases by modification time, including the earlier session path', async t => {
  const { cwd, root } = await fixture(t)
  const older = await createSessionPath(cwd, root)
  const newer = await createSessionPath(cwd, root)
  const key = basename(dirname(older))
  const legacy = join(root, `${key}.sqlite`)
  await mkdir(dirname(older), { recursive: true })
  for (const path of [older, newer, legacy, `${newer}-wal`, join(dirname(older), 'notes.txt')]) await writeFile(path, '')
  await mkdir(join(dirname(older), 'directory.sqlite'))
  await utimes(older, 10, 10)
  await utimes(legacy, 20, 20)
  await utimes(newer, 30, 30)
  const sessions = await listSessions(cwd, root)
  assert.deepEqual(sessions, [newer, legacy, older].map((path, index) => ({
    id: basename(path, '.sqlite'), path, updatedAt: (30 - index * 10) * 1000,
  })))
  assert.equal(await resolveSession(cwd, undefined, root), newer)
  assert.equal(await resolveSession(cwd, basename(older, '.sqlite'), root), older)
  assert.equal(await resolveSession(cwd, basename(legacy, '.sqlite'), root), legacy)
  assert.equal(await resolveSession(cwd, older, root), older)
  await assert.rejects(resolveSession(cwd, 'missing', root), /Session not found: missing/)
  await assert.rejects(resolveSession(cwd, `${newer}.missing`, root), { code: 'ENOENT' })
  await assert.rejects(resolveSession(cwd, dirname(older), root), /Not a session file/)
})

test('legacy sessions remain discoverable before the workspace session directory exists', async t => {
  const { cwd, root } = await fixture(t)
  const generated = await createSessionPath(cwd, root)
  const legacy = join(root, `${basename(dirname(generated))}.sqlite`)
  await mkdir(root)
  await writeFile(legacy, '')
  assert.deepEqual((await listSessions(cwd, root)).map(session => session.path), [legacy])
})
