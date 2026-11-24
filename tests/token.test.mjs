import test from 'node:test'
import assert from 'node:assert/strict'
import { tokenMiddleware } from '../server/token-middleware.mjs'

async function request(middleware, overrides = {}) {
  let status, headers, body, passed = false
  await middleware({ url: '/api/stt-token', method: 'POST', headers: { host: 'localhost:5173', origin: 'http://localhost:5173' }, ...overrides }, {
    writeHead(code, values) { status = code; headers = values },
    end(value) { body = JSON.parse(value) },
  }, () => { passed = true })
  return { status, headers, body, passed }
}

test('missing Soniox key has useful error and never calls provider', async () => {
  const response = await request(tokenMiddleware('', () => { throw new Error('Must not call') }))
  assert.equal(response.status, 503)
  assert.match(response.body.error, /SONIOX_API_KEY/)
})

test('restricted single-use Soniox key returned with no-store; long-lived key stays server-side', async () => {
  const middleware = tokenMiddleware('server-secret', async (url, options) => {
    assert.equal(url, 'https://api.soniox.com/v1/auth/temporary-api-key')
    assert.equal(options.headers.Authorization, 'Bearer server-secret')
    assert.equal(options.headers['Content-Type'], 'application/json')
    assert.deepEqual(JSON.parse(options.body), {
      usage_type: 'transcribe_websocket', expires_in_seconds: 60, single_use: true, max_session_duration_seconds: 3600,
    })
    return { ok: true, json: async () => ({ api_key: 'snx_temp_short-lived', expires_at: '2030-01-01T00:00:00Z' }) }
  })
  const response = await request(middleware)
  assert.equal(response.status, 200)
  assert.equal(response.headers['Cache-Control'], 'no-store')
  assert.deepEqual(response.body, { api_key: 'snx_temp_short-lived', expires_at: '2030-01-01T00:00:00Z' })
  assert.ok(!JSON.stringify(response).includes('server-secret'))
})

test('wrong methods and cross-origin requests are rejected; unrelated routes pass through', async () => {
  const middleware = tokenMiddleware('secret')
  assert.equal((await request(middleware, { method: 'GET' })).status, 405)
  assert.equal((await request(middleware, { headers: { host: 'localhost:5173', origin: 'https://elsewhere.test' } })).status, 403)
  assert.equal((await request(middleware, { url: '/' })).passed, true)
})

test('upstream authorization errors and malformed keys cannot leak secrets', async () => {
  const denied = await request(tokenMiddleware('secret', async () => ({
    ok: false, status: 403, json: async () => ({ message: 'secret' }),
  })))
  assert.equal(denied.status, 502)
  assert.match(denied.body.error, /Soniox.*403/)
  assert.ok(!JSON.stringify(denied.body).includes('secret'))
  for (const body of [null, {}, { api_key: 'secret' }, { api_key: 'snx_temp_invalid:protocol' }]) {
    const response = await request(tokenMiddleware('secret', async () => ({ ok: true, json: async () => body })))
    assert.equal(response.status, 502)
    assert.ok(!JSON.stringify(response.body).includes('secret'))
  }
})

test('provider errors are sanitized and requests are rate limited', async () => {
  const middleware = tokenMiddleware('secret', async () => { throw new Error('secret must not leak') })
  const response = await request(middleware)
  assert.equal(response.status, 502)
  assert.ok(!JSON.stringify(response.body).includes('secret'))
  for (let i = 1; i < 20; i++) await request(middleware)
  assert.equal((await request(middleware)).status, 429)
})
