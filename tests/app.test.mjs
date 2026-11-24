import test from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'

// Execute the real app controller, substituting only the device, UI and STT boundary.
test('G2 controller gates mic, routes PCM safely, serializes writes and stops on errors/background/exit', async t => {
  let handler, actions, onSnapshot, onError
  let microphone = false, concurrent = 0, maximumConcurrent = 0, sends = 0, micStarts = 0
  const captions = [], statuses = []
  const operation = async result => {
    maximumConcurrent = Math.max(maximumConcurrent, ++concurrent)
    await new Promise(resolve => setImmediate(resolve))
    concurrent--
    return result
  }
  const bridge = {
    createStartUpPageContainer: () => operation(0),
    textContainerUpgrade: page => { captions.push(page.content); return operation(true) },
    audioControl: enabled => { microphone = enabled; if (enabled) micStarts++; return operation(true) },
    onEvenHubEvent: callback => { handler = callback; return () => { handler = undefined } },
    shutDownPageContainer: () => operation(true),
  }
  const client = { sendPcm() { sends++ }, clear() {}, close() {} }
  const harness = {
    bridge,
    stt: async (snapshot, error, signal) => {
      onSnapshot = snapshot; onError = error
      assert.equal(microphone, false, 'mic must stay off while connecting')
      signal.throwIfAborted()
      return client
    },
    ui: {
      mountUi(value) { actions = value }, setStatus(kind, text) { statuses.push({ kind, text }) },
      setTranscript() {}, setCaption() {}, setControls() {}, setLevel() {}, filterEnabled: () => true,
    },
  }
  const windowEvents = new EventTarget()
  globalThis.__englishSttTest = harness
  Object.defineProperty(globalThis, 'window', { value: windowEvents, configurable: true })
  t.after(() => { windowEvents.dispatchEvent(new Event('pagehide')); delete globalThis.window; delete globalThis.__englishSttTest })
  const sdk = `const h=globalThis.__englishSttTest;
    export const waitForEvenAppBridge=async()=>h.bridge;
    class Model{constructor(v){Object.assign(this,v)}}
    export {Model as TextContainerProperty,Model as TextContainerUpgrade,Model as CreateStartUpPageContainer};
    export const OsEventTypeList={CLICK_EVENT:0,DOUBLE_CLICK_EVENT:3,FOREGROUND_ENTER_EVENT:4,FOREGROUND_EXIT_EVENT:5,ABNORMAL_EXIT_EVENT:6,SYSTEM_EXIT_EVENT:7};`
  const ui = `const u=globalThis.__englishSttTest.ui; export const {mountUi,setStatus,setTranscript,setCaption,setControls,setLevel,filterEnabled}=u;`
  const output = await build({
    entryPoints: ['src/main.ts'], bundle: true, write: false, format: 'esm', platform: 'browser',
    plugins: [{ name: 'app-boundaries', setup(builder) {
      builder.onResolve({ filter: /^(@evenrealities\/even_hub_sdk|\.\/ui|\.\/asr\/stt)$/ }, args => ({ path: args.path, namespace: 'test-boundary' }))
      builder.onLoad({ filter: /.*/, namespace: 'test-boundary' }, args => ({ contents:
        args.path === './ui' ? ui : args.path === './asr/stt' ? 'export const startSttStream=(...args)=>globalThis.__englishSttTest.stt(...args)' : sdk,
      }))
    } }],
  })
  await import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString('base64')}`)
  const until = async condition => {
    for (let i = 0; i < 100; i++) { if (condition()) return; await new Promise(resolve => setTimeout(resolve, 5)) }
    assert.fail('app state did not settle')
  }
  await until(() => handler)
  assert.equal(microphone, false)
  actions.toggle()
  await until(() => statuses.at(-1)?.kind === 'listening')
  assert.equal(microphone, true)
  onSnapshot({ finalText: 'Could you confirm the meeting?', interimText: '' })
  handler({ audioEvent: { audioPcm: new Uint8Array(320) } })
  assert.equal(sends, 1)
  assert.equal(micStarts, 1, 'PCM envelope cannot trigger a zero-valued click')
  await until(() => captions.includes('Could you confirm the meeting?'))
  handler({ sysEvent: {} }) // protobuf omits CLICK_EVENT's zero field
  await until(() => !microphone)
  handler({ sysEvent: {} })
  await until(() => statuses.at(-1)?.kind === 'listening')
  handler({ sysEvent: { eventType: 5 } })
  await until(() => !microphone)
  actions.toggle()
  await until(() => statuses.at(-1)?.kind === 'listening')
  onError(new Error('Network dropped'))
  await until(() => !microphone)
  assert.equal(statuses.at(-1).kind, 'error')
  actions.toggle()
  await until(() => statuses.at(-1)?.kind === 'listening')
  handler({ sysEvent: { eventType: 3 } })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(microphone, true, 'exit dialog can be cancelled; do not stop prematurely')
  handler({ sysEvent: { eventType: 7 } })
  await until(() => !microphone && !handler)
  assert.equal(maximumConcurrent, 1)
})
