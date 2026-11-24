// Development-only, same-origin token endpoint. Never include this key in VITE_*.
export function tokenMiddleware(apiKey, fetchToken = fetch) {
  let windowStart = Date.now()
  let requests = 0
  return async (req, res, next) => {
    if (req.url?.split('?')[0] !== '/api/stt-token') { next(); return }
    const reply = (status, data) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
      res.end(JSON.stringify(data))
    }
    if (req.method !== 'POST') { reply(405, { error: 'POST 요청이 필요합니다.' }); return }
    // Browsers send Origin for same-origin POST; reject cross-origin calls.
    if (req.headers.origin) {
      try {
        if (new URL(req.headers.origin).host !== req.headers.host) { reply(403, { error: '허용되지 않은 출처입니다.' }); return }
      } catch { reply(403, { error: '잘못된 출처입니다.' }); return }
    }
    if (Date.now() - windowStart > 60000) { windowStart = Date.now(); requests = 0 }
    if (++requests > 20) { reply(429, { error: '연결 요청이 많습니다. 잠시 후 다시 시작하세요.' }); return }
    if (!apiKey) { reply(503, { error: '.env.local에 SONIOX_API_KEY를 설정한 후 개발 서버를 다시 시작하세요.' }); return }
    try {
      const response = await fetchToken('https://api.soniox.com/v1/auth/temporary-api-key', {
        method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ usage_type: 'transcribe_websocket', expires_in_seconds: 60, single_use: true, max_session_duration_seconds: 3600 }),
        signal: AbortSignal.timeout(10000),
      })
      if (!response.ok) {
        reply(502, { error: `Soniox 인증 실패 (${response.status}). Temporary API keys·실시간 STT 권한 및 계정 잔액을 확인하세요.` }); return
      }
      const body = await response.json()
      if (typeof body?.api_key !== 'string' || !/^snx_temp_[A-Za-z0-9._-]+$/.test(body.api_key) || body.api_key === apiKey) throw new Error('Invalid token response')
      reply(200, { api_key: body.api_key, expires_at: body.expires_at })
    } catch { reply(502, { error: 'Soniox 인증 서버 응답을 확인하지 못했습니다. 네트워크와 API 설정을 확인하세요.' }) }
  }
}
