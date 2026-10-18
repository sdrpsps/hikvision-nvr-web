import { createConnection } from "node:net"
import type { NvrConfig } from "./config"
import { digestAuthorization, parseChallenge, type Challenge } from "./digest"
import { validatePlaybackUri } from "./recordings"

// Direct RTSP control probe. Never returns raw headers, SDP, URI or payload.
export async function probeRtspControl(uri: string, config: NvrConfig) {
  validatePlaybackUri(uri, config)
  const stages: { method: string; status: number }[] = []
  const socket = createConnection({
    host: config.NVR_HOST.replace(/^\[|\]$/g, ""),
    port: config.NVR_RTSP_PORT,
  })
  let buffer = Buffer.alloc(0),
    sequence = 0,
    challenge: Challenge | undefined
  let pending:
    | {
        resolve: (value: {
          status: number
          headers: Record<string, string>
          body: string
        }) => void
        reject: (error: Error) => void
      }
    | undefined
  const fail = () => {
    pending?.reject(new Error("RTSP_CONNECTION_FAILED"))
    pending = undefined
  }
  socket.on("error", fail)
  socket.on("close", fail)
  socket.setTimeout(config.NVR_TIMEOUT_MS, () => {
    fail()
    socket.destroy()
  })
  socket.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk])
    if (buffer.length > 1024 * 1024) {
      fail()
      socket.destroy()
      return
    }
    const end = buffer.indexOf("\r\n\r\n")
    if (end < 0) return
    const lines = buffer.subarray(0, end).toString().split("\r\n")
    const headers: Record<string, string> = {}
    for (const line of lines.slice(1)) {
      const colon = line.indexOf(":")
      if (colon > 0) {
        const key = line.slice(0, colon).toLowerCase(),
          value = line.slice(colon + 1).trim()
        if (key !== "www-authenticate" || !headers[key]?.startsWith("Digest"))
          headers[key] = value
      }
    }
    const length = Number(headers["content-length"] ?? 0)
    if (!Number.isSafeInteger(length) || length < 0 || length > 1024 * 1024) {
      fail()
      socket.destroy()
      return
    }
    if (buffer.length < end + 4 + length) return
    const body = buffer.subarray(end + 4, end + 4 + length).toString()
    buffer = buffer.subarray(end + 4 + length)
    const current = pending
    pending = undefined
    current?.resolve({ status: Number(lines[0].split(" ")[1]), headers, body })
  })
  const request = async (method: string) => {
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await new Promise<{
        status: number
        headers: Record<string, string>
        body: string
      }>((resolve, reject) => {
        pending = { resolve, reject }
        const auth = challenge
          ? `Authorization: ${digestAuthorization(challenge, config.NVR_USERNAME, config.NVR_PASSWORD, method, uri)}\r\n`
          : ""
        socket.write(
          `${method} ${uri} RTSP/1.0\r\nCSeq: ${++sequence}\r\nUser-Agent: NvrReadOnlyDiagnostic/1.0\r\n${method === "DESCRIBE" ? "Accept: application/sdp\r\n" : ""}${auth}\r\n`
        )
      })
      stages.push({ method, status: response.status })
      if (response.status !== 401)
        return {
          status: response.status,
          sdpReceived: response.body.startsWith("v=0"),
        }
      challenge = parseChallenge(response.headers["www-authenticate"] ?? null)
    }
    return { status: 401, sdpReceived: false }
  }
  try {
    const options = await request("OPTIONS")
    const describe =
      options.status === 200 ? await request("DESCRIBE") : undefined
    return {
      stages,
      sdpReceived: describe?.sdpReceived ?? false,
      connected: true,
    }
  } catch {
    return { stages, sdpReceived: false, connected: false }
  } finally {
    socket.destroy()
  }
}
