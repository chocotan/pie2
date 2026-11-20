import { Type } from 'typebox'
import { defineDoc, defineExtension, defineTool, section } from '@earendil-works/pi-durable'
import type { Plugin } from '../plugin.ts'
import { text } from '../plugin.ts'
import { validateQuestions, type UserAnswer, type UserInteraction } from '../interaction.ts'

const AnswerReceipt = defineDoc<{ answers: UserAnswer[] | null }>({
  kind: 'pie2.user-answer', version: 1, scope: 'task', initial: () => ({ answers: null }), checkpointWhen: () => false,
})
const nonblank = Type.String({ minLength: 1, maxLength: 131072, pattern: '\\S' })
const policy = 'Use ask_user_question only for a concrete user-owned choice, approval, or missing information you cannot discover by inspecting the workspace. Group related questions. Put the recommended choice first and label it (Recommended). Cancellation and an unavailable UI are not answers or approval; report the missing decision rather than guessing or repeatedly asking.'

export function createAskUserPlugin(interaction: UserInteraction): Plugin {
  return {
    name: 'askUser',
    extension: defineExtension({
      name: 'askUser', sections: [section('ask_user_policy', () => policy)],
      tools: [defineTool({
        name: 'ask_user_question', description: policy, replay: 'safe', executionMode: 'sequential',
        parameters: Type.Object({ questions: Type.Array(Type.Object({
          id: Type.String({ minLength: 1, maxLength: 100, pattern: '\\S' }), question: nonblank,
          header: Type.Optional(Type.String({ maxLength: 100 })),
          options: Type.Optional(Type.Array(Type.Object({ label: Type.String({ minLength: 1, maxLength: 200, pattern: '\\S' }),
            description: Type.Optional(Type.String({ maxLength: 2000 })),
          }, { additionalProperties: false }), { minItems: 1, maxItems: 10 })),
          multi_select: Type.Optional(Type.Boolean()),
        }, { additionalProperties: false }), { minItems: 1, maxItems: 4 }) }, { additionalProperties: false }),
        execute: async ({ questions }, api, context) => {
          const normalized = questions.map(({ multi_select, ...question }) => ({ ...question, multiSelect: multi_select ?? false }))
          validateQuestions(normalized)
          const receipt = await api.snapshot(AnswerReceipt, api.taskId, context)
          if (receipt?.answers) return text({ answers: receipt.answers })
          const answers = await interaction.ask(normalized, context)
          await api.commit(async tx => { (await tx.doc(AnswerReceipt, api.taskId)).answers = answers }, context)
          return text({ answers })
        },
      })],
    }),
  }
}
