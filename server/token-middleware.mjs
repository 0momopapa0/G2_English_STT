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
    if (!apiKey) { reply(503, { error: '.env.local에 DEEPGRAM_API_KEY를 설정한 후 개발 서버를 다시 시작하세요.' }); return }
    try {
      const response = await fetchToken('https://api.deepgram.com/v1/auth/grant', {
        method: 'POST', headers: { Authorization: `Token ${apiKey}` }, signal: AbortSignal.timeout(10000),
      })
      if (!response.ok) {
        reply(502, { error: `Deepgram 인증 실패 (${response.status}). Member 권한 및 계정 상태를 확인하세요.` }); return
      }
      const body = await response.json()
      if (typeof body.access_token !== 'string') throw new Error('Invalid token response')
      reply(200, { access_token: body.access_token, expires_in: body.expires_in })
    } catch { reply(502, { error: 'Deepgram 인증 서버에 연결하지 못했습니다.' }) }
  }
}
