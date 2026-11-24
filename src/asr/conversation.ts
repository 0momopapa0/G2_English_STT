// Keep the session separate from the 4,000-character live caption window.
export class Conversation {
  private text = ''
  private boundary = false
  truncated = false
  static readonly LIMIT = 100000
  startStream() { this.boundary = true }
  append(delta: string) {
    if (!delta) return
    if (this.boundary && this.text && !/\s$/.test(this.text) && !/^\s/.test(delta)) this.text += '\n'
    this.boundary = false
    this.text += delta
    if (this.text.length > Conversation.LIMIT) {
      this.truncated = true
      this.text = this.text.slice(-Conversation.LIMIT)
    }
  }
  get transcript() { return this.text.trim() }
  clear() { this.text = ''; this.boundary = false; this.truncated = false }
}
