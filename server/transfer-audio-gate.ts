const AUDIO_CLASSIFICATION_MS = 3000
const MAX_AUDIO_CLASSIFICATION_BYTES = 1024 ** 2

// Inspect only bounded startup lines, never retain or expose FFmpeg output.
// Audio can reach its pipe before stderr metadata, so classification gates it.
export class LiveAudioGate {
  private state: "unknown" | "supported" | "unsupported" | "absent" = "unknown"
  private sourceAudioSeen = false
  private inputComplete = false
  private slaveFailed = false
  private tail = ""
  private queued: Buffer[] = []
  private queuedBytes = 0
  private timer?: ReturnType<typeof setTimeout>
  private disposed = false

  constructor(
    private callbacks: {
      forward(chunk: Buffer): void
      unsupported(): void
      classified(): void
    }
  ) {}

  get classified() {
    return this.state !== "unknown"
  }

  videoArrived() {
    this.arm()
  }

  private arm() {
    if (this.state !== "unknown" || this.timer || this.disposed) return
    this.timer = setTimeout(
      () => this.classify("unsupported"),
      AUDIO_CLASSIFICATION_MS
    )
    this.timer.unref()
  }

  private classify(state: "supported" | "unsupported" | "absent") {
    if (this.disposed || this.state === "unsupported") return
    if (state === "supported" && this.slaveFailed) state = "unsupported"
    this.state = state
    clearTimeout(this.timer)
    this.timer = undefined
    if (state === "unsupported") this.callbacks.unsupported()
    if (state === "supported")
      for (const chunk of this.queued) this.callbacks.forward(chunk)
    this.queued.length = 0
    this.queuedBytes = 0
    this.callbacks.classified()
  }

  receive(chunk: Buffer) {
    if (this.disposed || this.state === "unsupported") return
    if (this.state === "supported") {
      this.callbacks.forward(chunk)
      return
    }
    if (
      this.state === "absent" ||
      this.queuedBytes + chunk.byteLength > MAX_AUDIO_CLASSIFICATION_BYTES
    ) {
      this.classify("unsupported")
      return
    }
    this.queued.push(chunk)
    this.queuedBytes += chunk.byteLength
    this.arm()
  }

  private line(line: string) {
    if (/\bSlave muxer #1 failed\b/.test(line)) {
      this.slaveFailed = true
      if (this.sourceAudioSeen) this.classify("unsupported")
    }
    if (!this.inputComplete && !this.sourceAudioSeen) {
      const match = /^\s*Stream #0:\d+[^\r\n]*:\s*Audio:\s*([a-z0-9_]+)?/i.exec(
        line
      )
      if (match) {
        this.sourceAudioSeen = true
        this.classify(
          ["pcm_alaw", "pcm_mulaw"].includes(match[1]?.toLowerCase() ?? "")
            ? "supported"
            : "unsupported"
        )
      }
    }
    if (/^\s*(?:Stream mapping:|Output #|Input #[1-9]\d*,)/.test(line)) {
      this.inputComplete = true
      if (!this.sourceAudioSeen && this.state === "unknown")
        this.classify(this.queuedBytes ? "unsupported" : "absent")
    }
  }

  diagnostics(chunk: Buffer) {
    if (this.disposed) return
    for (let at = 0; at < chunk.byteLength; at += 4096) {
      const lines = (
        this.tail + chunk.subarray(at, at + 4096).toString("utf8")
      ).split(/\r?\n/)
      this.tail = (lines.pop() ?? "").slice(-4096)
      for (const line of lines) this.line(line)
    }
  }

  diagnosticsEnd() {
    if (!this.disposed && this.tail) this.line(this.tail)
    this.tail = ""
  }

  dispose() {
    this.disposed = true
    clearTimeout(this.timer)
    this.tail = ""
    this.queued.length = 0
    this.queuedBytes = 0
  }
}
