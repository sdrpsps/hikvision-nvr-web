export type SaveSource =
  | {
      mode: "live"
      track: string
      channelName: string
      limitSeconds: number
      timeZone?: string
    }
  | {
      mode: "history"
      timeZone?: string
      track: string
      channelName: string
      date: string
      segmentId: string
      fileStartAt?: string
      startSeconds: number
      endSeconds: number
    }

export type SaveTask = {
  id: string
  source: SaveSource
  filename: string
  state:
    | "preparing"
    | "saving"
    | "stopping"
    | "complete"
    | "partial"
    | "failed"
    | "cancelled"
  bytes: number
  sourceBytes: number
  durationSeconds: number
  actualStartSeconds?: number
  actualEndSeconds?: number
  audioPackets: number
  files: number
  saveMode?: SaveDestination["type"]
  message?: string
  createdAt: number
}

export type LocalFile = {
  name: string
  createWritable(): Promise<LocalWritable>
}
export type LocalWritable = {
  write(data: Uint8Array | { type: "seek"; position: number }): Promise<void>
  seek?(position: number): Promise<void>
  close(): Promise<void>
  abort?(reason?: unknown): Promise<void>
}
export type LocalDirectory = {
  name: string
  getFileHandle(name: string, options: { create: boolean }): Promise<LocalFile>
  removeEntry?(name: string): Promise<void>
}

export type SaveDestination =
  | { type: "file"; file: LocalFile }
  | { type: "directory"; directory: LocalDirectory }
  | { type: "download"; port: MessagePort }

export type SaveWorkerRequest =
  | {
      type: "start"
      id: string
      source: SaveSource
      filename: string
      destination: SaveDestination
    }
  | { type: "stop" }

export type SaveWorkerEvent = {
  type: "ready" | "progress" | "done"
  patch: Partial<SaveTask>
}

export function mediaClock(seconds: number) {
  const total = Math.max(0, Math.floor(seconds))
  return `${String(Math.floor(total / 3600)).padStart(2, "0")}:${String(Math.floor(total / 60) % 60).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`
}

export function parseMediaClock(value: string): number | undefined {
  const match = /^(\d{1,3}):([0-5]\d)(?::([0-5]\d))?$/.exec(value.trim())
  if (!match) return undefined
  return match[3] === undefined
    ? Number(match[1]) * 60 + Number(match[2])
    : Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3])
}

export function safeFilename(name: string) {
  return name.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").slice(0, 60) || "摄像头"
}
