import { spawn, type ChildProcess } from "node:child_process"
import { config } from "dotenv"
import { readNvrConfig } from "../server/config"
import { AppError } from "../server/errors"
import { LiveSessions, MAX_LIVE_SESSIONS } from "../server/live"
import { NvrService } from "../server/recordings"

// Short, read-only LAN diagnostic. Keep private media in bounded memory only;
// never log FFmpeg arguments, device names, addresses, credentials or payloads.
config({ quiet: true })
const controller = new AbortController()
const children = new Set<ChildProcess>()
const sessions = new LiveSessions((args) => {
  const child = spawn(process.env.FFMPEG_PATH || "ffmpeg", args, {
    stdio: ["ignore", "pipe", "pipe", "pipe"],
    shell: false,
  })
  children.add(child)
  child.once("close", () => children.delete(child))
  return child
})
const stop = () => controller.abort()
process.once("SIGINT", stop)
process.once("SIGTERM", stop)
const count = Number(process.argv[2] ?? MAX_LIVE_SESSIONS)
const seconds = Number(process.argv[3] ?? 30)

try {
  if (
    process.argv.length > 4 ||
    !Number.isInteger(count) ||
    count < 1 ||
    count > MAX_LIVE_SESSIONS ||
    !Number.isInteger(seconds) ||
    seconds < 5 ||
    seconds > 120
  )
    throw new AppError(
      "INVALID_ARGUMENT",
      400,
      "用法：pnpm verify:live-wall [路数 1–16，默认 16] [观察秒数 5–120，默认 30]"
    )
  const settings = readNvrConfig()
  const service = new NvrService(settings)
  const channels = await service.channels()
  if (channels.length < count)
    throw new AppError("NOT_ENOUGH_CHANNELS", 400, "设备通道数量不足。")
  const start = Date.now()
  const results = await Promise.allSettled(
    channels.slice(0, count).map(async (channel) => {
      const session = await sessions.create(
        settings,
        async () => channel.id,
        controller.signal
      )
      return { session, startupMs: Date.now() - start }
    })
  )
  const ready = results.flatMap((result) =>
    result.status === "fulfilled" ? [result.value] : []
  )
  const failures: Record<string, number> = {}
  for (const result of results)
    if (result.status === "rejected") {
      const code =
        result.reason instanceof AppError
          ? result.reason.code
          : "VERIFICATION_FAILED"
      failures[code] = (failures[code] ?? 0) + 1
    }
  console.log(
    JSON.stringify({
      event: "live-wall-ready",
      requested: count,
      ready: ready.length,
      failures,
      maxStartupMs: Math.max(0, ...ready.map((item) => item.startupMs)),
      codecs: [...new Set(ready.map((item) => item.session.codec))],
      decodedOnServer: false,
    })
  )
  const previous = new Map<string, number>()
  const advanced = new Set<string>()
  const interrupted = new Set<string>()
  const observeUntil = Date.now() + seconds * 1000
  while (
    ready.length &&
    Date.now() < observeUntil &&
    !controller.signal.aborted
  ) {
    for (const { session } of ready) {
      if (interrupted.has(session.id)) continue
      try {
        const playlist = sessions.playlist(session.id)
        const sequences = [...playlist.matchAll(/^([0-9]+)\.m4s$/gm)].map(
          (match) => Number(match[1])
        )
        const latest = sequences.at(-1)!
        const before = previous.get(session.id)
        if (before !== undefined && latest > before) advanced.add(session.id)
        previous.set(session.id, latest)
        sessions.asset(session.id, `${latest}.m4s`)
      } catch {
        interrupted.add(session.id)
      }
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(done, 500)
      function done() {
        clearTimeout(timer)
        controller.signal.removeEventListener("abort", done)
        resolve()
      }
      controller.signal.addEventListener("abort", done, { once: true })
      if (controller.signal.aborted) done()
    })
  }
  const healthy = ready.filter(({ session }) => !interrupted.has(session.id))
  console.log(
    JSON.stringify({
      event: "live-wall-observed",
      observationSeconds: seconds,
      healthy: healthy.length,
      advancing: advanced.size,
      interrupted: interrupted.size,
      cancelled: controller.signal.aborted,
      audioAvailable: healthy.filter(
        ({ session }) => sessions.audio(session.id, -1).status === "available"
      ).length,
      browserDecodeVerified: false,
    })
  )
  // Recheck failed channels one at a time after releasing every concurrent
  // stream. This distinguishes the observation from a claimed 16-way limit;
  // it does not assume a rejected stream means its camera is offline.
  sessions.dispose()
  const controls = {
    checked: 0,
    ready: 0,
    failures: {} as Record<string, number>,
  }
  for (let index = 0; index < results.length; index++) {
    if (results[index].status !== "rejected" || controller.signal.aborted)
      continue
    controls.checked++
    try {
      const session = await sessions.create(
        settings,
        async () => channels[index].id,
        controller.signal
      )
      controls.ready++
      sessions.delete(session.id)
    } catch (error) {
      const code =
        error instanceof AppError ? error.code : "VERIFICATION_FAILED"
      controls.failures[code] = (controls.failures[code] ?? 0) + 1
    }
  }
  if (controls.checked)
    console.log(
      JSON.stringify({ event: "failed-channel-single-controls", ...controls })
    )
  if (
    ready.length !== count ||
    interrupted.size ||
    advanced.size !== count ||
    controller.signal.aborted
  )
    process.exitCode = 1
} catch (error) {
  console.error(
    JSON.stringify(
      error instanceof AppError
        ? { code: error.code, message: error.message }
        : { code: "VERIFICATION_FAILED", message: "验证失败，内部详情已隐藏。" }
    )
  )
  process.exitCode = 1
} finally {
  controller.abort()
  sessions.dispose()
  const deadline = Date.now() + 5000
  while (children.size && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 50))
  console.log(
    JSON.stringify({ event: "released", remainingChildren: children.size })
  )
  if (children.size) process.exitCode = 1
  process.removeListener("SIGINT", stop)
  process.removeListener("SIGTERM", stop)
}
