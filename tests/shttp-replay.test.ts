import { createHash } from "node:crypto"
import { createServer, type Server, type Socket } from "node:net"
import { setImmediate as nextTurn } from "node:timers/promises"
import { afterEach, describe, expect, it, vi } from "vitest"
import { readNvrConfig, type NvrConfig } from "../server/config"
import {
  openShttpReplay,
  type ShttpReplayOptions,
} from "../server/shttp-replay"

const options: ShttpReplayOptions = {
  nativeChannel: 33,
  streamIndex: 0,
  startAt: "2026-10-28T04:00:00Z",
  endAt: "2026-10-28T04:00:10Z",
}
const head = Buffer.alloc(40)
head.write("IMKH")
const ps = Buffer.from([0, 0, 1, 0xba, 0x44, 1, 2, 3, 4])
const digest =
  'Digest realm="synthetic-realm", nonce="nonce-one", qop="auth", algorithm=MD5'
const http100 = Buffer.from("HTTP/1.1 100 Continue\r\n\r\n")

function packet(type: number, payload = Buffer.alloc(0)) {
  const value = Buffer.alloc(8 + payload.length)
  value.writeUInt32BE(value.length)
  value.writeUInt32BE(type, 4)
  payload.copy(value, 8)
  return value
}
function codecHeader(value = head, length = value.length) {
  const metadata = Buffer.alloc(16)
  metadata.writeUInt32BE(length, 12)
  return packet(19, Buffer.concat([metadata, value]))
}
function ack(status = 1) {
  const value = Buffer.alloc(44)
  value.writeUInt32BE(44)
  value.writeUInt32BE(status, 8)
  value.writeUInt32BE(40, 40)
  value.writeUInt32LE(
    value.subarray(8).reduce((sum, byte) => sum + byte, 0),
    4
  )
  return value
}
function challenge(socket: Socket, value = digest) {
  socket.write(
    `HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: ${value}\r\nContent-Length: 0\r\n\r\n`
  )
}
type Request = {
  path: string
  headers: Record<string, string>
  body: Buffer
}
type Device = {
  config: NvrConfig
  server: Server
  sockets: Set<Socket>
  requests: Request[]
  commands: Buffer[]
  errors: Error[]
}
type Handlers = {
  request?: (request: Request, socket: Socket, device: Device) => void
  command?: (bytes: Buffer, socket: Socket, device: Device) => void
}
const devices: Device[] = []

async function device(handlers: Handlers = {}): Promise<Device> {
  const sockets = new Set<Socket>()
  const requests: Request[] = []
  const commands: Buffer[] = []
  const errors: Error[] = []
  const server = createServer((socket) => {
    socket.setNoDelay()
    sockets.add(socket)
    socket.once("close", () => sockets.delete(socket))
    socket.on("error", () => {})
    let buffer = Buffer.alloc(0)
    let binary = false
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk])
      try {
        while (buffer.length) {
          if (binary) {
            if (buffer.length < 4) return
            const length = buffer.readUInt32BE()
            if (length < 16 || length > 1024)
              throw new Error("bad test command")
            if (buffer.length < length) return
            const bytes = buffer.subarray(0, length)
            buffer = buffer.subarray(length)
            commands.push(bytes)
            if (handlers.command) handlers.command(bytes, socket, result)
            else if (bytes.readUInt32BE(12) === 0x30103)
              socket.write(
                Buffer.concat([codecHeader(), packet(20, ps), packet(21)])
              )
          } else {
            const end = buffer.indexOf("\r\n\r\n")
            if (end < 0) return
            const [first, ...lines] = buffer
              .subarray(0, end)
              .toString()
              .split("\r\n")
            const headers: Record<string, string> = {}
            for (const line of lines) {
              const colon = line.indexOf(":")
              headers[line.slice(0, colon).toLowerCase()] = line
                .slice(colon + 1)
                .trim()
            }
            const length = Number(headers["content-length"])
            if (buffer.length < end + 4 + length) return
            const request = {
              path: first.split(" ")[1],
              headers,
              body: buffer.subarray(end + 4, end + 4 + length),
            }
            buffer = buffer.subarray(end + 4 + length)
            requests.push(request)
            binary = Boolean(headers.authorization)
            if (handlers.request) handlers.request(request, socket, result)
            else if (!headers.authorization) challenge(socket)
            else socket.write(Buffer.concat([http100, ack()]))
          }
        }
      } catch (reason) {
        errors.push(
          reason instanceof Error ? reason : new Error("test server failed")
        )
        socket.destroy()
      }
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  const address = server.address()
  if (!address || typeof address === "string")
    throw new Error("missing test port")
  const result: Device = {
    config: readNvrConfig({
      NVR_HOST: "127.0.0.1",
      NVR_HTTP_PORT: String(address.port),
      NVR_USERNAME: "synthetic-user",
      NVR_PASSWORD: "test-credential-for-shttp",
    }),
    server,
    sockets,
    requests,
    commands,
    errors,
  }
  devices.push(result)
  return result
}

async function until(predicate: () => boolean) {
  for (let turn = 0; turn < 2000; turn++) {
    if (predicate()) return
    await nextTurn()
  }
  throw new Error("synthetic device did not settle")
}
async function readAll(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) return Buffer.concat(chunks)
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
}
async function split(socket: Socket, bytes: Buffer) {
  for (const byte of bytes) {
    if (socket.destroyed) return
    socket.write(Buffer.from([byte]))
    await nextTurn()
  }
}
function mediaDevice(bytes: Buffer, end = false) {
  return device({
    command(command, socket) {
      if (command.readUInt32BE(12) === 0x30103) {
        if (end) socket.end(Buffer.concat([codecHeader(), bytes]))
        else socket.write(Buffer.concat([codecHeader(), bytes]))
      }
    },
  })
}

afterEach(async () => {
  for (const current of devices.splice(0)) {
    for (const socket of current.sockets) socket.destroy()
    await new Promise<void>((resolve) => current.server.close(() => resolve()))
    expect(current.errors).toEqual([])
  }
  vi.useRealTimers()
})

describe("private SHTTP replay transport", () => {
  it("authenticates with Digest, sends exact 96/36-byte commands, and finishes only on 21", async () => {
    const current = await device()
    const replay = await openShttpReplay(current.config, options)
    expect(await readAll(replay.stream)).toEqual(Buffer.concat([head, ps]))
    expect(await replay.finished).toEqual({ complete: true })
    await until(() => current.sockets.size === 0)
    expect(current.requests).toHaveLength(2)
    const [initial, authenticated] = current.requests
    expect(initial.path).toBe("/SDK/playback/3300")
    expect(initial.body).toHaveLength(0)
    expect(initial.headers).not.toHaveProperty("authorization")
    expect(authenticated.headers["content-type"]).toBe(
      "application/octet-stream"
    )
    expect(authenticated.headers.authorization).toMatch(/^Digest /)
    expect(authenticated.headers.authorization).not.toContain(
      current.config.NVR_PASSWORD
    )
    const auth = Object.fromEntries(
      [
        ...authenticated.headers.authorization.matchAll(
          /(\w+)=(?:"([^"]*)"|([^, ]+))/g
        ),
      ].map((item) => [item[1], item[2] ?? item[3]])
    )
    const md5 = (value: string) => createHash("md5").update(value).digest("hex")
    expect(auth.response).toBe(
      md5(
        `${md5(`${current.config.NVR_USERNAME}:synthetic-realm:${current.config.NVR_PASSWORD}`)}:nonce-one:00000001:${auth.cnonce}:auth:${md5("GET:/SDK/playback/3300")}`
      )
    )
    const expected = Buffer.alloc(96)
    expected.writeUInt32BE(96)
    expected.writeUInt32BE(0x30102, 12)
    expected.writeUInt32BE(33, 32)
    ;[2026, 10, 28, 12, 0, 0, 2026, 10, 28, 12, 0, 10].forEach((value, index) =>
      expected.writeUInt32BE(value, 36 + index * 4)
    )
    expect(authenticated.body).toEqual(expected)
    expect(current.commands).toHaveLength(1)
    const start = Buffer.alloc(36)
    start.writeUInt32BE(36)
    start.writeUInt32BE(0x30103, 12)
    expect(current.commands[0]).toEqual(start)
    replay.close()
    expect(await replay.finished).toEqual({ complete: true })
  })

  it("preserves HTTP100/ACK bytes and every boundary when TCP splits one byte at a time", async () => {
    const current = await device({
      request(request, socket) {
        if (!request.headers.authorization)
          void split(
            socket,
            Buffer.from(
              `HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: ${digest}\r\n\r\n`
            )
          )
        else void split(socket, Buffer.concat([http100, ack()]))
      },
      command(command, socket) {
        if (command.readUInt32BE(12) === 0x30103)
          void split(
            socket,
            Buffer.concat([codecHeader(), packet(20, ps), packet(21)])
          )
      },
    })
    const replay = await openShttpReplay(current.config, options)
    expect(await readAll(replay.stream)).toEqual(Buffer.concat([head, ps]))
    expect(await replay.finished).toEqual({ complete: true })
  })

  it("rounds the requested window outwards and handles a device-local midnight", async () => {
    const current = await device()
    const replay = await openShttpReplay(current.config, {
      ...options,
      streamIndex: 1,
      startAt: "2026-10-28T15:59:59.999Z",
      endAt: "2026-10-28T16:00:01.001Z",
    })
    await readAll(replay.stream)
    const request = current.requests[1]
    expect(request.path).toBe("/SDK/playback/3301")
    expect(request.body[92]).toBe(1)
    expect(
      Array.from({ length: 12 }, (_, index) =>
        request.body.readUInt32BE(36 + index * 4)
      )
    ).toEqual([2026, 10, 28, 23, 59, 59, 2026, 10, 29, 0, 0, 2])
  })

  it("keeps SDK wall-clock fields independent of the recording-search time mode", async () => {
    const current = await device()
    const replay = await openShttpReplay(
      {
        ...current.config,
        NVR_RECORDING_TIME_MODE: "utc",
        NVR_TIME_ZONE: "Asia/Shanghai",
      },
      options
    )
    await readAll(replay.stream)
    expect(current.requests[1].body.readUInt32BE(48)).toBe(12)
  })

  it("also supports the verified 64-byte IMKH header variant", async () => {
    const extended = Buffer.alloc(64)
    extended.write("IMKH")
    const current = await device({
      command(command, socket) {
        if (command.readUInt32BE(12) === 0x30103)
          socket.write(
            Buffer.concat([codecHeader(extended), packet(20, ps), packet(21)])
          )
      },
    })
    const replay = await openShttpReplay(current.config, options)
    expect(await readAll(replay.stream)).toEqual(Buffer.concat([extended, ps]))
    expect(await replay.finished).toEqual({ complete: true })
  })

  it("discards identical repeated codec headers and keeps pulling through the file boundary", async () => {
    const current = await mediaDevice(
      Buffer.concat([
        packet(20, ps),
        codecHeader(),
        codecHeader(),
        packet(20, ps),
        packet(21),
      ])
    )
    const replay = await openShttpReplay(current.config, options)
    expect(await readAll(replay.stream)).toEqual(Buffer.concat([head, ps, ps]))
    expect(await replay.finished).toEqual({ complete: true })
  })

  it.each(["consecutive", "session"])(
    "limits repeated headers per %s",
    async (kind) => {
      const bytes =
        kind === "consecutive"
          ? Buffer.concat(Array.from({ length: 5 }, () => codecHeader()))
          : Buffer.concat(
              Array.from({ length: 33 }, () =>
                Buffer.concat([packet(20, ps), codecHeader()])
              )
            )
      const current = await mediaDevice(bytes)
      const replay = await openShttpReplay(current.config, options)
      await expect(readAll(replay.stream)).rejects.toMatchObject({
        code: "MEDIA_SHTTP_LIMIT",
      })
      expect(await replay.finished).toEqual({ complete: false })
      await until(() => current.sockets.size === 0)
    }
  )

  it("validates repeated header length before discarding any bytes", async () => {
    const current = await mediaDevice(
      Buffer.concat([packet(20, ps), codecHeader(head, 41), packet(21)])
    )
    const replay = await openShttpReplay(current.config, options)
    await expect(readAll(replay.stream)).rejects.toMatchObject({
      code: "MEDIA_SHTTP_PROTOCOL",
    })
    expect(await replay.finished).toEqual({ complete: false })
  })

  it.each([
    { nativeChannel: 0 },
    { nativeChannel: 1.5 },
    { nativeChannel: 65536 },
    { streamIndex: 2 },
    { streamIndex: 0.5 },
    { startAt: "invalid" },
    { endAt: options.startAt },
    { endAt: "2026-10-27T00:00:00Z" },
    { endAt: "+010000-01-01T00:00:00Z" },
  ])(
    "rejects invalid trusted options before connecting: %j",
    async (change) => {
      const current = await device()
      await expect(
        openShttpReplay(current.config, { ...options, ...change })
      ).rejects.toMatchObject({ code: "MEDIA_SHTTP_INVALID" })
      expect(current.requests).toHaveLength(0)
      expect(current.sockets.size).toBe(0)
    }
  )

  it.each([
    'Basic realm="private-realm"',
    'Digest realm="private-realm", nonce="private-nonce", algorithm=SHA-512',
  ])("never falls back to unsupported authentication: %s", async (value) => {
    const current = await device({
      request: (_, socket) => challenge(socket, value),
    })
    await expect(
      openShttpReplay(current.config, options)
    ).rejects.toMatchObject({ code: "MEDIA_SHTTP_AUTH" })
    await until(() => current.sockets.size === 0)
    expect(current.requests).toHaveLength(1)
    expect(current.commands).toHaveLength(0)
  })

  it("permits exactly one stale Digest challenge and starts only on the final connection", async () => {
    const current = await device({
      request(request, socket, current) {
        if (!request.headers.authorization) challenge(socket)
        else if (current.requests.length === 2)
          challenge(
            socket,
            `${digest.replace("nonce-one", "nonce-two")}, stale=true`
          )
        else socket.write(Buffer.concat([http100, ack()]))
      },
    })
    const replay = await openShttpReplay(current.config, options)
    await readAll(replay.stream)
    expect(await replay.finished).toEqual({ complete: true })
    expect(current.requests.map((request) => request.body.length)).toEqual([
      0, 96, 96,
    ])
    expect(current.requests[2].headers.authorization).toContain(
      'nonce="nonce-two"'
    )
    expect(current.commands).toHaveLength(1)
  })

  it.each([false, true])(
    "bounds authentication failure, including repeated stale=%s",
    async (stale) => {
      const current = await device({
        request: (_, socket) =>
          challenge(socket, `${digest}${stale ? ", stale=true" : ""}`),
      })
      await expect(
        openShttpReplay(current.config, options)
      ).rejects.toMatchObject({ code: "MEDIA_SHTTP_AUTH" })
      await until(() => current.sockets.size === 0)
      expect(current.requests).toHaveLength(stale ? 3 : 2)
      expect(current.commands).toHaveLength(0)
    }
  )

  it.each(["rejected", "checksum", "length"])(
    "never sends START for an invalid ACK: %s",
    async (kind) => {
      const value = ack(kind === "rejected" ? 7 : 1)
      if (kind === "checksum") value[4] ^= 1
      if (kind === "length") value.writeUInt32BE(100)
      const current = await device({
        request(request, socket) {
          if (!request.headers.authorization) challenge(socket)
          else socket.write(Buffer.concat([http100, value]))
        },
      })
      await expect(
        openShttpReplay(current.config, options)
      ).rejects.toMatchObject({
        code:
          kind === "rejected" ? "MEDIA_SHTTP_REJECTED" : "MEDIA_SHTTP_PROTOCOL",
      })
      await until(() => current.sockets.size === 0)
      expect(current.commands).toHaveLength(0)
    }
  )

  it.each([
    "HTTP/1.1 302 Redirect\r\nLocation: http://private.example/secret\r\n\r\n",
    "HTTP/1.1 200 OK\r\n\r\n",
    "HTTP/1.1 100 Continue\r\nTransfer-Encoding: chunked\r\n\r\n",
    "HTTP/1.1 100 Continue\r\nContent-Length: 44\r\n\r\n",
    "HTTP/1.1 100 Continue\r\nContent-Length: 0\r\nContent-Length: 0\r\n\r\n",
  ])(
    "rejects unverified HTTP framing without exposing response text",
    async (header) => {
      const current = await device({
        request(request, socket) {
          if (!request.headers.authorization) challenge(socket)
          else socket.write(header)
        },
      })
      const result = await openShttpReplay(current.config, options).catch(
        (reason: unknown) => reason
      )
      expect(result).toMatchObject({ code: "MEDIA_SHTTP_PROTOCOL" })
      expect(String(result)).not.toMatch(
        /private|secret|Redirect|chunked|127\.0\.0\.1|synthetic/
      )
      expect(current.commands).toHaveLength(0)
    }
  )

  it("caps HTTP header buffering before accepting an endless header", async () => {
    const current = await device({
      request: (_, socket) => {
        socket.write(
          `HTTP/1.1 401 Unauthorized\r\nX-Test: ${"x".repeat(20 * 1024)}`
        )
      },
    })
    await expect(
      openShttpReplay(current.config, options)
    ).rejects.toMatchObject({ code: "MEDIA_SHTTP_LIMIT" })
    await until(() => current.sockets.size === 0)
  })

  it.each([
    codecHeader(head, 41),
    codecHeader(Buffer.from("IMKH")),
    codecHeader(
      Buffer.concat([Buffer.from([0xc9, 0xcd, 0xcb, 0xc8]), Buffer.alloc(36)])
    ),
    codecHeader(Buffer.from("NOPE")),
    packet(19, Buffer.alloc(15)),
    packet(20, ps),
    packet(21),
    packet(99),
  ])("rejects unsupported or malformed initial headers", async (value) => {
    const current = await device({
      command(command, socket) {
        if (command.readUInt32BE(12) === 0x30103) socket.write(value)
      },
    })
    await expect(
      openShttpReplay(current.config, options)
    ).rejects.toMatchObject({ code: "MEDIA_SHTTP_PROTOCOL" })
    await until(() => current.sockets.size === 0)
  })

  it("caps the codec header independently of the media packet limit", async () => {
    const oversized = packet(19, Buffer.alloc(64 * 1024 + 17))
    const current = await device({
      command(command, socket) {
        if (command.readUInt32BE(12) === 0x30103)
          socket.write(oversized.subarray(0, 8))
      },
    })
    await expect(
      openShttpReplay(current.config, options)
    ).rejects.toMatchObject({ code: "MEDIA_SHTTP_PROTOCOL" })
  })

  it.each([
    { bytes: packet(14), code: "MEDIA_SHTTP_DEVICE_ERROR" },
    {
      bytes: packet(77, Buffer.from("private-device-details")),
      code: "MEDIA_SHTTP_PROTOCOL",
    },
    {
      bytes: codecHeader(
        Buffer.concat([Buffer.from("IMKH"), Buffer.alloc(36, 1)])
      ),
      code: "MEDIA_SHTTP_PROTOCOL",
    },
    { bytes: packet(21, Buffer.from([0])), code: "MEDIA_SHTTP_PROTOCOL" },
    { bytes: packet(21), code: "MEDIA_SHTTP_PROTOCOL" },
    { bytes: packet(20), code: "MEDIA_SHTTP_PROTOCOL" },
    {
      bytes: Buffer.from([0, 0, 0, 7, 0, 0, 0, 20]),
      code: "MEDIA_SHTTP_LIMIT",
    },
    {
      bytes: Buffer.from([0, 32, 0, 1, 0, 0, 0, 20]),
      code: "MEDIA_SHTTP_LIMIT",
    },
  ])("fails safely after preparation on $code", async ({ bytes, code }) => {
    const current = await mediaDevice(bytes)
    const replay = await openShttpReplay(current.config, options)
    await expect(readAll(replay.stream)).rejects.toMatchObject({ code })
    expect(await replay.finished).toEqual({ complete: false })
    await until(() => current.sockets.size === 0)
  })

  it.each([
    packet(20, ps),
    packet(20, ps).subarray(0, 11),
    Buffer.from([0, 0, 0]),
  ])(
    "does not mistake early EOF, including partial packets, for completion",
    async (bytes) => {
      const current = await mediaDevice(bytes, true)
      const replay = await openShttpReplay(current.config, options)
      await expect(readAll(replay.stream)).rejects.toMatchObject({
        code: "MEDIA_SHTTP_EARLY_EOF",
      })
      expect(await replay.finished).toEqual({ complete: false })
      await until(() => current.sockets.size === 0)
    }
  )

  it("fails an initial EOF instead of waiting for a complete ACK", async () => {
    const current = await device({
      request(request, socket) {
        if (!request.headers.authorization) challenge(socket)
        else socket.end(Buffer.concat([http100, ack().subarray(0, 20)]))
      },
    })
    await expect(
      openShttpReplay(current.config, options)
    ).rejects.toMatchObject({ code: "MEDIA_SHTTP_EARLY_EOF" })
    expect(current.commands).toHaveLength(0)
  })

  it("honors cancellation before connecting", async () => {
    const current = await device()
    const controller = new AbortController()
    controller.abort(new Error("private-reason"))
    await expect(
      openShttpReplay(current.config, options, controller.signal)
    ).rejects.toMatchObject({ code: "MEDIA_SHTTP_CANCELLED" })
    expect(current.requests).toHaveLength(0)
  })

  it("cancels and closes a pending authentication request", async () => {
    const current = await device({ request() {} })
    const controller = new AbortController()
    const pending = openShttpReplay(current.config, options, controller.signal)
    const rejected = expect(pending).rejects.toMatchObject({
      code: "MEDIA_SHTTP_CANCELLED",
    })
    await until(() => current.requests.length === 1)
    controller.abort(new Error("private-reason"))
    await rejected
    await until(() => current.sockets.size === 0)
  })

  it.each(["abort", "close", "cancel"])(
    "cleans up an active replay on %s",
    async (action) => {
      const current = await mediaDevice(packet(20, ps))
      const controller = new AbortController()
      const replay = await openShttpReplay(
        current.config,
        options,
        controller.signal
      )
      if (action === "abort") controller.abort(new Error("private-reason"))
      else if (action === "close") replay.close()
      else await replay.stream.cancel()
      expect(await replay.finished).toEqual({ complete: false })
      await until(() => current.sockets.size === 0)
      replay.close()
      expect(await replay.finished).toEqual({ complete: false })
      if (action !== "cancel")
        await expect(readAll(replay.stream)).rejects.toMatchObject({
          code: "MEDIA_SHTTP_CANCELLED",
        })
    }
  )

  it("does not expose a raw connection error", async () => {
    const current = await device()
    await new Promise<void>((resolve) => current.server.close(() => resolve()))
    const result = await openShttpReplay(current.config, options).catch(
      (reason: unknown) => reason
    )
    expect(result).toMatchObject({ code: "MEDIA_SHTTP_UNREACHABLE" })
    expect(String(result)).not.toMatch(/127\.0\.0\.1|ECONN|synthetic|SDK/)
  })

  it("enforces the 10-second preparation deadline and clears all timers", async () => {
    const current = await device({ request() {} })
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"],
    })
    const pending = openShttpReplay(current.config, options)
    const rejected = expect(pending).rejects.toMatchObject({
      code: "MEDIA_SHTTP_TIMEOUT",
    })
    await until(() => current.requests.length === 1)
    await vi.advanceTimersByTimeAsync(10_000)
    await rejected
    await until(() => current.sockets.size === 0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it("does not restart the preparation deadline when Digest reconnects", async () => {
    let initial: Socket | undefined
    const current = await device({
      request(request, socket) {
        if (!request.headers.authorization) initial = socket
      },
    })
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"],
    })
    const pending = openShttpReplay(current.config, options)
    const rejected = expect(pending).rejects.toMatchObject({
      code: "MEDIA_SHTTP_TIMEOUT",
    })
    await until(() => initial !== undefined)
    await vi.advanceTimersByTimeAsync(6000)
    challenge(initial!)
    await until(() => current.requests.length === 2)
    await vi.advanceTimersByTimeAsync(4000)
    await rejected
    await until(() => current.sockets.size === 0)
    expect(current.commands).toHaveLength(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it("cancels an in-progress media body without waiting for the declared packet size", async () => {
    const prefix = Buffer.alloc(11)
    prefix.writeUInt32BE(1024 * 1024)
    prefix.writeUInt32BE(20, 4)
    const current = await mediaDevice(prefix)
    const controller = new AbortController()
    const replay = await openShttpReplay(
      current.config,
      options,
      controller.signal
    )
    const pending = readAll(replay.stream)
    const rejected = expect(pending).rejects.toMatchObject({
      code: "MEDIA_SHTTP_CANCELLED",
    })
    await nextTurn()
    controller.abort()
    await rejected
    expect(await replay.finished).toEqual({ complete: false })
    await until(() => current.sockets.size === 0)
  })

  it("times out media inactivity and sends the verified 36-byte heartbeat every three seconds", async () => {
    const current = await mediaDevice(packet(20, ps))
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"],
    })
    const replay = await openShttpReplay(current.config, options)
    const pending = readAll(replay.stream)
    const rejected = expect(pending).rejects.toMatchObject({
      code: "MEDIA_SHTTP_TIMEOUT",
    })
    await nextTurn()
    await vi.advanceTimersByTimeAsync(9000)
    await until(
      () =>
        current.commands.filter((bytes) => bytes.readUInt32BE(12) === 0x30109)
          .length === 3
    )
    const expected = Buffer.alloc(36)
    expected.writeUInt32BE(36)
    expected.writeUInt32BE(0x30109, 12)
    expect(current.commands.slice(1)).toEqual([expected, expected, expected])
    await vi.advanceTimersByTimeAsync(1000)
    await rejected
    expect(await replay.finished).toEqual({ complete: false })
    await until(() => current.sockets.size === 0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it("keeps buffers bounded under backpressure without imposing an idle or short total duration limit", async () => {
    let sent = 0
    let done = false
    const payload = Buffer.alloc(512 * 1024, 7)
    const bytes = packet(20, payload)
    const current = await device({
      command(command, socket) {
        if (command.readUInt32BE(12) !== 0x30103) return
        socket.write(codecHeader())
        const send = () => {
          while (!socket.destroyed && sent < 64) {
            sent++
            if (!socket.write(bytes)) {
              socket.once("drain", send)
              return
            }
          }
          if (!socket.destroyed) {
            done = true
            socket.write(packet(21))
          }
        }
        send()
      },
    })
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"],
    })
    const replay = await openShttpReplay(current.config, options)
    let finished = false
    void replay.finished.then(() => {
      finished = true
    })
    await until(() => sent >= 2)
    for (let turn = 0; turn < 100; turn++) await nextTurn()
    expect(done).toBe(false)
    expect(sent).toBeLessThan(64)
    await vi.advanceTimersByTimeAsync(11 * 60_000)
    expect(finished).toBe(false)
    expect(current.sockets.size).toBe(1)
    const reader = replay.stream.getReader()
    expect(() => replay.stream.getReader()).toThrow()
    let count = 0
    while (true) {
      const value = await reader.read()
      if (value.done) break
      count += value.value.byteLength
    }
    reader.releaseLock()
    expect(count).toBe(head.length + 64 * payload.length)
    expect(await replay.finished).toEqual({ complete: true })
    await until(() => current.sockets.size === 0)
    expect(vi.getTimerCount()).toBe(0)
  })
})
