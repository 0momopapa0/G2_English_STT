export interface SttSnapshot { finalText: string; interimText: string }

export function tailAtWord(text: string, limit: number): string {
  if (text.length <= limit) return text
  const start = text.length - limit
  const tail = text.slice(start)
  if (/\s/.test(text[start - 1])) return tail
  const space = tail.indexOf(' ')
  return space >= 0 ? tail.slice(space + 1) : tail
}

export class Transcript {
  private finalText = ''
  private interimText = ''
  private lastFinalEnd = -1
  accept(message: { type?: string; start?: number; duration?: number; is_final?: boolean;
    channel?: { alternatives?: { transcript?: string }[] } }): SttSnapshot | null {
    if (message.type !== 'Results') return null
    const text = message.channel?.alternatives?.[0]?.transcript?.trim() ?? ''
    const end = (message.start ?? 0) + (message.duration ?? 0)
    if (message.is_final) {
      if (end <= this.lastFinalEnd) return null
      this.lastFinalEnd = end
      if (text) this.finalText = tailAtWord(`${this.finalText} ${text}`.trim(), 4000)
      this.interimText = ''
    } else {
      if (end <= this.lastFinalEnd) return null
      this.interimText = text
    }
    return this.snapshot()
  }
  snapshot(): SttSnapshot { return { finalText: this.finalText, interimText: this.interimText } }
  clear() { this.finalText = ''; this.interimText = '' }
}
