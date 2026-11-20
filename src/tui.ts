import { homedir } from 'node:os'
import { basename, dirname } from 'node:path'
import type { Context } from '@earendil-works/chord/context'
import type { AssistantMessage, Message } from '@earendil-works/pi-ai'
import type { AgentEvent, EntryRecord, SnapshotEvent } from '@earendil-works/pi-durable'
import { validateQuestions, type UserAnswer, type UserQuestion } from './interaction.ts'
import type { ActivityOverview, StatusBar } from './plugin.ts'
import { LAYOUT_NODE } from '@earendil-works/pi-tui/dist/layout-node.js'
import {
  CombinedAutocompleteProvider, Container, Editor, Input, Loader, Markdown,
  ProcessTerminal, ScrollView, SelectList, Text, TuiAltScreen, VStack,
  matchesKey, stripTerminalSequences, truncateToWidth, visibleWidth, wrapTextWithAnsi,
  type Component, type Focusable, type MarkdownTheme, type SelectItem,
  type SelectListTheme, type SlashCommand, type Terminal, type TuiInputListener, type TuiMouseEvent,
} from '@earendil-works/pi-tui'

// ─── Terminal-Native ANSI Styling (Adapts to Light & Dark Terminals) ─────────

const accent = (text: string) => `\x1b[36m${text}\x1b[39m`
const accentBold = (text: string) => `\x1b[1;36m${text}\x1b[39;22m`
const brand = (text: string) => `\x1b[35m${text}\x1b[39m`
const info = (text: string) => `\x1b[34m${text}\x1b[39m`
const success = (text: string) => `\x1b[32m${text}\x1b[39m`
const errorColor = (text: string) => `\x1b[31m${text}\x1b[39m`
const errorBold = (text: string) => `\x1b[1;31m${text}\x1b[39;22m`
const muted = (text: string) => `\x1b[2m${text}\x1b[22m`
const bold = (text: string) => `\x1b[1m${text}\x1b[22m`
const italic = (text: string) => `\x1b[3m${text}\x1b[23m`
const underline = (text: string) => `\x1b[4m${text}\x1b[24m`
const strikethrough = (text: string) => `\x1b[9m${text}\x1b[29m`
const inverse = (text: string) => `\x1b[7m${text}\x1b[27m`

// ─── Responsive Layout & Typography Helpers ──────────────────────────────────

const pagePad = (width: number) => width >= 40 ? 2 : width >= 20 ? 1 : 0
const singleLine = (text: string) => stripTerminalSequences(text).replace(/[\r\n]+/g, ' ')
const HOME = homedir()
const shortPath = (cwd: string) => cwd === HOME ? '~' : cwd.startsWith(`${HOME}/`) ? `~${cwd.slice(HOME.length)}` : cwd

function padEdges(text: string, width: number, pad: number, ellipsis = ''): string {
  if (width <= 0) return ''
  const left = ' '.repeat(Math.min(pad, Math.max(0, Math.floor((width - 1) / 2))))
  const contentWidth = Math.max(1, width - left.length * 2)
  const fitted = truncateToWidth(text, contentWidth, ellipsis)
  const rightPad = Math.max(0, width - left.length - visibleWidth(fitted))
  return `${left}${fitted}${' '.repeat(rightPad)}`
}

function splitRow(left: string, right: string, width: number, pad: number, ellipsis = ''): string {
  if (width <= 0) return ''
  const margin = Math.min(pad, Math.max(0, Math.floor((width - 1) / 2)))
  const inner = Math.max(1, width - margin * 2)
  const leftWidth = visibleWidth(left)
  const rightWidth = visibleWidth(right)
  if (!right || leftWidth + 2 + rightWidth > inner) {
    return padEdges(left, width, margin, ellipsis)
  }
  const gap = ' '.repeat(inner - leftWidth - rightWidth)
  return `${' '.repeat(margin)}${left}${gap}${right}${' '.repeat(margin)}`
}

function titledRule(leftLabel: string, rightLabel: string, width: number, styleLine: (text: string) => string): string {
  if (width <= 0) return ''
  const left = leftLabel ? `── ${leftLabel} ` : ''
  const right = rightLabel ? ` ${rightLabel} ──` : ''
  const used = visibleWidth(left) + visibleWidth(right)
  if (used <= width) {
    return truncateToWidth(`${styleLine('──')}${leftLabel ? ` ${leftLabel} ` : ''}${styleLine('─'.repeat(width - used))}${rightLabel ? ` ${rightLabel} ` : ''}${right ? styleLine('──') : ''}`, width, '')
  }
  if (left && visibleWidth(left) <= width) {
    return truncateToWidth(`${styleLine('──')} ${leftLabel} ${styleLine('─'.repeat(Math.max(0, width - visibleWidth(left))))}`, width, '')
  }
  return styleLine('─'.repeat(width))
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`
  const mins = Math.floor(ms / 60_000)
  const secs = Math.floor((ms % 60_000) / 1000)
  return `${mins}m${secs}s`
}

// ─── Syntax Highlighting & Markdown Theme ────────────────────────────────────

const CODE_TOKEN_REGEX = /(\/\/.*$|#.*$|--.*$|\/\*[\s\S]*?\*\/)|("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)(\s*:)?|\b(0x[\da-fA-F]+|0b[01]+|0o[0-7]+|\d+(?:\.\d+)?(?:e[+-]?\d+)?)\b|\b(const|let|var|function|return|async|await|import|export|from|default|type|interface|class|extends|implements|new|typeof|instanceof|in|of|if|else|for|while|do|switch|case|break|continue|try|catch|finally|throw|void|delete|yield|static|readonly|private|protected|public|def|elif|except|lambda|with|as|pass|raise|global|nonlocal|fn|pub|mut|impl|struct|enum|match|use|mod|crate|where|trait|package|func|defer|go|select|chan|fallthrough|true|false|null|undefined|None|True|False|nil|self|super|this)\b|\b([A-Z][A-Za-z0-9_]*)\b|\b([a-zA-Z_$][\w$]*)(?=\s*\()/g

function highlightCodeLine(line: string, lang?: string): string {
  if (!line) return line
  const normalizedLang = lang?.toLowerCase() ?? ''
  if (normalizedLang === 'diff' || normalizedLang === 'patch' || /^@@\s+-\d+/.test(line)) {
    if (line.startsWith('+++') || line.startsWith('---')) return bold(line)
    if (line.startsWith('+')) return success(line)
    if (line.startsWith('-')) return errorColor(line)
    if (line.startsWith('@@')) return accent(line)
  }
  return line.replace(CODE_TOKEN_REGEX, (match, comment, str, colon, num, kw, typeName, fnName) => {
    if (comment !== undefined) return muted(italic(comment))
    if (str !== undefined) {
      if (colon !== undefined) return `${accent(str)}${muted(colon)}`
      if (str === '"[redacted]"') return muted(italic(str))
      return success(str)
    }
    if (num !== undefined) return info(num)
    if (kw !== undefined) return brand(kw)
    if (typeName !== undefined) return accent(typeName)
    if (fnName !== undefined) return info(fnName)
    return match
  })
}

function highlightCodeBlock(code: string, lang?: string): string[] {
  return code.split('\n').map(line => highlightCodeLine(line, lang))
}

const selectTheme: SelectListTheme = {
  selectedPrefix: accentBold,
  selectedText: accentBold,
  description: muted,
  scrollInfo: muted,
  noMatch: muted,
}

const markdownTheme: MarkdownTheme = {
  heading: bold,
  link: text => underline(accent(text)),
  linkUrl: muted,
  code: accent,
  codeBlock: text => text,
  codeBlockBorder: muted,
  quote: muted,
  quoteBorder: muted,
  hr: muted,
  listBullet: accent,
  bold,
  italic,
  strikethrough,
  underline,
  highlightCode: highlightCodeBlock,
  codeBlockIndent: '  ',
}

// ─── Layout Wrappers ─────────────────────────────────────────────────────────

class PaddedComponent extends Container {
  constructor(inner: Component) {
    super()
    this.addChild(inner)
  }

  render(width: number): string[] {
    const pad = pagePad(width)
    const contentWidth = Math.max(1, width - pad * 2)
    const margin = ' '.repeat(pad)
    const child = this.children[0]
    if (!child) return []
    return child.render(contentWidth).map(line => truncateToWidth(`${margin}${line}`, width, ''))
  }

  handleMouse(event: TuiMouseEvent) {
    const pad = pagePad(event.width)
    const contentWidth = Math.max(1, event.width - pad * 2)
    return super.handleMouse({ ...event, x: Math.max(0, event.x - pad), width: contentWidth })
  }
}

class CompactLoader extends Loader {
  private readonly startedAt = Date.now()

  render(width: number): string[] {
    const pad = pagePad(width)
    const frame = this.getRenderedIndicator()
    const elapsedMs = Date.now() - this.startedAt
    const elapsed = elapsedMs >= 1000 ? ` ${muted(formatDuration(elapsedMs))}` : ''
    const raw = (this as unknown as { message: string }).message || 'Working…'
    const cleanMsg = raw.replace(/\s*Esc to interrupt$/, '')
    const left = `${frame ? `${frame} ` : ''}${bold(cleanMsg)}${elapsed}`
    return [padEdges(left, width, pad, '…')]
  }
}

// ─── Message & Thinking Views ────────────────────────────────────────────────

function messageText(message: Message): string {
  return typeof message.content === 'string' ? message.content : message.content
    .flatMap(block => block.type === 'text' ? [block.text] : block.type === 'image' ? ['[image]'] : []).join('\n')
}

function mouseTarget(component: Component, event: TuiMouseEvent) {
  return { component, originX: event.screenX - event.x, originY: event.screenY - event.y, width: event.width, height: event.height }
}

class ThinkingRow extends Container {
  expanded = true
  private manuallyToggled = false
  private text = ''
  private requestRender: () => void

  constructor(requestRender: () => void) { super(); this.requestRender = requestRender }

  setContent(text: string, streaming: boolean) {
    this.text = stripTerminalSequences(text)
    if (!this.manuallyToggled) this.expanded = streaming
  }

  toggle(expanded = !this.expanded) {
    this.expanded = expanded
    this.manuallyToggled = true
    this.requestRender()
  }

  render(width: number) {
    const pad = pagePad(width)
    const margin = ' '.repeat(pad)
    const lastLine = this.text.split('\n').findLast(line => line.trim())?.trim() ?? ''
    const preview = this.expanded || !lastLine ? '' : ` · ${lastLine}`
    const header = padEdges(muted(`${this.expanded ? '▾' : '▸'} Thinking${preview}`), width, pad, '…')
    if (!this.expanded) return [header]
    const bodyWidth = Math.max(1, width - pad * 2 - 2)
    const wrapped = wrapTextWithAnsi(this.text, bodyWidth)
    return [header, ...wrapped.map(line => truncateToWidth(`${margin}${muted('│')} ${muted(line)}`, width, ''))]
  }

  handleMouse(event: TuiMouseEvent): ReturnType<Container['handleMouse']> {
    if (event.button !== 'left' || event.y !== 0) return undefined
    if (event.type === 'click') { this.toggle(); return { handled: true, target: mouseTarget(this, event) } }
    if (event.type === 'press') return { handled: true, target: mouseTarget(this, event) }
    return undefined
  }
}

class AssistantView extends Container {
  private parts: (PaddedComponent | ThinkingRow | undefined)[] = []
  private markdowns = new Map<number, Markdown>()
  private requestRender: () => void

  constructor(requestRender: () => void) { super(); this.requestRender = requestRender }

  setContent(blocks: AssistantMessage['content'], streaming: boolean) {
    this.clear()
    blocks.forEach((block, index) => {
      if (block.type === 'thinking') {
        const text = block.redacted ? 'Thinking was not exposed by the provider.' : block.thinking
        if (!text.trim() && !streaming) return
        const row = this.parts[index] instanceof ThinkingRow ? this.parts[index] as ThinkingRow : new ThinkingRow(this.requestRender)
        row.setContent(text, streaming)
        this.parts[index] = row
        this.addChild(row)
      } else if (block.type === 'text') {
        if (!block.text) return
        let markdown = this.markdowns.get(index)
        if (!markdown) {
          markdown = new Markdown('', 0, 0, markdownTheme)
          this.markdowns.set(index, markdown)
        }
        markdown.setText(block.text)
        const wrapped = this.parts[index] instanceof PaddedComponent ? this.parts[index] as PaddedComponent : new PaddedComponent(markdown)
        this.parts[index] = wrapped
        this.addChild(wrapped)
      }
    })
    this.parts.length = blocks.length
  }
}

// ─── Tool Display & Rich Detail Formatters ───────────────────────────────────

function boundedOutput(output: string): string {
  const lines = output.slice(0, 32000).split('\n')
  return lines.slice(0, 200).join('\n') + (lines.length > 200 || output.length > 32000 ? '\n… output truncated' : '')
}

function redactObject(item: unknown, depth = 0): unknown {
  if (depth > 4) return '[…]'
  if (Array.isArray(item)) return item.slice(0, 30).map(value => redactObject(value, depth + 1))
  if (item && typeof item === 'object') return Object.fromEntries(Object.entries(item).slice(0, 30).map(([key, value]) => [
    key, /api.?key|token|authorization|password|secret|providers|models|headers/i.test(key) ? '[redacted]' : redactObject(value, depth + 1),
  ]))
  return item
}

function readableDetails(value: unknown): string {
  return boundedOutput(typeof value === 'string' ? value : JSON.stringify(redactObject(value), null, 2) ?? '')
}

function parseJsonSafe(raw: string): Record<string, unknown> | undefined {
  if (!raw || (!raw.startsWith('{') && !raw.startsWith('['))) return undefined
  try {
    const parsed: unknown = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined
  } catch { return undefined }
}

function diffCounts(diffText: string): { added: number; removed: number } | undefined {
  let added = 0
  let removed = 0
  for (const line of diffText.split('\n')) {
    if (/^\+\s*\d+|^\+(?!\+\+)/.test(line)) added++
    else if (/^-\s*\d+|^-(?!-)/.test(line)) removed++
  }
  return added || removed ? { added, removed } : undefined
}

const toolTitles: Record<string, string> = {
  read_image: 'Image',
  glob: 'glob',
  grep: 'grep',
  todo_write: 'todo',
  create_goal: 'goal · create',
  update_goal: 'goal · update',
  get_goal: 'goal',
  subagent: 'subagent',
  send_message: 'agent · msg',
  interrupt_agent: 'agent · stop',
  ask_user_question: 'ask_user',
  enter_plan_mode: 'plan · enter',
  exit_plan_mode: 'plan · review',
  web_search: 'web_search',
  workflow: 'workflow',
  ralph: 'ralph',
}

function formatToolSummary(name: string, args: Record<string, unknown>, rawDetails: string, output: string): string {
  const str = (key: string) => typeof args[key] === 'string' ? singleLine(args[key] as string) : ''
  if (name === 'read') {
    const path = str('path')
    if (!path) return ''
    const offset = typeof args.offset === 'number' ? args.offset : undefined
    const limit = typeof args.limit === 'number' ? args.limit : undefined
    if (offset !== undefined || limit !== undefined) {
      const start = offset ?? 1
      const range = limit !== undefined ? `L${start}-${start + limit - 1}` : `L${start}+`
      return `${path} (${range})`
    }
    return path
  }
  if (name === 'write') {
    const path = str('path')
    const content = typeof args.content === 'string' ? args.content : undefined
    if (!path) return ''
    return content !== undefined ? `${path} (${content.split('\n').length} lines)` : path
  }
  if (name === 'edit') {
    const path = str('path')
    if (!path) return ''
    const edits = Array.isArray(args.edits) ? args.edits.length : 0
    const parsed = parseJsonSafe(rawDetails)
    const diffText = typeof parsed?.diff === 'string' ? parsed.diff : typeof parsed?.patch === 'string' ? parsed.patch : ''
    const counts = diffText ? diffCounts(diffText) : undefined
    if (counts) return `${path} (${success(`+${counts.added}`)} ${errorColor(`-${counts.removed}`)})`
    return edits > 1 ? `${path} (${edits} edits)` : path
  }
  if (name === 'glob') {
    const pattern = str('pattern')
    const path = str('path')
    const parsed = parseJsonSafe(output)
    const count = Array.isArray(parsed?.paths) ? `${parsed.paths.length} files` : ''
    return [pattern, path ? `in ${path}` : '', count].filter(Boolean).join(' · ')
  }
  if (name === 'grep') {
    const pattern = str('pattern')
    const path = str('path')
    const include = str('include')
    const parsed = parseJsonSafe(output)
    const count = Array.isArray(parsed?.matches) && parsed.matches.length
      ? `${parsed.matches.length} matches`
      : Array.isArray(parsed?.paths) && parsed.paths.length ? `${parsed.paths.length} files` : parsed?.noMatches ? '0 matches' : ''
    return [pattern ? `/${pattern}/` : '', path ? `in ${path}` : '', include ? `(${include})` : '', count].filter(Boolean).join(' · ')
  }
  if (name === 'todo_write' && Array.isArray(args.todos)) {
    const items = args.todos as { content?: string; status?: string }[]
    const done = items.filter(item => item.status === 'completed').length
    const active = items.find(item => item.status === 'in_progress')?.content
    return [`${done}/${items.length} done`, active ? singleLine(active) : ''].filter(Boolean).join(' · ')
  }
  if (name === 'web_search') {
    const query = str('query')
    const parsed = parseJsonSafe(output)
    const count = Array.isArray(parsed?.sources) ? `${parsed.sources.length} sources` : ''
    return [query ? `"${query}"` : '', count].filter(Boolean).join(' · ')
  }
  if (name === 'subagent') {
    const desc = str('description')
    const bg = args.run_in_background !== false
    return desc ? `${desc}${bg ? ' (bg)' : ''}` : ''
  }
  if (name === 'send_message') {
    const id = str('subagent_id')
    const msg = str('message')
    return [id ? `#${id}` : '', msg].filter(Boolean).join(' · ')
  }
  if (name === 'interrupt_agent') return str('agent_id') ? `#${str('agent_id')}` : ''
  if (name === 'update_goal') return [str('action'), str('objective')].filter(Boolean).join(' · ')
  if (name === 'ralph') {
    const obj = str('objective')
    const maxRounds = typeof args.maxRounds === 'number' ? `(${args.maxRounds} rounds)` : ''
    return [obj, maxRounds].filter(Boolean).join(' ')
  }
  if (name === 'bash') {
    const base = str('description') || str('command')
    const workdir = str('workdir')
    return workdir && base ? `${base} (${workdir})` : base
  }
  const meta = args.meta
  const fallback = ['description', 'command', 'path', 'file', 'name', 'subject', 'prompt', 'query', 'pattern', 'objective']
    .map(key => args[key]).find(value => typeof value === 'string')
    ?? (meta && typeof meta === 'object' && 'description' in meta ? meta.description : undefined)
  return typeof fallback === 'string' ? singleLine(fallback) : ''
}

function formatToolBodyLines(name: string, args: Record<string, unknown>, rawDetails: string, output: string): string[] {
  const lines: string[] = []
  const parsedDetails = parseJsonSafe(rawDetails)
  const parsedOutput = parseJsonSafe(output)

  // 1. Concise tool-aware argument header (still redacting any sensitive keys)
  const sensitiveKeys = Object.entries(args).filter(([key]) => /api.?key|token|authorization|password|secret|providers|models|headers/i.test(key))
  if (name === 'bash' && typeof args.command === 'string') {
    lines.push(`${accent('$')} ${bold(args.command)}`)
    if (typeof args.workdir === 'string') lines.push(muted(`workdir: ${args.workdir}`))
    if (sensitiveKeys.length) lines.push(readableDetails(Object.fromEntries(sensitiveKeys)))
  } else if (name === 'edit' && typeof args.path === 'string' && (typeof parsedDetails?.diff === 'string' || typeof parsedDetails?.patch === 'string')) {
    const diffText = (parsedDetails.patch as string | undefined) ?? (parsedDetails.diff as string)
    for (const diffLine of boundedOutput(diffText).split('\n')) {
      lines.push(highlightCodeLine(diffLine, 'diff'))
    }
    if (output) lines.push(muted(output))
    return lines
  } else if (name === 'todo_write' && Array.isArray(args.todos)) {
    for (const item of args.todos as { content?: string; status?: string }[]) {
      const mark = item.status === 'completed' ? success('✓') : item.status === 'in_progress' ? accent('▸') : muted('○')
      lines.push(`${mark} ${item.content ?? ''}`)
    }
    return lines
  } else if (name === 'read' && typeof args.path === 'string') {
    if (!output) {
      const range = typeof args.offset === 'number' || typeof args.limit === 'number'
        ? ` (offset=${args.offset ?? 1}${args.limit !== undefined ? `, limit=${args.limit}` : ''})` : ''
      lines.push(`${muted('file:')} ${bold(args.path)}${muted(range)}`)
    }
  } else if (name === 'write' && typeof args.path === 'string') {
    if (!output) {
      const count = typeof args.content === 'string' ? ` (${args.content.split('\n').length} lines)` : ''
      lines.push(`${muted('file:')} ${bold(args.path)}${muted(count)}`)
    }
  } else if (Object.keys(args).length) {
    lines.push(...readableDetails(args).split('\n').map(line => highlightCodeLine(line, 'json')))
  }

  // 2. Details (e.g. exitCode, truncation, workflow status)
  if (rawDetails) {
    if (parsedDetails && 'workflow' in parsedDetails) {
      const { workflow, name: wfName, phase, status, agentsStarted, agentsCompleted } = parsedDetails
      lines.push(`${accent(`workflow #${workflow}`)} ${wfName ?? ''}${phase ? ` · ${phase}` : ''} · ${agentsCompleted ?? 0}/${agentsStarted ?? 0} agents ${muted(`[${status ?? ''}]`)}`)
    } else {
      lines.push(...rawDetails.split('\n').map(line => highlightCodeLine(line, 'json')))
    }
  }

  // 3. Output (formatted per tool when structured JSON)
  if (output) {
    if ((name === 'glob' || name === 'grep') && parsedOutput) {
      if (typeof parsedOutput.root === 'string') lines.push(muted(`root: ${parsedOutput.root}`))
      if (Array.isArray(parsedOutput.matches) && parsedOutput.matches.length) {
        for (const m of parsedOutput.matches as { path?: string; lineNumber?: number; line?: string }[]) {
          lines.push(`${accent(String(m.path ?? ''))}${muted(`:${m.lineNumber ?? ''}:`)} ${m.line ?? ''}`)
        }
      } else if (Array.isArray(parsedOutput.paths) && parsedOutput.paths.length) {
        for (const p of parsedOutput.paths) lines.push(String(p))
      } else if (parsedOutput.noMatches) {
        lines.push(muted('No matches'))
      }
      if (parsedOutput.truncated) lines.push(muted('… results truncated'))
    } else if (name === 'web_search' && parsedOutput && Array.isArray(parsedOutput.sources)) {
      const sources = parsedOutput.sources as { title?: string; url?: string; snippet?: string }[]
      if (!sources.length) lines.push(muted('No results found'))
      else sources.forEach((src, idx) => {
        lines.push(`${accent(`${idx + 1}.`)} ${bold(src.title ?? '')} ${muted(src.url ?? '')}`)
        if (src.snippet) lines.push(`   ${muted(src.snippet)}`)
      })
    } else {
      for (const outLine of output.split('\n')) {
        if (outLine === '… output truncated') lines.push(muted(italic(outLine)))
        else if (/^\[exit code: [1-9]\d*\]/.test(outLine)) lines.push(errorColor(outLine))
        else if (/^\[exit code: 0\]/.test(outLine)) lines.push(success(outLine))
        else lines.push(outLine)
      }
    }
  }

  return lines.length ? lines : [muted('No output')]
}

export class ToolRow extends VStack implements Focusable {
  private isExpanded = false
  focused = false
  readonly detailsView: ScrollView
  readonly name: string
  private readonly heading: Component
  private readonly requestRender: () => void
  private readonly returnToEditor?: (data?: string) => void
  status: 'running' | 'done' | 'failed' | 'aborted' = 'running'
  output = ''
  details = ''
  args: Record<string, unknown> = {}
  durationMs?: number
  private startedAt?: number
  private jobId?: string

  constructor(name: string, requestRender: () => void, returnToEditor?: (data?: string) => void) {
    super()
    this.name = name
    this.requestRender = requestRender
    this.returnToEditor = returnToEditor
    this.heading = { render: width => [this.renderHeading(width)], invalidate() {} }
    const content: Component = {
      render: width => {
        const pad = pagePad(width)
        const rail = `${' '.repeat(pad)}${this.focused ? accent('│') : muted('│')} `
        const railWidth = pad + 2
        const innerWidth = Math.max(1, width - railWidth - 1)
        const bodyLines = formatToolBodyLines(this.name, this.args, this.details, this.output)
        const wrapped: string[] = []
        for (const rawLine of bodyLines) {
          for (const segment of wrapTextWithAnsi(rawLine, innerWidth)) {
            wrapped.push(truncateToWidth(`${rail}${segment}`, width, ''))
          }
        }
        return wrapped.length ? wrapped : [truncateToWidth(`${rail}${muted('No output')}`, width, '')]
      },
      invalidate() {},
    }
    this.detailsView = new ScrollView(content, {
      overscroll: 'contain', scrollbar: 'auto', scrollbarTrackStyle: muted, scrollbarThumbStyle: accent,
    })
    this.addChild(this.heading)
  }

  get expanded() { return this.isExpanded }
  set expanded(value: boolean) {
    if (value === this.isExpanded) return
    this.isExpanded = value
    if (value) this.addChild(this.detailsView, { maxSize: 10 })
    else {
      this.removeChild(this.detailsView)
      this.detailsView.scrollToStart()
      if (this.focused) this.returnToEditor?.()
    }
  }

  get isJobLaunch() { return this.name === 'job_start' || this.name === 'bash' && this.args.run_in_background === true }

  start(args: Record<string, unknown>) {
    this.args = args
    this.jobId = undefined
    this.startedAt = Date.now()
    this.status = 'running'
  }

  finish(output: string, status: ToolRow['status'], durationMs?: number) {
    this.output = boundedOutput(output)
    this.status = status
    this.durationMs = durationMs ?? (this.startedAt === undefined ? undefined : Date.now() - this.startedAt)
    if (this.isJobLaunch && status === 'done') {
      try {
        const receipt: unknown = JSON.parse(this.output)
        if (receipt && typeof receipt === 'object' && 'kind' in receipt && receipt.kind === 'background' &&
            'jobId' in receipt && typeof receipt.jobId === 'string' && /^[1-9]\d*$/.test(receipt.jobId)) this.jobId = receipt.jobId
      } catch { /* A failed or replaced tool may return plain text instead of a launch receipt. */ }
    }
  }

  private renderHeading(width: number) {
    const pad = pagePad(width)
    const duration = this.durationMs === undefined ? '' : ` ${this.durationMs}ms`
    const operation = this.name === 'job_list' ? '列表' : this.name === 'job_output' ? '日志' : this.name === 'job_kill' ? '停止' : undefined
    const id = this.jobId ?? (typeof this.args.job_id === 'string' && /^[1-9]\d*$/.test(this.args.job_id) ? this.args.job_id : undefined)
    const title = this.isJobLaunch || operation || this.name === 'Job'
      ? `${this.name === 'job_list' ? 'Jobs' : 'Job'}${id ? ` #${id}` : ''}${operation ? ` · ${operation}` : ''}` : toolTitles[this.name] ?? this.name
    const state = this.isJobLaunch && this.status === 'running' ? '启动中' : this.isJobLaunch && this.status === 'done' && this.jobId ? '已启动'
      : { running: '进行中', done: '完成', failed: '失败', aborted: '已中断' }[this.status]

    const chevronText = this.expanded ? '▾' : '▸'
    const chevron = this.focused || this.expanded ? accentBold(chevronText) : this.status === 'failed' ? errorColor(chevronText) : muted(chevronText)
    const plainBadge = `  [${state}${duration}]`
    const badgeColor = this.status === 'failed' ? errorColor : this.status === 'running' ? accent : this.status === 'done' ? success : muted
    const styledBadge = `  ${badgeColor(`[${state}${duration}]`)}`

    const summary = formatToolSummary(this.name, this.args, this.details, this.output).slice(0, 140)
    const avail = Math.max(1, width - pad * 2)
    const badgeWidth = visibleWidth(plainBadge)
    const labelBudget = avail - 2 - badgeWidth
    const rawLabel = summary ? `${title} · ${summary}` : title
    const fittedLabel = labelBudget > 3 ? truncateToWidth(rawLabel, labelBudget, '…') : rawLabel
    const styledLabel = this.status === 'failed' ? errorColor(fittedLabel) : this.status === 'aborted' ? muted(fittedLabel) : fittedLabel

    return padEdges(`${chevron} ${styledLabel}${styledBadge}`, width, pad, '')
  }

  render(width: number) {
    const lines = [this.renderHeading(width)]
    if (this.expanded) {
      const content = this.detailsView.render(width)
      this.detailsView.updateLayout(content.length, Math.min(10, content.length), this.requestRender)
      lines.push(...content.slice(this.detailsView.scrollTop, this.detailsView.scrollTop + 10))
    }
    return lines
  }

  handleInput(data: string) {
    if (!this.expanded) { this.returnToEditor?.(data); return }
    if (matchesKey(data, 'up')) this.detailsView.scrollBy(-1)
    else if (matchesKey(data, 'down')) this.detailsView.scrollBy(1)
    else if (matchesKey(data, 'pageUp')) this.detailsView.scrollBy(-Math.max(1, this.detailsView.viewportHeight))
    else if (matchesKey(data, 'pageDown')) this.detailsView.scrollBy(Math.max(1, this.detailsView.viewportHeight))
    else if (matchesKey(data, 'home')) this.detailsView.scrollToStart()
    else if (matchesKey(data, 'end')) this.detailsView.scrollToEnd()
    else this.returnToEditor?.(matchesKey(data, 'escape') || matchesKey(data, 'enter') ? undefined : data)
    this.requestRender()
  }

  handleMouse(event: TuiMouseEvent): ReturnType<VStack['handleMouse']> {
    const handled = (focus = false): NonNullable<ReturnType<VStack['handleMouse']>> => ({
      handled: true,
      target: mouseTarget(this, event),
      ...(focus ? { focus: true, focusTarget: this } : {}),
    })
    if (this.expanded && event.y > 0 && event.type === 'wheel') {
      this.detailsView.scrollBy(event.wheelDelta ?? 0)
      return handled()
    }
    if (event.button === 'left' && event.y === 0) {
      if (event.type === 'click') { this.expanded = !this.expanded; this.requestRender(); return handled() }
      if (event.type === 'press') return handled()
    }
    if (this.expanded && event.button === 'left' && event.y > 0 && (event.type === 'press' || event.type === 'click')) return handled(true)
    return undefined
  }
}

// ─── Bottom Panel Components (Activity, Prompt, Picker, Question, Footer) ────

export type InspectAction = {
  key: string
  label: string
}

export type InspectOptions = {
  title: string
  badge?: string
  content: string
  actions?: readonly InspectAction[]
}

function extractActivePreview(lines: readonly string[]): string {
  for (const line of lines) {
    const agent = /^Agent #(\d+) \[(queued|pending|running|waiting|sleeping|completing)\](?: queued \d+(?: \(parked \d+\))?)? · (.+)$/.exec(line)
    if (agent) return `#${agent[1]} ${agent[3]!.trim()}`
  }
  for (const line of lines) {
    const job = /^Job #([^\s]+) \[(queued|running|stopping)\] (.+)$/.exec(line)
    if (job) return `Job #${job[1]} ${job[3]!.trim()}`
  }
  for (const line of lines) {
    const todo = /^Todo \[in_progress\] (.+)$/.exec(line)
    if (todo) return `Todo: ${todo[1]!.trim()}`
  }
  for (const line of lines) {
    const goal = /^Goal \[active\] (?:\d+\/\d+ )?(.+)$/.exec(line)
    if (goal) return `Goal: ${goal[1]!.trim()}`
  }
  for (const line of lines) {
    const wf = /^(Workflow|Ralph) #([^\s]+) \[running\] (.+)$/.exec(line)
    if (wf) return `${wf[1]} #${wf[2]} ${wf[3]!.trim()}`
  }
  return ''
}

function formatActivityHeading(
  expanded: boolean,
  focused: boolean,
  overview: ActivityOverview,
  width: number,
  hasAgentsAction: boolean,
): { line: string; agentsRange?: { start: number; end: number } } {
  const pad = pagePad(width)
  const margin = Math.min(pad, Math.max(0, Math.floor((width - 1) / 2)))
  const inner = Math.max(1, width - margin * 2)
  const chevron = (expanded || focused ? accentBold : accent)(expanded ? '▾' : '▸')
  const styledSegments = overview.summary.split(' · ').map(seg => {
    if (/unavailable|blocked/i.test(seg)) return errorBold(seg)
    if (/\b(?:0|—)$/.test(seg)) return muted(seg)
    if (/active/i.test(seg)) return accentBold(seg)
    if (/complete/i.test(seg)) return success(seg)
    return seg
  }).join(muted(' · '))

  let right = ''
  let agentsButtonText = ''
  if (hasAgentsAction) {
    if (width >= 60) {
      agentsButtonText = '/agents'
      right = `${muted(expanded ? 'Ctrl+T 收起' : 'Ctrl+T')}${muted(' · ')}${accent(agentsButtonText)}`
    } else if (width >= 48) {
      agentsButtonText = 'Agents'
      right = `${muted('Ctrl+T')}${muted(' · ')}${accent(agentsButtonText)}`
    } else if (width >= 40) {
      right = muted(expanded ? 'Ctrl+T 收起' : 'Ctrl+T')
    }
  } else if (width >= 54) {
    right = muted(expanded ? 'Ctrl+T 收起' : 'Ctrl+T')
  }

  let left = `${chevron} ${styledSegments}`
  const preview = extractActivePreview(overview.lines)
  const rightReserved = right ? visibleWidth(right) + 2 : 0
  if (preview) {
    const availForPreview = inner - visibleWidth(left) - rightReserved - 3
    if (availForPreview >= 10) {
      left += `${muted(' · ')}${accent(truncateToWidth(preview, availForPreview, '…'))}`
    }
  }

  const leftW = visibleWidth(left)
  const rightW = visibleWidth(right)
  if (!right || leftW + 2 + rightW > inner) {
    return { line: padEdges(left, width, margin, '…') }
  }
  const gap = ' '.repeat(inner - leftW - rightW)
  const line = `${' '.repeat(margin)}${left}${gap}${right}${' '.repeat(margin)}`
  const btnW = visibleWidth(agentsButtonText)
  const agentsRange = btnW > 0 ? { start: margin + inner - btnW, end: margin + inner } : undefined
  return { line, agentsRange }
}

function formatActivityDetailLine(line: string, clickableAgent = false): string {
  if (!line) return line
  if (/^Goal blocked:/i.test(line)) return errorBold(line)
  if (/:\s+no\s+/i.test(line) || line === 'No activity yet.') return muted(line)
  if (/\[(completed|complete)\]/i.test(line)) return clickableAgent && /^Agent #/.test(line) ? `${success(line)} ${muted('↗')}` : success(line)
  if (/\[(failed|blocked)\]/i.test(line) || /exit\s+[1-9]\d*/i.test(line)) return clickableAgent && /^Agent #/.test(line) ? `${errorColor(line)} ${muted('↗')}` : errorColor(line)
  if (/\[(in_progress|active|running|queued|completing)\]/i.test(line)) return clickableAgent && /^Agent #/.test(line) ? `${accent(line)} ${accent('↗')}` : accent(line)
  if (/\[(paused|pending|interrupted|killed|stopping)\]/i.test(line)) return clickableAgent && /^Agent #/.test(line) ? `${muted(line)} ${muted('↗')}` : muted(line)
  return line
}

class ActivityPanel extends VStack implements Focusable {
  focused = false
  private isExpanded = false
  readonly detailsView: ScrollView
  private getState: () => ActivityOverview
  private requestRender: () => void
  private returnToEditor: (data?: string) => void
  private capacity: () => number
  private onInspectAgents?: () => void
  private onInspectAgent?: (id: number) => void
  private agentsHitRange?: { start: number; end: number }
  private renderedSourceLines: string[] = []

  constructor(
    getState: () => ActivityOverview,
    requestRender: () => void,
    returnToEditor: (data?: string) => void,
    capacity: () => number,
    actions?: { onInspectAgents?: () => void; onInspectAgent?: (id: number) => void },
  ) {
    super()
    this.getState = getState
    this.requestRender = requestRender
    this.returnToEditor = returnToEditor
    this.capacity = capacity
    this.onInspectAgents = actions?.onInspectAgents
    this.onInspectAgent = actions?.onInspectAgent
    this.addChild({
      render: width => {
        const heading = formatActivityHeading(
          this.expanded,
          this.focused,
          this.getState(),
          width,
          Boolean(this.onInspectAgents),
        )
        this.agentsHitRange = heading.agentsRange
        return [heading.line]
      },
      invalidate() {},
    })
    this.detailsView = new ScrollView({
      render: width => {
        const pad = pagePad(width)
        const rail = `${' '.repeat(pad)}${this.focused ? accent('│') : muted('│')} `
        const innerWidth = Math.max(1, width - pad - 3)
        const lines = this.getState().lines
        const source = lines.length ? lines : ['No activity yet.']
        const wrapped: string[] = []
        this.renderedSourceLines = []
        for (const item of source) {
          const styled = formatActivityDetailLine(item, Boolean(this.onInspectAgent))
          for (const segment of wrapTextWithAnsi(styled, innerWidth)) {
            wrapped.push(truncateToWidth(`${rail}${segment}`, width, ''))
            this.renderedSourceLines.push(item)
          }
        }
        return wrapped
      },
      invalidate() {},
    }, { overscroll: 'contain', scrollbar: 'auto', scrollbarTrackStyle: muted, scrollbarThumbStyle: accent })
  }

  get expanded() { return this.isExpanded }
  set expanded(value: boolean) {
    if (value === this.isExpanded) return
    this.isExpanded = value
    if (value) this.addChild(this.detailsView, { maxSize: this.capacity() })
    else { this.removeChild(this.detailsView); this.detailsView.scrollToStart(); this.returnToEditor() }
    this.requestRender()
  }

  [LAYOUT_NODE]() {
    const node = super[LAYOUT_NODE]()
    return { ...node, entries: node.entries.map(entry => entry.component === this.detailsView ? { ...entry, maxSize: this.capacity() } : entry) }
  }

  render(width: number) {
    const lines = this.children[0]!.render(width)
    if (this.expanded) {
      const content = this.detailsView.render(width)
      this.detailsView.updateLayout(content.length, Math.min(this.capacity(), content.length), this.requestRender)
      lines.push(...content.slice(this.detailsView.scrollTop, this.detailsView.scrollTop + this.capacity()))
    }
    return lines
  }

  handleInput(data: string) {
    if (matchesKey(data, 'tab') && this.onInspectAgents) {
      this.onInspectAgents()
      return
    }
    if (matchesKey(data, 'up')) this.detailsView.scrollBy(-1)
    else if (matchesKey(data, 'down')) this.detailsView.scrollBy(1)
    else if (matchesKey(data, 'pageUp')) this.detailsView.scrollBy(-Math.max(1, this.detailsView.viewportHeight))
    else if (matchesKey(data, 'pageDown')) this.detailsView.scrollBy(Math.max(1, this.detailsView.viewportHeight))
    else if (matchesKey(data, 'home')) this.detailsView.scrollToStart()
    else if (matchesKey(data, 'end')) this.detailsView.scrollToEnd()
    else if (matchesKey(data, 'escape') || matchesKey(data, 'enter')) this.expanded = false
    else this.returnToEditor(data)
    this.requestRender()
  }

  handleMouse(event: TuiMouseEvent): ReturnType<VStack['handleMouse']> {
    if (event.type === 'wheel' && this.expanded && event.y > 0) {
      this.detailsView.scrollBy(event.wheelDelta ?? 0)
      return { handled: true, target: mouseTarget(this, event) }
    }
    if (event.button !== 'left') return undefined
    if (event.y === 0) {
      if (event.type === 'click') {
        if (this.onInspectAgents && this.agentsHitRange && event.x >= this.agentsHitRange.start && event.x < this.agentsHitRange.end) {
          this.onInspectAgents()
          return { handled: true, target: mouseTarget(this, event) }
        }
        this.expanded = !this.expanded
        return { handled: true, target: mouseTarget(this, event) }
      }
      if (event.type === 'press') return { handled: true, target: mouseTarget(this, event) }
    } else if (this.expanded && (event.type === 'press' || event.type === 'click')) {
      if (event.type === 'click' && this.onInspectAgent) {
        const sourceLine = this.renderedSourceLines[this.detailsView.scrollTop + event.y - 1]
        const match = sourceLine ? /^Agent #(\d+)\b/.exec(sourceLine) : undefined
        if (match) {
          this.onInspectAgent(Number(match[1]))
          return { handled: true, target: mouseTarget(this, event) }
        }
      }
      return { handled: true, target: mouseTarget(this, event), focus: true, focusTarget: this }
    }
    return undefined
  }
}

class QuestionBox extends VStack implements Focusable {
  readonly detailsView: ScrollView
  private readonly input = new Input({ prompt: accentBold('Answer: '), placeholder: 'Type your answer…', placeholderStyle: muted })
  private readonly question: UserQuestion
  private readonly requestRender: () => void
  private readonly capacity: () => number
  private readonly showChrome: () => boolean
  private readonly onAnswer: (answer: UserAnswer) => void
  private readonly onCancel: () => void
  private readonly checked = new Set<string>()
  private cursor = 0
  private customMode = false
  private _focused = false

  get focused() { return this._focused }
  set focused(value: boolean) {
    this._focused = value
    this.input.focused = value && (!this.question.options?.length || this.customMode)
  }

  get hasOptions() { return Boolean(this.question.options?.length) && !this.customMode }
  get isMultiSelect() { return Boolean(this.question.multiSelect) }

  constructor(
    question: UserQuestion,
    index: number,
    total: number,
    requestRender: () => void,
    capacity: () => number,
    showChrome: () => boolean,
    onAnswer: (answer: UserAnswer) => void,
    onCancel: () => void,
  ) {
    super()
    this.question = question
    this.requestRender = requestRender
    this.capacity = capacity
    this.showChrome = showChrome
    this.onAnswer = onAnswer
    this.onCancel = onCancel
    const title = question.header?.trim() || question.id
    this.addChild({
      render: width => [titledRule(`${accentBold('?')} ${bold(title)}`, muted(`${index + 1}/${total}`), width, accent)],
      invalidate() {},
    })
    const body = new PaddedComponent(new Markdown(question.question, 0, 0, markdownTheme))
    this.detailsView = new ScrollView(body, {
      overscroll: 'contain', scrollbar: 'auto', scrollbarTrackStyle: muted, scrollbarThumbStyle: accent,
    })
    this.addChild(this.detailsView, { maxSize: this.capacity() })
    this.addChild({
      render: width => this.renderControls(width),
      invalidate() {},
    })
  }

  [LAYOUT_NODE]() {
    const node = super[LAYOUT_NODE]()
    return { ...node, entries: node.entries.map(entry => entry.component === this.detailsView ? { ...entry, maxSize: this.capacity() } : entry) }
  }

  private renderControls(width: number): string[] {
    const pad = pagePad(width)
    const options = this.question.options
    const chrome = this.showChrome()
    const rows: string[] = []
    if (chrome) rows.push(muted('─'.repeat(width)))
    if (!options?.length || this.customMode) {
      rows.push(...this.input.render(Math.max(1, width - pad * 2)).map(line => padEdges(line, width, pad, '')))
    } else {
      const inner = Math.max(1, width - pad * 2)
      const maxLabel = options.reduce((max, opt) => Math.max(max, visibleWidth(opt.label)), 0)
      const descCol = Math.min(24, maxLabel + 2)
      for (let idx = 0; idx < options.length; idx++) {
        const opt = options[idx]!
        const active = idx === this.cursor
        const prefix = active ? accentBold('→ ') : '  '
        const box = this.question.multiSelect ? `${this.checked.has(opt.label) ? success('[x]') : muted('[ ]')} ` : ''
        const label = active ? accentBold(opt.label) : opt.label
        let line: string
        if (opt.description && inner >= 44) {
          const gap = ' '.repeat(Math.max(2, descCol - visibleWidth(opt.label)))
          line = `${prefix}${box}${label}${gap}${muted(singleLine(opt.description))}`
        } else {
          line = `${prefix}${box}${label}${opt.description ? muted(` · ${singleLine(opt.description)}`) : ''}`
        }
        rows.push(padEdges(line, width, pad, '…'))
      }
      if (this.question.multiSelect) {
        const confirmActive = this.cursor === options.length
        rows.push(padEdges(`${confirmActive ? accentBold('→ ') : '  '}${confirmActive ? accentBold('Confirm selection') : muted('Confirm selection')}`, width, pad, ''))
      }
      const otherIndex = this.question.multiSelect ? options.length + 1 : options.length
      const otherActive = this.cursor === otherIndex
      rows.push(padEdges(`${otherActive ? accentBold('→ ') : '  '}${otherActive ? accentBold('Other (custom answer…)') : muted('Other (custom answer…)')}`, width, pad, ''))
    }
    if (chrome) rows.push(accent('─'.repeat(width)))
    return rows
  }

  render(width: number) {
    const header = this.children[0]!.render(width)
    const content = this.detailsView.render(width)
    const cap = this.capacity()
    this.detailsView.updateLayout(content.length, Math.min(cap, content.length), this.requestRender)
    const body = content.slice(this.detailsView.scrollTop, this.detailsView.scrollTop + cap)
    const controls = this.renderControls(width)
    return [...header, ...body, ...controls]
  }

  handleInput(data: string) {
    if (matchesKey(data, 'ctrl+c')) { this.onCancel(); return }
    if (matchesKey(data, 'escape')) {
      if (this.customMode && this.question.options?.length) {
        this.customMode = false
        this.input.focused = false
        this.requestRender()
      } else this.onCancel()
      return
    }
    if (matchesKey(data, 'pageUp')) { this.detailsView.scrollBy(-Math.max(1, this.detailsView.viewportHeight)); this.requestRender(); return }
    if (matchesKey(data, 'pageDown')) { this.detailsView.scrollBy(Math.max(1, this.detailsView.viewportHeight)); this.requestRender(); return }
    const options = this.question.options
    if (!options?.length || this.customMode) {
      if (matchesKey(data, 'enter')) {
        const custom = this.input.getValue().trim()
        if (custom) this.onAnswer({ id: this.question.id, selected: [], custom })
        return
      }
      this.input.handleInput(data)
      this.requestRender()
      return
    }
    const otherIndex = this.question.multiSelect ? options.length + 1 : options.length
    const totalRows = otherIndex + 1
    if (matchesKey(data, 'up')) {
      this.cursor = (this.cursor - 1 + totalRows) % totalRows
      this.requestRender()
      return
    }
    if (matchesKey(data, 'down')) {
      this.cursor = (this.cursor + 1) % totalRows
      this.requestRender()
      return
    }
    if (this.question.multiSelect && data === ' ') {
      const opt = options[this.cursor]
      if (opt) {
        if (this.checked.has(opt.label)) this.checked.delete(opt.label)
        else this.checked.add(opt.label)
        this.requestRender()
      }
      return
    }
    if (matchesKey(data, 'enter')) {
      if (this.cursor === otherIndex) {
        this.customMode = true
        this.input.focused = this.focused
        this.requestRender()
        return
      }
      if (this.question.multiSelect) {
        const selected = options.filter(opt => this.checked.has(opt.label)).map(opt => opt.label)
        if (selected.length) this.onAnswer({ id: this.question.id, selected })
      } else {
        const opt = options[this.cursor]
        if (opt) this.onAnswer({ id: this.question.id, selected: [opt.label] })
      }
    }
  }
}

class InspectorBox extends VStack implements Focusable {
  readonly detailsView: ScrollView
  private readonly options: InspectOptions
  private readonly requestRender: () => void
  private readonly capacity: () => number
  private readonly showChrome: () => boolean
  private readonly onDone: (action?: string) => void
  focused = false

  constructor(
    options: InspectOptions,
    requestRender: () => void,
    capacity: () => number,
    showChrome: () => boolean,
    onDone: (action?: string) => void,
  ) {
    super()
    this.options = options
    this.requestRender = requestRender
    this.capacity = capacity
    this.showChrome = showChrome
    this.onDone = onDone
    this.addChild({
      render: width => [titledRule(`${accentBold('☰')} ${bold(options.title)}`, options.badge ? accentBold(options.badge) : '', width, accent)],
      invalidate() {},
    })
    const body = new PaddedComponent(new Markdown(options.content.trim() || '_No content yet._', 0, 0, markdownTheme))
    this.detailsView = new ScrollView(body, {
      overscroll: 'contain', scrollbar: 'auto', scrollbarTrackStyle: muted, scrollbarThumbStyle: accent,
    })
    this.addChild(this.detailsView, { maxSize: this.capacity() })
    this.addChild({
      render: width => this.renderControls(width),
      invalidate() {},
    })
  }

  [LAYOUT_NODE]() {
    const node = super[LAYOUT_NODE]()
    return { ...node, entries: node.entries.map(entry => entry.component === this.detailsView ? { ...entry, maxSize: this.capacity() } : entry) }
  }

  private renderControls(width: number): string[] {
    const pad = pagePad(width)
    const chrome = this.showChrome()
    const rows: string[] = []
    if (chrome) rows.push(muted('─'.repeat(width)))
    const actions = (this.options.actions ?? []).map(a => `${accent(`[${a.key}]`)} ${a.label}`)
    if (actions.length) {
      rows.push(splitRow(actions.join('  '), muted('[Esc] Close'), width, pad, '…'))
    } else if (!chrome) {
      rows.push(padEdges(muted('↑↓/PgUp/PgDn scroll · Esc close'), width, pad, ''))
    }
    if (chrome) rows.push(accent('─'.repeat(width)))
    return rows
  }

  render(width: number) {
    const header = this.children[0]!.render(width)
    const content = this.detailsView.render(width)
    const cap = this.capacity()
    this.detailsView.updateLayout(content.length, Math.min(cap, content.length), this.requestRender)
    const body = content.slice(this.detailsView.scrollTop, this.detailsView.scrollTop + cap)
    const controls = this.renderControls(width)
    return [...header, ...body, ...controls]
  }

  handleInput(data: string) {
    if (matchesKey(data, 'ctrl+c') || matchesKey(data, 'escape')) { this.onDone(); return }
    if (matchesKey(data, 'up')) { this.detailsView.scrollBy(-1); this.requestRender(); return }
    if (matchesKey(data, 'down')) { this.detailsView.scrollBy(1); this.requestRender(); return }
    if (matchesKey(data, 'pageUp')) { this.detailsView.scrollBy(-Math.max(1, this.detailsView.viewportHeight)); this.requestRender(); return }
    if (matchesKey(data, 'pageDown')) { this.detailsView.scrollBy(Math.max(1, this.detailsView.viewportHeight)); this.requestRender(); return }
    if (matchesKey(data, 'home')) { this.detailsView.scrollToStart(); this.requestRender(); return }
    if (matchesKey(data, 'end')) { this.detailsView.scrollToEnd(); this.requestRender(); return }
    const lower = data.toLowerCase()
    const hit = (this.options.actions ?? []).find(a =>
      a.key.toLowerCase() === lower || (a.key.toLowerCase() === 'enter' && matchesKey(data, 'enter')),
    )
    if (hit) { this.onDone(hit.key); return }
  }
}

class PromptBox extends Container implements Focusable {
  private readonly input: Input
  private readonly done: (value?: string) => void
  private readonly requestRender: () => void
  private _focused = false

  get focused() { return this._focused }
  set focused(value: boolean) { this._focused = value; this.input.focused = value }

  constructor(title: string, placeholder: string, requestRender: () => void, done: (value?: string) => void) {
    super()
    this.requestRender = requestRender
    this.done = done
    this.input = new Input({ prompt: accentBold('› '), placeholder, placeholderStyle: muted })
    this.addChild({
      render: width => [titledRule(accentBold(title), muted('Enter send · Esc cancel'), width, accent)],
      invalidate() {},
    })
    this.addChild(new PaddedComponent(this.input))
    this.addChild({
      render: width => [accent('─'.repeat(width))],
      invalidate() {},
    })
  }

  handleInput(data: string) {
    if (matchesKey(data, 'escape') || matchesKey(data, 'ctrl+c')) { this.done(); return }
    if (matchesKey(data, 'enter')) {
      const value = this.input.getValue().trim()
      if (value) this.done(value)
      return
    }
    this.input.handleInput(data)
    this.requestRender()
  }

  render(width: number) { return super.render(width).map(line => truncateToWidth(line, width, '')) }
}

class ToolDetailsTui extends TuiAltScreen {
  addInputListener(listener: TuiInputListener) {
    // The native viewport listener is registered first; intercept pane paging before it.
    return super.addInputListener(data => {
      const focused = this.getFocusedComponent()
      if ((focused instanceof ToolRow && focused.expanded || focused instanceof ActivityPanel && focused.expanded || focused instanceof QuestionBox || focused instanceof InspectorBox) &&
          (matchesKey(data, 'pageUp') || matchesKey(data, 'pageDown'))) {
        focused.handleInput(data)
        return { consume: true }
      }
      return listener(data)
    })
  }

  scrollBy(lines: number) {
    const focused = this.getFocusedComponent()
    if (focused instanceof ToolRow && focused.expanded || focused instanceof ActivityPanel && focused.expanded || focused instanceof QuestionBox || focused instanceof InspectorBox) {
      // Native viewport paging runs before application input listeners.
      focused.detailsView.scrollBy(Math.sign(lines) * Math.min(Math.abs(lines), Math.max(1, focused.detailsView.viewportHeight)))
      this.requestRender()
      return
    }
    super.scrollBy(lines)
  }
}

class PromptEditor extends Editor {
  private outerWidth = 80

  private renderBorderLine(direction: '↑' | '↓', hiddenLineCount: number) {
    const width = Math.max(0, this.outerWidth)
    const lineStyle = this.focused ? accent : muted
    if (hiddenLineCount > 0) {
      const label = ` ${direction} ${hiddenLineCount} more `
      const labelWidth = visibleWidth(label)
      if (labelWidth + 2 <= width) {
        const left = Math.floor((width - labelWidth) / 2)
        return lineStyle(`${'─'.repeat(left)}${label}${'─'.repeat(width - left - labelWidth)}`)
      }
    }
    return lineStyle('─'.repeat(width))
  }

  protected renderTopBorder(_width: number, hiddenLineCount: number) {
    return this.renderBorderLine('↑', hiddenLineCount)
  }

  protected renderBottomBorder(_width: number, hiddenLineCount: number) {
    return this.renderBorderLine('↓', hiddenLineCount)
  }

  render(width: number) {
    this.outerWidth = width
    const pad = pagePad(width)
    const rawPrefix = width >= 10 ? 'pie2> ' : '> '
    const styledPrefix = width >= 10 ? `${accentBold('pie2')}${accent('>')} ` : `${accent('>')} `
    const leftOffset = pad + rawPrefix.length
    const innerWidth = Math.max(1, width - leftOffset - pad)
    const rawLines = super.render(innerWidth)
    const visibleLines = (this as unknown as { renderedVisibleLineCount: number }).renderedVisibleLineCount ?? 1
    const bottomBorderIndex = visibleLines + 1
    const margin = ' '.repeat(pad)
    const continuation = ' '.repeat(leftOffset)
    return rawLines.map((line, index) => {
      if (index === 0 || index === bottomBorderIndex) return truncateToWidth(line, width, '')
      if (index > bottomBorderIndex) return truncateToWidth(`${margin}${line}`, width, '')
      const prefix = index === 1 ? `${margin}${styledPrefix}` : continuation
      const combined = line ? `${prefix}${line}` : ''
      return visibleWidth(combined) <= width ? combined : truncateToWidth(combined, width, '')
    })
  }

  handleMouse(event: TuiMouseEvent) {
    const pad = pagePad(event.width)
    const prefixLen = event.width >= 10 ? 6 : 2
    const visibleLines = (this as unknown as { renderedVisibleLineCount: number }).renderedVisibleLineCount ?? 1
    const autocompleteStartRow = visibleLines + 2
    const xOffset = event.y >= autocompleteStartRow ? pad : pad + prefixLen
    const innerWidth = Math.max(1, event.width - pad * 2 - prefixLen)
    return super.handleMouse({ ...event, x: Math.max(0, event.x - xOffset), width: innerWidth })
  }
}

class SearchPicker extends Container implements Focusable {
  readonly input = new Input({ prompt: accentBold('Search: '), placeholder: 'Type to filter', placeholderStyle: muted })
  private list: SelectList
  private _focused = false
  get focused() { return this._focused }
  set focused(value: boolean) { this._focused = value; this.input.focused = value }

  private readonly items: SelectItem[]
  private matchCount: number
  private readonly done: (value?: string) => void

  constructor(title: string, items: SelectItem[], done: (value?: string) => void, current?: string) {
    super()
    this.items = items
    this.matchCount = items.length
    this.done = done
    this.list = this.makeList(items)
    if (current) this.list.setSelectedIndex(items.findIndex(item => item.value === current))
    this.addChild({
      render: width => [titledRule(accentBold(title), muted(`${this.matchCount}/${this.items.length}`), width, accent)],
      invalidate() {},
    })
    this.addChild(new PaddedComponent(this.input))
    this.addChild(new PaddedComponent(this.list))
    this.addChild({
      render: width => [accent('─'.repeat(width))],
      invalidate() {},
    })
  }

  private makeList(items: SelectItem[]) {
    const list = new SelectList(items, 8, selectTheme)
    list.onSelect = item => this.done(item.value)
    list.onCancel = () => this.done()
    return list
  }

  handleInput(data: string) {
    if (matchesKey(data, 'escape') || matchesKey(data, 'ctrl+c')) { this.done(); return }
    if (['up', 'down', 'enter'].some(key => matchesKey(data, key as 'up' | 'down' | 'enter'))) {
      this.list.handleInput(data)
      return
    }
    const before = this.input.getValue()
    this.input.handleInput(data)
    if (before !== this.input.getValue()) {
      const terms = this.input.getValue().toLowerCase().trim().split(/\s+/)
      const filtered = this.items.filter(item => {
        const text = `${item.value} ${item.label} ${item.description ?? ''}`.toLowerCase()
        return terms.every(term => text.includes(term))
      })
      this.matchCount = filtered.length
      this.list = this.makeList(filtered)
      this.children[2] = new PaddedComponent(this.list)
    }
  }

  render(width: number) { return super.render(width).map(line => truncateToWidth(line, width, '')) }
}

// ─── Header & Footer Formatters ──────────────────────────────────────────────

function extractTelemetryMeta(rawStatus: string) {
  const segments = rawStatus.split(' · ')
  let sessionId = ''
  let branch = ''
  const left: string[] = []
  const right: string[] = []
  const trailing = segments.at(-1) ?? ''
  const dirBranch = /^(.+?)\s+(\([^)]+\))$/.exec(trailing)

  segments.forEach((seg, index) => {
    if (index === segments.length - 1 && (seg === '~' || seg.startsWith('~/') || seg.startsWith('/') || dirBranch)) {
      if (dirBranch) branch = dirBranch[2]!
      return
    }
    if (/^#[0-9a-zA-Z_-]+$/.test(seg)) {
      sessionId = seg
      right.push(seg)
      return
    }
    if (/^↑\S+\s+↓\S+$/.test(seg) || /^cache\s+\d+%$/.test(seg) || /^~\d+%\s+ctx$/.test(seg)) {
      right.push(seg)
      return
    }
    left.push(seg)
  })

  return { left, right, sessionId, branch }
}

function styleStatusSegment(seg: string, isModel: boolean): string {
  if (isModel) {
    const slash = seg.indexOf('/')
    return slash > 0 ? `${muted(seg.slice(0, slash + 1))}${accentBold(seg.slice(slash + 1))}` : accentBold(seg)
  }
  const thinking = /^thinking\s+(.+)$/.exec(seg)
  if (thinking) {
    const level = thinking[1]!
    const levelFn = level === 'off' ? muted : level === 'low' ? info : accent
    return `${muted('thinking')} ${levelFn(level)}`
  }
  if (seg === 'ready') return success(seg)
  if (seg === 'working') return accentBold(seg)
  if (seg === 'compacting') return brand(seg)
  if (/^\d+\s+queued$/.test(seg)) return accentBold(seg)
  if (/^#[0-9a-zA-Z_-]+$/.test(seg)) return muted(seg)
  const tokens = /^↑(\S+)\s+↓(\S+)$/.exec(seg)
  if (tokens) return `${muted('↑')}${tokens[1]} ${muted('↓')}${tokens[2]}`
  const cache = /^cache\s+(\d+%)$/.exec(seg)
  if (cache) return `${muted('cache')} ${cache[1]}`
  const ctx = /^~(\d+)%\s+ctx$/.exec(seg)
  if (ctx) {
    const pct = Number(ctx[1])
    return (pct >= 85 ? errorBold : pct >= 65 ? brand : success)(seg)
  }
  return muted(seg)
}

function formatFooterStatusLine(rawLine: string, width: number, omitSessionInFooter: boolean): string {
  if (width <= 0 || !rawLine) return ''
  const pad = pagePad(width)
  const inner = Math.max(1, width - pad * 2)
  const { left, right } = extractTelemetryMeta(rawLine)
  const filteredRight = omitSessionInFooter ? right.filter(item => !/^#[0-9a-zA-Z_-]+$/.test(item)) : right

  const leftStyled = left.map((seg, i) => styleStatusSegment(seg, i === 0)).join(muted(' · '))
  const leftWidth = visibleWidth(leftStyled)

  if (!filteredRight.length) return padEdges(leftStyled, width, pad, '')

  // Fit as many right-aligned telemetry items as cleanly coexist with the left status cluster.
  const keptRight: string[] = []
  for (const item of filteredRight) {
    const candidate = [...keptRight, item].map(seg => styleStatusSegment(seg, false)).join(muted(' · '))
    if (leftWidth + 2 + visibleWidth(candidate) <= inner) keptRight.push(item)
  }
  const rightStyled = keptRight.map(seg => styleStatusSegment(seg, false)).join(muted(' · '))
  return splitRow(leftStyled, rightStyled, width, pad, '')
}

type HintMode = 'editor' | 'picker' | 'question-choice' | 'question-multi' | 'question-text' | 'inspect' | 'prompt' | 'details'

function formatHintsLine(mode: HintMode, width: number): string {
  if (width <= 0) return ''
  const pad = pagePad(width)
  const inner = Math.max(1, width - pad * 2)
  const fmt = ([key, label]: readonly [string, string]) => `${accent(key)} ${muted(label)}`

  let primary: readonly (readonly [string, string])[]
  let secondary: readonly (readonly [string, string])[] = []

  switch (mode) {
    case 'picker':
      primary = [['↑↓', 'select'], ['Enter', 'confirm']]
      secondary = [['Esc', 'cancel']]
      break
    case 'question-multi':
      primary = [['↑↓', 'move'], ['Space', 'toggle'], ['PgUp/PgDn', 'scroll'], ['Enter', 'confirm']]
      secondary = [['Esc', 'cancel']]
      break
    case 'question-choice':
      primary = [['↑↓', 'select'], ['PgUp/PgDn', 'scroll'], ['Enter', 'confirm']]
      secondary = [['Esc', 'cancel']]
      break
    case 'question-text':
      primary = [['Enter', 'submit'], ['PgUp/PgDn', 'scroll']]
      secondary = [['Esc', 'cancel']]
      break
    case 'inspect':
      primary = [['↑↓', 'scroll'], ['PgUp/PgDn', 'page'], ['Home/End', 'jump']]
      secondary = [['Esc', 'close']]
      break
    case 'prompt':
      primary = [['Enter', 'send']]
      secondary = [['Esc', 'cancel']]
      break
    case 'details':
      primary = [['↑↓', 'scroll'], ['PgUp/PgDn', 'page'], ['Home/End', 'jump'], ['Tab', 'agents']]
      secondary = [['Esc', 'editor']]
      break
    case 'editor':
      primary = [
        ['/', 'commands'],
        ['/agents', 'agents'],
        ['Ctrl+P', 'model'],
        ['Ctrl+T', 'activity'],
        ['Shift+Tab', 'thinking'],
        ['Ctrl+O', 'tools'],
      ]
      secondary = [['Esc', 'interrupt'], ['Ctrl+D', 'exit']]
      break
  }

  const sep = '  '
  const sepW = sep.length
  const rightParts: string[] = []
  let rightW = 0
  for (const item of secondary) {
    const rendered = fmt(item)
    const nextW = rightW + (rightParts.length ? sepW : 0) + visibleWidth(rendered)
    if (nextW <= inner) {
      rightParts.push(rendered)
      rightW = nextW
    }
  }

  const leftBudget = rightW ? inner - rightW - 2 : inner
  const leftParts: string[] = []
  let leftW = 0
  for (const item of primary) {
    const rendered = fmt(item)
    const nextW = leftW + (leftParts.length ? sepW : 0) + visibleWidth(rendered)
    if (nextW <= leftBudget) {
      leftParts.push(rendered)
      leftW = nextW
    }
  }

  if (!leftParts.length && rightParts.length) return padEdges(rightParts.join(sep), width, pad, '')
  return splitRow(leftParts.join(sep), rightParts.join(sep), width, pad, '')
}

function formatHeaderLine(cwd: string, rawStatus: string, width: number): string {
  if (width <= 0) return ''
  const pad = pagePad(width)
  const display = shortPath(cwd)
  const parent = dirname(display)
  const base = basename(display)
  const styledPath = base && parent !== display && display !== '~'
    ? `${muted(parent === '/' ? '/' : `${parent}/`)}${bold(base)}`
    : bold(display)
  const left = `${accentBold('pie2')}${muted(' · ')}${styledPath}`
  const { branch, sessionId } = extractTelemetryMeta(rawStatus)
  const metaParts = [branch ? accent(branch) : '', sessionId ? muted(sessionId) : ''].filter(Boolean)
  const right = width >= 56 && metaParts.length ? metaParts.join(muted(' · ')) : ''
  return splitRow(left, right, width, pad, '…')
}

// ─── Main Terminal UI ────────────────────────────────────────────────────────

export class TerminalUI {
  readonly tui: TuiAltScreen
  readonly editor: Editor
  readonly closed: Promise<void>
  private resolveClosed!: () => void
  private started = false
  private isClosed = false
  private transcript = new VStack()
  private activity = new Container()
  private composer = new Container()
  private statusBar?: StatusBar
  private activityPanel?: ActivityPanel
  private activeQuestion?: QuestionBox
  private activeInspector?: InspectorBox
  private cwd: string
  private footer: Component = {
    render: width => {
      const rawStatus = this.statusBar?.render(width) ?? [truncateToWidth(`${this.model} · thinking ${this.thinking} · ${this.busy ? 'working' : 'ready'}`, width, '')]
      const focused = this.tui.getFocusedComponent()
      const mode: HintMode = this.promptSession
        ? 'prompt'
        : this.picker
          ? 'picker'
          : this.activeQuestion
            ? (this.activeQuestion.hasOptions ? (this.activeQuestion.isMultiSelect ? 'question-multi' : 'question-choice') : 'question-text')
            : this.activeInspector
              ? 'inspect'
              : (focused instanceof ToolRow || focused instanceof ActivityPanel)
                ? 'details'
                : 'editor'
      const headerShowsSession = this.tui.terminal.rows > 8 && width >= 56
      return [
        ...rawStatus.map(line => formatFooterStatusLine(line, width, headerShowsSession)),
        formatHintsLine(mode, width),
      ]
    },
    invalidate() {},
  }
  private model = 'model unset'
  private thinking = 'off'
  private busy = false
  private loader?: Loader
  private picker?: { finish: (value?: string) => void }
  private questionSession?: { cancel: () => void }
  private inspectSession?: { cancel: () => void }
  private promptSession?: { cancel: () => void }
  private assistant?: { view: AssistantView; blocks: AssistantMessage['content'] }
  private seenEntries = new Set<number>()
  private tools = new Map<string, ToolRow>()

  constructor(options: {
    cwd: string
    commands: SlashCommand[]
    onSubmit: (text: string) => Promise<void>
    onInterrupt: () => Promise<void>
    onCycleModel?: () => Promise<void>
    onCycleThinking?: () => Promise<void>
    onInspectAgents?: () => Promise<void>
    onInspectAgent?: (id: number) => Promise<void>
    statusBar?: StatusBar
    terminal?: Terminal
  }) {
    this.cwd = options.cwd
    this.closed = new Promise(resolve => { this.resolveClosed = resolve })
    this.statusBar = options.statusBar
    this.tui = new ToolDetailsTui(options.terminal ?? new ProcessTerminal(), true, undefined, {
      mouse: true,
      searchMatchStyle: inverse,
      searchCurrentMatchStyle: text => bold(inverse(text)),
      scrollToEndIndicator: () => inverse(accent(' ↓ Latest ')),
    })
    this.editor = new PromptEditor(this.tui, { borderColor: muted, selectList: selectTheme })
    this.editor.setAutocompleteMaxVisible(8)
    this.editor.setAutocompleteProvider(new CombinedAutocompleteProvider(options.commands, options.cwd))
    this.editor.onSubmit = value => {
      const text = value.trim()
      this.editor.setText('')
      if (!text) return
      this.editor.addToHistory(value)
      if (text === '/exit' || text === '/quit') { this.close(); return }
      this.invoke(() => options.onSubmit(text))
    }
    const header: Component = {
      render: width => {
        const rawStatus = this.statusBar?.render(1000)[0] ?? ''
        return [formatHeaderLine(this.cwd, rawStatus, width)]
      },
      invalidate() {},
    }
    this.composer.addChild(this.editor)
    this.statusBar?.setRenderHook?.(() => this.tui.requestRender())
    const inspectAgents = options.onInspectAgents
      ? () => {
        if (this.questionSession) return
        this.invoke(options.onInspectAgents!)
      }
      : undefined
    const inspectAgent = options.onInspectAgent
      ? (id: number) => {
        if (this.questionSession) return
        this.invoke(() => options.onInspectAgent!(id))
      }
      : undefined
    if (this.statusBar?.activity) this.activityPanel = new ActivityPanel(
      () => this.statusBar!.activity!(), () => this.tui.requestRender(),
      data => { this.tui.setFocus(this.editor); if (data) this.editor.handleInput(data) },
      () => Math.max(1, Math.min(8, this.tui.terminal.rows - 9)),
      { onInspectAgents: inspectAgents, onInspectAgent: inspectAgent },
    )
    // Short chats sit above the composer; empty chats show a calm centered quick-start canvas.
    const spacer: Component = {
      render: width => this.renderEmptyCanvas(width),
      invalidate() {},
    }
    const topDivider: Component = {
      render: width => [muted('┄'.repeat(width))],
      invalidate() {},
    }
    const transcriptView = new ScrollView(this.transcript, {
      follow: 'end', primary: true, scrollbar: 'always', scrollbarTrackStyle: muted, scrollbarThumbStyle: accent,
    })
    const layout = new VStack([
      { component: header, shrink: 0, visible: viewport => viewport.height > 8 },
      ...(this.activityPanel ? [{ component: this.activityPanel, shrink: 0 }] : []),
      { component: topDivider, shrink: 0, visible: viewport => viewport.height > 12 && Boolean(this.activityPanel) },
      { component: spacer, basis: 0, grow: 1, shrink: 0 },
      { component: transcriptView, basis: 'auto', shrink: 1, minSize: 0 },
      { component: this.activity, shrink: 0 },
      { component: this.composer, shrink: 0 },
      { component: this.footer, shrink: 0 },
    ])
    this.tui.addChild(layout)
    this.tui.setLayoutRoot(layout)
    this.tui.setFocus(this.editor)
    this.updateFooter()
    this.tui.addInputListener(data => {
      if (this.isClosed) return { consume: true }
      if (this.picker || this.questionSession || this.inspectSession || this.promptSession) return
      const focusedDetails = this.tui.getFocusedComponent()
      if ((focusedDetails instanceof ToolRow || focusedDetails instanceof ActivityPanel) && ['up', 'down', 'pageUp', 'pageDown', 'home', 'end'].some(key => matchesKey(data, key as 'up' | 'down' | 'pageUp' | 'pageDown' | 'home' | 'end'))) {
        focusedDetails.handleInput(data)
        return { consume: true }
      }
      if (matchesKey(data, 'ctrl+t') && this.activityPanel) {
        this.activityPanel.expanded = !this.activityPanel.expanded
        this.tui.setFocus(this.activityPanel.expanded ? this.activityPanel : this.editor)
        return { consume: true }
      }
      if (matchesKey(data, 'ctrl+o')) {
        const thinking = this.thinkingRows()
        const expand = [...this.tools.values()].some(tool => !tool.expanded) || thinking.some(row => !row.expanded)
        for (const tool of this.tools.values()) tool.expanded = expand
        for (const row of thinking) row.toggle(expand)
        this.tui.requestRender()
        return { consume: true }
      }
      if (matchesKey(data, 'ctrl+d') && !this.editor.getText()) { this.close(); return { consume: true } }
      if (matchesKey(data, 'ctrl+p') && options.onCycleModel) {
        this.invoke(options.onCycleModel)
        return { consume: true }
      }
      if (matchesKey(data, 'shift+tab') && options.onCycleThinking) {
        this.invoke(options.onCycleThinking)
        return { consume: true }
      }
      if (matchesKey(data, 'escape') && focusedDetails instanceof ToolRow) {
        this.tui.setFocus(this.editor)
        return { consume: true }
      }
      if (matchesKey(data, 'escape') && this.editor.isShowingAutocomplete()) return
      if (matchesKey(data, 'escape') && this.activityPanel?.expanded) {
        this.activityPanel.expanded = false
        return { consume: true }
      }
      if (matchesKey(data, 'escape') || matchesKey(data, 'ctrl+c')) {
        this.invoke(options.onInterrupt)
        return { consume: true }
      }
    })
  }

  private renderEmptyCanvas(width: number): string[] {
    if (this.transcript.children.length > 0 || this.picker || this.questionSession || this.inspectSession || this.promptSession || this.activityPanel?.expanded) return []
    if (this.editor.getText() || this.editor.isShowingAutocomplete()) return []
    const rows = this.tui.terminal.rows
    if (rows < 18 || width < 52) return []
    const center = (line: string) => {
      const clipped = truncateToWidth(line, width, '')
      const left = Math.max(0, Math.floor((width - visibleWidth(clipped)) / 2))
      return `${' '.repeat(left)}${clipped}`
    }
    const items: readonly [string, string][] = [
      ['/help', 'commands & shortcuts'],
      ['/agents', 'inspect & manage subagents'],
      ['/model', 'switch model (Ctrl+P)'],
      ['/plan on', 'read-only planning mode'],
      ['/goal', 'long-running objective'],
    ]
    const gridLines = items.map(([cmd, desc]) => `${accent(cmd.padEnd(11))}${muted(desc)}`)
    const blockWidth = gridLines.reduce((max, line) => Math.max(max, visibleWidth(line)), 0)
    const blockMargin = ' '.repeat(Math.max(0, Math.floor((width - blockWidth) / 2)))
    const card = [
      center(accentBold('pie2')),
      center(muted(`${shortPath(this.cwd)} · ${this.model}`)),
      '',
      ...gridLines.map(line => truncateToWidth(`${blockMargin}${line}`, width, '')),
    ]
    const chromeRows = this.activityPanel ? 8 : 6
    const availHeight = Math.max(card.length, rows - chromeRows)
    const topPad = Math.max(0, Math.floor((availHeight - card.length) / 2))
    return [...Array.from({ length: topPad }, () => ''), ...card]
  }

  private thinkingRows(): ThinkingRow[] {
    const collect = (component: Component): ThinkingRow[] => component instanceof ThinkingRow ? [component]
      : component instanceof Container ? component.children.flatMap(collect) : []
    return collect(this.transcript)
  }

  private invoke(action: () => Promise<void>) {
    void Promise.resolve().then(action).catch(error => this.notify(error instanceof Error ? error.message : String(error), true))
  }

  start() {
    if (this.started || this.isClosed) return
    this.started = true
    this.tui.start()
  }

  stop() {
    this.close()
    this.setBusy(false)
    if (!this.started) return
    this.started = false
    this.tui.stop()
  }

  private cancelComposerOverlays() {
    this.picker?.finish()
    this.inspectSession?.cancel()
    this.promptSession?.cancel()
  }

  private restoreComposer() {
    this.composer.clear()
    this.composer.addChild(this.editor)
    this.tui.setFocus(this.editor)
    this.tui.requestRender()
  }

  close() {
    if (this.isClosed) return
    this.isClosed = true
    this.statusBar?.setRenderHook?.(undefined)
    this.cancelComposerOverlays()
    this.questionSession?.cancel()
    this.resolveClosed()
  }

  notify(text: string, error = false) {
    if (this.isClosed) return
    const formatted = error ? `${errorColor('✕')} ${errorColor(text)}` : muted(text)
    this.transcript.addChild(new PaddedComponent(new Text(formatted, 0, 1)))
    this.tui.requestRender()
  }

  setStatus(model: string, thinking: string) {
    this.model = model
    this.thinking = thinking
    this.updateFooter()
  }

  private updateFooter() {
    this.statusBar?.setModel(this.model, this.thinking)
    this.tui.requestRender()
  }

  private setBusy(busy: boolean, message = 'Working…') {
    this.busy = busy
    if (busy) {
      if (!this.loader) {
        this.loader = new CompactLoader(this.tui, accent, muted, message)
        this.activity.addChild(this.loader)
      } else this.loader.setMessage(message)
    } else if (this.loader) {
      this.loader.stop()
      this.activity.removeChild(this.loader)
      this.loader = undefined
    }
    this.updateFooter()
  }

  async select(title: string, items: SelectItem[], current?: string): Promise<string | undefined> {
    if (this.isClosed) return
    this.cancelComposerOverlays()
    if (this.activityPanel?.expanded) this.activityPanel.expanded = false
    return new Promise(resolve => {
      let settled = false
      const finish = (value?: string) => {
        if (settled) return
        settled = true
        this.picker = undefined
        this.restoreComposer()
        resolve(value)
      }
      const picker = new SearchPicker(title, items, finish, current)
      this.picker = { finish }
      this.composer.clear()
      this.composer.addChild(picker)
      this.tui.setFocus(picker)
      this.tui.requestRender()
    })
  }

  async inspect(options: InspectOptions): Promise<string | undefined> {
    if (this.isClosed) return
    this.cancelComposerOverlays()
    if (this.activityPanel?.expanded) this.activityPanel.expanded = false
    return new Promise(resolve => {
      let settled = false
      const finish = (action?: string) => {
        if (settled) return
        settled = true
        this.inspectSession = undefined
        this.activeInspector = undefined
        this.restoreComposer()
        resolve(action)
      }
      const showChrome = () => this.tui.terminal.rows > 10
      const box = new InspectorBox(
        options,
        () => this.tui.requestRender(),
        () => {
          const chromeRows = showChrome() ? 2 : 0
          const controlsRows = options.actions?.length || !showChrome() ? 1 : 0
          const reserved = chromeRows + controlsRows + (this.busy ? 1 : 0) + (this.activityPanel ? 2 : 0) + 4
          return Math.max(1, Math.min(14, this.tui.terminal.rows - reserved))
        },
        showChrome,
        finish,
      )
      this.activeInspector = box
      this.inspectSession = { cancel: () => finish(undefined) }
      this.composer.clear()
      this.composer.addChild(box)
      this.tui.setFocus(box)
      this.tui.requestRender()
    })
  }

  async prompt(title: string, placeholder = 'Type message…'): Promise<string | undefined> {
    if (this.isClosed) return
    this.cancelComposerOverlays()
    return new Promise(resolve => {
      let settled = false
      const finish = (value?: string) => {
        if (settled) return
        settled = true
        this.promptSession = undefined
        this.restoreComposer()
        resolve(value)
      }
      const box = new PromptBox(title, placeholder, () => this.tui.requestRender(), finish)
      this.promptSession = { cancel: () => finish(undefined) }
      this.composer.clear()
      this.composer.addChild(box)
      this.tui.setFocus(box)
      this.tui.requestRender()
    })
  }

  async askUser(questions: readonly UserQuestion[], context?: Context): Promise<UserAnswer[]> {
    validateQuestions(questions)
    if (this.isClosed || context?.abortSignal?.aborted) {
      throw new Error('User interaction cancelled; no answer or approval was granted')
    }
    this.cancelComposerOverlays()
    this.questionSession?.cancel()
    if (this.activityPanel?.expanded) this.activityPanel.expanded = false
    const answers: UserAnswer[] = []
    for (let index = 0; index < questions.length; index++) {
      const question = questions[index]!
      const answer = await new Promise<UserAnswer>((resolve, reject) => {
        let settled = false
        const restore = () => {
          context?.abortSignal?.removeEventListener('abort', cancel)
          this.questionSession = undefined
          this.activeQuestion = undefined
          this.composer.clear()
          this.composer.addChild(this.editor)
          this.tui.setFocus(this.editor)
          this.tui.requestRender()
        }
        const cancel = () => {
          if (settled) return
          settled = true
          restore()
          reject(new Error('User interaction cancelled; no answer or approval was granted'))
        }
        const confirm = (value: UserAnswer) => {
          if (settled) return
          settled = true
          restore()
          resolve(value)
        }
        const optionRows = question.options?.length ? question.options.length + (question.multiSelect ? 2 : 1) : 1
        const showChrome = () => this.tui.terminal.rows > 10
        const box = new QuestionBox(
          question,
          index,
          questions.length,
          () => this.tui.requestRender(),
          () => {
            const chromeRows = showChrome() ? 2 : 0
            const reserved = optionRows + chromeRows + (this.busy ? 1 : 0) + (this.activityPanel ? 1 : 0) + 3
            return Math.max(1, Math.min(12, this.tui.terminal.rows - reserved))
          },
          showChrome,
          confirm,
          cancel,
        )
        this.activeQuestion = box
        this.questionSession = { cancel }
        context?.abortSignal?.addEventListener('abort', cancel, { once: true })
        this.composer.clear()
        this.composer.addChild(box)
        this.tui.setFocus(box)
        this.tui.requestRender()
      })
      answers.push(answer)
    }
    return answers
  }

  private addMessage(message: Message, streaming = false): AssistantView | undefined {
    if (message.role !== 'user' && message.role !== 'assistant') return
    if (message.role === 'assistant') {
      const view = new AssistantView(() => this.tui.requestRender())
      view.setContent(message.content, streaming)
      this.transcript.addChild(view)
      return view
    }
    if (this.transcript.children.length > 0) {
      this.transcript.addChild({ render: () => [''], invalidate() {} })
    }
    this.transcript.addChild(new PaddedComponent(new Text(accentBold('You'), 0, 0)))
    this.transcript.addChild(new PaddedComponent(new Markdown(messageText(message), 0, 0, markdownTheme)))
  }

  private appendEntry(entry: EntryRecord) {
    if (this.seenEntries.has(entry.id)) return
    this.seenEntries.add(entry.id)
    if (entry.kind === 'pie2.background-result' && entry.data && typeof entry.data === 'object' && !Array.isArray(entry.data)) {
      const { source, id, description, status } = entry.data
      const row = this.tool(`background:${source}:${id}`, source === 'subagent' ? 'Agent' : 'Job')
      row.args = { description: `后台：${typeof description === 'string' && description ? description : String(id)}`,
        ...(source === 'job' ? { job_id: String(id) } : {}) }
      row.finish((entry.model ?? []).map(messageText).join('\n'), status === 'completed' ? 'done' : status === 'aborted' || status === 'interrupted' ? 'aborted' : 'failed')
      return
    }
    for (const message of entry.model ?? []) {
      if (message.role === 'assistant' && this.assistant) {
        this.assistant.view.setContent(message.content, false)
        for (const block of message.content) if (block.type === 'toolCall') this.tool(block.id, block.name).args = block.arguments
        this.assistant = undefined
      } else if (message.role === 'toolResult') {
        const status = message.isError ? (/abort|interrupt|cancel/i.test(messageText(message)) ? 'aborted' : 'failed') : 'done'
        this.finishTool(message.toolCallId, message.toolName, messageText(message), status)
      } else {
        this.addMessage(message)
        if (message.role === 'assistant') for (const block of message.content) if (block.type === 'toolCall') this.tool(block.id, block.name).args = block.arguments
      }
    }
  }

  private startAssistant(message: AssistantMessage) {
    const view = this.assistant?.view ?? this.addMessage(message, true)!
    this.assistant = { view, blocks: structuredClone(message.content) }
    view.setContent(message.content, true)
  }

  private tool(callId: string, name: string) {
    let tool = this.tools.get(callId)
    if (!tool) {
      tool = new ToolRow(name, () => this.tui.requestRender(), data => {
        this.tui.setFocus(this.editor)
        if (data) this.editor.handleInput(data)
      })
      this.tools.set(callId, tool)
      this.transcript.addChild(tool)
    }
    return tool
  }

  private finishTool(callId: string, name: string, output: string, status: ToolRow['status'], durationMs?: number) {
    this.tool(callId, name).finish(output, status, durationMs)
  }

  showSnapshot(snapshot: SnapshotEvent) {
    if (this.isClosed) return
    this.setBusy(false)
    this.transcript.clear()
    this.assistant = undefined
    this.seenEntries.clear()
    this.tools.clear()
    for (const entry of snapshot.entries) this.appendEntry(entry)
    if (snapshot.generation?.message) this.startAssistant(snapshot.generation.message)
    for (const slot of [...snapshot.tools, ...snapshot.nestedTools]) {
      if (slot.name === 'job_start' && 'parentCallId' in slot && this.tools.get(slot.parentCallId)?.isJobLaunch) continue
      const tool = this.tool(slot.callId, slot.name)
      if (slot.output !== undefined) tool.output = boundedOutput(slot.output)
      tool.details = slot.details === undefined ? '' : readableDetails(slot.details)
      if ('arguments' in slot) tool.args = slot.arguments
      if (slot.status === 'done') {
        if ('summary' in slot && slot.summary) {
          tool.status = slot.summary.isError ? 'failed' : 'done'
          tool.durationMs = slot.summary.durationMs
        } else if (tool.status === 'running') tool.status = 'done'
      }
    }
    this.showEvent({ type: 'agent_changed', agent: snapshot.agent })
    this.setBusy(Boolean(snapshot.run))
    if (snapshot.generation?.retry) this.setBusy(true, `Retrying: ${snapshot.generation.retry.error}`)
    if (snapshot.compactionFailure) this.notify(`Compaction failed: ${snapshot.compactionFailure.error}`, true)
    this.statusBar?.snapshot(snapshot)
    this.tui.requestRender()
  }

  showEvent(event: AgentEvent) {
    if (this.isClosed) return
    if (event.type !== 'snapshot') this.statusBar?.update(event)
    if ('toolName' in event && event.toolName === 'job_start' && event.parentToolCallId && this.tools.get(event.parentToolCallId)?.isJobLaunch) return
    switch (event.type) {
      case 'snapshot': this.showSnapshot(event); return
      case 'run_start': this.setBusy(true); break
      case 'run_end':
        this.setBusy(false)
        this.assistant?.view.setContent(this.assistant.blocks, false)
        this.assistant = undefined
        for (const tool of this.tools.values()) if (tool.status === 'running') tool.finish(tool.output, 'aborted')
        break
      case 'message_start':
        if (event.message.role === 'assistant') this.startAssistant(event.message)
        break
      case 'message_update':
        for (const change of event.changes) {
          if (change.type === 'message') { this.startAssistant(change.message); continue }
          if (!this.assistant) continue
          if ('block' in change) this.assistant.blocks[change.contentIndex] = structuredClone(change.block)
          else if (change.type === 'text_delta') {
            const block = this.assistant.blocks[change.contentIndex]
            if (block?.type === 'text') block.text += change.delta
          } else if (change.type === 'thinking_delta') {
            const block = this.assistant.blocks[change.contentIndex]
            if (block?.type === 'thinking') block.thinking += change.delta
          }
        }
        if (this.assistant) this.assistant.view.setContent(this.assistant.blocks, true)
        break
      case 'message_end': case 'entry_appended': this.appendEntry(event.entry); break
      case 'tool_execution_start': this.tool(event.toolCallId, event.toolName).start(event.args); break
      case 'tool_execution_update': {
        const tool = this.tool(event.toolCallId, event.toolName)
        if (event.output) tool.output = boundedOutput('set' in event.output ? event.output.set : tool.output.slice(event.output.trimStart ?? 0) + (event.output.append ?? ''))
        if (event.details !== undefined) tool.details = readableDetails(event.details)
        if (event.diagnostics?.length) tool.details = boundedOutput(`${tool.details}\n${event.diagnostics.map(item => item.message).join('\n')}`)
        break
      }
      case 'tool_execution_end': {
        const result = event.entry?.model?.find(message => message.role === 'toolResult')
        const nested = event.result
        const diagnostics = nested?.diagnostics.map(item => item.message).join('\n') ?? ''
        const output = result ? messageText(result) : nested?.structuredOutput === undefined ? this.tools.get(event.toolCallId)?.output ?? diagnostics : readableDetails(nested.structuredOutput)
        const failed = result?.isError ?? nested?.isError ?? (!event.entry && !nested)
        const aborted = !event.entry && !nested || failed && /abort|interrupt|cancel/i.test(`${output}\n${diagnostics}`)
        this.finishTool(event.toolCallId, event.toolName, output, aborted ? 'aborted' : failed ? 'failed' : 'done', nested?.durationMs)
        if (nested?.details !== undefined) this.tool(event.toolCallId, event.toolName).details = readableDetails(nested.details)
        if (event.entry) this.seenEntries.add(event.entry.id)
        break
      }
      case 'agent_changed':
        this.setStatus(event.agent.model ? `${event.agent.model.provider}/${event.agent.model.modelId}` : this.model, event.agent.thinkingLevel ?? this.thinking)
        break
      case 'task_failed': this.notify(event.message, true); break
      case 'auto_retry_start': this.setBusy(true, `Retry ${event.attempt}: ${event.errorMessage}`); break
      case 'auto_retry_end': this.setBusy(true); break
      case 'compaction_start': this.notify('Compacting context…'); break
      case 'compaction_end': if (event.error) this.notify(`Compaction failed: ${event.error}`, true); break
    }
    this.tui.requestRender()
  }
}
