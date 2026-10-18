import { config } from "dotenv"
import { recordingsQuerySchema } from "../shared/contracts"
import { readNvrConfig } from "../server/config"
import { NvrService } from "../server/recordings"
import { AppError } from "../server/errors"
import { probeMedia } from "../server/rtsp-diagnostics"
import { probeRtspControl } from "../server/rtsp-control"
import { parseDownloadCapabilities } from "../server/xml"

config({ quiet: true })
const controller = new AbortController()
process.once("SIGINT", () => {
  controller.abort()
  process.exitCode = 130
})
process.once("SIGTERM", () => {
  controller.abort()
  process.exitCode = 143
})
const query = recordingsQuerySchema.safeParse({
  track: process.argv[2],
  date: process.argv[3],
})
const index = Number(process.argv[4] ?? 0)
if (!query.success || !Number.isSafeInteger(index) || index < 0) {
  console.error(
    "用法：pnpm diagnose:rtsp <track> <YYYY-MM-DD> [segmentIndex=0]"
  )
  process.exitCode = 1
} else {
  try {
    const settings = readNvrConfig(),
      service = new NvrService(settings)
    const segments = await service.queryRaw(query.data.track, query.data.date)
    const segment = segments[index]
    if (!segment)
      throw new AppError("NO_SEGMENT", 404, "此日期或片段序号没有录像。")
    console.log(
      JSON.stringify({
        event: "baseline",
        checkedAt: new Date().toISOString(),
        track: query.data.track,
        date: query.data.date,
        segmentIndex: index,
        startAt: segment.startAt,
        endAt: segment.endAt,
        rawUriPreserved: true,
      })
    )
    console.log(
      JSON.stringify({
        event: "direct-control",
        variant: "original",
        ...(await probeRtspControl(segment.playbackURI, settings)),
      })
    )
    if (process.argv.includes("--live-control")) {
      const live = `rtsp://${settings.NVR_HOST}:${settings.NVR_RTSP_PORT}/Streaming/Channels/${query.data.track}`
      console.log(
        JSON.stringify({
          event: "live-control",
          ...(await probeRtspControl(live, settings)),
        })
      )
    }
    const run = async (
      uri: string,
      variant: string,
      transport: "tcp" | "udp",
      auth: "none" | "username" | "credentials",
      tool: "ffprobe" | "ffmpeg" = "ffprobe"
    ) => {
      if (controller.signal.aborted)
        throw new AppError("DIAGNOSTIC_STOPPED", 503, "诊断已停止。")
      const result = await probeMedia(uri, settings, {
        tool,
        transport,
        auth,
        signal: controller.signal,
        executable:
          process.env[tool === "ffprobe" ? "FFPROBE_PATH" : "FFMPEG_PATH"],
      })
      if (controller.signal.aborted)
        throw new AppError("DIAGNOSTIC_STOPPED", 503, "诊断已停止。")
      console.log(JSON.stringify({ event: "probe", variant, auth, ...result }))
      if (result.unavailable)
        throw new AppError(
          "TOOL_UNAVAILABLE",
          503,
          "请在本机安装 FFmpeg/ffprobe 后重试。"
        )
      return result
    }
    await run(segment.playbackURI, "original", "tcp", "none")
    await run(segment.playbackURI, "original", "tcp", "username")
    const tcp = await run(segment.playbackURI, "original", "tcp", "credentials")
    const udp = await run(segment.playbackURI, "original", "udp", "credentials")
    let candidate:
      { uri: string; variant: string; transport: "tcp" | "udp" } | undefined
    if (tcp.exitCode === 0 && tcp.streams.some((s) => (s.frames ?? 0) > 0))
      candidate = {
        uri: segment.playbackURI,
        variant: "original",
        transport: "tcp",
      }
    else if (udp.exitCode === 0 && udp.streams.some((s) => (s.frames ?? 0) > 0))
      candidate = {
        uri: segment.playbackURI,
        variant: "original",
        transport: "udp",
      }
    if (!candidate) {
      // Each variant changes one variable from the original search result.
      const withoutSlash = segment.playbackURI.replace(/\/(\?)/, "$1")
      const withoutMetadata = segment.playbackURI
        .replace(/([?&])(name|size)=[^&]*&?/g, "$1")
        .replace(/[?&]$/, "")
      const isapi = segment.playbackURI.replace(
        "/Streaming/",
        "/ISAPI/Streaming/"
      )
      for (const [variant, uri] of [
        ["remove-trailing-slash", withoutSlash],
        ["remove-name-size", withoutMetadata],
        ["isapi-path", isapi],
      ]) {
        if (uri === segment.playbackURI) continue
        const result = await run(uri, variant, "tcp", "credentials")
        if (
          result.exitCode === 0 &&
          result.streams.some((s) => (s.frames ?? 0) > 0)
        ) {
          candidate = { uri, variant, transport: "tcp" }
          break
        }
      }
    }
    if (candidate) {
      const decoded = await run(
        candidate.uri,
        candidate.variant,
        candidate.transport,
        "credentials",
        "ffmpeg"
      )
      console.log(
        JSON.stringify({
          event: "decode-verdict",
          decoded: decoded.exitCode === 0 && decoded.decodedFrames > 0,
          arbitraryStartVerified: false,
          browserPlaybackVerified: false,
        })
      )
      // Decoding one segment does not yet verify arbitrary start behavior.
      process.exitCode =
        decoded.exitCode === 0 && decoded.decodedFrames > 0 ? 0 : 2
    } else {
      const minimal = segment.playbackURI
        .replace(/([?&])(name|size)=[^&]*&?/g, "$1")
        .replace(/[?&]$/, "")
        .replace(/\/(\?)/, "$1")
      const plusMinute = segment.playbackURI.replace(
        /starttime=\d{8}T\d{6}Z/,
        `starttime=${new Date(Date.parse(segment.startAt) + 60000)
          .toISOString()
          .replace(/[-:]/g, "")
          .replace(/\.\d{3}Z$/, "Z")}`
      )
      for (const [variant, parentVariant, uri] of [
        ["minimal", "remove-name-size", minimal],
        ["start-plus-60-seconds", "original", plusMinute],
        ...(segments[index + 1]
          ? [["next-segment", "original", segments[index + 1].playbackURI]]
          : []),
      ]) {
        console.log(
          JSON.stringify({
            event: "direct-control",
            variant,
            parentVariant,
            ...(await probeRtspControl(uri, settings)),
          })
        )
      }
      const capability = await service.client
        .request("/ISAPI/ContentMgmt/download/capabilities")
        .then(parseDownloadCapabilities)
        .catch(() => undefined)
      console.log(
        JSON.stringify({
          event: "download-capability",
          ...(capability ?? { available: false }),
          actualDownloadVerified: false,
        })
      )
      console.log(
        JSON.stringify({
          event: "blocked",
          reason:
            "没有获得可读取的视频帧；请根据 RTSP 阶段状态核对权限、时间与会话。",
          browserPlaybackVerified: false,
        })
      )
      process.exitCode = 2
    }
  } catch (error) {
    console.error(
      JSON.stringify(
        error instanceof AppError
          ? { code: error.code, message: error.message }
          : {
              code: "DIAGNOSTIC_FAILED",
              message: "诊断未完成，内部详情已隐藏。",
            }
      )
    )
    process.exitCode = 1
  }
}
