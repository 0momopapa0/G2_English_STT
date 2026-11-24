import { Transcript, type SttSnapshot } from './transcript.ts'

export interface SttClient {
  sendPcm(chunk: Uint8Array): void
  clear(): void
  close(finalize?: boolean): Promise<boolean>
}

function serviceError(code: number, type?: string): Error {
  if (type === 'temp_api_key_session_expired' || code === 409) return Object.assign(new Error('Soniox 세션 시간이 끝났습니다. 시작을 눌러 다시 연결하세요.'), { sessionExpired: true })
  if (code === 401 || code === 403) return new Error('Soniox 인증 또는 권한 오류. API 키와 실시간 STT 권한을 확인하세요.')
  if (code === 402) return new Error('Soniox 잔액 또는 월 사용 한도에 도달했습니다. 콘솔을 확인하세요.')
  if (code === 429) return new Error('Soniox 연결 한도에 도달했습니다. 잠시 후 다시 시작하세요.')
  return new Error('Soniox 음성 인식 오류 (' + code + '). 설정과 네트워크를 확인하고 다시 시작하세요.')
}

// Resolve only after a pong proves that Soniox accepted the configuration.
// Never queue microphone audio while opening or silently retry a billable stream.
export async function startSttStream(
  onSnapshot: (snap: SttSnapshot) => void,
  onError: (err: Error) => void,
  signal: AbortSignal,
  maxDurationSeconds?: number,
): Promise<SttClient> {
  const endpoint = import.meta.env?.VITE_STT_TOKEN_URL || '/api/stt-token'
  const tokenUrl = maxDurationSeconds === undefined ? endpoint : endpoint + (endpoint.includes('?') ? '&' : '?') + 'max_session_seconds=' + Math.max(1, Math.min(3600, Math.ceil(maxDurationSeconds)))
  const response = await fetch(tokenUrl, { method: 'POST', signal: AbortSignal.any([signal, AbortSignal.timeout(12000)]) })
  let body
  try { body = await response.json() }
  catch { throw new Error('인증 서버가 JSON을 반환하지 않았습니다. 토큰 서버 주소와 실행 상태를 확인하세요.') }
  if (!response.ok) throw new Error(typeof body?.error === 'string' ? body.error : 'Soniox 인증 실패')
  if (typeof body?.api_key !== 'string' || !/^snx_temp_[A-Za-z0-9._-]+$/.test(body.api_key)) {
    throw new Error('인증 서버가 Soniox 단기 API 키를 반환하지 않았습니다.')
  }
  signal.throwIfAborted()
  const socket = new WebSocket('wss://stt-rt.soniox.com/transcribe-websocket', ['soniox-api-key', body.api_key])
  const transcript = new Transcript()
  let intentional = false
  let failed = false
  let ready = false
  let pingId = 0
  let awaitingPong: number | undefined
  let heartbeat: ReturnType<typeof setInterval> | undefined
  let pongTimer: ReturnType<typeof setTimeout> | undefined
  let openingTimer: ReturnType<typeof setTimeout> | undefined
  let closeTimer: ReturnType<typeof setTimeout> | undefined
  let closing: Promise<boolean> | undefined
  let deliverFinal = false
  let resolveClose: (completed: boolean) => void = () => {}
  const completeClose = (completed: boolean) => {
    clearTimeout(closeTimer)
    resolveClose(completed)
    socket.close()
  }
  let rejectOpening: (error: Error) => void = () => {}
  const release = () => {
    clearInterval(heartbeat)
    clearTimeout(pongTimer)
    clearTimeout(openingTimer)
    signal.removeEventListener('abort', abort)
  }
  const fail = (error: Error) => {
    if (intentional || failed) return
    failed = true
    release()
    socket.close()
    if (ready) onError(error)
    else rejectOpening(error)
  }
  const abort = () => {
    intentional = true
    release()
    socket.close()
    rejectOpening(new DOMException('연결 취소됨', 'AbortError'))
  }
  const ping = () => {
    if (awaitingPong !== undefined || socket.readyState !== WebSocket.OPEN) return
    awaitingPong = ++pingId
    try { socket.send(JSON.stringify({ type: 'ping', id: pingId })) }
    catch { fail(new Error('Soniox 연결이 끊겼습니다. 시작을 눌러 다시 연결하세요.')); return }
    pongTimer = setTimeout(() => fail(new Error('Soniox 응답이 멈췄습니다. 네트워크를 확인하고 다시 시작하세요.')), 10000)
  }
  await new Promise<void>((resolve, reject) => {
    rejectOpening = reject
    openingTimer = setTimeout(() => fail(new Error('Soniox 연결 시간 초과. 네트워크를 확인하세요.')), 12000)
    socket.onopen = () => {
      if (signal.aborted || intentional) { abort(); return }
      try {
        socket.send(JSON.stringify({
          model: 'stt-rt-v6', audio_format: 'pcm_s16le', sample_rate: 16000, num_channels: 1,
          language_hints: ['en'], language_hints_strict: true,
          // Default semantic endpointing preserves time to revise accented speech.
          enable_endpoint_detection: true,
        }))
        ping()
      } catch { fail(new Error('Soniox 세션을 시작하지 못했습니다. 다시 연결하세요.')) }
    }
    socket.onerror = () => fail(new Error('Soniox 연결 실패. 인터넷과 API 설정을 확인하세요.'))
    socket.onclose = () => {
      release()
      clearTimeout(closeTimer)
      if (intentional) resolveClose(false)
      if (!intentional) fail(new Error('Soniox 연결이 종료됐습니다. 시작을 눌러 다시 연결하세요.'))
    }
    socket.onmessage = event => {
      // End-and-summarize drains final tokens; pause discards late captions.
      if (failed) return
      try {
        const message = JSON.parse(String(event.data))
        if (!message || typeof message !== 'object') throw new Error('Invalid response')
        if (intentional) {
          if (deliverFinal && ready && !message.error_code) {
            const snapshot = transcript.accept(message)
            if (snapshot) onSnapshot({ ...snapshot, finalDelta: transcript.takeFinalDelta() })
          }
          if (message.finished || message.error_code) completeClose(message.finished === true && !message.error_code)
          return
        }
        if (typeof message.error_code === 'number') { fail(serviceError(message.error_code, message.error_type)); return }
        if (message.type === 'pong' && message.id === awaitingPong) {
          awaitingPong = undefined
          clearTimeout(pongTimer)
          if (!ready) {
            ready = true
            clearTimeout(openingTimer)
            heartbeat = setInterval(ping, 5000)
            resolve()
          }
          return
        }
        const snapshot = transcript.accept(message)
        if (snapshot && ready) onSnapshot({ ...snapshot, finalDelta: transcript.takeFinalDelta() })
        if (message.finished) fail(new Error('Soniox 세션이 끝났습니다. 시작을 눌러 다시 연결하세요.'))
      } catch {
        if (intentional) completeClose(false)
        else fail(new Error('Soniox 응답을 처리하지 못했습니다.'))
      }
    }
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
  })
  return {
    sendPcm(chunk) {
      if (intentional || failed || !ready || socket.readyState !== WebSocket.OPEN || !chunk.length) return
      if (socket.bufferedAmount + chunk.byteLength > 64000) { fail(new Error('네트워크가 느려 자막이 지연됩니다. 다시 연결하세요.')); return }
      try { socket.send(new Uint8Array(chunk)) }
      catch { fail(new Error('음성 전송에 실패했습니다. 다시 연결하세요.')) }
    },
    clear() { transcript.clear(); onSnapshot(transcript.snapshot()) },
    close(finalize = false) {
      if (closing) return closing
      if (intentional || failed) return Promise.resolve(false)
      intentional = true
      deliverFinal = finalize
      release()
      closing = new Promise(resolve => { resolveClose = resolve })
      if (socket.readyState === WebSocket.OPEN) {
        // Soniox ends a stream with an empty TEXT frame, not empty binary PCM.
        closeTimer = setTimeout(() => completeClose(false), 2000)
        try { socket.send('') }
        catch { completeClose(false) }
      } else completeClose(false)
      return closing
    },
  }
}
