import { defineExtension, defineTool } from '@earendil-works/pi-durable'
import { Type } from 'typebox'
import { text, type Plugin } from '../src/plugin.ts'

const plugin: Plugin = {
  name: 'hello',
  extension: defineExtension({
    name: 'hello',
    tools: [defineTool({
      name: 'Hello', description: 'Greet someone by name.',
      parameters: Type.Object({ name: Type.String({ minLength: 1, maxLength: 100 }) }),
      replay: 'safe',
      execute: async ({ name }) => text(`Hello, ${name}!`),
    })],
  }),
  commands: { hello: async name => ({ output: `Hello, ${name || 'world'}!` }) },
}
export default plugin
