export interface ConversationSummary {
  source: 'local' | 'openai'
  overview: string
  highlights: string[]
  decisions: string[]
  actions: string[]
  lensText: string
}

export const summarySchema = {
  type: 'object',
  properties: {
    overview: { type: 'string' },
    highlights: { type: 'array', items: { type: 'string' } },
    decisions: { type: 'array', items: { type: 'string' } },
    actions: { type: 'array', items: { type: 'string' } },
    lensText: { type: 'string' },
  },
  required: ['overview', 'highlights', 'decisions', 'actions', 'lensText'],
  additionalProperties: false,
}

export function isSummary(value: unknown): value is Omit<ConversationSummary, 'source'> {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return ['overview', 'lensText'].every(key => typeof record[key] === 'string' && (record[key] as string).length <= 4000)
    && ['highlights', 'decisions', 'actions'].every(key => Array.isArray(record[key])
      && record[key].length <= 10 && record[key].every((item: unknown) => typeof item === 'string' && item.length <= 2000))
}

const STOP = new Set('a an the and or but if to of in on at for from by with is are was were be been being i you he she it we they my your our their this that these those as do does did have has had can could would should will just so not no yes okay ok please thank thanks very about'.split(' '))
function words(text: string): string[] {
  return (text.toLowerCase().match(/[a-z][a-z'-]+/g) ?? []).filter(word => word.length > 2 && !STOP.has(word))
}

// Extract source sentences only. No generated facts, translation or network request.
export function summarizeLocally(text: string): ConversationSummary {
  const segmenter = new Intl.Segmenter('en', { granularity: 'sentence' })
  const sentences = text.split(/\n+/).flatMap(line => [...segmenter.segment(line)].map(item => item.segment.trim()))
    .filter(Boolean)
  const candidates = sentences.map((sentence, index) => ({ sentence, index, terms: new Set(words(sentence)) }))
  const frequency = new Map<string, number>()
  for (const { terms } of candidates) for (const word of terms) frequency.set(word, (frequency.get(word) ?? 0) + 1)
  const ranked = candidates.map(item => ({
    ...item,
    score: [...item.terms].reduce((sum, word) => sum + Math.log1p(frequency.get(word) ?? 0), 0)
      / Math.sqrt(Math.max(1, item.terms.size))
      + (/\b(agree|agreed|decided|deadline|schedule|meeting|send|confirm|need|must|tomorrow|next)\b|\d/i.test(item.sentence) ? 1.5 : 0),
  })).sort((a, b) => b.score - a.score || a.index - b.index)
  const selected: typeof ranked = []
  for (const item of ranked) {
    if (selected.some(other => {
      if (other.sentence.toLowerCase() === item.sentence.toLowerCase()) return true
      const intersection = [...item.terms].filter(word => other.terms.has(word)).length
      const union = new Set([...item.terms, ...other.terms]).size
      return union > 0 && intersection / union > 0.8
    })) continue
    selected.push(item)
    if (selected.length === 5) break
  }
  const highlights = selected.sort((a, b) => a.index - b.index).map(item =>
    item.sentence.length > 1000 ? item.sentence.slice(0, 997) + '…' : item.sentence)
  return {
    source: 'local',
    overview: highlights.length ? '대화 원문에서 핵심 문장을 골랐습니다. 번역하거나 새로운 내용을 생성하지 않습니다.' : '요약할 확정 대화가 없습니다.',
    highlights, decisions: [], actions: [],
    lensText: highlights[0]?.slice(0, 220) ?? 'No confirmed speech to summarize.',
  }
}
