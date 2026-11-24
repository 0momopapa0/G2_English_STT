import './style.css'
import type { ConversationSummary } from './summary/summary'
import type { SessionEntry } from './history/store'
import { formatDuration, type UsageSettings, type UsageView } from './usage/meter'

type Status = 'connecting' | 'listening' | 'paused' | 'error'
let statusEl: HTMLElement
let finalEl: HTMLElement
let interimEl: HTMLElement
let captionEl: HTMLElement
let toggleEl: HTMLButtonElement
let finishEl: HTMLButtonElement
let clearEl: HTMLButtonElement
let demoEl: HTMLButtonElement
let levelEl: HTMLMeterElement
let summaryEl: HTMLElement
let summaryStatusEl: HTMLElement
let improveEl: HTMLButtonElement
let summaryCopy = ''
let originalText = ''

interface UiActions {
  toggle: () => void; finish: () => void; improveSummary: () => void; clear: () => void; demo: () => void
  configureUsage: (settings: UsageSettings) => void
  save: () => void; open: (id: string, mode: 'resume' | 'summary') => void
  remove: (id: string) => void; removeAll: () => void; export: (id?: string) => void
}
let historyActions: UiActions
let exportText = ''
let exportFilename = 'english-stt.txt'

export function mountUi(actions: UiActions) {
  historyActions = actions
  document.querySelector<HTMLDivElement>('#app')!.innerHTML = `
    <main class="panel">
      <header><div class="eyebrow">EVEN G2 · LIVE CAPTIONS</div><h1>English STT</h1>
        <p>들리는 영어를, 눈앞의 영어 자막으로.</p></header>
      <div id="status" class="status status-connecting" role="status">G2 연결 대기 중…</div>
      <p id="storage-status" role="status" class="storage-status">대화 저장소 확인 중…</p>
      <section id="recovery" class="recovery" hidden aria-label="이전 대화 복구">
        <h2>이전 대화를 복구할까요?</h2>
        <p id="recovery-text"></p>
        <p>확정된 자막만 복구됩니다. 마이크는 자동으로 켜지지 않습니다.</p>
        <div class="controls"><button id="recover-resume">이어가기</button>
          <button id="recover-summary" class="secondary">요약 보기</button>
          <button id="recover-delete" class="secondary">삭제</button></div>
      </section>
      <section class="glasses"><div class="eyebrow">G2 화면 미리보기</div>
        <div id="caption">Ready to listen.</div></section>
      <div class="controls"><button id="toggle" disabled>시작</button>
        <button id="finish" class="secondary" disabled>대화 종료</button>
        <button id="clear" class="secondary">대화 지우기</button>
        <button id="demo" class="secondary">자막 데모</button></div>
      <section id="usage" class="usage" aria-label="인식 시간과 사용 한도">
        <div class="usage-stats">
          <div><span>이번 대화 인식 시간</span><strong id="recognition-time">00:00</strong></div>
          <div><span>자동 종료까지</span><strong id="time-remaining">30:00</strong></div>
          <div><span>오늘 인식 시간 / 한도</span><strong id="daily-usage">00:00 / 60:00</strong></div>
        </div>
        <p id="usage-warning" class="summary-notice" role="status" hidden></p>
        <details><summary>자동 종료·사용 한도 설정</summary>
          <div class="usage-settings">
            <label>대화당 자동 종료(분)<input id="session-limit" type="number" min="1" max="60" step="1" value="30"></label>
            <label>하루 사용 한도(분)<input id="daily-limit" type="number" min="1" max="1440" step="1" value="60"></label>
            <button id="apply-limits" class="secondary">설정 저장</button>
          </div>
        </details>
        <p id="usage-status" role="status">기기 내 추정치이며 실제 청구 시간·금액과 다를 수 있습니다.</p>
      </section>
      <label class="filter"><input id="filter" type="checkbox" checked> 저주파 소음 완화 (100 Hz)</label>
      <label class="level">마이크 입력 <meter id="level" min="0" max="1" value="0"></meter></label>
      <section id="summary" class="summary" hidden aria-labelledby="summary-title">
        <div class="summary-heading"><h2 id="summary-title">대화 요약</h2><span id="summary-source" class="badge"></span></div>
        <p id="summary-overview"></p>
        <p id="summary-notice" class="summary-notice" hidden></p>
        <div id="summary-highlights"></div><div id="summary-decisions"></div><div id="summary-actions"></div>
        <div id="summary-choice" class="summary-choice" hidden>
          <h3>더 자세한 요약이 필요하신가요?</h3>
          <p>OpenAI로 핵심 내용·결정사항·할 일을 정리합니다. 선택하면 대화 텍스트가 전송되며 API 사용 요금이 발생합니다.</p>
          <div class="controls">
            <button id="improve-summary">네, 추가 요약하기</button>
            <button id="keep-summary" class="secondary">아니요, 이 요약으로 충분해요</button>
          </div>
        </div>
        <div class="controls">
          <button id="save-session">대화 저장</button>
          <button id="export-session" class="secondary">텍스트 내보내기</button>
          <button id="copy-summary" class="secondary">요약 복사</button>
          <button id="copy-transcript" class="secondary">대화 복사</button>
        </div>
        <p class="summary-help">기본 요약은 영어 원문의 핵심 문장을 추립니다. 추가 요약 API 비용은 없습니다.</p>
        <p id="summary-status" role="status" aria-live="polite"></p>
        <div id="copy-fallback" hidden><label for="copy-text">수동 복사용 텍스트</label><textarea id="copy-text" readonly></textarea></div>
        <details id="full-transcript"><summary>요약에 사용한 대화 원문</summary><textarea id="session-text" readonly aria-label="대화 원문"></textarea></details>
      </section>
      <section><h2>최근 대화</h2><div class="transcript" aria-live="polite"><span id="final"></span><span id="interim"></span></div></section>
      <section id="history" class="history" aria-labelledby="history-title">
        <div class="summary-heading"><h2 id="history-title">최근 대화 기록</h2><button id="delete-all" class="secondary">전체 삭제</button></div>
        <p>최대 30개 · 임시 기록도 보관됩니다. 중요한 대화는 저장하거나 파일로 내보내세요.</p>
        <div id="history-list"></div>
      </section>
      <section id="export-panel" class="history" hidden>
        <h2>대화 텍스트 내보내기</h2>
        <p>파일 저장·공유를 선택하거나 아래 텍스트를 복사하세요.</p>
        <textarea id="export-text" readonly aria-label="내보낼 대화 텍스트"></textarea>
        <div class="controls"><button id="download-export">파일 저장·공유</button>
          <button id="close-export" class="secondary">닫기</button></div>
      </section>
      <footer>안경 한 번 터치: 시작/일시정지 · 두 번 터치: 앱 종료 확인<br>
        대화 요약을 보려면 앱을 닫기 전에 휴대폰의 '대화 종료'를 누르세요.<br>
        음성 인식은 Soniox 사용량 요금이 발생합니다. 기본 요약에는 추가 API 요금이 없습니다.<br>
        대화 텍스트와 요약은 기기에 저장됩니다. 앱 삭제·데이터 초기화에 대비해 중요한 대화는 내보내세요.<br>
        필터는 저주파 잡음을 줄입니다. 주변 말소리 분리·억양 인식 정확도는 보장하지 않습니다.</footer>
    </main>`
  statusEl = document.querySelector('#status')!
  finalEl = document.querySelector('#final')!
  interimEl = document.querySelector('#interim')!
  captionEl = document.querySelector('#caption')!
  toggleEl = document.querySelector('#toggle')!
  finishEl = document.querySelector('#finish')!
  clearEl = document.querySelector('#clear')!
  demoEl = document.querySelector('#demo')!
  levelEl = document.querySelector('#level')!
  summaryEl = document.querySelector('#summary')!
  summaryStatusEl = document.querySelector('#summary-status')!
  improveEl = document.querySelector('#improve-summary')!
  document.querySelector<HTMLButtonElement>('#apply-limits')!.onclick = () => {
    const session = document.querySelector<HTMLInputElement>('#session-limit')!
    const daily = document.querySelector<HTMLInputElement>('#daily-limit')!
    if (!session.reportValidity() || !daily.reportValidity()) return
    actions.configureUsage({ sessionMinutes: Number(session.value), dailyMinutes: Number(daily.value) })
  }
  toggleEl.onclick = actions.toggle
  finishEl.onclick = actions.finish
  clearEl.onclick = () => { if (window.confirm('현재 대화와 저장된 해당 기록을 삭제할까요?')) actions.clear() }
  document.querySelector<HTMLButtonElement>('#save-session')!.onclick = actions.save
  document.querySelector<HTMLButtonElement>('#export-session')!.onclick = () => actions.export()
  document.querySelector<HTMLButtonElement>('#delete-all')!.onclick = () => {
    if (window.confirm('임시 기록과 저장된 대화를 모두 삭제할까요? 삭제하면 복구할 수 없습니다.')) actions.removeAll()
  }
  document.querySelector<HTMLButtonElement>('#close-export')!.onclick = () => {
    document.querySelector<HTMLElement>('#export-panel')!.hidden = true
    document.querySelector<HTMLTextAreaElement>('#export-text')!.value = ''
    exportText = ''
  }
  document.querySelector<HTMLButtonElement>('#download-export')!.onclick = () => {
    void downloadExport().catch(() => setStorageStatus('파일로 내보내지 못했습니다. 내보내기 텍스트를 직접 복사하세요.'))
  }
  demoEl.onclick = actions.demo
  improveEl.onclick = actions.improveSummary
  document.querySelector<HTMLButtonElement>('#keep-summary')!.onclick = () => {
    document.querySelector<HTMLElement>('#summary-choice')!.hidden = true
    summaryStatusEl.textContent = '기본 요약을 유지합니다.'
  }
  document.querySelector<HTMLButtonElement>('#copy-summary')!.onclick = () => { void copyText(summaryCopy) }
  document.querySelector<HTMLButtonElement>('#copy-transcript')!.onclick = () => { void copyText(originalText) }
  if (new URLSearchParams(location.search).get('view') === 'glasses') {
    document.body.classList.add('glasses-preview')
    const note = document.createElement('p')
    note.className = 'glasses-preview-note'
    note.textContent = 'G2 표시 내용 미리보기 · 576 × 288 · 글꼴·밝기는 실기기와 다를 수 있습니다.'
    document.querySelector('.panel')!.prepend(note)
    const link = document.createElement('a')
    link.href = '/'
    link.textContent = '휴대폰 화면으로 돌아가기'
    note.append(document.createElement('br'), link)
    // Run after main.ts has completed initialization; this demo never opens an STT connection.
    setTimeout(actions.demo, 0)
  }

}
export function setStatus(kind: Status, text: string) {
  statusEl.className = 'status status-' + kind
  statusEl.textContent = text
}
export function setControls(ready: boolean, active: boolean, busy = false, canEnd = false, ending = false) {
  toggleEl.disabled = !ready || busy
  toggleEl.textContent = ending ? '종료 중…' : busy ? '연결 중…' : active ? '일시정지' : !summaryEl.hidden ? '새 대화 시작' : '시작'
  finishEl.disabled = !canEnd || ending
  finishEl.textContent = ending ? '마지막 자막 정리 중…' : '대화 종료'
  demoEl.disabled = active || busy
  clearEl.disabled = busy || active
}
export function setTranscript(finalText: string, interimText: string) {
  finalEl.textContent = finalText
  interimEl.textContent = interimText
  finalEl.parentElement!.scrollTop = finalEl.parentElement!.scrollHeight
}
export function setCaption(text: string) { captionEl.textContent = text }
export function setLevel(level: number) { levelEl.value = level }
export function filterEnabled() { return document.querySelector<HTMLInputElement>('#filter')!.checked }

function renderList(selector: string, heading: string, items: string[]) {
  const target = document.querySelector<HTMLElement>(selector)!
  target.replaceChildren()
  if (!items.length) return
  const title = document.createElement('h3')
  title.textContent = heading
  const list = document.createElement('ul')
  for (const item of items) {
    const li = document.createElement('li')
    li.textContent = item
    list.append(li)
  }
  target.append(title, list)
}
export function setSummary(summary: ConversationSummary | null, transcript = '', notice = '') {
  const newlyFinished = summaryEl.hidden && summary !== null
  summaryEl.hidden = summary === null
  document.body.classList.toggle('conversation-finished', summary !== null)
  document.querySelector<HTMLElement>('#summary-choice')!.hidden = !summary || summary.source !== 'local' || !transcript
  toggleEl.textContent = summary ? '새 대화 시작' : '시작'
  originalText = transcript
  document.querySelector<HTMLElement>('#copy-fallback')!.hidden = true
  summaryCopy = ''
  if (!summary) {
    document.querySelector<HTMLTextAreaElement>('#session-text')!.value = ''
    document.querySelector<HTMLTextAreaElement>('#export-text')!.value = ''
    document.querySelector<HTMLElement>('#export-panel')!.hidden = true
    exportText = ''
    for (const selector of ['#summary-overview', '#summary-notice', '#summary-highlights', '#summary-decisions', '#summary-actions']) {
      document.querySelector(selector)!.replaceChildren()
    }
    return
  }
  document.querySelector('#summary-source')!.textContent = summary.source === 'local' ? '무료 · 기기 내 문장 추출' : 'OpenAI · 한국어 AI 요약'
  document.querySelector('#summary-overview')!.textContent = summary.overview
  const warning = document.querySelector<HTMLElement>('#summary-notice')!
  warning.hidden = !notice
  warning.textContent = notice
  renderList('#summary-highlights', '핵심 내용', summary.highlights)
  renderList('#summary-decisions', '결정사항', summary.decisions)
  renderList('#summary-actions', '다음 할 일', summary.actions)
  document.querySelector<HTMLTextAreaElement>('#session-text')!.value = transcript
  improveEl.disabled = !transcript
  if (newlyFinished && !document.body.classList.contains('glasses-preview')) {
    summaryEl.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }
  summaryCopy = [summary.overview, ...summary.highlights, ...summary.decisions.map(value => '결정: ' + value),
    ...summary.actions.map(value => '할 일: ' + value), notice].filter(Boolean).join('\n')
}
export function setSummaryStatus(message: string, busy = false) {
  summaryStatusEl.textContent = message
  improveEl.disabled = busy || !originalText
  document.querySelector<HTMLButtonElement>('#keep-summary')!.disabled = busy
  improveEl.textContent = busy ? '추가 요약 중…' : '네, 추가 요약하기'
}
async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text)
    summaryStatusEl.textContent = '복사했습니다.'
  } catch {
    // LAN HTTP/WebViews may not expose the clipboard. Keep a selectable fallback.
    document.querySelector<HTMLElement>('#copy-fallback')!.hidden = false
    const area = document.querySelector<HTMLTextAreaElement>('#copy-text')!
    area.value = text
    area.focus()
    area.select()
    summaryStatusEl.textContent = '자동 복사를 지원하지 않습니다. 선택된 텍스트를 길게 눌러 복사하세요.'
  }
}

export function setStorageStatus(text: string) {
  document.querySelector<HTMLElement>('#storage-status')!.textContent = text
}
export function setSessionSaved(saved: boolean | null) {
  const save = document.querySelector<HTMLButtonElement>('#save-session')!
  save.disabled = saved === null
  save.textContent = saved ? '저장됨' : '대화 저장'
  document.querySelector<HTMLButtonElement>('#export-session')!.disabled = saved === null
}
export function setHistory(entries: SessionEntry[], recoveryId: string | undefined, currentId: string | undefined, locked: boolean) {
  const recovery = entries.find(entry => entry.id === recoveryId)
  document.querySelector<HTMLElement>('#recovery')!.hidden = !recovery
  const banner = document.querySelector<HTMLElement>('#recovery-text')!
  banner.textContent = recovery ? '이전 대화 기록이 있습니다. ' + recovery.title : ''
  const target = document.querySelector<HTMLElement>('#history-list')!
  target.replaceChildren()
  if (!entries.length) target.textContent = '아직 저장된 대화가 없습니다.'
  for (const entry of entries) {
    const row = document.createElement('article')
    row.className = 'history-row'
    const title = document.createElement('h3')
    title.textContent = entry.title
    const meta = document.createElement('p')
    meta.textContent = new Date(entry.createdAt).toLocaleString('ko-KR') + ' · ' +
      (entry.saved ? '저장됨' : '임시 기록') + ' · ' + (entry.ended ? '종료' : '미종료') + ' · 인식 ' + formatDuration(entry.recognitionMs ?? 0) +
      (entry.id === currentId ? ' · 현재 대화' : '')
    const controls = document.createElement('div')
    controls.className = 'controls'
    const add = (label: string, action: () => void) => {
      const button = document.createElement('button')
      button.className = 'secondary'
      button.textContent = label
      button.disabled = locked
      button.onclick = action
      controls.append(button)
    }
    if (!entry.ended) add('이어가기', () => historyActions.open(entry.id, 'resume'))
    add('요약 보기', () => historyActions.open(entry.id, 'summary'))
    add('내보내기', () => historyActions.export(entry.id))
    add('삭제', () => { if (window.confirm('이 대화 기록을 삭제할까요? 삭제하면 복구할 수 없습니다.')) historyActions.remove(entry.id) })
    row.append(title, meta, controls)
    target.append(row)
  }
  const resume = document.querySelector<HTMLButtonElement>('#recover-resume')!
  resume.hidden = Boolean(recovery?.ended)
  resume.disabled = locked
  resume.onclick = () => { if (recoveryId) historyActions.open(recoveryId, 'resume') }
  const review = document.querySelector<HTMLButtonElement>('#recover-summary')!
  review.disabled = locked
  review.onclick = () => { if (recoveryId) historyActions.open(recoveryId, 'summary') }
  const discard = document.querySelector<HTMLButtonElement>('#recover-delete')!
  discard.disabled = locked
  discard.onclick = () => {
    if (recoveryId && window.confirm('이전 임시 대화를 삭제할까요?')) historyActions.remove(recoveryId)
  }
  document.querySelector<HTMLButtonElement>('#delete-all')!.disabled = locked || !entries.length
  document.querySelector<HTMLButtonElement>('#save-session')!.disabled = locked || !currentId
  document.querySelector<HTMLButtonElement>('#export-session')!.disabled = locked || !currentId
}
export function showExport(text: string, filename: string) {
  exportText = text; exportFilename = filename
  const panel = document.querySelector<HTMLElement>('#export-panel')!
  panel.hidden = false
  document.querySelector<HTMLTextAreaElement>('#export-text')!.value = text
  panel.scrollIntoView({ behavior: 'smooth', block: 'start' })
}
async function downloadExport() {
  const file = new File([exportText], exportFilename, { type: 'text/plain;charset=utf-8' })
  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file] }); return }
    catch (error) { if (error instanceof Error && error.name === 'AbortError') return }
  }
  const url = URL.createObjectURL(file)
  try {
    const link = document.createElement('a')
    link.href = url; link.download = exportFilename
    document.body.append(link); link.click(); link.remove()
    setStorageStatus('파일 저장이 지원되지 않으면 아래 내보내기 텍스트를 선택해 복사하세요.')
  } finally { setTimeout(() => URL.revokeObjectURL(url), 1000) }
}

let displayedUsageSettings = ''
export function setUsage(view: UsageView, locked: boolean) {
  document.querySelector('#recognition-time')!.textContent = formatDuration(view.sessionMs)
  document.querySelector('#daily-usage')!.textContent = formatDuration(view.dailyMs) + ' / ' + formatDuration(view.settings.dailyMinutes * 60000)
  document.querySelector('#time-remaining')!.textContent = formatDuration(view.remainingMs)
  const warning = document.querySelector<HTMLElement>('#usage-warning')!
  warning.hidden = !view.reason && !(view.running && view.remainingMs <= 60000)
  warning.textContent = view.reason === 'daily' ? '오늘 사용 한도에 도달했습니다.'
    : view.reason === 'session' ? '이 대화의 자동 종료 시간에 도달했습니다.'
    : '1분 이내에 자동 종료됩니다.'
  const session = document.querySelector<HTMLInputElement>('#session-limit')!
  const daily = document.querySelector<HTMLInputElement>('#daily-limit')!
  const key = JSON.stringify(view.settings)
  if (key !== displayedUsageSettings) {
    session.value = String(view.settings.sessionMinutes)
    daily.value = String(view.settings.dailyMinutes)
    displayedUsageSettings = key
  }
  session.disabled = locked; daily.disabled = locked
  document.querySelector<HTMLButtonElement>('#apply-limits')!.disabled = locked || !view.ready
}
export function setUsageStatus(text: string) {
  document.querySelector('#usage-status')!.textContent = text
}
