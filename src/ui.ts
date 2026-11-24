import './style.css'
import type { ConversationSummary } from './summary/summary'

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

export function mountUi(actions: { toggle: () => void; finish: () => void; improveSummary: () => void; clear: () => void; demo: () => void }) {
  document.querySelector<HTMLDivElement>('#app')!.innerHTML = `
    <main class="panel">
      <header><div class="eyebrow">EVEN G2 · LIVE CAPTIONS</div><h1>English STT</h1>
        <p>들리는 영어를, 눈앞의 영어 자막으로.</p></header>
      <div id="status" class="status status-connecting" role="status">G2 연결 대기 중…</div>
      <section class="glasses"><div class="eyebrow">G2 화면 미리보기</div>
        <div id="caption">Ready to listen.</div></section>
      <div class="controls"><button id="toggle" disabled>시작</button>
        <button id="finish" class="secondary" disabled>대화 종료</button>
        <button id="clear" class="secondary">대화 지우기</button>
        <button id="demo" class="secondary">자막 데모</button></div>
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
          <button id="copy-summary" class="secondary">요약 복사</button>
          <button id="copy-transcript" class="secondary">대화 복사</button>
        </div>
        <p class="summary-help">기본 요약은 영어 원문의 핵심 문장을 추립니다. 추가 요약 API 비용은 없습니다.</p>
        <p id="summary-status" role="status" aria-live="polite"></p>
        <div id="copy-fallback" hidden><label for="copy-text">수동 복사용 텍스트</label><textarea id="copy-text" readonly></textarea></div>
        <details id="full-transcript"><summary>요약에 사용한 대화 원문</summary><textarea id="session-text" readonly aria-label="대화 원문"></textarea></details>
      </section>
      <section><h2>최근 대화</h2><div class="transcript" aria-live="polite"><span id="final"></span><span id="interim"></span></div></section>
      <footer>안경 한 번 터치: 시작/일시정지 · 두 번 터치: 앱 종료 확인<br>
        대화 요약을 보려면 앱을 닫기 전에 휴대폰의 '대화 종료'을 누르세요.<br>
        음성 인식은 Soniox 사용량 요금이 발생합니다. 기본 요약에는 추가 API 요금이 없습니다.<br>
        대화는 현재 화면의 메모리에만 유지되며, 새 대화 시작·새로고침·앱 종료 시 사라집니다.<br>
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
  toggleEl.onclick = actions.toggle
  finishEl.onclick = actions.finish
  clearEl.onclick = actions.clear
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
  clearEl.disabled = busy
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
  if (!summary) return
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
