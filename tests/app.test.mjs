import test from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'

let moduleId = 0
async function mountApp(t) {
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
  h.bridge = {
    createStartUpPageContainer: () => operation(0),
    textContainerUpgrade: page => { h.captions.push(page.content); return operation(true) },
    audioControl: enabled => { h.microphone = enabled; if (enabled) h.micStarts++; return operation(true) },
    onEvenHubEvent: callback => { h.handler = callback; return () => { h.handler = undefined } },
    shutDownPageContainer: () => operation(true),
  }
  h.closeHandler = () => Promise.resolve(true)
  h.client = { sendPcm() { h.sends++ }, clear() {}, close(finalize) { h.lifecycle.push('close'); return h.closeHandler(finalize) } }
  h.stt = async (snapshot, error, signal) => {
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
  const ui = 'const u=globalThis.__englishSttTest.ui; export const {mountUi,setStatus,setTranscript,setCaption,setControls,setLevel,filterEnabled,setSummary,setSummaryStatus}=u;'
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
  await h.until(() => h.captions.includes('Could you confirm the meeting?'))
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
