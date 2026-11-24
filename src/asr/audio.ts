// Gentle 100 Hz high-pass for rumble/DC, NOT AI denoising or speaker separation.
// No hard gate: quiet speech and accented consonants must still reach STT.
export class RumbleFilter {
  private previousInput = 0
  private previousOutput = 0
  private pendingByte: number | undefined
  private readonly alpha = (1 / (2 * Math.PI * 100)) / (1 / (2 * Math.PI * 100) + 1 / 16000)
  reset() { this.previousInput = 0; this.previousOutput = 0; this.pendingByte = undefined }
  process(chunk: Uint8Array, enabled: boolean): { pcm: Uint8Array; level: number } {
    const bytes = this.pendingByte === undefined ? chunk : new Uint8Array([this.pendingByte, ...chunk])
    this.pendingByte = bytes.length % 2 ? bytes[bytes.length - 1] : undefined
    const output = new Uint8Array(bytes.length - bytes.length % 2)
    const inputView = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const outputView = new DataView(output.buffer)
    let sum = 0
    for (let i = 0; i < output.length; i += 2) {
      const x = inputView.getInt16(i, true)
      const filtered = this.alpha * (this.previousOutput + x - this.previousInput)
      this.previousInput = x
      this.previousOutput = filtered
      const value = Math.max(-32768, Math.min(32767, Math.round(enabled ? filtered : x)))
      outputView.setInt16(i, value, true)
      sum += (value / 32768) ** 2
    }
    return { pcm: output, level: output.length ? Math.min(1, Math.sqrt(sum / (output.length / 2)) * 5) : 0 }
  }
}
