import { spawn } from "node:child_process"
import { mkdtemp, writeFile, rm } from "node:fs/promises"
import { rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { NvrConfig } from "./config"
import { validatePlaybackUri } from "./recordings"

export type ProbeResult = {
  tool: "ffprobe" | "ffmpeg"
  transport: "tcp" | "udp"
  exitCode: number | null
  timedOut: boolean
  unavailable: boolean
  stages: { method: string; status: number }[]
  challenges: string[]
  decodedFrames: number
  streams: {
    codec?: string
    width?: number
    height?: number
    frames?: number
  }[]
}
export function summarizeTrace(trace: string) {
  let method = "UNKNOWN"
  const stages: ProbeResult["stages"] = []
  const challenges = new Set<string>()
  for (const line of trace.split(/\r?\n/)) {
    const request = line.match(
      /\b(OPTIONS|DESCRIBE|SETUP|PLAY|TEARDOWN|GET_PARAMETER) rtsp:/
    )
    if (request) method = request[1]
    const status = line.match(/RTSP\/1\.0 (\d{3})/)
    if (status) stages.push({ method, status: Number(status[1]) })
    const failed = line.match(
      /method (OPTIONS|DESCRIBE|SETUP|PLAY) failed: (\d{3})/
    )
    if (failed) stages.push({ method: failed[1], status: Number(failed[2]) })
    if (/WWW-Authenticate:\s*Digest/i.test(line)) challenges.add("Digest")
    if (/WWW-Authenticate:\s*Basic/i.test(line)) challenges.add("Basic")
  }
  return { stages, challenges: [...challenges] }
}

export async function probeMedia(
  rawUri: string,
  config: NvrConfig,
  options: {
    tool: "ffprobe" | "ffmpeg"
    transport: "tcp" | "udp"
    auth: "none" | "username" | "credentials"
    timeoutMs?: number
    executable?: string
    signal?: AbortSignal
  }
): Promise<ProbeResult> {
  const url = validatePlaybackUri(rawUri, config)
  let input = rawUri
  if (options.auth !== "none") {
    // URI credentials live only in a private, short-lived local manifest, never argv.
    url.username = encodeURIComponent(config.NVR_USERNAME).replace(/'/g, "%27")
    if (options.auth === "credentials")
      url.password = encodeURIComponent(config.NVR_PASSWORD).replace(
        /'/g,
        "%27"
      )
    const originEnd = rawUri.indexOf("/", "rtsp://".length)
    input = `${url.protocol}//${url.username}${url.password ? `:${url.password}` : ""}@${rawUri.slice(7, originEnd < 0 ? undefined : originEnd)}${originEnd < 0 ? "/" : rawUri.slice(originEnd)}`
  }
  const folder = await mkdtemp(join(tmpdir(), "nvr-rtsp-"))
  const cleanupOnExit = () => rmSync(folder, { recursive: true, force: true })
  process.once("exit", cleanupOnExit)
  const file = join(folder, "input.ffconcat")
  const quote = (value: string) => value.replace(/'/g, "'\\''")
  try {
    await writeFile(
      file,
      `ffconcat version 1.0\nfile '${quote(input)}'\noption rtsp_transport ${options.transport}\noption timeout 8000000\n`,
      { mode: 0o600 }
    )
    const common = [
      "-v",
      "trace",
      "-protocol_whitelist",
      "file,rtsp,tcp,udp,rtp,crypto",
      "-f",
      "concat",
      "-safe",
      "0",
      "-i",
      file,
    ]
    const args =
      options.tool === "ffprobe"
        ? [
            ...common,
            "-read_intervals",
            "%+3",
            "-count_frames",
            "-select_streams",
            "v:0",
            "-show_entries",
            "stream=codec_name,width,height,nb_read_frames",
            "-of",
            "json",
          ]
        : [
            "-nostdin",
            ...common,
            "-map",
            "0:v:0",
            "-frames:v",
            "3",
            "-an",
            "-f",
            "null",
            "-",
            "-progress",
            "pipe:1",
          ]
    return await new Promise((resolve) => {
      const child = spawn(options.executable || options.tool, args, {
        stdio: ["ignore", "pipe", "pipe"],
        shell: false,
      })
      const abort = () => child.kill("SIGKILL")
      options.signal?.addEventListener("abort", abort, { once: true })
      if (options.signal?.aborted) abort()
      let stdout = "",
        stderr = "",
        timedOut = false,
        unavailable = false
      const timer = setTimeout(() => {
        timedOut = true
        child.kill("SIGKILL")
      }, options.timeoutMs ?? 25000)
      const collect = (type: "out" | "err", chunk: Buffer) => {
        if (type === "out") stdout += chunk.toString()
        else stderr += chunk.toString()
        // Bound sensitive in-memory trace and stop on output floods.
        if (stdout.length + stderr.length > 4 * 1024 * 1024) {
          child.kill("SIGKILL")
          timedOut = true
        }
      }
      child.stdout.on("data", (chunk) => collect("out", chunk))
      child.stderr.on("data", (chunk) => collect("err", chunk))
      child.on("error", () => {
        unavailable = true
      })
      child.on("close", (exitCode) => {
        clearTimeout(timer)
        options.signal?.removeEventListener("abort", abort)
        const streams: ProbeResult["streams"] = []
        if (options.tool === "ffprobe") {
          try {
            const data = JSON.parse(stdout) as {
              streams?: {
                codec_name?: string
                width?: number
                height?: number
                nb_read_frames?: string
              }[]
            }
            for (const stream of data.streams ?? [])
              streams.push({
                codec: stream.codec_name?.replace(/[^\w-]/g, "").slice(0, 32),
                width: stream.width,
                height: stream.height,
                frames: Number(stream.nb_read_frames) || 0,
              })
          } catch {
            /* No raw process output escapes this module. */
          }
        }
        const frames = [...stdout.matchAll(/^frame=(\d+)$/gm)].map((match) =>
          Number(match[1])
        )
        resolve({
          tool: options.tool,
          transport: options.transport,
          exitCode,
          timedOut,
          unavailable,
          ...summarizeTrace(stderr),
          decodedFrames: options.tool === "ffmpeg" ? Math.max(0, ...frames) : 0,
          streams,
        })
      })
    })
  } finally {
    await rm(folder, { recursive: true, force: true })
    process.removeListener("exit", cleanupOnExit)
  }
}
