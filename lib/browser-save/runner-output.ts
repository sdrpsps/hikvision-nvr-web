import {
  MatroskaMuxer,
  type AudioConfig,
  type EncodedPacket,
} from "../media-export"
import type { LocalWritable, SaveDestination } from "./types"
import { portWriter } from "./port-writer"

// Owns the current file, its startup queue, and counters committed by close().
// Timeline selection and audio coverage remain with the save task.
export class SaveOutput {
  private writable?: LocalWritable
  private muxer?: MatroskaMuxer
  private currentName?: string
  private startupPackets: EncodedPacket[] = []
  private startupBytes = 0
  private startupAt?: number
  private audioConfig?: AudioConfig
  private muxerHasAudio = false
  private omittedAudio = false
  private completedDuration = 0
  private completedAudio = 0
  private fileCount = 0
  private committedFiles = 0
  private committedBytes = 0

  constructor(
    private readonly destination: SaveDestination,
    private readonly filename: string
  ) {}

  get completedBytes() {
    return this.committedBytes
  }

  get hasVideoWritten() {
    return !!this.muxer?.stats.videoPackets
  }

  get audioOmitted() {
    return this.omittedAudio
  }

  progress(done: boolean) {
    const stats = this.muxer?.stats
    return {
      bytes: this.committedBytes + (stats?.bytesWritten ?? 0),
      durationSeconds: this.completedDuration + (stats?.durationSeconds ?? 0),
      audioPackets: this.completedAudio + (stats?.audioPackets ?? 0),
      files: done ? this.committedFiles : this.fileCount,
    }
  }

  async open() {
    this.currentName = this.filename.replace(
      /\.mkv$/,
      `_${String(this.fileCount + 1).padStart(3, "0")}.mkv`
    )
    if (this.destination.type === "download") {
      this.writable = portWriter(this.destination.port)
    } else {
      const file =
        this.destination.type === "file"
          ? this.destination.file
          : await this.destination.directory.getFileHandle(this.currentName, {
              create: true,
            })
      this.writable = await file.createWritable()
    }
    this.fileCount++
  }

  private async flushStartup() {
    if (!this.startupPackets.length) return
    if (!this.writable) await this.open()
    if (!this.muxer) {
      const writable = this.writable!
      this.muxerHasAudio = !!this.audioConfig
      this.muxer = new MatroskaMuxer(
        {
          write: (bytes) => writable.write(bytes),
          ...(writable.seek
            ? { seek: (position: number) => writable.seek!(position) }
            : {}),
        },
        { audio: this.audioConfig ?? null, waitForAudioSeconds: 0 }
      )
    }
    for (const packet of this.startupPackets) await this.muxer.add(packet)
    this.startupPackets.length = 0
    this.startupBytes = 0
  }

  async write(packet: EncodedPacket, audioConfig?: AudioConfig) {
    this.audioConfig = audioConfig
    if (packet.kind === "audio" && this.muxer && !this.muxerHasAudio) {
      this.omittedAudio = true
    }
    if (!this.muxer) {
      // OS pipe scheduling may deliver video before the first audio fragment.
      this.startupAt ??= Date.now()
      this.startupPackets.push(packet)
      this.startupBytes += packet.data.byteLength
      if (
        audioConfig ||
        Date.now() - this.startupAt > 3000 ||
        this.startupBytes >= 8 * 1024 * 1024
      ) {
        await this.flushStartup()
      }
      return
    }
    await this.muxer.add(packet)
  }

  async finish(audioConfig?: AudioConfig) {
    this.audioConfig = audioConfig
    await this.flushStartup()
    if (!this.muxer || !this.writable) return
    await this.muxer.finish()
    await this.writable.close()
    const { endPts, bytesWritten, durationSeconds, audioPackets } =
      this.muxer.stats
    this.committedFiles++
    this.committedBytes += bytesWritten
    this.completedDuration += durationSeconds
    this.completedAudio += audioPackets
    this.muxer = undefined
    this.writable = undefined
    return { endPts }
  }

  async abort() {
    try {
      await this.writable?.abort?.()
    } catch {
      /* The stream may already be errored. */
    }
  }

  async discard() {
    await this.abort()
    if (this.destination.type === "directory" && this.currentName) {
      try {
        await this.destination.directory.removeEntry?.(this.currentName)
      } catch {
        /* Permission may be gone. */
      }
    }
    this.muxer = undefined
    this.writable = undefined
  }
}
