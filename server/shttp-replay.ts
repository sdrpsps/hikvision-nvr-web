import { createConnection, isIP, type Socket } from "node:net"
import { connect as connectTls } from "node:tls"
import { Temporal } from "@js-temporal/polyfill"
import type { NvrConfig } from "./config"
import { digestAuthorization, parseChallenge } from "./digest"
import { AppError } from "./errors"

export type ShttpReplayOptions = {
  nativeChannel: number
  streamIndex: number
  startAt: string
  endAt: string
}
export type ShttpReplay = {
  stream: ReadableStream<Uint8Array>
  finished: Promise<{ complete: boolean }>
  close(): void
}

const PREPARE_MS = 10_000
const IDLE_MS = 10_000
const MAX_HTTP_HEADER = 16 * 1024
const MAX_CODEC_HEADER = 64
const MAX_PACKET = 2 * 1024 * 1024
const MAX_WRITE_QUEUE = 64 * 1024
const error = (code: string) =>
  new AppError(
    `MEDIA_SHTTP_${code}`,
    code === "TIMEOUT" ? 504 : code === "INVALID" ? 400 : 502,
    code === "TIMEOUT"
      ? "历史回放取流超时，请重新播放。"
      : "历史回放取流失败或已取消，请重新播放。"
  )

// Read on demand: the socket's own bounded readable queue provides backpressure.
class Input {
  private chunk: Buffer = Buffer.alloc(0)
  private offset = 0
  private failure?: AppError
  private ended = false
  private connected = false
  private wake?: () => void
  private timer?: ReturnType<typeof setTimeout>

  constructor(
    readonly socket: Socket,
    secure: boolean,
    fail: (reason: AppError) => void
  ) {
    socket.pause()
    socket.once(secure ? "secureConnect" : "connect", () => {
      this.connected = true
      this.wake?.()
    })
    socket.on("readable", () => this.wake?.())
    socket.on("end", () => {
      this.ended = true
      this.wake?.()
    })
    socket.on("error", () => {
      if (!this.failure) fail(error("UNREACHABLE"))
    })
    socket.on("close", () => {
      this.ended = true
      this.wake?.()
    })
  }

  stop(reason: AppError) {
    this.failure = reason
    clearTimeout(this.timer)
    this.wake?.()
    this.chunk = Buffer.alloc(0)
    this.offset = 0
    this.socket.destroy()
  }

  private async wait() {
    if (this.failure) throw this.failure
    if (this.ended) throw error("EARLY_EOF")
    await new Promise<void>((resolve) => {
      this.wake = resolve
      this.timer = setTimeout(() => {
        this.failure = error("TIMEOUT")
        resolve()
      }, IDLE_MS)
      this.timer.unref()
    })
    clearTimeout(this.timer)
    this.wake = undefined
    if (this.failure) throw this.failure
  }

  async ready() {
    while (!this.connected) await this.wait()
  }

  private async available() {
    if (this.failure) throw this.failure
    while (this.offset === this.chunk.length) {
      if (this.failure) throw this.failure
      const next: unknown = this.socket.read()
      if (Buffer.isBuffer(next)) {
        this.chunk = next
        this.offset = 0
        break
      }
      await this.wait()
    }
  }

  async read(length: number) {
    const result = Buffer.allocUnsafe(length)
    let copied = 0
    while (copied < length) {
      await this.available()
      const count = Math.min(length - copied, this.chunk.length - this.offset)
      this.chunk.copy(result, copied, this.offset, this.offset + count)
      this.offset += count
      copied += count
    }
    return result
  }

  async header() {
    const result = Buffer.allocUnsafe(MAX_HTTP_HEADER)
    let length = 0
    while (length < MAX_HTTP_HEADER) {
      await this.available()
      const count = Math.min(
        MAX_HTTP_HEADER - length,
        this.chunk.length - this.offset
      )
      this.chunk.copy(result, length, this.offset, this.offset + count)
      const end = result
        .subarray(0, length + count)
        .indexOf("\r\n\r\n", Math.max(0, length - 3))
      if (end >= 0) {
        this.offset += end + 4 - length
        return result.subarray(0, end).toString("latin1")
      }
      length += count
      this.offset += count
    }
    throw error("LIMIT")
  }

  write(bytes: Buffer) {
    if (this.failure) throw this.failure
    if (!this.socket.writable || this.socket.destroyed) throw error("EARLY_EOF")
    if (this.socket.writableLength + bytes.length > MAX_WRITE_QUEUE)
      throw error("LIMIT")
    this.socket.write(bytes)
  }
}

function command(code: number, length = 36) {
  const bytes = Buffer.alloc(length)
  bytes.writeUInt32BE(length)
  bytes.writeUInt32BE(code, 12)
  return bytes
}

function requestBody(config: NvrConfig, options: ShttpReplayOptions) {
  try {
    if (
      !Number.isInteger(options.nativeChannel) ||
      options.nativeChannel < 1 ||
      options.nativeChannel > 65535 ||
      ![0, 1].includes(options.streamIndex) ||
      Temporal.Instant.compare(options.startAt, options.endAt) >= 0
    )
      throw error("INVALID")
    const bytes = command(0x30102, 96)
    bytes.writeUInt32BE(options.nativeChannel, 32)
    for (const [index, at] of [options.startAt, options.endAt].entries()) {
      const time = Temporal.Instant.from(at)
        .round({
          smallestUnit: "second",
          roundingMode: index ? "ceil" : "floor",
        })
        .toZonedDateTimeISO(config.NVR_TIME_ZONE)
      if (time.year < 1 || time.year > 9999) throw error("INVALID")
      const fields = [
        time.year,
        time.month,
        time.day,
        time.hour,
        time.minute,
        time.second,
      ]
      fields.forEach((field, part) =>
        bytes.writeUInt32BE(field, 36 + index * 24 + part * 4)
      )
    }
    bytes[92] = options.streamIndex
    return bytes
  } catch {
    throw error("INVALID")
  }
}

function parseHeader(raw: string) {
  const [first, ...lines] = raw.split("\r\n")
  const status = /^HTTP\/1\.[01] (\d{3})(?: [^\x00-\x1f\x7f]*)?$/.exec(first)
  if (!status) throw error("PROTOCOL")
  const headers: Record<string, string> = Object.create(null)
  for (const line of lines) {
    const match =
      /^([\w!#$%&'*+.^`|~-]+):[ \t]*([^\x00-\x08\x0a-\x1f\x7f]*)$/.exec(line)
    if (!match) throw error("PROTOCOL")
    const name = match[1].toLowerCase()
    if (headers[name] !== undefined && name !== "www-authenticate")
      throw error("PROTOCOL")
    if (name !== "www-authenticate" || !/^Digest\s/i.test(headers[name] ?? ""))
      headers[name] = match[2].trim()
  }
  return { status: Number(status[1]), headers }
}

async function frame(input: Input) {
  const header = await input.read(8)
  const length = header.readUInt32BE(0)
  const type = header.readUInt32BE(4)
  if (length < 8 || length > MAX_PACKET) throw error("LIMIT")
  if (type === 14) throw error("DEVICE_ERROR")
  if (![19, 20, 21].includes(type)) throw error("PROTOCOL")
  return { type, length }
}

async function codecHead(input: Input, length: number) {
  if (length < 28 || length > MAX_CODEC_HEADER + 24) throw error("PROTOCOL")
  const metadata = await input.read(16)
  const headLength = metadata.readUInt32BE(12)
  if (headLength !== length - 24 || ![40, 64].includes(headLength))
    throw error("PROTOCOL")
  const head = await input.read(headLength)
  // Only the verified IMKH/PS variants are supported, not arbitrary SDK codecs.
  if (!head.subarray(0, 4).equals(Buffer.from("IMKH"))) throw error("PROTOCOL")
  return head
}

/** Private HTTP/binary replay transport; native channel mapping stays server-side. */
export async function openShttpReplay(
  config: NvrConfig,
  options: ShttpReplayOptions,
  signal?: AbortSignal
): Promise<ShttpReplay> {
  const body = requestBody(config, options)
  const path = `/SDK/playback/${options.nativeChannel * 100 + options.streamIndex}`
  let input: Input | undefined
  let output: ReadableStreamDefaultController<Uint8Array> | undefined
  let heartbeat: ReturnType<typeof setInterval> | undefined
  let stopped = false
  let settle!: (result: { complete: boolean }) => void
  const finished = new Promise<{ complete: boolean }>((resolve) => {
    settle = resolve
  })
  const prepare = setTimeout(() => stop(false, error("TIMEOUT")), PREPARE_MS)
  prepare.unref()
  const abort = () => stop(false, error("CANCELLED"))

  function stop(complete: boolean, reason = error("CANCELLED")) {
    if (stopped) return
    stopped = true
    clearTimeout(prepare)
    clearInterval(heartbeat)
    signal?.removeEventListener("abort", abort)
    input?.stop(reason)
    if (complete) output?.close()
    else output?.error(reason)
    settle({ complete })
  }

  signal?.addEventListener("abort", abort, { once: true })
  try {
    if (signal?.aborted) throw error("CANCELLED")
    let authorization: string | undefined
    for (let attempt = 0; attempt < 3; attempt++) {
      if (stopped) throw error("CANCELLED")
      const secure = config.NVR_HTTP_SCHEME === "https"
      const host = config.NVR_HOST.replace(/^\[|\]$/g, "")
      const connection = {
        host,
        port: config.NVR_HTTP_PORT,
        highWaterMark: 64 * 1024,
      }
      const socket = secure
        ? connectTls({
            ...connection,
            ...(isIP(host) ? {} : { servername: host }),
          })
        : createConnection(connection)
      input = new Input(socket, secure, (reason) => stop(false, reason))
      await input.ready()
      const payload = authorization ? body : Buffer.alloc(0)
      const request = [
        `GET ${path} HTTP/1.1`,
        `Host: ${config.NVR_HOST}:${config.NVR_HTTP_PORT}`,
        "User-Agent: NS-HTTP/1.0",
        "Connection: keep-alive",
        "Content-Type: application/octet-stream",
        `Content-Length: ${payload.length}`,
        ...(authorization ? [`Authorization: ${authorization}`] : []),
        "",
        "",
      ].join("\r\n")
      input.write(Buffer.concat([Buffer.from(request), payload]))
      const response = parseHeader(await input.header())
      if (response.status === 401) {
        const challenge = response.headers["www-authenticate"] ?? ""
        if (
          attempt === 2 ||
          (attempt === 1 &&
            !/\bstale\s*=\s*"?true"?(?:\s*,|\s*$)/i.test(challenge))
        )
          throw error("AUTH")
        try {
          authorization = digestAuthorization(
            parseChallenge(challenge),
            config.NVR_USERNAME,
            config.NVR_PASSWORD,
            "GET",
            path
          )
          if (/[\x00-\x1f\x7f]/.test(authorization)) throw error("AUTH")
        } catch {
          throw error("AUTH")
        }
        input.stop(error("AUTH"))
        continue
      }
      if (
        !authorization ||
        response.status !== 100 ||
        response.headers["transfer-encoding"] ||
        (response.headers["content-length"] !== undefined &&
          response.headers["content-length"] !== "0")
      )
        throw error("PROTOCOL")
      const size = await input.read(4)
      if (size.readUInt32BE() !== 44) throw error("PROTOCOL")
      const ack = Buffer.concat([size, await input.read(40)])
      const checksum = ack.subarray(8).reduce((sum, byte) => sum + byte, 0)
      if (ack.readUInt32LE(4) !== checksum) throw error("PROTOCOL")
      if (ack.readUInt32BE(8) !== 1) throw error("REJECTED")
      input.write(command(0x30103))
      const first = await frame(input)
      if (first.type !== 19) throw error("PROTOCOL")
      const head = await codecHead(input, first.length)
      const active = input
      clearTimeout(prepare)
      heartbeat = setInterval(() => {
        try {
          active.write(command(0x30109))
        } catch {
          stop(false, error("UNREACHABLE"))
        }
      }, 3000)
      heartbeat.unref()
      let media = false
      let repeatedHeads = 0
      const stream = new ReadableStream<Uint8Array>(
        {
          start(controller) {
            output = controller
            controller.enqueue(head)
          },
          async pull(controller) {
            try {
              let consecutiveHeads = 0
              while (!stopped) {
                const packet = await frame(active)
                if (stopped) return
                if (packet.type === 19) {
                  if (++consecutiveHeads > 4 || ++repeatedHeads > 32)
                    throw error("LIMIT")
                  if (!(await codecHead(active, packet.length)).equals(head))
                    throw error("PROTOCOL")
                  continue
                }
                if (packet.type === 21) {
                  if (packet.length !== 8 || !media) throw error("PROTOCOL")
                  stop(true)
                } else {
                  if (packet.length === 8) throw error("PROTOCOL")
                  const payload = await active.read(packet.length - 8)
                  if (stopped) return
                  media = true
                  controller.enqueue(payload)
                }
                return
              }
            } catch (reason) {
              if (!stopped)
                stop(
                  false,
                  reason instanceof AppError ? reason : error("PROTOCOL")
                )
            }
          },
          cancel() {
            stop(false)
          },
        },
        { highWaterMark: 256 * 1024, size: (chunk) => chunk.byteLength }
      )
      return { stream, finished, close: () => stop(false) }
    }
    throw error("AUTH")
  } catch (reason) {
    const safe = reason instanceof AppError ? reason : error("UNREACHABLE")
    stop(false, safe)
    throw safe
  }
}
