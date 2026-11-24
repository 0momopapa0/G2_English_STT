import {
  waitForEvenAppBridge, type EvenAppBridge, TextContainerProperty,
  CreateStartUpPageContainer, TextContainerUpgrade, OsEventTypeList,
} from '@evenrealities/even_hub_sdk'
import { UsageMeter, formatDuration, type UsageSettings } from './usage/meter'
import { startSttStream, type SttClient } from './asr/stt'
import { RumbleFilter } from './asr/audio'
import { tailAtWord } from './asr/transcript'
import { Conversation } from './asr/conversation'
import { summarizeLocally, type ConversationSummary } from './summary/summary'
import { requestOpenAiSummary } from './summary/client'
import { HistoryStore, newSessionId, exportSession, type SessionRecord, type StoragePort } from './history/store'
import { mountUi, setStatus, setTranscript, setCaption, setControls, setLevel, filterEnabled, setSummary, setSummaryStatus, setHistory, setStorageStatus, setSessionSaved, showExport, setUsage, setUsageStatus } from './ui'

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

let historyStore: HistoryStore | undefined
let historyBusy = true
let pendingRecovery: string | undefined
let sessionRecord: SessionRecord | undefined
let currentSummary: ConversationSummary | null = null
let autosaveTimer: ReturnType<typeof setTimeout> | undefined
let pendingSave: { record: SessionRecord; store: HistoryStore } | undefined
let persistenceTask: Promise<boolean> | undefined

const usage = new UsageMeter()
let usageTimer: ReturnType<typeof setInterval> | undefined
let usageCheckpoint = 0
let usageSaving = false
let usageNotice = ''
let configuringUsage = false

function renderUsage() {
  const view = usage.tick()
  setUsage(view, active || busy || historyBusy || configuringUsage)
  return view
}
function stopUsage() {
  clearInterval(usageTimer); usageTimer = undefined
  const view = usage.stop()
  setUsage(view, busy || historyBusy)
  if (view.ready) void usage.save().catch(error => setUsageStatus(error instanceof Error ? error.message : '사용 시간을 저장하지 못했습니다.'))
}
function startUsage() {
  usage.start()
  usageCheckpoint = performance.now()
  clearInterval(usageTimer)
  usageTimer = setInterval(() => {
    const view = renderUsage()
    if (!active || disposed || ending) return
    if (view.reason) {
      void finishConversation(view.reason === 'daily' ? '하루 사용 한도에 도달하여 자동 종료했습니다.' : '설정한 인식 시간이 지나 자동 종료했습니다.').catch(handleError)
      return
    }
    if (!usageSaving && performance.now() - usageCheckpoint >= 5000) {
      usageSaving = true
      usageCheckpoint = performance.now()
      void usage.save().then(() => { scheduleSave() }).catch(error => {
        setUsageStatus(error instanceof Error ? error.message : '사용 시간을 저장하지 못했습니다.')
        if (active && !disposed) void finishConversation('사용 시간을 저장하지 못해 안전을 위해 자동 종료했습니다.').catch(handleError)
      }).finally(() => { usageSaving = false })
    }
    if (Math.floor(view.sessionMs / 1000) !== lastUsageSecond) {
      lastUsageSecond = Math.floor(view.sessionMs / 1000)
      showTranscript()
    }
  }, 250)
}
let lastUsageSecond = -1
async function configureUsage(settings: UsageSettings) {
  if (active || busy || historyBusy || disposed || configuringUsage) return
  configuringUsage = true; renderUsage()
  try {
    await usage.configure(settings)
    setUsageStatus('사용 한도를 저장했습니다.')
  } catch (error) { setUsageStatus(error instanceof Error ? error.message : '사용 한도 설정 실패') }
  configuringUsage = false
  renderUsage()
}


function historyError(error: unknown) {
  setStorageStatus(error instanceof Error ? error.message : '기록 저장에 실패했습니다. 중요한 대화는 텍스트로 내보내세요.')
}
function updateHistory() {
  setSessionSaved(sessionRecord ? sessionRecord.saved : null)
  setHistory(historyStore?.list() ?? [], pendingRecovery, sessionRecord?.id, historyBusy || active || busy)
}
function ensureSession() {
  if (!sessionRecord) sessionRecord = {
    id: newSessionId(), createdAt: Date.now(), updatedAt: Date.now(), transcript: '',
    ended: false, saved: false, truncated: false, summary: null, notice: '',
  }
}
function snapshot(): SessionRecord | undefined {
  if (!conversation.transcript) return
  ensureSession()
  return {
    ...sessionRecord!, updatedAt: Date.now(), transcript: conversation.transcript,
    truncated: conversation.truncated, ended, summary: currentSummary, notice: summaryNotice, recognitionMs: usage.tick().sessionMs,
  }
}
async function persistNow(): Promise<boolean> {
  clearTimeout(autosaveTimer); autosaveTimer = undefined
  const record = snapshot()
  const store = historyStore
  if (!record) return true
  if (!store) { setStorageStatus('저장소를 사용할 수 없어 기록을 보존하지 못했습니다. 텍스트로 내보낸 후 다시 시도하세요.'); return false }
  pendingSave = { record, store }
  if (!persistenceTask) {
    persistenceTask = (async () => {
      let success = true
      while (pendingSave) {
        const { record, store } = pendingSave
        pendingSave = undefined
        try {
          await store.write(record)
          if (store === historyStore) {
            setStorageStatus('기기에 ' + (record.saved ? '저장됨' : '임시 저장됨') + ' · ' + new Date(record.updatedAt).toLocaleTimeString('ko-KR'))
            updateHistory()
          }
        } catch (error) { historyError(error); success = false }
      }
      return success
    })().finally(() => { persistenceTask = undefined })
  }
  const success = await persistenceTask
  return pendingSave ? (await persistNow()) && success : success
}
function scheduleSave() {
  if (autosaveTimer || disposed) return
  autosaveTimer = setTimeout(() => { autosaveTimer = undefined; void persistNow() }, 2000)
}
async function loadHistory(port: StoragePort) {
  historyBusy = true
  const store = new HistoryStore(port)
  try {
    await store.load()
    historyStore = store
    pendingRecovery = store.list().find(entry => !entry.saved)?.id
    setStorageStatus('기기에 대화 텍스트와 요약만 저장합니다. 음성 파일은 저장하지 않습니다.')
  } catch (error) {
    historyStore = undefined
    pendingRecovery = undefined
    historyError(error)
  } finally {
    try { await usage.load(port); setUsageStatus('연결된 인식 시간을 기준으로 한 기기 내 추정치입니다. 실제 청구액과 다를 수 있습니다.') }
    catch { setUsageStatus('사용 시간 기록을 읽지 못했습니다. 새로고침 후 다시 확인하세요. 음성 인식은 시작하지 않습니다.') }
    historyBusy = false; refreshControls()
  }
}
function resetSession() {
  pendingSave = undefined
  clearTimeout(autosaveTimer); autosaveTimer = undefined
  clearDemo()
  cancelSummary()
  conversation.clear()
  sessionRecord = undefined
  usage.restoreSession()
  usageNotice = ''
  currentSummary = null
  summaryText = ''; summaryNotice = ''; ended = false
  finalText = ''; interimText = ''; sessionPrefix = ''
  setSummary(null)
  setTranscript('', '')
}
async function saveSession() {
  if (historyBusy || active || busy || !historyStore) return
  const record = snapshot()
  if (!record) return
  historyBusy = true
  clearTimeout(autosaveTimer); autosaveTimer = undefined
  pendingSave = undefined
  refreshControls()
  try {
    await historyStore.write({ ...record, saved: true })
    sessionRecord = { ...record, saved: true }
    setStorageStatus('대화를 저장했습니다. 최근 대화에서 다시 볼 수 있습니다.')
  } catch (error) { historyError(error) }
  finally { historyBusy = false; refreshControls() }
}
async function openSession(id: string, mode: 'resume' | 'summary') {
  if (historyBusy || active || busy || !historyStore) return
  historyBusy = true
  clearTimeout(autosaveTimer); autosaveTimer = undefined
  pendingSave = undefined
  cancelSummary(); clearDemo(); refreshControls()
  try {
    const current = snapshot()
    if (current) await historyStore.write(current)
    const record = await historyStore.read(id)
    resetSession()
    sessionRecord = record
    usage.restoreSession(record.recognitionMs ?? 0)
    conversation.append(record.transcript)
    conversation.truncated = record.truncated
    finalText = tailAtWord(record.transcript, 4000)
    summaryNotice = record.notice
    ended = mode === 'summary' || record.ended
    pendingRecovery = undefined
    setTranscript(finalText, '')
    if (ended) {
      summaryText = record.transcript
      currentSummary = record.summary ?? summarizeLocally(summaryText)
      setSummary(currentSummary, summaryText, summaryNotice)
      showSummaryOnGlasses(currentSummary)
      await historyStore.write(snapshot()!)
    } else showTranscript()
    setStatus('paused', ended ? '저장된 대화 요약 · API를 다시 호출하지 않았습니다.' : '이전 대화를 복구했습니다. 시작을 누르면 음성 인식을 이어갑니다.')
  } catch (error) { historyError(error) }
  finally { historyBusy = false; refreshControls() }
}
async function deleteSession(id: string) {
  if (historyBusy || active || busy || !historyStore) return
  historyBusy = true
  clearTimeout(autosaveTimer); autosaveTimer = undefined
  if (sessionRecord?.id === id) cancelSummary()
  refreshControls()
  try {
    if (sessionRecord?.id === id) pendingSave = undefined
    await historyStore.remove(id)
    if (sessionRecord?.id === id) { resetSession(); showTranscript() }
    if (pendingRecovery === id) pendingRecovery = undefined
    setStorageStatus('대화를 삭제했습니다.')
  } catch (error) { historyError(error) }
  finally { historyBusy = false; refreshControls() }
}
async function deleteAllSessions() {
  if (historyBusy || active || busy || !historyStore) return
  historyBusy = true
  clearTimeout(autosaveTimer); autosaveTimer = undefined
  cancelSummary(); clearDemo(); refreshControls()
  try {
    pendingSave = undefined
    await historyStore.clear()
    resetSession(); pendingRecovery = undefined
    showTranscript()
    setStorageStatus('모든 대화 기록을 삭제했습니다. 이미 내보낸 파일은 별도로 삭제하세요.')
  } catch (error) { historyError(error) }
  finally { historyBusy = false; refreshControls() }
}
async function exportRecord(id?: string) {
  if (historyBusy) return
  try {
    const record = !id || id === sessionRecord?.id ? snapshot() : await historyStore?.read(id)
    if (!record) return
    showExport(exportSession(record), 'english-stt-' + new Date(record.createdAt).toISOString().replace(/[:.]/g, '-') + '.txt')
  } catch (error) { historyError(error) }
}


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
  const view = usage.tick()
  const prefix = active ? formatDuration(view.sessionMs) + ' | ' + formatDuration(view.remainingMs) + ' left\n' : ''
  display(prefix + (tailAtWord(`${finalText}${interimText}`.trim(), 240 - prefix.length) || (active ? 'Listening…' : 'Ready. Tap to start.')))
}
function clearDemo() { clearInterval(demoTimer); demoTimer = undefined }

async function stop(message = '일시정지 · 시작을 눌러 다시 연결하세요.') {
  generation++
  ending = false
  active = false
  busy = false
  stopUsage()
  // End the Soniox stream before aborting a pending connection.
  void stt?.close()
  stt = undefined
  controller?.abort()
  controller = undefined
  clearDemo()
  interimText = ''
  setLevel(0)
  refreshControls()
  if (!disposed) void persistNow()
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
  if (!ready || disposed || busy || historyBusy || pendingRecovery || configuringUsage) return
  if (active) { await stop(); return }
  const beforeStart = renderUsage()
  if (!beforeStart.ready || beforeStart.reason === 'daily') {
    setUsageStatus(beforeStart.ready ? '오늘 사용 한도에 도달했습니다. 다음 날 또는 한도 변경 후 시작하세요.' : '사용 시간 저장소를 확인한 뒤 시작하세요.')
    return
  }
  cancelSummary()
  if (ended) {
    historyBusy = true; refreshControls()
    if (!await persistNow()) { historyBusy = false; refreshControls(); return }
    resetSession()
    historyBusy = false
  }
  const allowance = renderUsage()
  if (!allowance.ready || allowance.reason) {
    setUsageStatus(!allowance.ready ? '사용 시간 저장소를 확인한 뒤 시작하세요.' : allowance.reason === 'daily' ? '오늘 사용 한도에 도달했습니다. 다음 날 또는 한도 변경 후 시작하세요.' : '이 대화의 제한 시간에 도달했습니다. 대화를 종료하고 새 대화를 시작하세요.')
    refreshControls()
    return
  }
  try { await usage.save() } catch {
    setUsageStatus('사용 시간을 저장할 수 없어 음성 인식을 시작하지 않았습니다.')
    return
  }
  if (disposed || active || busy || historyBusy) return
  ensureSession()
  usageNotice = ''
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
      if (snapshot.finalDelta) { conversation.append(snapshot.finalDelta); scheduleSave() }
      interimText = snapshot.interimText
      if (ending) setTranscript(finalText, interimText)
      else showTranscript()
    }, error => {
      if (generation !== id) return
      if (active && 'sessionExpired' in error) {
        void finishConversation('서버의 세션 제한 시간에 도달하여 자동 종료했습니다.').catch(handleError)
      } else handleError(error)
    }, abortController.signal, Math.max(1, Math.ceil(allowance.remainingMs / 1000)))
    if (generation !== id || disposed) { void client.close(); return }
    stt = client
    startUsage()
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
  if (ending || active || busy || historyBusy) return
  const id = sessionRecord?.id
  resetSession()
  showTranscript()
  if (id) void deleteSession(id)
  refreshControls()
}
async function demo() {
  if (active || busy || disposed || historyBusy || pendingRecovery) return
  historyBusy = true; refreshControls()
  if (!await persistNow()) { historyBusy = false; refreshControls(); return }
  resetSession()
  ensureSession()
  historyBusy = false; refreshControls()
  setStatus('paused', '자막 데모 · 실제 음성 인식이 아닙니다.')
  const words = 'Could you please send me the updated schedule? I would like to confirm our meeting tomorrow.'.split(' ')
  let index = 0
  demoTimer = setInterval(() => {
    interimText = words.slice(0, ++index).join(' ')
    if (index === words.length) { finalText = interimText; interimText = ''; conversation.append(finalText); clearDemo(); void persistNow(); refreshControls() }
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
  setControls(ready && !pendingRecovery && !historyBusy, active, busy || historyBusy, !historyBusy && !ended && (active || busy || Boolean(conversation.transcript)), ending)
  updateHistory()
  renderUsage()
}
function showSummaryOnGlasses(summary: ConversationSummary) {
  display(((usageNotice ? 'Auto stopped\n' : '') + 'Summary\n' + summary.lensText).slice(0, 240))
}
async function finishConversation(autoNotice = '') {
  if (disposed || ending || historyBusy || (!active && !busy && !conversation.transcript)) return
  cancelSummary()
  clearDemo()
  ending = true
  busy = true
  active = false
  usageNotice = autoNotice
  stopUsage()
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
  currentSummary = summary
  summaryNotice = [
    usageNotice,
    conversation.truncated ? '기록 한도를 넘어 최근 100,000자를 기준으로 요약했습니다.' : '',
    results[0].status === 'rejected' || (results[0].status === 'fulfilled' && results[0].value !== true)
      ? '마지막 발화가 완전히 확정되지 않았을 수 있습니다.' : '',
    results[1].status === 'rejected' || (results[1].status === 'fulfilled' && results[1].value !== true)
      ? 'G2 마이크 중지 응답을 확인하지 못했습니다. 연결을 확인하세요.' : '',
  ].filter(Boolean).join(' ')
  setSummary(summary, summaryText, summaryNotice)
  refreshControls()
  setStatus('paused', usageNotice || '대화 종료 · 무료 요약을 확인하거나 새 대화를 시작하세요.')
  showSummaryOnGlasses(summary)
  void persistNow()
}
async function improveSummary() {
  if (disposed || active || busy || historyBusy || !ended || !summaryText || summaryController) return
  const controller = new AbortController()
  summaryController = controller
  const id = ++summaryGeneration
  setSummaryStatus('대화 텍스트를 OpenAI로 보내 요약 중입니다…', true)
  try {
    const summary = await requestOpenAiSummary(summaryText, controller.signal)
    if (disposed || id !== summaryGeneration) return
    currentSummary = summary
    setSummary(summary, summaryText, summaryNotice)
    void persistNow()
    setSummaryStatus('OpenAI 요약을 표시했습니다. 원문과 비교해 확인하세요.', false)
    showSummaryOnGlasses(summary)
  } catch (error) {
    if (disposed || id !== summaryGeneration) return
    setSummaryStatus(error instanceof Error ? error.message : 'OpenAI 요약에 실패했습니다. 무료 요약은 유지됩니다.', false)
  } finally {
    if (id === summaryGeneration) summaryController = undefined
  }
}

mountUi({ toggle: () => { void toggle().catch(handleError) }, finish: () => { void finishConversation().catch(handleError) }, improveSummary: () => { void improveSummary() }, clear, demo: () => { void demo() }, save: () => { void saveSession() }, open: (id, mode) => { void openSession(id, mode) }, remove: id => { void deleteSession(id) }, removeAll: () => { void deleteAllSessions() }, export: id => { void exportRecord(id) }, configureUsage: settings => { void configureUsage(settings) } })

// Browser storage is only for browser demos; native startup replaces it with SDK storage.
const browserHistoryReady = loadHistory({
  get: async key => window.localStorage.getItem(key) ?? '',
  set: async (key, value) => { if (value) window.localStorage.setItem(key, value); else window.localStorage.removeItem(key); return true },
})

async function initialize() {
  const timeout = setTimeout(() => {
    if (!ready && !disposed) setStatus('paused', 'Even 앱 또는 시뮬레이터에서 열어주세요. 자막 데모는 여기서도 볼 수 있습니다.')
  }, 8000)
  try {
    bridge = await waitForEvenAppBridge()
    if (disposed) return
    await browserHistoryReady
    await loadHistory({
      get: key => bridgeCall(() => bridge!.getLocalStorage(key)),
      set: (key, value) => bridgeCall(() => bridge!.setLocalStorage(key, value)),
    })
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
        const allowance = usage.tick()
        if (allowance.reason) { void finishConversation(allowance.reason === 'daily' ? '하루 사용 한도에 도달하여 자동 종료했습니다.' : '설정한 인식 시간이 지나 자동 종료했습니다.').catch(handleError); return }
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
  stopUsage()
  void persistNow()
  disposed = true
  cancelSummary()
  clearTimeout(renderTimer)
  clearDemo()
  unsubscribe()
  void stop('종료됨').catch(() => {})
}
window.addEventListener('pagehide', cleanup)
window.addEventListener('beforeunload', cleanup)
if (typeof document !== 'undefined') document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden' && !disposed) { if (active || busy) void stop('화면이 숨겨져 음성 인식을 중지했습니다.').catch(handleError); else void persistNow() } })
void initialize()
