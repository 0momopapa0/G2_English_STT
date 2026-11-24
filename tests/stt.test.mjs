import test from 'node:test'
import assert from 'node:assert/strict'
import { startSttStream } from '../src/asr/stt.ts'

test('stream authentication, captions, bounded send queue, errors and shutdown', async t => {
  class FakeSocket extends EventTarget {
    static OPEN = 1
    static instance
    readyState = 0
    bufferedAmount = 0
    sent = []
    constructor(url, protocols) { super(); this.url = url; this.protocols = protocols; FakeSocket.instance = this }
    open() { this.readyState = 1; this.onopen?.() }
    send(data) { this.sent.push(data) }
    message(value) { this.onmessage?.({ data: JSON.stringify(value) }) }
    close() { this.readyState = 3; this.dispatchEvent(new Event('close')); this.onclose?.() }
  }
  t.mock.method(globalThis, 'fetch', async () => ({ ok: true, json: async () => ({ access_token: 'temporary' }) }))
  t.mock.property(globalThis, 'WebSocket', FakeSocket)
  const connect = async (snapshots = [], errors = []) => {
    const controller = new AbortController()
    const promise = startSttStream(value => snapshots.push(value), error => errors.push(error), controller.signal)
    await new Promise(resolve => setImmediate(resolve))
    const socket = FakeSocket.instance
    socket.open()
    return { client: await promise, socket, controller }
  }
  const snapshots = [], errors = []
  const { client, socket } = await connect(snapshots, errors)
  assert.deepEqual(socket.protocols, ['bearer', 'temporary'])
  assert.match(socket.url, /language=en/)
  assert.match(socket.url, /sample_rate=16000/)
  client.sendPcm(new Uint8Array([0, 1]))
  assert.deepEqual(socket.sent[0], new Uint8Array([0, 1]))
  socket.message({ type: 'Results', start: 0, duration: 1, is_final: true, channel: { alternatives: [{ transcript: 'Hello.' }] } })
  assert.equal(snapshots[0].finalText, 'Hello.')
  client.clear()
  assert.equal(snapshots[1].finalText, '')
  client.close()
  assert.equal(JSON.parse(socket.sent.at(-1)).type, 'CloseStream')
  socket.close()
  assert.equal(errors.length, 0)
  const slowErrors = []
  const slow = await connect([], slowErrors)
  slow.socket.bufferedAmount = 64001
  slow.client.sendPcm(new Uint8Array(2))
  assert.equal(slowErrors.length, 1)
  assert.equal(slow.socket.readyState, 3)
  const closedErrors = []
  const dropped = await connect([], closedErrors)
  dropped.socket.close()
  assert.equal(closedErrors.length, 1)
  const aborted = new AbortController()
  const pending = startSttStream(() => {}, () => {}, aborted.signal)
  await new Promise(resolve => setImmediate(resolve))
  aborted.abort()
  await assert.rejects(pending, { name: 'AbortError' })
})
