import test from 'node:test'
import assert from 'node:assert/strict'
import { startSttStream } from '../src/asr/stt.ts'

function setup(t) {
  class FakeSocket extends EventTarget {
    static OPEN = 1
    static instance
    readyState = 0
    bufferedAmount = 0
    sent = []
    constructor(url, protocols) { super(); this.url = url; this.protocols = protocols; FakeSocket.instance = this }
    open() { this.readyState = 1; this.onopen?.() }
    send(data) {
      if (this.readyState !== 1) throw new Error('Socket closed')
      this.sent.push(data)
    }
    message(value) { this.onmessage?.({ data: JSON.stringify(value) }) }
    close() {
      if (this.readyState === 3) return
      this.readyState = 3
      this.dispatchEvent(new Event('close'))
      this.onclose?.()
    }
  }
  t.mock.method(globalThis, 'fetch', async () => ({ ok: true, json: async () => ({ api_key: 'snx_temp_test', expires_at: '2030-01-01T00:00:00Z' }) }))
  t.mock.property(globalThis, 'WebSocket', FakeSocket)
  const pending = async (snapshots = [], errors = []) => {
    const controller = new AbortController()
    const promise = startSttStream(value => snapshots.push(value), error => errors.push(error), controller.signal)
    await new Promise(resolve => setImmediate(resolve))
    const socket = FakeSocket.instance
    t.after(() => { controller.abort(); socket.close() })
    return { promise, socket, controller }
  }
  const connect = async (snapshots = [], errors = []) => {
    const connection = await pending(snapshots, errors)
    connection.socket.open()
    connection.socket.message({ type: 'pong', id: 1 })
    return { ...connection, client: await connection.promise }
  }
  return { FakeSocket, pending, connect }
}

test('Soniox config uses temporary-key protocol; capture waits for accepted stream', async t => {
  const { pending } = setup(t)
  const { socket, promise } = await pending()
  assert.equal(socket.url, 'wss://stt-rt.soniox.com/transcribe-websocket')
  assert.deepEqual(socket.protocols, ['soniox-api-key', 'snx_temp_test'])
  let resolved = false
  promise.then(() => { resolved = true })
  socket.open()
  const config = JSON.parse(socket.sent[0])
  assert.equal(config.model, 'stt-rt-v6')
  assert.equal(config.audio_format, 'pcm_s16le')
  assert.equal(config.sample_rate, 16000)
  assert.equal(config.num_channels, 1)
  assert.deepEqual(config.language_hints, ['en'])
  assert.equal(config.language_hints_strict, true)
  assert.equal(config.enable_endpoint_detection, true)
  assert.equal(config.api_key, undefined)
  await Promise.resolve()
  assert.equal(resolved, false)
  socket.message({ type: 'pong', id: 999 })
  await Promise.resolve()
  assert.equal(resolved, false)
  socket.message({ type: 'pong', id: 1 })
  const client = await promise
  client.close()
  assert.equal(socket.sent.at(-1), '', 'end-of-stream must be an empty text frame')
})

test('streams copied PCM, joins tokens and closes gracefully before abort', async t => {
  const { connect } = setup(t)
  const snapshots = [], errors = []
  const { client, socket, controller } = await connect(snapshots, errors)
  const chunk = new Uint8Array([0, 1])
  client.sendPcm(chunk)
  chunk[0] = 42
  assert.deepEqual(socket.sent.at(-1), new Uint8Array([0, 1]))
  socket.message({ tokens: [{ text: 'Hello', is_final: true }, { text: '.', is_final: true }] })
  assert.deepEqual(snapshots.at(-1), { finalText: 'Hello.', interimText: '', finalDelta: 'Hello.' })
  client.clear()
  assert.equal(snapshots.at(-1).finalText, '')
  const before = socket.sent.length
  client.sendPcm(new Uint8Array())
  assert.equal(socket.sent.length, before)
  client.close()
  controller.abort()
  assert.equal(socket.readyState, 1, 'stop must leave time to deliver the end frame')
  assert.equal(socket.sent.at(-1), '')
  socket.message({ tokens: [{ text: 'late text', is_final: true }] })
  assert.equal(snapshots.at(-1).finalText, '', 'late captions cannot repopulate a stopped session')
  socket.message({ tokens: [], finished: true })
  assert.equal(socket.readyState, 3)
  assert.equal(errors.length, 0)
})

test('authentication is rejected before microphone start and raw provider errors stay private', async t => {
  const { pending } = setup(t)
  const errors = []
  const { socket, promise } = await pending([], errors)
  socket.open()
  socket.message({ error_code: 401, error_type: 'unauthenticated', error_message: 'secret raw provider message' })
  await assert.rejects(promise, /Soniox 인증/)
  assert.equal(errors.length, 0)
  assert.equal(socket.readyState, 3)
})

test('oversized send queue, provider budget errors and unexpected close stop once', async t => {
  const { connect } = setup(t)
  for (const kind of ['queue', 'budget', 'close', 'malformed', 'finished']) {
    const errors = []
    const { client, socket } = await connect([], errors)
    if (kind === 'queue') { socket.bufferedAmount = 63999; client.sendPcm(new Uint8Array(2)) }
    if (kind === 'budget') socket.message({ error_code: 402, error_type: 'project_monthly_budget_exhausted' })
    if (kind === 'close') socket.close()
    if (kind === 'malformed') socket.message({ tokens: [null] })
    if (kind === 'finished') socket.message({ tokens: [], finished: true })
    socket.onerror?.()
    assert.equal(errors.length, 1, kind)
    assert.equal(socket.readyState, 3)
    if (kind === 'budget') assert.match(errors[0].message, /잔액|한도/)
  }
})

test('opening, stalled ping and deliberate shutdown have bounded timers', async t => {
  const { pending, connect } = setup(t)
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  const opening = await pending()
  const rejection = assert.rejects(opening.promise, /연결 시간 초과/)
  t.mock.timers.tick(12000)
  await rejection
  assert.equal(opening.socket.readyState, 3)

  const errors = []
  const live = await connect([], errors)
  t.mock.timers.tick(5000)
  assert.deepEqual(JSON.parse(live.socket.sent.at(-1)), { type: 'ping', id: 2 })
  live.socket.message({ type: 'pong', id: 2 })
  t.mock.timers.tick(5000)
  assert.deepEqual(JSON.parse(live.socket.sent.at(-1)), { type: 'ping', id: 3 })
  t.mock.timers.tick(10000)
  assert.equal(errors.length, 1)
  assert.match(errors[0].message, /응답이 멈췄/)
  assert.equal(live.socket.readyState, 3)

  const closing = await connect()
  closing.client.close()
  t.mock.timers.tick(2000)
  assert.equal(closing.socket.readyState, 3)
})

test('abort while connecting rejects and cleans up', async t => {
  const { pending } = setup(t)
  const { promise, socket, controller } = await pending()
  controller.abort()
  await assert.rejects(promise, { name: 'AbortError' })
  assert.equal(socket.readyState, 3)
})

test('HTML token endpoint and non-temporary credentials produce actionable errors', async t => {
  setup(t)
  t.mock.method(globalThis, 'fetch', async () => ({ ok: true, json: async () => { throw new SyntaxError('HTML') } }))
  await assert.rejects(startSttStream(() => {}, () => {}, new AbortController().signal), /JSON/)
  t.mock.method(globalThis, 'fetch', async () => ({ ok: true, json: async () => ({ api_key: 'long-lived-key' }) }))
  await assert.rejects(startSttStream(() => {}, () => {}, new AbortController().signal), /단기 API 키/)
})

test('end-and-summarize drains final tokens and reports complete versus interrupted shutdown', async t => {
  const { connect } = setup(t)
  const snapshots = []
  const live = await connect(snapshots)
  live.socket.message({ tokens: [{ text: 'Meet Friday', is_final: true }] })
  const closing = live.client.close(true)
  assert.equal(live.client.close(true), closing)
  live.controller.abort()
  live.socket.message({ tokens: [{ text: ' at ten.', is_final: true }] })
  live.socket.message({ tokens: [], finished: true })
  assert.equal(await closing, true)
  assert.equal(snapshots.map(value => value.finalDelta ?? '').join(''), 'Meet Friday at ten.')

  const interrupted = await connect()
  const pending = interrupted.client.close(true)
  interrupted.socket.close()
  assert.equal(await pending, false)
})
