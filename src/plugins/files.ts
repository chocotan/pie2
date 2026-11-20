import { spawn } from 'node:child_process'
import { stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { Context } from '@earendil-works/chord/context'
import { Type } from 'typebox'
import { defineExtension, defineTool, section, type ToolExecutionApi } from '@earendil-works/pi-durable'
import { createReadTool } from '@earendil-works/pi-durable/tools'
import { text, type Plugin } from '../plugin.ts'

const MAX_OUTPUT_BYTES = 40_000
const MAX_RECORD_BYTES = 512 * 1024
const MAX_RAW_BYTES = 4 * 1024 * 1024
const imageTypes = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])
const pathSchema = Type.String({ minLength: 1, maxLength: 4096 })
const shared = {
  path: Type.Optional(pathSchema),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000, description: 'Maximum retained results (default 100).' })),
  timeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: 120_000, description: 'Search timeout in milliseconds (default 10000).' })),
}
const matchSchema = Type.Object({ path: Type.String(), lineNumber: Type.Integer(), line: Type.String(), lineTruncated: Type.Boolean() })
const searchOutput = Type.Object({
  root: Type.String(), mode: Type.Union([Type.Literal('glob'), Type.Literal('content'), Type.Literal('files')]),
  paths: Type.Array(Type.String()), matches: Type.Array(matchSchema),
  truncated: Type.Boolean(), noMatches: Type.Boolean(),
})
type Match = { path: string; lineNumber: number; line: string; lineTruncated: boolean }

function nonblank(value: string, name: string) {
  if (!value.trim() || value.includes('\0')) throw new Error(`${name} must not be blank or contain NUL`)
}
function positive(value: number, max: number, name: string) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > max) throw new Error(`${name} must be an integer between 1 and ${max}`)
}
function utf8Head(value: string, max: number): string {
  return new TextDecoder().decode(Buffer.from(value).subarray(0, max), { stream: true })
}

async function searchRoot(path: string | undefined, api: ToolExecutionApi, context: Context, directoryOnly: boolean) {
  if (path !== undefined) nonblank(path, 'path')
  const root = resolve(api.env?.cwd ?? (await api.agent(context)).cwd ?? process.cwd(), path ?? '.')
  const info = await stat(root)
  if (!info.isDirectory() && (directoryOnly || !info.isFile())) throw new Error(`Search path must be ${directoryOnly ? 'a directory' : 'a regular file or directory'}: ${root}`)
  return root
}

// Keep both incoming records and total subprocess output bounded, even for enormous matching lines.
async function runRipgrep(args: string[], cwd: string, separator: number, timeoutMs: number, signal: AbortSignal | undefined, record: (value: Buffer) => boolean): Promise<boolean> {
  signal?.throwIfAborted()
  return new Promise<boolean>((resolveRun, reject) => {
    const child = spawn('rg', ['--no-config', ...args], { cwd, shell: false, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, RIPGREP_CONFIG_PATH: undefined } })
    let pending = Buffer.alloc(0)
    let rawBytes = 0
    let stderr = Buffer.alloc(0)
    let stopped: Error | 'truncated' | undefined
    const stop = (reason: Error | 'truncated') => {
      if (stopped !== undefined) return
      stopped = reason
      child.kill('SIGKILL')
    }
    const abort = () => stop(signal?.reason instanceof Error ? signal.reason : new Error('Search aborted'))
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
    const timer = setTimeout(() => stop(new Error(`Search timed out after ${timeoutMs}ms`)), timeoutMs)
    timer.unref()
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort) }
    child.stdout.on('data', (chunk: Buffer) => {
      if (stopped !== undefined) return
      rawBytes += chunk.length
      if (rawBytes > MAX_RAW_BYTES) { stop('truncated'); return }
      pending = Buffer.concat([pending, chunk])
      let start = 0
      for (let end = pending.indexOf(separator); end !== -1; end = pending.indexOf(separator, start)) {
        if (end - start > MAX_RECORD_BYTES) { stop('truncated'); break }
        try { if (!record(pending.subarray(start, end))) { stop('truncated'); break } }
        catch (error) { stop(error instanceof Error ? error : new Error(String(error))); break }
        start = end + 1
      }
      pending = pending.subarray(start)
      if (pending.length > MAX_RECORD_BYTES) stop('truncated')
    })
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < 8192) stderr = Buffer.concat([stderr, chunk.subarray(0, 8192 - stderr.length)])
    })
    child.once('error', error => { cleanup(); reject(new Error(`Unable to run ripgrep (rg): ${error.message}`, { cause: error })) })
    child.once('close', (code, terminationSignal) => {
      cleanup()
      if (stopped instanceof Error) reject(stopped)
      else if (stopped === 'truncated') resolveRun(true)
      else if (code === 0 || code === 1) {
        try { resolveRun(pending.length > 0 && !record(pending)) }
        catch (error) { reject(error) }
      } else reject(new Error(`ripgrep failed (${code ?? terminationSignal}): ${stderr.toString('utf8').trim() || 'no error details'}`))
    })
  })
}

function rgText(value: { text?: string; bytes?: string }): string {
  if (typeof value.text === 'string') return value.text
  if (typeof value.bytes === 'string') return Buffer.from(value.bytes, 'base64').toString('utf8')
  throw new Error('Invalid ripgrep text record')
}

export function createFilesPlugin(): Plugin {
  const read = createReadTool()
  return {
    name: 'files',
    extension: defineExtension({
      name: 'files',
      sections: [section('files_policy', () => 'Use glob to discover file paths and grep to search file contents; narrow searches with path and include. Searches respect ripgrep ignore rules and skip binary content. A truncated result is incomplete: narrow the query instead of assuming absence. Use read for surrounding text and read_image for image attachments; image input depends on the selected model.')],
      tools: [
        defineTool({
          name: 'read_image', replay: 'safe',
          description: 'Read a PNG/JPEG/GIF/WebP image as an attachment, detected by its contents. Relative paths resolve against the session workspace. Reuses read image size limits and model compatibility diagnostics; rejects text and unsupported images.',
          parameters: Type.Object({ path: pathSchema }, { additionalProperties: false }),
          execute: async (args, api, context) => {
            nonblank(args.path, 'path')
            context.abortSignal?.throwIfAborted()
            const result = await read.execute({ path: args.path }, api, context)
            if (result.isError) return result
            if (!result.output?.length || result.output.some(item => item.type !== 'image' || !imageTypes.has(item.mimeType))) {
              throw new Error('read_image only accepts supported PNG/JPEG/GIF/WebP images; use read for text files')
            }
            return result
          },
        }),
        defineTool({
          name: 'glob', replay: 'safe',
          description: 'Find files by glob pattern, never directories. Patterns without a slash match basenames at any depth; paths with slashes are relative to the search directory. Uses ripgrep ignore and hidden-file rules; an explicit glob can include matching hidden files. Returns relative paths in path order, with explicit empty/truncated status. Requires rg on PATH.',
          parameters: Type.Object({ pattern: Type.String({ minLength: 1, maxLength: 4096 }), ...shared }, { additionalProperties: false }),
          structuredOutputSchema: searchOutput,
          execute: async (args, api, context) => {
            nonblank(args.pattern, 'pattern')
            const limit = args.limit ?? 100, timeoutMs = args.timeoutMs ?? 10_000
            positive(limit, 1000, 'limit'); positive(timeoutMs, 120_000, 'timeoutMs')
            const root = await searchRoot(args.path, api, context, true)
            const paths: string[] = []
            let bytes = 0
            const truncated = await runRipgrep(['--files', '--null', '--sort', 'path', '--glob', args.pattern, '--', '.'], root, 0, timeoutMs, context.abortSignal, value => {
              const path = value.toString('utf8').replace(/^\.\//, '')
              if (paths.length >= limit || (bytes += Buffer.byteLength(JSON.stringify(path))) > MAX_OUTPUT_BYTES) return false
              paths.push(path)
              return true
            })
            const result = { root, mode: 'glob' as const, paths, matches: [], truncated, noMatches: !truncated && paths.length === 0 }
            return { ...text(JSON.stringify(result)), structuredOutput: result }
          },
        }),
        defineTool({
          name: 'grep', replay: 'safe',
          description: 'Search text with a ripgrep regex (or fixed text), optionally case insensitive and filtered by a glob. Search a workspace-relative/absolute file or directory. mode=content returns matching lines with line numbers; mode=files returns matching paths. Respects ignore rules, skips binary files, and bounds results and line previews. Invalid regex/path is an error, distinct from noMatches. Requires rg on PATH.',
          parameters: Type.Object({
            pattern: Type.String({ minLength: 1, maxLength: 4096 }), ...shared,
            include: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })),
            fixed: Type.Optional(Type.Boolean()), ignoreCase: Type.Optional(Type.Boolean()),
            mode: Type.Optional(Type.Union([Type.Literal('content'), Type.Literal('files')])),
          }, { additionalProperties: false }),
          structuredOutputSchema: searchOutput,
          execute: async (args, api, context) => {
            nonblank(args.pattern, 'pattern')
            if (args.include !== undefined) nonblank(args.include, 'include')
            const limit = args.limit ?? 100, timeoutMs = args.timeoutMs ?? 10_000
            positive(limit, 1000, 'limit'); positive(timeoutMs, 120_000, 'timeoutMs')
            const root = await searchRoot(args.path, api, context, false)
            const info = await stat(root)
            const cwd = info.isDirectory() ? root : (api.env?.cwd ?? (await api.agent(context)).cwd ?? process.cwd())
            const mode = args.mode ?? 'content'
            const paths: string[] = [], matches: Match[] = []
            let bytes = 0, previewTruncated = false
            const command = ['--sort', 'path', '--color', 'never', ...(mode === 'files' ? ['--files-with-matches', '--null'] : ['--json'])]
            if (args.fixed) command.push('--fixed-strings')
            if (args.ignoreCase) command.push('--ignore-case')
            if (args.include !== undefined) command.push('--glob', args.include)
            command.push('--', args.pattern, info.isDirectory() ? '.' : root)
            const truncated = await runRipgrep(command, cwd, mode === 'files' ? 0 : 10, timeoutMs, context.abortSignal, value => {
              if (mode === 'files') {
                const path = value.toString('utf8').replace(/^\.\//, '')
                if (paths.length >= limit || (bytes += Buffer.byteLength(JSON.stringify(path))) > MAX_OUTPUT_BYTES) return false
                paths.push(path)
              } else {
                const event = JSON.parse(value.toString('utf8'))
                if (event.type !== 'match') return true
                const path = rgText(event.data.path).replace(/^\.\//, '')
                const full = rgText(event.data.lines).replace(/\r?\n$/, '')
                const line = utf8Head(full, 2000)
                const match = { path, lineNumber: event.data.line_number, line, lineTruncated: line !== full }
                if (matches.length >= limit || (bytes += Buffer.byteLength(JSON.stringify(match))) > MAX_OUTPUT_BYTES) return false
                matches.push(match)
                previewTruncated ||= match.lineTruncated
              }
              return true
            })
            const result = { root, mode, paths, matches, truncated: truncated || previewTruncated, noMatches: !truncated && paths.length === 0 && matches.length === 0 }
            return { ...text(JSON.stringify(result)), structuredOutput: result }
          },
        }),
      ],
    }),
  }
}
