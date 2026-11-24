import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import { summarizeLocally, isSummary } from '../src/summary/summary.ts'
import { Conversation } from '../src/asr/conversation.ts'
import { Transcript } from '../src/asr/transcript.ts'
import { requestOpenAiSummary } from '../src/summary/client.ts'
import { summaryMiddleware } from '../server/summary-middleware.mjs'

const valid = {
  overview: '금요일 회의 준비를 논의했습니다.', highlights: ['일정 확인'], decisions: [],
  actions: ['업데이트된 일정을 보내기'], lensText: 'Send the updated schedule.',
}

async function request(middleware, body = { transcript: 'Please send the schedule.' }, overrides = {}) {
  const req = Readable.from([Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))])
  Object.assign(req, { url: '/api/summary', method: 'POST',
    headers: { host: 'localhost:5173', origin: 'http://localhost:5173', 'content-type': 'application/json' }, ...overrides })
  const res = new EventEmitter()
  res.destroyed = false
  res.writableEnded = false
  res.writeHead = (status, headers) => { res.status = status; res.headers = headers }
  res.end = value => { res.body = JSON.parse(value); res.writableEnded = true }
  await middleware(req, res, () => { res.passed = true })
  return res
}

test('free summary only extracts source sentences, deduplicates and preserves numbers', t => {
  t.mock.method(globalThis, 'fetch', () => { throw new Error('Free summary must stay local') })
  const text = 'Hello everyone. We agreed to meet on Friday at 10:30. Please send the revised schedule by Thursday. Please send the revised schedule by Thursday. The project budget is 2500 dollars.'
  const summary = summarizeLocally(text)
  assert.equal(summary.source, 'local')
  assert.ok(summary.highlights.length <= 5)
  assert.equal(new Set(summary.highlights).size, summary.highlights.length)
  for (const sentence of summary.highlights) assert.ok(text.includes(sentence))
  assert.ok(summary.highlights.some(line => line.includes('10:30')))
  assert.deepEqual(summary.decisions, [])
  assert.deepEqual(summary.actions, [])
  assert.equal(summarizeLocally('').highlights.length, 0)
  assert.ok(isSummary(summary))
})

test('summary record keeps earlier speech beyond live caption window; overflow is explicit', () => {
  const transcript = new Transcript()
  const conversation = new Conversation()
  conversation.startStream()
  for (const text of ['Important first decision. ', 'Later discussion. '.repeat(400)]) {
    transcript.accept({ tokens: [{ text, is_final: true }] })
    conversation.append(transcript.takeFinalDelta())
  }
  assert.ok(transcript.snapshot().finalText.length <= 4000)
  assert.ok(conversation.transcript.startsWith('Important first decision.'))
  assert.equal(transcript.takeFinalDelta(), '')
  conversation.startStream()
  conversation.append('Resumed.')
  assert.match(conversation.transcript, /Resumed\.$/)
  conversation.append('X'.repeat(Conversation.LIMIT + 1))
  assert.equal(conversation.truncated, true)
  assert.equal(conversation.transcript.length, Conversation.LIMIT)
  conversation.clear()
  assert.equal(conversation.transcript, '')
  assert.equal(conversation.truncated, false)
})

test('OpenAI is optional; missing key, wrong method and origin never call provider', async () => {
  const noCall = () => { throw new Error('Must not call') }
  assert.equal((await request(summaryMiddleware('', undefined, noCall))).status, 503)
  const middleware = summaryMiddleware('secret', undefined, noCall)
  assert.equal((await request(middleware, {}, { method: 'GET' })).status, 405)
  assert.equal((await request(middleware, {}, { headers: { origin: 'https://evil.test', host: 'localhost:5173' } })).status, 403)
  assert.equal((await request(middleware, {}, { url: '/' })).passed, true)
})

test('summary endpoint bounds and validates input before any paid call', async () => {
  const middleware = summaryMiddleware('secret', undefined, () => { throw new Error('Must not call') })
  assert.equal((await request(middleware, '{invalid')).status, 400)
  assert.equal((await request(middleware, { transcript: '' })).status, 400)
  assert.equal((await request(middleware, { transcript: 'a'.repeat(100001) })).status, 413)
  assert.equal((await request(middleware, { transcript: 'a'.repeat(460000) })).status, 413)
  assert.equal((await request(middleware, {}, { headers: { host: 'localhost:5173', 'content-type': 'text/plain' } })).status, 415)
})

test('paid endpoint sends only text with server key, fixed schema/model and no storage', async () => {
  let calls = 0
  const middleware = summaryMiddleware('server-secret', 'gpt-6.1-terra', async (url, options) => {
    calls++
    assert.equal(url, 'https://api.openai.com/v1/responses')
    assert.equal(options.headers.Authorization, 'Bearer server-secret')
    const body = JSON.parse(options.body)
    assert.equal(body.model, 'gpt-6.1-terra')
    assert.equal(body.store, false)
    assert.equal(body.text.format.type, 'json_schema')
    assert.equal(body.text.format.strict, true)
    assert.equal(body.max_output_tokens, 4096)
    assert.match(body.instructions, /untrusted/)
    assert.match(body.input[0].content, /Please send/)
    assert.equal(body.tools, undefined)
    return { ok: true, json: async () => ({ status: 'completed', output: [
      { type: 'reasoning', summary: [] },
      { type: 'message', content: [{ type: 'output_text', text: JSON.stringify(valid) }] },
    ] }) }
  })
  const response = await request(middleware)
  assert.equal(calls, 1)
  assert.equal(response.status, 200)
  assert.equal(response.headers['Cache-Control'], 'no-store')
  assert.deepEqual(response.body.summary, valid)
  assert.ok(!JSON.stringify(response.body).includes('server-secret'))
})

test('provider errors, refused, incomplete or malformed outputs do not replace free summary', async () => {
  for (const output of [
    { status: 'incomplete', output: [] },
    { status: 'completed', output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'no' }] }] },
    { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: '{"overview":"missing fields"}' }] }] },
  ]) {
    const response = await request(summaryMiddleware('secret', undefined, async () => ({ ok: true, json: async () => output })))
    assert.equal(response.status, 502)
    assert.equal(response.body.summary, undefined)
  }
  const error = await request(summaryMiddleware('secret', undefined, async () => ({
    ok: false, status: 429, json: async () => ({ error: 'secret' }),
  })))
  assert.equal(error.status, 502)
  assert.ok(!JSON.stringify(error.body).includes('secret'))
})

test('paid summary rate limit blocks the sixth request', async () => {
  let calls = 0
  const middleware = summaryMiddleware('secret', undefined, async () => {
    calls++
    return { ok: false, status: 500 }
  })
  for (let i = 0; i < 5; i++) await request(middleware)
  assert.equal((await request(middleware)).status, 429)
  assert.equal(calls, 5)
})

test('client calls paid endpoint only when invoked and validates errors', async t => {
  const calls = []
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url, options })
    return { ok: true, json: async () => ({ summary: valid }) }
  })
  assert.equal(calls.length, 0)
  const result = await requestOpenAiSummary('Transcript', new AbortController().signal)
  assert.equal(result.source, 'openai')
  assert.equal(calls[0].url, '/api/summary')
  assert.deepEqual(JSON.parse(calls[0].options.body), { transcript: 'Transcript' })
  t.mock.method(globalThis, 'fetch', async () => ({ ok: false, json: async () => ({ error: 'OPENAI_API_KEY missing' }) }))
  await assert.rejects(requestOpenAiSummary('Text', new AbortController().signal), /OPENAI_API_KEY/)
})
