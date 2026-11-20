import { withAbortSignal, type Context } from '@earendil-works/chord/context'

export type UserQuestion = {
  id: string
  question: string
  header?: string
  options?: readonly { label: string; description?: string }[]
  multiSelect?: boolean
}
export type UserAnswer = {
  id: string
  selected: string[]
  custom?: string
}
export interface UserInteraction {
  ask(questions: readonly UserQuestion[], context: Context): Promise<UserAnswer[]>
}
export type QuestionHandler = (questions: readonly UserQuestion[], context: Context) => Promise<UserAnswer[]>

export function validateQuestions(questions: readonly UserQuestion[]) {
  if (!Array.isArray(questions) || questions.length < 1 || questions.length > 4) throw new Error('Ask 1–4 questions at a time')
  const ids = new Set<string>()
  for (const question of questions as readonly UserQuestion[]) {
    if (!question.id?.trim() || !question.question?.trim()) throw new Error('Question id and text must not be blank')
    if (ids.has(question.id)) throw new Error('Question ids must be unique')
    ids.add(question.id)
    const labels = question.options?.map(option => option.label.trim()) ?? []
    if (labels.length > 10 || labels.some(label => !label) || new Set(labels).size !== labels.length) throw new Error('Question choices must have unique nonblank labels (at most 10)')
  }
}

function validateAnswers(questions: readonly UserQuestion[], answers: UserAnswer[]): UserAnswer[] {
  if (!Array.isArray(answers) || answers.length !== questions.length) throw new Error('Every question requires an explicit answer')
  const ids = new Set<string>()
  for (const answer of answers) {
    const question = questions.find(question => question.id === answer.id)
    if (!question || ids.has(answer.id)) throw new Error('Answer ids must match the question ids exactly once')
    ids.add(answer.id)
    if (!Array.isArray(answer.selected) || new Set(answer.selected).size !== answer.selected.length ||
        answer.selected.some(label => !question.options?.some(option => option.label === label))) throw new Error('Answer contains an invalid choice')
    if (!question.multiSelect && answer.selected.length > 1) throw new Error('This question accepts only one choice')
    if (answer.custom !== undefined && (typeof answer.custom !== 'string' || !answer.custom.trim() || answer.custom.length > 131072)) throw new Error('Custom answer must be nonblank and at most 128 KiB')
    if (!answer.selected.length && answer.custom === undefined) throw new Error('Question was not answered')
  }
  return answers
}

/** One human interaction at a time; an absent UI or cancellation can never imply approval. */
export function createUserInteraction() {
  let handler: QuestionHandler | undefined
  let closed = false
  let tail = Promise.resolve()
  const controllers = new Set<AbortController>()
  return {
    attach(next?: QuestionHandler) { handler = next },
    close() {
      closed = true
      handler = undefined
      for (const controller of controllers) controller.abort()
    },
    async ask(questions: readonly UserQuestion[], context: Context): Promise<UserAnswer[]> {
      validateQuestions(questions)
      if (closed || !handler) throw new Error('User interaction requires an interactive terminal; no answer or approval was granted')
      const controller = new AbortController()
      controllers.add(controller)
      const abort = () => controller.abort()
      context.abortSignal?.addEventListener('abort', abort, { once: true })
      if (context.abortSignal?.aborted) controller.abort()
      let rejectAbort!: (error: Error) => void
      const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject })
      const cancelled = () => rejectAbort(new Error('User interaction cancelled; no answer or approval was granted'))
      controller.signal.addEventListener('abort', cancelled, { once: true })
      if (controller.signal.aborted) cancelled()
      const request = tail.then(async () => {
        if (controller.signal.aborted || closed) throw new Error('User interaction cancelled')
        const current = handler
        if (!current) throw new Error('User interaction is unavailable; no answer or approval was granted')
        const answers = await current(questions, withAbortSignal(controller.signal, context))
        if (controller.signal.aborted || closed) throw new Error('User interaction cancelled')
        return validateAnswers(questions, answers)
      })
      tail = request.then(() => {}, () => {})
      try { return await Promise.race([request, aborted]) }
      finally {
        controllers.delete(controller)
        context.abortSignal?.removeEventListener('abort', abort)
        controller.signal.removeEventListener('abort', cancelled)
      }
    },
  }
}
