import type { StoragePort } from '../history/store.ts'

export interface UsageSettings { sessionMinutes: number; dailyMinutes: number }
export interface UsageView {
  sessionMs: number; dailyMs: number; remainingMs: number
  settings: UsageSettings; running: boolean; ready: boolean
  reason: 'session' | 'daily' | null
}
export const USAGE_KEY = 'english-stt.usage.v1'
const defaults: UsageSettings = { sessionMinutes: 30, dailyMinutes: 60 }
export function localDay(time: number): string {
  const d = new Date(time)
  return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')].join('-')
}
export function validSettings(value: unknown): value is UsageSettings {
  if (!value || typeof value !== 'object') return false
  const s = value as UsageSettings
  return Number.isInteger(s.sessionMinutes) && s.sessionMinutes >= 1 && s.sessionMinutes <= 60
    && Number.isInteger(s.dailyMinutes) && s.dailyMinutes >= 1 && s.dailyMinutes <= 1440
}
export function formatDuration(ms: number): string {
  const seconds = Math.floor(Math.max(0, ms) / 1000)
  return String(Math.floor(seconds / 60)).padStart(2, '0') + ':' + String(seconds % 60).padStart(2, '0')
}

// Counts accepted STT connection time, including silence. This is a local estimate, not a bill.
export class UsageMeter {
  private settings: UsageSettings = { ...defaults }
  private day: string
  private dailyMs = 0
  private sessionMs = 0
  private running = false
  private ready = false
  private last = 0
  private wall = 0
  private port: StoragePort | undefined
  private queue: Promise<unknown> = Promise.resolve()
  private monotonic: () => number
  private clock: () => number
  constructor(monotonic = () => performance.now(), clock = () => Date.now()) {
    this.monotonic = monotonic; this.clock = clock; this.day = localDay(clock())
  }
  async load(port: StoragePort) {
    this.ready = false
    this.port = port
    const text = await port.get(USAGE_KEY)
    if (text) {
      const data = JSON.parse(text)
      if (data?.version !== 1 || !validSettings(data.settings) || !/^\d{4}-\d{2}-\d{2}$/.test(data.day)
        || typeof data.dailyMs !== 'number' || !Number.isFinite(data.dailyMs) || data.dailyMs < 0 || data.dailyMs > 172800000) {
        throw new Error('사용 시간 기록을 읽지 못했습니다. 기록 확인 전에는 음성 인식을 시작하지 않습니다.')
      }
      this.settings = { ...data.settings }; this.day = data.day; this.dailyMs = data.dailyMs
    } else {
      this.settings = { ...defaults }; this.day = localDay(this.clock()); this.dailyMs = 0
    }
    this.ready = true
    this.tick()
  }
  tick(): UsageView {
    const now = this.monotonic(), wall = this.clock()
    const delta = this.running ? Math.max(0, now - this.last) : 0
    this.sessionMs += delta
    const day = localDay(wall)
    if (day > this.day) {
      const midnight = new Date(wall); midnight.setHours(0, 0, 0, 0)
      const fraction = wall > this.wall ? Math.min(1, Math.max(0, (wall - midnight.getTime()) / (wall - this.wall))) : 0
      this.dailyMs = this.running ? delta * fraction : 0
      this.day = day
    } else this.dailyMs += delta
    this.last = now; this.wall = wall
    const remainingMs = Math.max(0, Math.min(this.settings.sessionMinutes * 60000 - this.sessionMs, this.settings.dailyMinutes * 60000 - this.dailyMs))
    const reason = this.dailyMs >= this.settings.dailyMinutes * 60000 ? 'daily'
      : this.sessionMs >= this.settings.sessionMinutes * 60000 ? 'session' : null
    return { sessionMs: this.sessionMs, dailyMs: this.dailyMs, remainingMs, settings: { ...this.settings }, running: this.running, ready: this.ready, reason }
  }
  start() {
    const view = this.tick()
    if (!this.ready) throw new Error('사용 시간 저장소가 준비되지 않았습니다.')
    if (view.reason) throw new Error(view.reason === 'daily' ? '오늘 사용 한도에 도달했습니다. 다음 날 또는 한도 변경 후 시작하세요.' : '이 대화의 자동 종료 시간에 도달했습니다. 대화를 종료한 뒤 새 대화를 시작하세요.')
    this.running = true
    this.last = this.monotonic(); this.wall = this.clock()
  }
  stop(): UsageView { const view = this.tick(); this.running = false; return { ...view, running: false } }
  restoreSession(ms = 0) {
    if (this.running) throw new Error('인식 중에는 사용 시간을 초기화할 수 없습니다.')
    this.sessionMs = Number.isFinite(ms) ? Math.max(0, ms) : 0
  }
  async save() {
    this.tick()
    const port = this.port
    if (!this.ready || !port) throw new Error('사용 시간 저장소를 사용할 수 없습니다.')
    const text = JSON.stringify({ version: 1, settings: this.settings, day: this.day, dailyMs: this.dailyMs })
    const pending = this.queue.then(async () => {
      if (!await port.set(USAGE_KEY, text)) throw new Error('사용 시간을 저장하지 못했습니다. 안전을 위해 음성 인식을 중지합니다.')
    })
    this.queue = pending.catch(() => {})
    await pending
  }
  async configure(settings: UsageSettings) {
    if (this.running) throw new Error('인식을 멈춘 뒤 사용 한도를 변경하세요.')
    if (!validSettings(settings)) throw new Error('자동 종료는 1~60분, 하루 한도는 1~1440분 사이의 정수로 입력하세요.')
    const previous = this.settings
    this.settings = { ...settings }
    try { await this.save() } catch (error) { this.settings = previous; throw error }
  }
}
