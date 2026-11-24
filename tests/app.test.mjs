import test from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { HistoryStore } from '../src/history/store.ts'
import { localDay } from '../src/usage/meter.ts'

let moduleId = 0
async function mountApp(t, options = {}) {
  const h = {
    microphone: false, concurrent: 0, maximumConcurrent: 0, sends: 0, micStarts: 0,
    captions: [], statuses: [], lifecycle: [], summaries: [], summaryStatuses: [], aiCalls: [],
  }
  const operation = async result => {
    h.maximumConcurrent = Math.max(h.maximumConcurrent, ++h.concurrent)
    await new Promise(resolve => setImmediate(resolve))
    h.concurrent--
    return result
  }
  h.storage = options.storage ?? new Map()
  h.bridge = {
    getLocalStorage: async key => h.storage.get(key) ?? '',
    setLocalStorage: async (key, value) => { if (value) h.storage.set(key, value); else h.storage.delete(key); return true },
    createStartUpPageContainer: () => operation(0),
    textContainerUpgrade: page => { h.captions.push(page.content); return operation(true) },
    audioControl: enabled => { h.microphone = enabled; if (enabled) h.micStarts++; return operation(true) },
    onEvenHubEvent: callback => { h.handler = callback; return () => { h.handler = undefined } },
    shutDownPageContainer: () => operation(true),
  }
  h.closeHandler = () => Promise.resolve(true)
  h.client = { sendPcm() { h.sends++ }, clear() {}, close(finalize) { h.lifecycle.push('close'); return h.closeHandler(finalize) } }
  h.stt = async (snapshot, error, signal, maxDuration) => {
    h.maxDuration = maxDuration
    h.onSnapshot = snapshot; h.onError = error
    assert.equal(h.microphone, false)
    signal.throwIfAborted()
    signal.addEventListener('abort', () => h.lifecycle.push('abort'), { once: true })
    if (h.startGate) await h.startGate
    return h.client
  }
  h.aiHandler = async () => ({
    source: 'openai', overview: '회의를 준비합니다.', highlights: ['금요일 회의'], decisions: [], actions: [],
    lensText: 'Prepare for Friday.',
  })
  h.summarize = async (...args) => { h.aiCalls.push(args); return h.aiHandler(...args) }
  h.ui = {
    mountUi(value) { h.actions = value }, setStatus(kind, text) { h.statuses.push({ kind, text }) },
    setTranscript() {}, setCaption() {}, setControls(...args) { h.controls = args },
    setLevel() {}, filterEnabled: () => true,
    setUsage(view) { h.usage = view }, setUsageStatus(text) { h.usageStatus = text },
    setHistory(entries, recovery, current, locked) { h.history = { entries, recovery, current, locked } },
    setStorageStatus(text) { h.storageStatus = text }, setSessionSaved() {}, showExport(text, filename) { h.export = { text, filename } },
    setSummary(summary, text, notice) { h.summaries.push({ summary, text, notice }) },
    setSummaryStatus(text, busy) { h.summaryStatuses.push({ text, busy }) },
  }
  const windowEvents = new EventTarget()
  globalThis.__englishSttTest = h
  Object.defineProperty(globalThis, 'window', { value: windowEvents, configurable: true })
  t.after(() => { windowEvents.dispatchEvent(new Event('pagehide')); delete globalThis.window; delete globalThis.__englishSttTest })
  const sdk = `const h=globalThis.__englishSttTest;
    export const waitForEvenAppBridge=async()=>h.bridge;
    class Model{constructor(v){Object.assign(this,v)}}
    export {Model as TextContainerProperty,Model as TextContainerUpgrade,Model as CreateStartUpPageContainer};
    export const OsEventTypeList={CLICK_EVENT:0,DOUBLE_CLICK_EVENT:3,FOREGROUND_ENTER_EVENT:4,FOREGROUND_EXIT_EVENT:5,ABNORMAL_EXIT_EVENT:6,SYSTEM_EXIT_EVENT:7};`
  const ui = 'const u=globalThis.__englishSttTest.ui; export const {mountUi,setStatus,setTranscript,setCaption,setControls,setLevel,filterEnabled,setSummary,setSummaryStatus,setHistory,setStorageStatus,setSessionSaved,showExport,setUsage,setUsageStatus}=u;'
  const output = await build({
    entryPoints: ['src/main.ts'], bundle: true, write: false, format: 'esm', platform: 'browser',
    plugins: [{ name: 'app-boundaries', setup(builder) {
      builder.onResolve({ filter: /^(@evenrealities\/even_hub_sdk|\.\/ui|\.\/asr\/stt|\.\/summary\/client)$/ }, args => ({ path: args.path, namespace: 'test-boundary' }))
      builder.onLoad({ filter: /.*/, namespace: 'test-boundary' }, args => ({ contents:
        args.path === './ui' ? ui : args.path === './asr/stt' ? 'export const startSttStream=(...args)=>globalThis.__englishSttTest.stt(...args)'
          : args.path === './summary/client' ? 'export const requestOpenAiSummary=(...args)=>globalThis.__englishSttTest.summarize(...args)' : sdk,
      }))
    } }],
  })
  await import('data:text/javascript;base64,' + Buffer.from(output.outputFiles[0].text).toString('base64') + '#' + moduleId++)
  h.until = async condition => {
    for (let i = 0; i < 200; i++) { if (condition()) return; await new Promise(resolve => setTimeout(resolve, 5)) }
    assert.fail('app state did not settle')
  }
  await h.until(() => h.handler)
  h.start = async () => { h.actions.toggle(); await h.until(() => h.statuses.at(-1)?.kind === 'listening') }
  return h
}

test('G2 controller gates mic, serializes writes and stops on errors/background/confirmed exit', async t => {
  const h = await mountApp(t)
  await h.start()
  h.onSnapshot({ finalText: 'Could', interimText: ' you confirm the meeting?', finalDelta: 'Could' })
  h.handler({ audioEvent: { audioPcm: new Uint8Array(320) } })
  assert.equal(h.sends, 1)
  assert.equal(h.micStarts, 1)
  await h.until(() => h.captions.some(caption => caption.endsWith('Could you confirm the meeting?')))
  h.handler({ sysEvent: {} })
  await h.until(() => !h.microphone)
  assert.deepEqual(h.lifecycle.slice(0, 2), ['close', 'abort'])
  await h.start()
  h.handler({ sysEvent: { eventType: 5 } })
  await h.until(() => !h.microphone)
  await h.start()
  h.onError(new Error('Network dropped'))
  await h.until(() => !h.microphone)
  assert.equal(h.statuses.at(-1).kind, 'error')
  await h.start()
  h.handler({ sysEvent: { eventType: 3 } })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(h.microphone, true, 'cancelled exit dialog cannot disable capture')
  h.handler({ sysEvent: { eventType: 7 } })
  await h.until(() => !h.microphone && !h.handler)
  assert.equal(h.maximumConcurrent, 1)
})

test('end drains last words and shows free summary before any paid request; paid errors retain it', async t => {
  const h = await mountApp(t)
  await h.start()
  h.onSnapshot({ finalText: 'We agreed to meet Friday.', interimText: ' At ten.', finalDelta: 'We agreed to meet Friday.' })
  let finishDrain
  h.closeHandler = finalize => {
    assert.equal(finalize, true)
    return new Promise(resolve => { finishDrain = resolve })
  }
  h.actions.finish()
  await h.until(() => !h.microphone)
  h.actions.toggle()
  assert.equal(h.micStarts, 1, 'no new capture while draining')
  assert.equal(h.aiCalls.length, 0)
  h.onSnapshot({ finalText: 'We agreed to meet Friday. At ten.', interimText: '', finalDelta: ' At ten.' })
  finishDrain(true)
  await h.until(() => h.summaries.at(-1)?.summary?.source === 'local')
  const free = h.summaries.at(-1)
  assert.equal(free.text, 'We agreed to meet Friday. At ten.')
  assert.equal(free.notice, '')
  assert.equal(h.aiCalls.length, 0)
  h.aiHandler = async () => { throw new Error('OPENAI_API_KEY missing') }
  h.actions.improveSummary()
  await h.until(() => h.summaryStatuses.at(-1)?.text.includes('OPENAI_API_KEY'))
  assert.equal(h.summaries.at(-1), free)
  h.aiHandler = async () => ({ ...free.summary, source: 'openai', overview: '금요일 10시에 만납니다.' })
  h.actions.improveSummary()
  await h.until(() => h.summaries.at(-1)?.summary?.source === 'openai')
  assert.equal(h.aiCalls.length, 2)
  assert.equal(h.aiCalls[0][0], free.text)
  h.closeHandler = () => Promise.resolve(true)
})

test('new conversation/clear cancels paid request and ignores stale results', async t => {
  const h = await mountApp(t)
  await h.start()
  h.onSnapshot({ finalText: 'Send the schedule.', interimText: '', finalDelta: 'Send the schedule.' })
  h.actions.finish()
  await h.until(() => h.summaries.at(-1)?.summary?.source === 'local')
  let resolveAi
  h.aiHandler = () => new Promise(resolve => { resolveAi = resolve })
  h.actions.improveSummary()
  await h.until(() => h.aiCalls.length === 1)
  await h.start()
  assert.equal(h.aiCalls[0][1].aborted, true)
  resolveAi({ source: 'openai', overview: 'stale', highlights: [], decisions: [], actions: [], lensText: 'stale' })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(h.summaries.at(-1).summary, null)
  h.onSnapshot({ finalText: 'New topic.', interimText: '', finalDelta: 'New topic.' })
  h.actions.finish()
  await h.until(() => h.summaries.at(-1)?.summary?.source === 'local')
  assert.equal(h.summaries.at(-1).text, 'New topic.')
  h.actions.clear()
  assert.equal(h.summaries.at(-1).summary, null)
})

test('end during connection setup cancels capture and cannot restart from late resolution', async t => {
  const h = await mountApp(t)
  let resolveStart
  h.startGate = new Promise(resolve => { resolveStart = resolve })
  h.actions.toggle()
  await h.until(() => h.statuses.at(-1)?.kind === 'connecting')
  h.actions.finish()
  await h.until(() => h.summaries.at(-1)?.summary?.source === 'local')
  resolveStart()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(h.micStarts, 0)
  assert.equal(h.summaries.at(-1).summary.highlights.length, 0)
})

test('native recovery restores confirmed speech without starting microphone; explicit resume appends', async t => {
  const storage = new Map()
  const seed = new HistoryStore({
    get: async key => storage.get(key) ?? '',
    set: async (key, value) => { if (value) storage.set(key, value); else storage.delete(key); return true },
  })
  await seed.load()
  await seed.write({ id: 'recovered-draft', createdAt: 1700000000000, updatedAt: 1700000000100,
    transcript: 'Earlier confirmed speech.', ended: false, saved: false, truncated: false, summary: null, notice: '' })
  const h = await mountApp(t, { storage })
  assert.equal(h.history.recovery, 'recovered-draft')
  assert.equal(h.micStarts, 0)
  h.actions.toggle()
  assert.equal(h.micStarts, 0, 'unresolved recovery cannot be overwritten by starting a new conversation')
  h.actions.open('recovered-draft', 'resume')
  await h.until(() => !h.history.locked && h.history.current === 'recovered-draft')
  assert.equal(h.microphone, false)
  assert.equal(h.aiCalls.length, 0)
  await h.start()
  h.onSnapshot({ finalText: 'New speech.', interimText: 'not confirmed', finalDelta: 'New speech.' })
  h.actions.finish()
  await h.until(() => h.summaries.at(-1)?.summary?.source === 'local')
  assert.equal(h.summaries.at(-1).text, 'Earlier confirmed speech.\nNew speech.')
  assert.ok(!h.summaries.at(-1).text.includes('not confirmed'))
})
test('saved paid summary opens offline, exports original and deletes without returning on reload', async t => {
  const storage = new Map()
  const port = {
    get: async key => storage.get(key) ?? '',
    set: async (key, value) => { if (value) storage.set(key, value); else storage.delete(key); return true },
  }
  const seed = new HistoryStore(port)
  await seed.load()
  await seed.write({ id: 'saved-paid', createdAt: 1700000000000, updatedAt: 1700000000100,
    transcript: 'Please send the schedule.', ended: true, saved: true, truncated: false,
    summary: { source: 'openai', overview: '저장된 요약', highlights: ['일정 전달'], decisions: [], actions: [], lensText: 'Send schedule.' }, notice: '' })
  const h = await mountApp(t, { storage })
  assert.equal(h.history.recovery, undefined)
  h.actions.open('saved-paid', 'summary')
  await h.until(() => h.summaries.at(-1)?.summary?.source === 'openai' && !h.history.locked)
  assert.equal(h.aiCalls.length, 0)
  assert.equal(h.micStarts, 0)
  h.actions.export('saved-paid')
  await h.until(() => h.export)
  assert.ok(h.export.text.includes('Please send the schedule.'))
  assert.ok(h.export.text.includes('저장된 요약'))
  assert.ok(h.export.filename.endsWith('.txt'))
  h.actions.remove('saved-paid')
  await h.until(() => !h.history.locked && !h.history.entries.length)
  assert.equal(h.summaries.at(-1).summary, null)
  const reopened = new HistoryStore(port)
  await reopened.load()
  assert.deepEqual(reopened.list(), [])
})
test('autosave runs during capture and manual save survives starting a new conversation', async t => {
  const h = await mountApp(t)
  await h.start()
  h.onSnapshot({ finalText: 'Keep this conversation.', interimText: 'do not save interim', finalDelta: 'Keep this conversation.' })
  // Test the actual two-second autosave while the microphone remains active.
  for (let i = 0; i < 600 && !h.history.entries.length; i++) await new Promise(resolve => setTimeout(resolve, 5))
  assert.equal(h.history.entries.length, 1)
  assert.equal(h.microphone, true)
  const firstId = h.history.entries[0].id
  h.actions.finish()
  await h.until(() => h.summaries.at(-1)?.summary?.source === 'local')
  h.actions.save()
  await h.until(() => !h.history.locked && h.history.entries.some(e => e.id === firstId && e.saved))
  await h.start()
  assert.ok(h.history.entries.some(e => e.id === firstId && e.saved))
  h.onSnapshot({ finalText: 'A second session.', interimText: '', finalDelta: 'A second session.' })
  h.actions.finish()
  await h.until(() => h.history.entries.length === 2)
  assert.equal(h.aiCalls.length, 0)
  h.actions.removeAll()
  await h.until(() => !h.history.locked && h.history.entries.length === 0)
  assert.equal(h.summaries.at(-1).summary, null)
})
test('storage failure keeps current summary and blocks replacing it with a new conversation', async t => {
  const h = await mountApp(t)
  await h.start()
  h.onSnapshot({ finalText: 'Important text.', interimText: '', finalDelta: 'Important text.' })
  h.actions.finish()
  await h.until(() => h.summaries.at(-1)?.summary?.source === 'local')
  h.bridge.setLocalStorage = async () => false
  const original = h.summaries.at(-1)
  h.actions.toggle()
  await h.until(() => !h.history.locked && h.storageStatus.includes('저장'))
  assert.equal(h.summaries.at(-1), original)
  assert.equal(h.micStarts, 1)
  h.actions.export()
  await h.until(() => h.export)
  assert.ok(h.export.text.includes('Important text.'))
  h.bridge.setLocalStorage = async (key, value) => { if (value) h.storage.set(key, value); else h.storage.delete(key); return true }
})

test('session timer closes mic/STT, summarizes for free and stops sending audio at deadline', async t => {
  const h = await mountApp(t)
  let clock = 0
  t.mock.method(performance, 'now', () => clock)
  h.actions.configureUsage({ sessionMinutes: 1, dailyMinutes: 60 })
  await h.until(() => h.usage.settings.sessionMinutes === 1)
  await h.start()
  assert.equal(h.maxDuration, 60)
  h.onSnapshot({ finalText: 'Confirm Friday.', interimText: '', finalDelta: 'Confirm Friday.' })
  clock = 60001
  await h.until(() => h.summaries.at(-1)?.summary?.source === 'local' && !h.microphone)
  assert.match(h.summaries.at(-1).notice, /자동 종료/)
  assert.equal(h.aiCalls.length, 0)
  assert.equal(h.usage.running, false)
  const sent = h.sends
  h.handler({ audioEvent: { audioPcm: new Uint8Array(320) } })
  assert.equal(h.sends, sent)
})
test('daily limit persists independently of history and blocks new capture without clearing the summary', async t => {
  const storage = new Map([['english-stt.usage.v1', JSON.stringify({
    version: 1, settings: { sessionMinutes: 30, dailyMinutes: 1 },
    day: localDay(Date.now()), dailyMs: 59900,
  })]])
  const h = await mountApp(t, { storage })
  let clock = 0
  t.mock.method(performance, 'now', () => clock)
  await h.start()
  assert.equal(h.maxDuration, 1)
  h.onSnapshot({ finalText: 'Daily limit test.', interimText: '', finalDelta: 'Daily limit test.' })
  clock = 200
  h.handler({ audioEvent: { audioPcm: new Uint8Array(320) } })
  await h.until(() => h.summaries.at(-1)?.summary?.source === 'local' && !h.microphone)
  assert.match(h.summaries.at(-1).notice, /하루 사용 한도/)
  const summary = h.summaries.at(-1)
  h.actions.toggle()
  await new Promise(resolve => setTimeout(resolve, 25))
  assert.equal(h.micStarts, 1)
  assert.equal(h.summaries.at(-1), summary)
  h.actions.removeAll()
  await h.until(() => !h.history.locked && !h.history.entries.length)
  assert.ok(JSON.parse(storage.get('english-stt.usage.v1')).dailyMs >= 60000)
})
test('usage persistence failure prevents opening a paid stream and fails closed during capture', async t => {
  const h = await mountApp(t)
  const original = h.bridge.setLocalStorage
  h.bridge.setLocalStorage = async () => false
  h.actions.toggle()
  await h.until(() => h.usageStatus.includes('시작하지'))
  assert.equal(h.micStarts, 0)
  assert.equal(h.onSnapshot, undefined)
  h.bridge.setLocalStorage = original
  let clock = 0
  t.mock.method(performance, 'now', () => clock)
  await h.start()
  h.onSnapshot({ finalText: 'Keep these words.', interimText: '', finalDelta: 'Keep these words.' })
  h.bridge.setLocalStorage = async () => false
  clock = 5001
  await h.until(() => h.summaries.at(-1)?.summary?.source === 'local' && !h.microphone)
  assert.match(h.summaries.at(-1).notice, /저장하지 못해/)
  assert.equal(h.aiCalls.length, 0)
  h.bridge.setLocalStorage = original
})

test('provider session expiry still leads to the free end summary rather than leaving capture paused', async t => {
  const h = await mountApp(t)
  await h.start()
  h.onSnapshot({ finalText: 'Before server expiry.', interimText: '', finalDelta: 'Before server expiry.' })
  h.onError(Object.assign(new Error('Session expired'), { sessionExpired: true }))
  await h.until(() => h.summaries.at(-1)?.summary?.source === 'local' && !h.microphone)
  assert.match(h.summaries.at(-1).notice, /서버의 세션 제한/)
  assert.equal(h.aiCalls.length, 0)
})
