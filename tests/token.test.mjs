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
test('missing key has useful error and never calls provider', async () => {
  const response = await request(tokenMiddleware('', () => { throw new Error('Must not call') }))
  assert.equal(response.status, 503)
  assert.match(response.body.error, /DEEPGRAM_API_KEY/)
})
test('temporary token is returned with no-store; long-lived key stays server-side', async () => {
  const middleware = tokenMiddleware('server-secret', async (url, options) => {
    assert.equal(url, 'https://api.deepgram.com/v1/auth/grant')
    assert.equal(options.headers.Authorization, 'Token server-secret')
    return { ok: true, json: async () => ({ access_token: 'short-lived', expires_in: 30 }) }
  })
  const response = await request(middleware)
  assert.equal(response.status, 200)
  assert.equal(response.headers['Cache-Control'], 'no-store')
  assert.deepEqual(response.body, { access_token: 'short-lived', expires_in: 30 })
  assert.ok(!JSON.stringify(response).includes('server-secret'))
})
test('wrong methods and cross-origin requests are rejected; unrelated routes pass through', async () => {
  const middleware = tokenMiddleware('secret')
  assert.equal((await request(middleware, { method: 'GET' })).status, 405)
  assert.equal((await request(middleware, { headers: { host: 'localhost:5173', origin: 'https://elsewhere.test' } })).status, 403)
  assert.equal((await request(middleware, { url: '/' })).passed, true)
})
test('provider errors are sanitized and requests are rate limited', async () => {
  const middleware = tokenMiddleware('secret', async () => { throw new Error('secret must not leak') })
  const response = await request(middleware)
  assert.equal(response.status, 502)
  assert.ok(!JSON.stringify(response.body).includes('secret'))
  for (let i = 1; i < 20; i++) await request(middleware)
  assert.equal((await request(middleware)).status, 429)
})
