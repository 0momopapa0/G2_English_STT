import test from 'node:test'
import assert from 'node:assert/strict'
import { HistoryStore, exportSession, MAX_RECORDS } from '../src/history/store.ts'

function backend() {
  const data = new Map()
  const h = {
    data, fail: () => false,
    port: {
      get: async key => data.get(key) ?? '',
      set: async (key, value) => {
        if (h.fail(key, value)) return false
        if (value) data.set(key, value); else data.delete(key)
        return true
      },
    },
  }
  return h
}
function record(id = 'record-1', changes = {}) {
  return { id, createdAt: 1700000000000, updatedAt: 1700000000100, transcript: 'Meet Friday at 10.',
    truncated: false, ended: false, saved: false, summary: null, notice: '', ...changes }
}
test('history persists full text in bounded chunks and reloads paid summaries without network', async t => {
  t.mock.method(globalThis, 'fetch', () => { throw new Error('Storage must not call APIs') })
  const h = backend()
  const store = new HistoryStore(h.port)
  await store.load()
  const original = record('record-1', { transcript: 'Hello. '.repeat(14000),
    summary: { source: 'openai', overview: '이미 생성된 요약', highlights: ['Friday'], decisions: [], actions: [], lensText: 'Friday' },
    ended: true, saved: true })
  await store.write(original)
  assert.ok([...h.data.values()].every(value => value.length <= 40000))
  const reopened = new HistoryStore(h.port)
  await reopened.load()
  assert.equal(reopened.list()[0].saved, true)
  assert.deepEqual(await reopened.read(original.id), original)
})
test('failed chunk or index write preserves the last committed conversation after reopening', async () => {
  for (const failOnIndex of [false, true]) {
    const h = backend()
    const store = new HistoryStore(h.port)
    await store.load()
    await store.write(record())
    h.fail = key => failOnIndex ? key.endsWith('.index') : !key.endsWith('.index')
    await assert.rejects(store.write(record('record-1', { transcript: 'New text'.repeat(12000) })), /저장/)
    const reopened = new HistoryStore(h.port)
    await reopened.load()
    assert.equal((await reopened.read('record-1')).transcript, 'Meet Friday at 10.')
  }
})
test('queued saves take immutable snapshots and cannot resurrect records after deletion', async () => {
  const h = backend()
  const store = new HistoryStore(h.port)
  await store.load()
  const source = record()
  const first = store.write(source)
  source.transcript = 'Mutated after enqueue'
  await first
  assert.equal((await store.read(source.id)).transcript, 'Meet Friday at 10.')
  const update = store.write(record('record-1', { transcript: 'Final words' }))
  const remove = store.remove('record-1')
  await Promise.all([update, remove])
  assert.deepEqual(store.list(), [])
  assert.ok([...h.data.values()].every(value => !value.includes('Final words')))
  await assert.rejects(store.read('record-1'), /찾지/)
})
test('autosave cannot downgrade a manually saved record; full history never evicts saved records', async () => {
  const h = backend()
  const store = new HistoryStore(h.port)
  await store.load()
  await store.write(record('saved', { saved: true }))
  await store.write(record('saved', { transcript: 'Updated paid summary', saved: false }))
  assert.equal((await store.read('saved')).saved, true)
  for (let i = 1; i < MAX_RECORDS; i++) await store.write(record('record-' + i, { saved: true }))
  await assert.rejects(store.write(record('overflow')), /30/)
  assert.equal(store.list().length, MAX_RECORDS)
  assert.equal((await store.read('saved')).transcript, 'Updated paid summary')
  await store.write(record('saved', { transcript: 'Existing record can still update' }))
})
test('corrupted index is not overwritten; corrupted record leaves other records readable', async () => {
  const h = backend()
  h.data.set('english-stt.history.v1.index', 'broken JSON')
  const broken = new HistoryStore(h.port)
  await assert.rejects(broken.load())
  await assert.rejects(broken.write(record()), /준비/)
  assert.equal(h.data.get('english-stt.history.v1.index'), 'broken JSON')
  h.data.clear()
  const store = new HistoryStore(h.port)
  await store.load()
  await store.write(record())
  await store.write(record('record-2'))
  const entry = store.list().find(e => e.id === 'record-1')
  h.data.set('english-stt.history.v1.' + entry.id + '.' + entry.revision + '.0', 'broken')
  await assert.rejects(store.read('record-1'), /손상/)
  assert.equal((await store.read('record-2')).transcript, 'Meet Friday at 10.')
})
test('delete failure retains records; successful clear removes their text and index entries', async () => {
  const h = backend()
  const store = new HistoryStore(h.port)
  await store.load()
  await store.write(record())
  h.fail = key => key.endsWith('.index')
  await assert.rejects(store.remove('record-1'), /삭제/)
  assert.equal(store.list().length, 1)
  h.fail = () => false
  await store.clear()
  const reopened = new HistoryStore(h.port)
  await reopened.load()
  assert.deepEqual(reopened.list(), [])
  assert.ok([...h.data.values()].every(text => !text.includes('Meet Friday')))
})
test('text export preserves original, paid summary, timestamps and truncation warnings', () => {
  const text = exportSession(record('record-1', { truncated: true, notice: 'Last words may be incomplete.',
    summary: { source: 'openai', overview: '일정 확인', highlights: ['금요일'], decisions: ['10시'], actions: ['자료 전달'], lensText: 'Friday' } }))
  for (const expected of ['Meet Friday at 10.', 'OpenAI', '일정 확인', '결정: 10시', '할 일: 자료 전달', '100,000', 'Last words', '2023-']) assert.ok(text.includes(expected))
})
