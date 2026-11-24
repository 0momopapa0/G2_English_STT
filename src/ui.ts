import './style.css'
type Status = 'connecting' | 'listening' | 'paused' | 'error'
let statusEl: HTMLElement
let finalEl: HTMLElement
let interimEl: HTMLElement
let captionEl: HTMLElement
let toggleEl: HTMLButtonElement
let demoEl: HTMLButtonElement
let levelEl: HTMLMeterElement

export function mountUi(actions: { toggle: () => void; clear: () => void; demo: () => void }) {
  document.querySelector<HTMLDivElement>('#app')!.innerHTML = `
    <main class="panel">
      <header><div class="eyebrow">EVEN G2 · LIVE CAPTIONS</div><h1>English STT</h1>
        <p>들리는 영어를, 눈앞의 영어 자막으로.</p></header>
      <div id="status" class="status status-connecting" role="status">G2 연결 대기 중…</div>
      <section class="glasses"><div class="eyebrow">G2 화면 미리보기</div>
        <div id="caption">Ready to listen.</div></section>
      <div class="controls"><button id="toggle" disabled>시작</button>
        <button id="clear" class="secondary">자막 지우기</button>
        <button id="demo" class="secondary">자막 데모</button></div>
      <label class="filter"><input id="filter" type="checkbox" checked> 저주파 소음 완화 (100 Hz)</label>
      <label class="level">마이크 입력 <meter id="level" min="0" max="1" value="0"></meter></label>
      <section><h2>최근 대화</h2><div class="transcript" aria-live="polite"><span id="final"></span><span id="interim"></span></div></section>
      <footer>안경 한 번 터치: 시작/일시정지 · 두 번 터치: 종료<br>
        시작하면 마이크 음성이 Deepgram으로 전송됩니다. 영어 인식이며 번역은 하지 않습니다.<br>
        필터는 저주파 잡음을 줄입니다. 주변 말소리 분리·억양 인식 정확도는 보장하지 않습니다.</footer>
    </main>`
  statusEl = document.querySelector('#status')!
  finalEl = document.querySelector('#final')!
  interimEl = document.querySelector('#interim')!
  captionEl = document.querySelector('#caption')!
  toggleEl = document.querySelector('#toggle')!
  demoEl = document.querySelector('#demo')!
  levelEl = document.querySelector('#level')!
  toggleEl.onclick = actions.toggle
  document.querySelector<HTMLButtonElement>('#clear')!.onclick = actions.clear
  demoEl.onclick = actions.demo
}
export function setStatus(kind: Status, text: string) {
  statusEl.className = `status status-${kind}`
  statusEl.textContent = text
}
export function setControls(ready: boolean, active: boolean, busy = false) {
  toggleEl.disabled = !ready || busy
  toggleEl.textContent = busy ? '연결 중…' : active ? '일시정지' : '시작'
  demoEl.disabled = active || busy
}
export function setTranscript(finalText: string, interimText: string) {
  finalEl.textContent = finalText
  interimEl.textContent = interimText ? ` ${interimText}` : ''
  finalEl.parentElement!.scrollTop = finalEl.parentElement!.scrollHeight
}
export function setCaption(text: string) { captionEl.textContent = text }
export function setLevel(level: number) { levelEl.value = level }
export function filterEnabled() { return document.querySelector<HTMLInputElement>('#filter')!.checked }
