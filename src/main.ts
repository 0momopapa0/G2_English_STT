import {
  waitForEvenAppBridge, type EvenAppBridge, TextContainerProperty,
  CreateStartUpPageContainer, TextContainerUpgrade, OsEventTypeList,
} from '@evenrealities/even_hub_sdk'
import { startSttStream, type SttClient } from './asr/stt'
import { RumbleFilter } from './asr/audio'
import { tailAtWord } from './asr/transcript'
import { Conversation } from './asr/conversation'
import { summarizeLocally, type ConversationSummary } from './summary/summary'
import { requestOpenAiSummary } from './summary/client'
import { mountUi, setStatus, setTranscript, setCaption, setControls, setLevel, filterEnabled, setSummary, setSummaryStatus } from './ui'

let bridge: EvenAppBridge | undefined
let ready = false
let active = false
let busy = false
let disposed = false
let stt: SttClient | undefined
let controller: AbortController | undefined
let generation = 0
let finalText = ''
let interimText = ''
let sessionPrefix = ''
let content = 'Ready. Tap to start.'
let lastRender = content
let renderTimer: ReturnType<typeof setTimeout> | undefined
let demoTimer: ReturnType<typeof setInterval> | undefined
let unsubscribe = () => {}
const filter = new RumbleFilter()
const conversation = new Conversation()
let ending = false
let ended = false
let summaryText = ''
let summaryNotice = ''
let summaryController: AbortController | undefined
let summaryGeneration = 0

// Preserve the actual operation queue after a UI timeout, avoiding concurrent BLE writes.
let bridgeQueue: Promise<unknown> = Promise.resolve()
function bridgeCall<T>(operation: () => Promise<T>): Promise<T> {
  const pending = bridgeQueue.then(operation)
  bridgeQueue = pending.catch(() => {})
  let timer: ReturnType<typeof setTimeout>
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('G2 응답 시간 초과. 안경 연결을 확인하고 앱을 다시 여세요.')), 6000)
  })
  return Promise.race([pending, timeout]).finally(() => clearTimeout(timer))
}

function display(text: string) {
  content = text
  setCaption(text)
  if (!ready || disposed || renderTimer) return
  renderTimer = setTimeout(() => {
    renderTimer = undefined
    void bridgeCall(async () => {
      if (!ready || disposed || content === lastRender) return
      const next = content
      const ok = await bridge!.textContainerUpgrade(new TextContainerUpgrade({
        containerID: 1, containerName: 'transcript', content: next,
        contentOffset: 0, contentLength: 0,
      }))
      if (!ok) throw new Error('G2 자막 전송 실패. 안경 연결을 확인하세요.')
      lastRender = next
    }).catch(error => { ready = false; handleError(error) })
  }, 180)
}
function showTranscript() {
  setTranscript(finalText, interimText)
  display(tailAtWord(`${finalText}${interimText}`.trim(), 240) || (active ? 'Listening…' : 'Ready. Tap to start.'))
}
function clearDemo() { clearInterval(demoTimer); demoTimer = undefined }

async function stop(message = '일시정지 · 시작을 눌러 다시 연결하세요.') {
  generation++
  ending = false
  active = false
  busy = false
  // End the Soniox stream before aborting a pending connection.
  void stt?.close()
  stt = undefined
  controller?.abort()
  controller = undefined
  clearDemo()
  interimText = ''
  setLevel(0)
  refreshControls()
  setStatus('paused', message)
  setTranscript(finalText, '')
  display(tailAtWord(finalText, 240) || 'Paused. Tap to resume.')
  if (bridge) {
    const ok = await bridgeCall(() => bridge!.audioControl(false))
    if (!ok) throw new Error('G2 마이크 중지 실패. 앱을 종료하고 연결을 확인하세요.')
  }
}
function handleError(error: unknown) {
  const message = error instanceof Error ? error.message : '알 수 없는 오류'
  // Stop locally immediately, then request hardware shutdown through the serialized queue.
  void stop().catch(() => { setStatus('error', `${message} · G2 연결을 확인하세요.`) })
  setStatus('error', message)
  display('Connection error. Check phone.')
}

async function toggle() {
  if (!ready || disposed || busy) return
  if (active) { await stop(); return }
  cancelSummary()
  if (ended) {
    conversation.clear()
    finalText = ''; interimText = ''; sessionPrefix = ''
    summaryText = ''; summaryNotice = ''; ended = false
    setSummary(null)
    setTranscript('', '')
  }
  conversation.startStream()
  clearDemo()
  busy = true
  const id = ++generation
  const abortController = new AbortController()
  controller = abortController
  sessionPrefix = finalText
  refreshControls()
  setStatus('connecting', '영어 음성 인식에 연결 중…')
  display('Connecting…')
  try {
    const client = await startSttStream(snapshot => {
      if (generation !== id || disposed) return
      finalText = tailAtWord(sessionPrefix ? `${sessionPrefix.trimEnd()} ${snapshot.finalText.trimStart()}` : snapshot.finalText, 4000)
      if (snapshot.finalDelta) conversation.append(snapshot.finalDelta)
      interimText = snapshot.interimText
      if (ending) setTranscript(finalText, interimText)
      else showTranscript()
    }, error => { if (generation === id) handleError(error) }, abortController.signal)
    if (generation !== id || disposed) { void client.close(); return }
    stt = client
    filter.reset()
    // Set before enabling capture so early audio callbacks are not discarded.
    active = true
    const ok = await bridgeCall(() => generation === id ? bridge!.audioControl(true) : Promise.resolve(false))
    if (generation !== id || disposed || ending) return
    if (!ok) throw new Error('G2 마이크 권한 또는 연결을 확인하세요.')
    busy = false
    refreshControls()
    setStatus('listening', '듣는 중 · 영어 자막이 실시간으로 표시됩니다.')
    showTranscript()
  } catch (error) {
    if (generation === id && !disposed) handleError(error)
  }
}
function clear() {
  if (ending) return
  cancelSummary()
  conversation.clear()
  summaryText = ''; summaryNotice = ''; ended = false
  setSummary(null)
  clearDemo()
  finalText = ''; interimText = ''; sessionPrefix = ''
  stt?.clear()
  showTranscript()
  refreshControls()
}
function demo() {
  if (active || busy || disposed) return
  clear()
  setStatus('paused', '자막 데모 · 실제 음성 인식이 아닙니다.')
  const words = 'Could you please send me the updated schedule? I would like to confirm our meeting tomorrow.'.split(' ')
  let index = 0
  demoTimer = setInterval(() => {
    interimText = words.slice(0, ++index).join(' ')
    if (index === words.length) { finalText = interimText; interimText = ''; conversation.append(finalText); clearDemo(); refreshControls() }
    showTranscript()
  }, 220)
}


function cancelSummary() {
  summaryController?.abort()
  summaryController = undefined
  summaryGeneration++
  setSummaryStatus('', false)
}
function refreshControls() {
  setControls(ready, active, busy, !ended && (active || busy || Boolean(conversation.transcript)), ending)
}
function showSummaryOnGlasses(summary: ConversationSummary) {
  display(('Summary\n' + summary.lensText).slice(0, 240))
}
async function finishConversation() {
  if (disposed || ending || (!active && !busy && !conversation.transcript)) return
  cancelSummary()
  clearDemo()
  ending = true
  busy = true
  active = false
  const client = stt
  stt = undefined
  const id = client ? generation : ++generation
  const closing = client?.close(true)
  controller?.abort()
  controller = undefined
  setLevel(0)
  refreshControls()
  setStatus('connecting', '대화를 종료하고 마지막 자막을 정리하는 중…')
  const results = await Promise.allSettled([
    closing ?? Promise.resolve(true),
    bridge ? bridgeCall(() => bridge!.audioControl(false)) : Promise.resolve(true),
  ])
  if (disposed || generation !== id) return
  generation++
  ending = false
  busy = false
  ended = true
  interimText = ''
  summaryText = conversation.transcript
  finalText = tailAtWord(summaryText, 4000)
  setTranscript(finalText, '')
  const summary = summarizeLocally(summaryText)
  summaryNotice = [
    conversation.truncated ? '기록 한도를 넘어 최근 100,000자를 기준으로 요약했습니다.' : '',
    results[0].status === 'rejected' || (results[0].status === 'fulfilled' && results[0].value !== true)
      ? '마지막 발화가 완전히 확정되지 않았을 수 있습니다.' : '',
    results[1].status === 'rejected' || (results[1].status === 'fulfilled' && results[1].value !== true)
      ? 'G2 마이크 중지 응답을 확인하지 못했습니다. 연결을 확인하세요.' : '',
  ].filter(Boolean).join(' ')
  setSummary(summary, summaryText, summaryNotice)
  refreshControls()
  setStatus('paused', '대화 종료 · 무료 요약을 확인하거나 새 대화를 시작하세요.')
  showSummaryOnGlasses(summary)
}
async function improveSummary() {
  if (disposed || active || busy || !ended || !summaryText || summaryController) return
  const controller = new AbortController()
  summaryController = controller
  const id = ++summaryGeneration
  setSummaryStatus('대화 텍스트를 OpenAI로 보내 요약 중입니다…', true)
  try {
    const summary = await requestOpenAiSummary(summaryText, controller.signal)
    if (disposed || id !== summaryGeneration) return
    setSummary(summary, summaryText, summaryNotice)
    setSummaryStatus('OpenAI 요약을 표시했습니다. 원문과 비교해 확인하세요.', false)
    showSummaryOnGlasses(summary)
  } catch (error) {
    if (disposed || id !== summaryGeneration) return
    setSummaryStatus(error instanceof Error ? error.message : 'OpenAI 요약에 실패했습니다. 무료 요약은 유지됩니다.', false)
  } finally {
    if (id === summaryGeneration) summaryController = undefined
  }
}

mountUi({ toggle: () => { void toggle().catch(handleError) }, finish: () => { void finishConversation().catch(handleError) }, improveSummary: () => { void improveSummary() }, clear, demo })

async function initialize() {
  const timeout = setTimeout(() => {
    if (!ready && !disposed) setStatus('paused', 'Even 앱 또는 시뮬레이터에서 열어주세요. 자막 데모는 여기서도 볼 수 있습니다.')
  }, 8000)
  try {
    bridge = await waitForEvenAppBridge()
    if (disposed) return
    const created = await bridgeCall(() => bridge!.createStartUpPageContainer(new CreateStartUpPageContainer({
      containerTotalNum: 1, textObject: [new TextContainerProperty({
        xPosition: 0, yPosition: 0, width: 576, height: 288,
        borderWidth: 0, borderColor: 5, paddingLength: 8,
        containerID: 1, containerName: 'transcript', content, isEventCapture: 1,
      })],
    })))
    if (created !== 0) throw new Error(`G2 화면 생성 실패: ${created}`)
    if (disposed) return
    ready = true
    refreshControls()
    setStatus('paused', '준비 완료 · 시작을 누르거나 안경을 한 번 터치하세요.')
    unsubscribe = bridge.onEvenHubEvent(event => {
      const pcm = event.audioEvent?.audioPcm
      if (pcm && active && stt) {
        const result = filter.process(pcm, filterEnabled())
        setLevel(result.level)
        stt.sendPcm(result.pcm)
      }
      // Only default to CLICK inside an existing envelope, never on PCM events.
      const sys = event.sysEvent ? event.sysEvent.eventType ?? OsEventTypeList.CLICK_EVENT : null
      const text = event.textEvent?.eventType
      if (sys === OsEventTypeList.DOUBLE_CLICK_EVENT || text === OsEventTypeList.DOUBLE_CLICK_EVENT) {
        void bridgeCall(() => bridge!.shutDownPageContainer(1)).catch(handleError)
      } else if (sys === OsEventTypeList.CLICK_EVENT) {
        void toggle().catch(handleError)
      } else if (sys === OsEventTypeList.FOREGROUND_EXIT_EVENT) {
        void stop('백그라운드 전환으로 중지됐습니다. 시작 버튼으로 재개하세요.').catch(handleError)
      } else if (sys === OsEventTypeList.SYSTEM_EXIT_EVENT || sys === OsEventTypeList.ABNORMAL_EXIT_EVENT) {
        cleanup()
      }
    })
    display(content)
  } catch (error) { handleError(error) }
  finally { clearTimeout(timeout) }
}
function cleanup() {
  if (disposed) return
  disposed = true
  cancelSummary()
  clearTimeout(renderTimer)
  clearDemo()
  unsubscribe()
  void stop('종료됨').catch(() => {})
}
window.addEventListener('pagehide', cleanup)
window.addEventListener('beforeunload', cleanup)
void initialize()
