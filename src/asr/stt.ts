import { Transcript, type SttSnapshot } from './transcript.ts'

export interface SttClient {
  sendPcm(chunk: Uint8Array): void
  clear(): void
  close(): void
}

// Start the mic only after this promise resolves; never queue stale audio.
export async function startSttStream(
  onSnapshot: (snap: SttSnapshot) => void,
  onError: (err: Error) => void,
  signal: AbortSignal,
): Promise<SttClient> {
  const endpoint = import.meta.env?.VITE_STT_TOKEN_URL || '/api/stt-token'
  const response = await fetch(endpoint, { method: 'POST', signal: AbortSignal.any([signal, AbortSignal.timeout(12000)]) })
  const body = await response.json()
  if (!response.ok) throw new Error(body.error || '음성 인식 인증 실패')
  if (typeof body.access_token !== 'string') throw new Error('인증 서버 응답 오류')
  signal.throwIfAborted()
  const params = new URLSearchParams({
    model: 'nova-3', language: 'en', encoding: 'linear16', sample_rate: '16000',
    channels: '1', interim_results: 'true', punctuate: 'true', smart_format: 'true',
    endpointing: '400', mip_opt_out: 'true',
  })
  const socket = new WebSocket(`wss://api.deepgram.com/v1/listen?${params}`, ['bearer', body.access_token])
  const transcript = new Transcript()
  let intentional = false
  let failed = false
  let heartbeat: ReturnType<typeof setInterval> | undefined
  let closeTimer: ReturnType<typeof setTimeout> | undefined
  let opened = false
  let rejectOpening: (error: Error) => void = () => {}
  const release = () => {
    clearInterval(heartbeat)
    clearTimeout(closeTimer)
    signal.removeEventListener('abort', abort)
  }
  const fail = (error: Error) => {
    if (intentional || failed) return
    failed = true
    release()
    socket.close()
    if (opened) onError(error)
    else rejectOpening(error)
  }
  const abort = () => {
    intentional = true
    release()
    socket.close()
    rejectOpening(new DOMException('연결 취소됨', 'AbortError'))
  }
  await new Promise<void>((resolve, reject) => {
    rejectOpening = reject
    const timeout = setTimeout(() => fail(new Error('음성 인식 연결 시간 초과. 네트워크를 확인하세요.')), 12000)
    socket.addEventListener('close', () => clearTimeout(timeout), { once: true })
    socket.onopen = () => {
      clearTimeout(timeout)
      if (signal.aborted || intentional) { abort(); return }
      opened = true
      heartbeat = setInterval(() => {
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'KeepAlive' }))
      }, 3000)
      resolve()
    }
    socket.onerror = () => fail(new Error('음성 인식 연결 실패. API 권한·잔액·인터넷을 확인하세요.'))
    socket.onclose = () => {
      release()
      if (!intentional) fail(new Error('음성 인식 연결이 종료됐습니다. 시작 버튼으로 다시 연결하세요.'))
    }
    socket.onmessage = event => {
      if (intentional || failed) return
      try {
        const message = JSON.parse(String(event.data))
        if (message.type === 'Error') { fail(new Error('음성 인식 서비스 오류. 설정을 확인하고 다시 시작하세요.')); return }
        const snapshot = transcript.accept(message)
        if (snapshot) onSnapshot(snapshot)
      } catch { fail(new Error('음성 인식 응답을 처리하지 못했습니다.')) }
    }
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
  })
  return {
    sendPcm(chunk) {
      if (intentional || failed || socket.readyState !== WebSocket.OPEN) return
      if (socket.bufferedAmount > 64000) { fail(new Error('네트워크가 느려 자막이 지연됩니다. 다시 연결하세요.')); return }
      socket.send(new Uint8Array(chunk))
    },
    clear() { transcript.clear(); onSnapshot(transcript.snapshot()) },
    close() {
      if (intentional) return
      intentional = true
      release()
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'CloseStream' }))
        closeTimer = setTimeout(() => socket.close(), 1000)
      } else socket.close()
    },
  }
}
