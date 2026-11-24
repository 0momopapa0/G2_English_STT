import test from 'node:test'
import assert from 'node:assert/strict'
import { Transcript, tailAtWord } from '../src/asr/transcript.ts'
import { RumbleFilter } from '../src/asr/audio.ts'

const result = (text, final = false, start = 0, duration = 1) => ({
  type: 'Results', is_final: final, start, duration,
  channel: { alternatives: [{ transcript: text }] },
})
test('interim revisions replace text; finals append once; stale results are ignored', () => {
  const transcript = new Transcript()
  assert.equal(transcript.accept(result('Can you'))?.interimText, 'Can you')
  assert.equal(transcript.accept(result('Could you'))?.interimText, 'Could you')
  assert.deepEqual(transcript.accept(result('Could you?', true)), { finalText: 'Could you?', interimText: '' })
  assert.equal(transcript.accept(result('Could you?', true)), null)
  assert.equal(transcript.accept(result('old interim')), null)
  assert.equal(transcript.accept(result('Confirm tomorrow.', true, 1))?.finalText, 'Could you? Confirm tomorrow.')
})
test('silence clears interim and metadata cannot become captions', () => {
  const transcript = new Transcript()
  transcript.accept(result('uncertain'))
  assert.equal(transcript.accept(result(''))?.interimText, '')
  assert.equal(transcript.accept({ type: 'Metadata' }), null)
  assert.equal(transcript.accept(result('', true))?.finalText, '')
})
test('clear retains timestamp watermark and transcript memory stays bounded', () => {
  const transcript = new Transcript()
  transcript.accept(result('Old words.', true))
  transcript.clear()
  assert.equal(transcript.accept(result('Old words.', true)), null)
  for (let i = 1; i < 2000; i++) transcript.accept(result('New conversation sentence.', true, i))
  assert.ok(transcript.snapshot().finalText.length <= 4000)
  assert.equal(tailAtWord('hello world again', 12), 'world again')
  assert.equal(tailAtWord('hello world again', 11), 'world again')
  assert.equal(tailAtWord('hello world again', 10), 'again')
  assert.ok(tailAtWord(transcript.snapshot().finalText, 240).length <= 240)
})

function pcm(samples) {
  const bytes = new Uint8Array(samples.length * 2)
  const view = new DataView(bytes.buffer)
  samples.forEach((value, i) => view.setInt16(i * 2, value, true))
  return bytes
}
test('PCM bypass preserves samples, byte offsets and split samples without mutating input', () => {
  const original = pcm([-32768, -123, 0, 321, 32767])
  const filter = new RumbleFilter()
  const a = filter.process(original.subarray(0, 3), false).pcm
  const b = filter.process(original.subarray(3), false).pcm
  assert.deepEqual(new Uint8Array([...a, ...b]), original)
  assert.deepEqual(filter.process(new Uint8Array(), false), { pcm: new Uint8Array(), level: 0 })
})
test('rumble filter attenuates low frequencies and preserves speech band', () => {
  const rms = data => {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
    let sum = 0
    for (let i = 3200; i < data.length; i += 2) sum += view.getInt16(i, true) ** 2
    return Math.sqrt(sum / ((data.length - 3200) / 2))
  }
  const wave = hz => pcm(Array.from({ length: 16000 }, (_, i) => Math.round(10000 * Math.sin(2 * Math.PI * hz * i / 16000))))
  const low = wave(30), speech = wave(1000)
  assert.ok(rms(new RumbleFilter().process(low, true).pcm) / rms(low) < 0.35)
  assert.ok(rms(new RumbleFilter().process(speech, true).pcm) / rms(speech) > 0.9)
  const filter = new RumbleFilter()
  filter.process(low, true)
  filter.reset()
  assert.deepEqual(filter.process(speech, true), new RumbleFilter().process(speech, true))
})
