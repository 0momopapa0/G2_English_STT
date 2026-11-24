export interface SttSnapshot { finalText: string; interimText: string; finalDelta?: string }

export function tailAtWord(text: string, limit: number): string {
  if (text.length <= limit) return text
  const start = text.length - limit
  const tail = text.slice(start)
  if (/\s/.test(text[start - 1])) return tail
  const space = tail.indexOf(' ')
  return space >= 0 ? tail.slice(space + 1) : tail
}

interface SonioxToken { text: string; is_final: boolean; translation_status?: string }

export class Transcript {
  private finalText = ''
  private interimText = ''
  private finalDelta = ''
  accept(message: { tokens?: SonioxToken[] }): SttSnapshot | null {
    if (!Array.isArray(message.tokens)) return null
    let interim = ''
    this.finalDelta = ''
    for (const token of message.tokens) {
      if (typeof token?.text !== 'string' || typeof token.is_final !== 'boolean') throw new Error('Invalid Soniox token')
      if (token.translation_status === 'translation') continue
      // Control tokens are not words. Never render <end>/<fin> on the lenses.
      if (/^<[^>]+>$/.test(token.text)) {
        if (token.is_final && token.text === '<end>' && this.finalText && !/\s$/.test(this.finalText)) { this.finalText += '\n'; this.finalDelta += '\n' }
        continue
      }
      // Final tokens arrive once; spaces and punctuation are tokens too.
      // Do not insert spaces between subwords or deduplicate repeated spoken words.
      if (token.is_final) { this.finalText = tailAtWord(this.finalText + token.text, 4000); this.finalDelta += token.text }
      else interim += token.text
    }
    this.finalText = tailAtWord(this.finalText, 4000)
    this.interimText = tailAtWord(interim, 4000)
    return this.snapshot()
  }
  snapshot(): SttSnapshot { return { finalText: this.finalText, interimText: this.interimText } }
  takeFinalDelta() { const delta = this.finalDelta; this.finalDelta = ''; return delta }
  clear() { this.finalText = ''; this.interimText = ''; this.finalDelta = '' }
}
