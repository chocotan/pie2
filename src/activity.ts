import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { ROOT_CONVERSATION_ID, type Cursor, type Harness } from '@earendil-works/pi-durable'
import { stripTerminalSequences } from '@earendil-works/pi-tui'
import type { ActivityOverview } from './plugin.ts'
import { BackgroundDoc } from './plugins/background.ts'
import { GoalDoc } from './plugins/goal.ts'
import { SubagentDoc } from './plugins/subagent.ts'
import { TodoDoc } from './plugins/tasks.ts'
import { PlanDoc } from './plugins/plan.ts'
import { WorkflowDoc } from './plugins/workflow.ts'
import { RalphDoc } from './plugins/ralph.ts'

const clean = (value: string) => stripTerminalSequences(value).replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ')
const empty = (): ActivityOverview => ({
  summary: 'Todo 0 · Goal — · Agents 0 · Jobs 0',
  lines: ['Todo: no tasks', 'Goal: no goal', 'Agents: no subagents', 'Jobs: no background jobs'],
})
const unavailable = (): ActivityOverview => ({ summary: 'Activity unavailable', lines: ['Activity state is unavailable.'] })
const activeAgent = (status: string) => ['queued', 'pending', 'running', 'waiting', 'sleeping', 'completing'].includes(status)

async function readActivity(harness: Harness): Promise<ActivityOverview> {
  const context = BACKGROUND_CONTEXT
  const rootId = ROOT_CONVERSATION_ID
  const [todo, goalState, background, plan, workflowState, ralphState] = await Promise.all([
    harness.snapshot(TodoDoc, rootId, context),
    harness.snapshot(GoalDoc, rootId, context),
    harness.snapshot(BackgroundDoc, rootId, context),
    harness.snapshot(PlanDoc, rootId, context),
    harness.snapshot(WorkflowDoc, rootId, context),
    harness.snapshot(RalphDoc, rootId, context),
  ])
  const todos = todo?.todos ?? []
  const goal = goalState?.goal
  const jobs = background?.jobs ?? []
  const ralphs = ralphState?.runs ?? []
  const workflows = (workflowState?.runs ?? []).filter(run => !ralphs.some(ralph => ralph.id === run.id))
  const agents: { id: number; status: string; queued: number; parked: number; description: string }[] = []
  let cursor: Cursor | undefined
  do {
    const page = await harness.commit(tx => tx.scanConversations({ ownerConversationId: rootId }, 100, cursor), context)
    for (const child of page.items) {
      const metadata = await harness.snapshot(SubagentDoc, child.id, context)
      if (!metadata || metadata.depth < 1) continue
      let status: string = metadata.status ?? 'unknown'
      const parked = metadata.messages?.filter(message => message.state === 'parked').length ?? 0
      if (metadata.background && !parked) {
        const runners = await Promise.all((metadata.runners ?? []).map(id => harness.getTask(id, context)))
        const live = runners.find(task => task && task.state.status !== 'terminal' && task.state.status !== 'completing')
        if (live) status = live.state.status === 'pending' ? 'queued' : live.state.status
        else if (activeAgent(status)) {
          const latest = runners.at(-1)
          if (latest?.state.status === 'terminal' && latest.state.outcome.status !== 'completed')
            status = latest.state.outcome.status === 'aborted' ? 'aborted' : 'failed'
        }
      } else if (!metadata.background && child.owner) {
        const owner = await harness.getTask(child.owner.taskId, context)
        if (owner?.state.status === 'terminal' && owner.state.outcome.status !== 'completed')
          status = owner.state.outcome.status === 'aborted' ? 'aborted' : 'failed'
      }
      agents.push({
        id: child.id, status, parked, description: metadata.description,
        queued: metadata.messages?.filter(message => message.state === 'queued' || message.state === 'parked').length ?? 0,
      })
    }
    cursor = page.next
  } while (cursor)
  const done = todos.filter(item => item.status === 'completed').length
  const activeAgents = agents.filter(agent => activeAgent(agent.status)).length
  const activeJobs = jobs.filter(job => ['queued', 'running', 'stopping'].includes(job.status)).length
  const summary = [
    ...(plan?.mode === 'plan' ? ['Plan read-only'] : []),
    todos.length ? `Todo ${done}/${todos.length}` : 'Todo 0',
    goal ? `Goal ${goal.phase}${goal.phase === 'complete' ? '' : ` ${goal.roundsStarted}/${goal.maxGoalRounds}`}` : 'Goal —',
    agents.length ? `Agents ${activeAgents}/${agents.length} active` : 'Agents 0',
    jobs.length ? `Jobs ${activeJobs}/${jobs.length} active` : 'Jobs 0',
    ...(workflows.length ? [`Workflows ${workflows.filter(run => run.status === 'running').length}/${workflows.length}`] : []),
    ...(ralphs.length ? [`Ralph ${ralphs.filter(run => run.status === 'running').length}/${ralphs.length}`] : []),
  ].join(' · ')
  const lines = [
    ...(plan?.mode === 'plan' ? ['Plan mode: read-only · /plan off exits', ...(plan.plan ? [`Plan: ${plan.plan}`] : [])] : []),
    ...(todos.length ? todos.map(item => `Todo [${item.status}] ${item.content}`) : ['Todo: no tasks']),
    ...(goal ? [
      `Goal [${goal.phase}] ${goal.roundsStarted}/${goal.maxGoalRounds} ${goal.objective}`,
      ...(goal.blockedReason ? [`Goal blocked: ${goal.blockedReason.code}: ${goal.blockedReason.message}`] : []),
    ] : ['Goal: no goal']),
    ...(agents.length ? agents.map(agent => `Agent #${agent.id} [${agent.status}] queued ${agent.queued}${agent.parked ? ` (parked ${agent.parked})` : ''} · ${agent.description}`) : ['Agents: no subagents']),
    ...(jobs.length ? jobs.map(job => `Job #${job.id} [${job.status}] ${job.description}${job.exitCode === null ? '' : ` · exit ${job.exitCode}`}${job.error ? ` · ${job.error}` : ''}`) : ['Jobs: no background jobs']),
    ...workflows.flatMap(run => [
      `Workflow #${run.id} [${run.status}] ${run.name} · ${run.phase || run.description} · ${run.agents.filter(agent => agent.status === 'completed').length}/${run.agents.length} agents completed`,
      ...run.agents.map(agent => `  Agent ${agent.seq} [${agent.status}] ${agent.label}`),
      ...(run.error ? [`  Error: ${run.error}`] : []),
    ]),
    ...ralphs.map(run => `Ralph #${run.id} [${run.status}] ${run.result?.roundsStarted ?? workflowState?.runs.find(workflow => workflow.id === run.id)?.agents.length ?? 0}/${run.maxRounds} · ${run.objective}${run.error ? ` · ${run.error}` : ''}`),
  ]
  return { summary: clean(summary), lines: lines.map(clean) }
}

/** A read-only projection: commits invalidate it, never AgentEvent delivery or a polling loop. */
export function createActivityProjection(getHarness?: () => Harness) {
  let value = empty()
  let render: (() => void) | undefined
  let harness: Harness | undefined
  let unsubscribeCommits: (() => void) | undefined
  let unsubscribeClose: (() => void) | undefined
  let closed = false
  let dirty = false
  let timer: NodeJS.Timeout | undefined
  let refreshing: Promise<void> | undefined
  const stop = () => {
    closed = true
    dirty = false
    if (timer) clearTimeout(timer)
    timer = undefined
    unsubscribeCommits?.()
    unsubscribeClose?.()
    render = undefined
  }
  const scheduleRefresh = () => {
    if (closed || !getHarness) return
    dirty = true
    if (timer || refreshing) return
    timer = setTimeout(() => { timer = undefined; void refreshActivity() }, 0)
    timer.unref()
  }
  const refreshActivity = (): Promise<void> => {
    if (closed || !getHarness) return Promise.resolve()
    dirty = true
    if (timer) clearTimeout(timer)
    timer = undefined
    if (refreshing) return refreshing
    refreshing = (async () => {
      while (dirty && !closed) {
        dirty = false
        let next: ActivityOverview
        try {
          if (!harness) {
            const current = getHarness()
            unsubscribeCommits = current.subscribeCommits(publication => {
              // Read-only scan commits have no changes; observing them would refresh forever.
              if (publication.changes.some(change => change.type === 'conversation' || change.type === 'task' ||
                ((change.type === 'document' || change.type === 'document.copy') &&
                  ['pie2.todos', 'pie2.goal', 'pie2.subagent', 'pie2.background', 'pie2.plan', 'pie2.workflows', 'pie2.ralph'].includes(change.record.kind)))) scheduleRefresh()
            })
            unsubscribeClose = current.subscribeClose(stop)
            harness = current
          }
          next = await readActivity(harness)
        } catch {
          // Do not expose storage errors: they may contain model configuration or message content.
          next = unavailable()
        }
        if (!closed && (next.summary !== value.summary || next.lines.join('\n') !== value.lines.join('\n'))) {
          value = next
          render?.()
        }
      }
    })().finally(() => { refreshing = undefined })
    return refreshing
  }
  return {
    activity: (): ActivityOverview => ({ summary: value.summary, lines: [...value.lines] }),
    refreshActivity,
    start: () => { if (!harness) void refreshActivity() },
    scheduleRefresh,
    setRenderHook: (hook?: () => void) => { if (!closed) render = hook },
  }
}
