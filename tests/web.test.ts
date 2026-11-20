import assert from 'node:assert/strict'
import { createServer, type RequestListener } from 'node:http'
import { test, type TestContext } from 'node:test'
import { BACKGROUND_CONTEXT as context, withAbortSignal } from '@earendil-works/chord/context'
import type { JsonObject } from '@earendil-works/pi-ai'
import { createModels } from '@earendil-works/pi-ai/models'
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import { getCurrentSystemPrompt, getCurrentTools } from '@earendil-works/pi-ai/utils/transcript'
import { createRegistry, Harness, MemoryStorage } from '@earendil-works/pi-durable'
import { createWebPlugin, type WebSearchOptions } from '../src/plugins/web.ts'

const page = (content: string) => `<!doctype html><html><body>${content}</body></html>`
const result = (title: string, href: string, snippet = '') => `<div class="result"><a class="result__a" href="${href}">${title}</a><a class="result__snippet">${snippet}</a></div>`
async function local(t: TestContext, handler: RequestListener, options: WebSearchOptions = {}) {
  const server = createServer(handler)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve())
    server.closeAllConnections()
  }))
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  const plugin = createWebPlugin({ ...options, endpoint: `http://127.0.0.1:${address.port}/search?token=endpoint-secret` })
  const tool = plugin.extension.tools![0]
  const call = async (query = 'current information', max_results?: number, signal?: AbortSignal) => {
    const output = await tool.execute({ query, ...(max_results === undefined ? {} : { max_results }) }, undefined as never, signal ? withAbortSignal(signal, context) : context)
    return JSON.parse(output.output!.map(item => item.type === 'text' ? item.text : '').join('')) as {
      sources: { title: string; url: string; snippet: string }[]; truncated: boolean; note: string
    }
  }
  return { plugin, tool, call }
}

test('web_search registers policy and a bounded tool, with no key or external network dependency', { timeout: 3000 }, async t => {
  let requests = 0
  const env = await local(t, (_req, res) => { requests++; res.end(page(result('Source', 'https://example.com'))) })
  assert.equal(env.plugin.name, 'web')
  assert.deepEqual(env.plugin.extension.tools!.map(tool => tool.name), ['web_search'])
  const models = createModels()
  const faux = fauxProvider()
  models.setProvider(faux.provider)
  const registry = createRegistry()
  registry.install(env.plugin.extension)
  const harness = await Harness.open(new MemoryStorage(), { models, registry }, context)
  t.after(() => harness.close(context))
  const conversation = await harness.root(context, { agent: { model: { provider: 'faux', modelId: 'faux-1' } } })
  const invalid: JsonObject[] = [
    { query: 'source', max_results: 0 }, { query: 'source', max_results: 21 },
    { query: '' }, { query: '   ' }, { query: 'a'.repeat(2001) },
  ]
  faux.setResponses([
    request => {
      const prompt = getCurrentSystemPrompt(request.messages)
      assert.match(prompt, /<web_search_policy>/)
      assert.match(prompt, /untrusted external content/)
      assert.match(prompt, /Cite relevant returned URLs/)
      assert.equal(getCurrentTools(request.messages).find(tool => tool.name === 'web_search')?.name, 'web_search')
      return fauxAssistantMessage(fauxToolCall('web_search', { query: 'source', max_results: 1 }), { stopReason: 'toolUse' })
    },
    ...invalid.map(args => fauxAssistantMessage(fauxToolCall('web_search', args), { stopReason: 'toolUse' })),
    fauxAssistantMessage('Found a source.'),
  ])
  const settled = await (await conversation.submit({ type: 'input', content: 'Find a current source.' }, context)).wait(context)
  assert.equal(settled.status, 'done')
  assert.equal(requests, 1, 'invalid calls must fail before making a network request')
  const entries = (await conversation.context(context)).entries
  const errors = entries.flatMap(entry => entry.model ?? []).filter(message => message.role === 'toolResult' && message.isError)
  assert.equal(errors.length, invalid.length)
})

test('search decodes entities, DDG redirects and Unicode while preserving query and endpoint parameters', async t => {
  const env = await local(t, (req, res) => {
    const url = new URL(req.url!, 'http://127.0.0.1')
    assert.equal(url.searchParams.get('q'), '你好 & TypeScript')
    assert.equal(url.searchParams.get('token'), 'endpoint-secret')
    res.setHeader('content-type', 'text/html; charset=utf-8')
    res.end(page(result('Node &amp; TS &#x1F680; &quot;官方&quot;', '//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fdocs%3Fa%3D1%26b%3D2&amp;rut=tracking', 'Use <b>fetch</b>&nbsp;&mdash; &#20013;文 &lt;safe&gt;')))
  })
  const found = await env.call('  你好 & TypeScript  ')
  assert.deepEqual(found.sources, [{ title: 'Node & TS 🚀 "官方"', url: 'https://example.com/docs?a=1&b=2', snippet: 'Use fetch — 中文 <safe>' }])
  assert.equal(found.truncated, false)
  assert.match(found.note, /Cite/)
  assert.doesNotMatch(JSON.stringify(found), /endpoint-secret/)
})

test('lite results, duplicate URLs and result limits are handled without following sources', async t => {
  let requests = 0
  const env = await local(t, (_req, res) => {
    requests++
    res.end(page(`<table><tr><td><a class='result-link' href='https://example.com/a'>First</a></td></tr><tr><td class='result-snippet'>Lite snippet</td></tr></table>${result('Duplicate', 'https://example.com/a')}${result('Second', 'https://example.com/b')}${result('Third', 'https://example.com/c')}`))
  })
  const found = await env.call('query', 2)
  assert.equal(requests, 1)
  assert.deepEqual(found.sources.map(source => source.title), ['First', 'Second'])
  assert.equal(found.sources[0].snippet, 'Lite snippet')
  assert.equal(found.truncated, true)
})

test('explicit no-results pages succeed, while empty and unfamiliar pages fail clearly', async t => {
  const env = await local(t, (req, res) => {
    const query = new URL(req.url!, 'http://127.0.0.1').searchParams.get('q')
    res.end(query === 'empty' ? page('<div class="no-results">No results found for query.</div>') : query === 'blank' ? '' : page('<h1>Sign in: private-response-body</h1>'))
  })
  assert.deepEqual(await env.call('empty'), { sources: [], truncated: false, note: 'No results found.' })
  await assert.rejects(env.call('blank'), /unrecognized response/)
  await assert.rejects(env.call('unknown'), error => {
    assert.match(String(error), /unrecognized response/)
    assert.doesNotMatch(String(error), /endpoint-secret|private-response-body/)
    return true
  })
})

test('unsafe result links are ignored, DDG targets validated and source ordering retained', async t => {
  const unsafe = [
    'javascript:alert(1)', 'data:text/html,evil', 'file:///etc/passwd', 'https://user:pass@example.com',
    '//user:pass@example.com', '//duckduckgo.com/l/?uddg=javascript%3Aalert(1)',
    '//duckduckgo.com/l/?uddg=https%3A%2F%2Fuser%3Apass%40example.com',
    'java&#x09;script:alert(1)', '/navigation', '//duckduckgo.com/l/?uddg=%2Frelative',
  ]
  const env = await local(t, (_req, res) => res.end(page(unsafe.map(href => result('Ignore', href)).join('') + result('Safe', 'https://example.com/good', 'Keep this'))))
  assert.deepEqual((await env.call()).sources, [{ title: 'Safe', url: 'https://example.com/good', snippet: 'Keep this' }])
  const bad = await local(t, (_req, res) => res.end(page(result('Bad', 'javascript:alert(1)'))))
  await assert.rejects(bad.call(), /no usable HTTP\(S\) source URLs/)
})

test('CAPTCHA, bot challenges, rate limits and other HTTP errors never masquerade as empty search results', async t => {
  for (const kind of ['captcha', 'challenge', '429', '403', '500']) {
    await t.test(kind, async t => {
      const env = await local(t, (_req, res) => {
        if (/^\d/.test(kind)) res.statusCode = Number(kind)
        res.end(kind === 'captcha' ? '<form id="captcha-form">secret response</form>' : kind === 'challenge' ? '<form action="//duckduckgo.com/anomaly.js">challenge</form>' : 'private-response-body')
      })
      await assert.rejects(env.call(), error => {
        assert.match(String(error), kind === 'captcha' || kind === 'challenge' ? /bot challenge or CAPTCHA/ : new RegExp(`HTTP ${kind}`))
        assert.doesNotMatch(String(error), /private-response-body|endpoint-secret|secret response/)
        return true
      })
    })
  }
})

test('redirects are bounded, invalid schemes rejected, and valid relative redirects work', async t => {
  let requests = 0
  const env = await local(t, (req, res) => {
    requests++
    const url = new URL(req.url!, 'http://127.0.0.1')
    if (url.pathname === '/done') return void res.end(page(result('Redirected', 'https://example.com')))
    res.writeHead(302, { location: url.searchParams.get('q') === 'good' ? '/done' : url.searchParams.get('q') === 'bad' ? 'file:///etc/passwd' : '/search' })
    res.end()
  })
  assert.equal((await env.call('good')).sources[0].title, 'Redirected')
  requests = 0
  await assert.rejects(env.call('loop'), /redirect limit/)
  assert.equal(requests, 4)
  await assert.rejects(env.call('bad'), /redirect.*invalid/)
})

test('timeouts apply while waiting for headers and while reading the body', { timeout: 2000 }, async t => {
  for (const headers of [false, true]) {
    const env = await local(t, (_req, res) => { if (headers) { res.writeHead(200); res.write('<html>') } }, { timeoutMs: 60 })
    await assert.rejects(env.call(), /timed out/)
  }
})

test('caller cancellation interrupts in-flight and pre-cancelled searches without leaking its reason', { timeout: 2000 }, async t => {
  const controller = new AbortController()
  let requests = 0
  const env = await local(t, (_req, res) => {
    requests++
    res.write('<html>')
    controller.abort(new Error('private-cancellation-token'))
  }, { timeoutMs: 1000 })
  await assert.rejects(env.call('query', undefined, controller.signal), error => {
    assert.match(String(error), /cancelled/)
    assert.doesNotMatch(String(error), /private-cancellation-token|endpoint-secret/)
    return true
  })
  assert.equal(requests, 1)
  await assert.rejects(env.call('query', undefined, controller.signal), /cancelled/)
  assert.equal(requests, 1)
})

test('response byte limit is enforced for content-length and streaming bodies, including otherwise valid results', async t => {
  for (const declared of [true, false]) {
    const env = await local(t, (_req, res) => {
      if (declared) res.setHeader('content-length', 1024 * 1024 + 1)
      else res.write(page(result('First', 'https://example.com')))
      res.end('a'.repeat(1024 * 1024 + 1))
    })
    await assert.rejects(env.call(), /1 MiB size limit/)
  }
})

test('streaming UTF-8 boundaries preserve complete characters and malformed UTF-8 is rejected', async t => {
  const env = await local(t, (req, res) => {
    if (req.url!.includes('q=invalid')) return void res.end(Buffer.from([0xc3, 0x28]))
    const body = Buffer.from(page(result('中文 🚀', 'https://example.com', '分块')))
    const split = body.indexOf(Buffer.from('中')) + 1
    res.write(body.subarray(0, split))
    setImmediate(() => res.end(body.subarray(split)))
  })
  assert.equal((await env.call()).sources[0].title, '中文 🚀')
  await assert.rejects(env.call('invalid'), /invalid UTF-8/)
})

test('invalid configuration and content types fail without exposing supplied URLs or response bodies', async t => {
  for (const endpoint of ['javascript:secret-token', 'https://name:private-token@example.com', 'invalid?key=private-token']) {
    assert.throws(() => createWebPlugin({ endpoint }), error => {
      assert.match(String(error), /Invalid web search endpoint/)
      assert.doesNotMatch(String(error), /private-token|secret-token/)
      return true
    })
  }
  for (const timeoutMs of [0, -1, 1.5, NaN, Infinity, 120001]) assert.throws(() => createWebPlugin({ timeoutMs }), /timeoutMs/)
  const env = await local(t, (_req, res) => { res.setHeader('content-type', 'application/json'); res.end('{"key":"private-response-body"}') })
  await assert.rejects(env.call(), /unsupported content type/)
  await assert.rejects(env.call(' \n '), /must not be blank/)
  const dropped = await local(t, req => req.socket.destroy())
  await assert.rejects(dropped.call(), error => {
    assert.match(String(error), /request failed/)
    assert.doesNotMatch(String(error), /endpoint-secret|127\.0\.0\.1/)
    return true
  })
})
