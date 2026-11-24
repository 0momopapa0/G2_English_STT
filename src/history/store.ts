import { isSummary, type ConversationSummary } from '../summary/summary.ts'

export interface StoragePort {
  get(key: string): Promise<string>
  set(key: string, value: string): Promise<boolean>
}
export interface SessionRecord {
  recognitionMs?: number
  id: string
  createdAt: number
  updatedAt: number
  transcript: string
  truncated: boolean
  ended: boolean
  saved: boolean
  summary: ConversationSummary | null
  notice: string
}
export interface SessionEntry {
  recognitionMs?: number
  id: string
  createdAt: number
  updatedAt: number
  title: string
  ended: boolean
  saved: boolean
  revision: string
  chunks: number
}
const PREFIX = 'english-stt.history.v1.'
const INDEX = PREFIX + 'index'
const CHUNK = 40000
export const MAX_RECORDS = 30
const validId = (id: unknown): id is string => typeof id === 'string' && /^[a-zA-Z0-9-]{1,80}$/.test(id)
const validDate = (date: unknown): date is number => typeof date === 'number' && Number.isFinite(date) && date > 0
function validRecord(value: unknown): value is SessionRecord {
  if (!value || typeof value !== 'object') return false
  const r = value as SessionRecord
  return validId(r.id) && validDate(r.createdAt) && validDate(r.updatedAt)
    && typeof r.transcript === 'string' && r.transcript.length <= 100000
    && ['truncated', 'ended', 'saved'].every(key => typeof (r as unknown as Record<string, unknown>)[key] === 'boolean')
    && (r.recognitionMs === undefined || (Number.isFinite(r.recognitionMs) && r.recognitionMs >= 0))
    && typeof r.notice === 'string' && r.notice.length <= 4000
    && (r.summary === null || (isSummary(r.summary) && ['local', 'openai'].includes(r.summary.source)))
}
function validEntry(value: unknown): value is SessionEntry {
  if (!value || typeof value !== 'object') return false
  const e = value as SessionEntry
  return validId(e.id) && validId(e.revision) && validDate(e.createdAt) && validDate(e.updatedAt)
    && typeof e.title === 'string' && e.title.length <= 100
    && typeof e.ended === 'boolean' && typeof e.saved === 'boolean'
    && Number.isInteger(e.chunks) && e.chunks > 0 && e.chunks <= 10
}
export function newSessionId(): string { return crypto.randomUUID() }
export function exportSession(record: SessionRecord): string {
  const summary = record.summary
  return [
    'English STT', '인식 시간(초): ' + Math.floor((record.recognitionMs ?? 0) / 1000), '시작: ' + new Date(record.createdAt).toISOString(),
    '상태: ' + (record.ended ? '종료' : '미종료 · 확정된 자막만 포함'),
    record.truncated ? '기록 한도를 넘어 최근 100,000자만 포함합니다.' : '',
    '\n대화 원문\n' + record.transcript,
    summary ? '\n요약 (' + (summary.source === 'openai' ? 'OpenAI' : '무료 문장 추출') + ')\n' +
      [summary.overview, ...summary.highlights, ...summary.decisions.map(x => '결정: ' + x),
        ...summary.actions.map(x => '할 일: ' + x)].join('\n') : '',
    record.notice,
  ].filter(Boolean).join('\n')
}

// Publish an immutable record revision through a small index only after all chunks succeed.
// Failed writes leave the previous revision readable. No automatic eviction of saved conversations.
export class HistoryStore {
  private entries: SessionEntry[] = []
  private loaded = false
  private queue: Promise<unknown> = Promise.resolve()
  private port: StoragePort
  constructor(port: StoragePort) { this.port = port }
  private enqueue<T>(action: () => Promise<T>): Promise<T> {
    const pending = this.queue.then(action)
    this.queue = pending.catch(() => {})
    return pending
  }
  list(): SessionEntry[] { return this.entries.map(e => ({ ...e })).sort((a, b) => b.updatedAt - a.updatedAt) }
  load(): Promise<void> {
    return this.enqueue(async () => {
      const text = await this.port.get(INDEX)
      const data = text ? JSON.parse(text) : { version: 1, entries: [] }
      if (data?.version !== 1 || !Array.isArray(data.entries) || data.entries.length > MAX_RECORDS
        || !data.entries.every(validEntry) || new Set(data.entries.map((e: SessionEntry) => e.id)).size !== data.entries.length) {
        throw new Error('저장된 대화 목록을 읽지 못했습니다. 기존 기록을 덮어쓰지 않았습니다.')
      }
      this.entries = data.entries
      this.loaded = true
    })
  }
  private ensureLoaded() { if (!this.loaded) throw new Error('대화 저장소가 준비되지 않았습니다.') }
  private key(e: SessionEntry, index: number) { return PREFIX + e.id + '.' + e.revision + '.' + index }
  private async clean(entry: SessionEntry) {
    for (let i = 0; i < entry.chunks; i++) {
      try { await this.port.set(this.key(entry, i), '') } catch { /* Unreferenced data; never delete a current revision. */ }
    }
  }
  read(id: string): Promise<SessionRecord> {
    return this.enqueue(async () => {
      this.ensureLoaded()
      const entry = this.entries.find(e => e.id === id)
      if (!entry) throw new Error('대화 기록을 찾지 못했습니다.')
      let text = ''
      for (let i = 0; i < entry.chunks; i++) text += await this.port.get(this.key(entry, i))
      let record: unknown
      try { record = JSON.parse(text) } catch { throw new Error('대화 기록이 손상되어 열 수 없습니다. 다른 기록은 유지됩니다.') }
      if (!validRecord(record) || record.id !== id) throw new Error('대화 기록 형식을 확인하지 못했습니다.')
      return record
    })
  }
  write(record: SessionRecord): Promise<void> {
    const snapshot: SessionRecord = structuredClone(record)
    return this.enqueue(async () => {
      this.ensureLoaded()
      if (!validRecord(snapshot)) throw new Error('저장할 대화 형식을 확인하지 못했습니다.')
      const old = this.entries.find(e => e.id === snapshot.id)
      if (!old && this.entries.length >= MAX_RECORDS) throw new Error('대화는 최대 30개까지 보관합니다. 내보내기 후 불필요한 기록을 삭제하세요.')
      snapshot.saved = snapshot.saved || Boolean(old?.saved)
      const text = JSON.stringify(snapshot)
      if (text.length > 400000) throw new Error('저장할 대화가 너무 큽니다. 텍스트로 내보내세요.')
      const entry: SessionEntry = {
        id: snapshot.id, createdAt: snapshot.createdAt, updatedAt: snapshot.updatedAt,
        title: snapshot.transcript.replace(/\s+/g, ' ').slice(0, 80) || '빈 대화',
        ended: snapshot.ended, saved: snapshot.saved, recognitionMs: snapshot.recognitionMs ?? 0,
        revision: newSessionId(), chunks: Math.ceil(text.length / CHUNK),
      }
      for (let i = 0; i < entry.chunks; i++) {
        if (!await this.port.set(this.key(entry, i), text.slice(i * CHUNK, (i + 1) * CHUNK))) throw new Error('대화를 저장하지 못했습니다. 저장 공간과 앱 상태를 확인하세요.')
      }
      const next = this.entries.filter(e => e.id !== snapshot.id).concat(entry)
      if (!await this.port.set(INDEX, JSON.stringify({ version: 1, entries: next }))) throw new Error('대화 목록을 저장하지 못했습니다.')
      this.entries = next
      if (old) await this.clean(old)
    })
  }
  remove(id: string): Promise<void> {
    return this.enqueue(async () => {
      this.ensureLoaded()
      const old = this.entries.find(e => e.id === id)
      if (!old) return
      const next = this.entries.filter(e => e.id !== id)
      if (!await this.port.set(INDEX, JSON.stringify({ version: 1, entries: next }))) throw new Error('대화를 삭제하지 못했습니다.')
      this.entries = next
      await this.clean(old)
    })
  }
  clear(): Promise<void> {
    return this.enqueue(async () => {
      this.ensureLoaded()
      const old = this.entries
      if (!await this.port.set(INDEX, JSON.stringify({ version: 1, entries: [] }))) throw new Error('대화 목록을 삭제하지 못했습니다.')
      this.entries = []
      for (const entry of old) await this.clean(entry)
    })
  }
}
