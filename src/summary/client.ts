import { isSummary, type ConversationSummary } from './summary.ts'

export async function requestOpenAiSummary(transcript: string, signal: AbortSignal): Promise<ConversationSummary> {
  const endpoint = import.meta.env?.VITE_SUMMARY_URL || '/api/summary'
  const response = await fetch(endpoint, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ transcript }),
    signal: AbortSignal.any([signal, AbortSignal.timeout(45000)]),
  })
  let body
  try { body = await response.json() }
  catch { throw new Error('요약 서버 응답을 확인하지 못했습니다. 서버 주소와 실행 상태를 확인하세요.') }
  if (!response.ok) throw new Error(typeof body?.error === 'string' ? body.error : 'OpenAI 요약 요청에 실패했습니다.')
  if (!isSummary(body?.summary)) throw new Error('OpenAI 요약 결과 형식이 올바르지 않습니다.')
  return { ...body.summary, source: 'openai' }
}
