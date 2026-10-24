import { config } from "dotenv"
import { recordingsQuerySchema } from "../shared/contracts"
import { readNvrConfig } from "../server/config"
import { NvrService } from "../server/recordings"
import { PlaybackSessions } from "../server/playback"
import { AppError } from "../server/errors"

config({ quiet: true })
const sessions = new PlaybackSessions()
try {
  const query = recordingsQuerySchema.parse({
    track: process.argv[2],
    date: process.argv[3],
  })
  const service = new NvrService(readNvrConfig())
  const segments = await service.queryRaw(query.track, query.date)
  const segment = [...segments].sort(
    (a, b) =>
      Date.parse(a.endAt) -
      Date.parse(a.startAt) -
      (Date.parse(b.endAt) - Date.parse(b.startAt))
  )[0]
  if (!segment) throw new AppError("RECORDING_NOT_FOUND", 404, "未找到录像。")
  const start = Date.now()
  const session = await sessions.create(
    service.config,
    async () => segment,
    new AbortController().signal
  )
  const startupMs = Date.now() - start
  while (!sessions.status(session.id).complete)
    await new Promise((resolve) => setTimeout(resolve, 500))
  const status = sessions.status(session.id)
  const audio = await sessions.audio(session.id, -1, 0)
  const tailAudio = await sessions.audio(
    session.id,
    -1,
    Math.max(0, status.durationSeconds - 1)
  )
  console.log(
    JSON.stringify({
      mode: session.mode,
      codec: session.codec,
      startupMs,
      durationSeconds: status.durationSeconds,
      complete: status.complete,
      segments: (sessions.playlist(session.id).match(/#EXTINF/g) ?? []).length,
      audioStatus: audio.status,
      audioFormats: [
        ...new Set(
          audio.chunks.map(
            (chunk) => `${chunk.codec}/${chunk.sampleRate}/${chunk.channels}`
          )
        ),
      ],
      tailAudioChunks: tailAudio.chunks.length,
      decodedOnServer: false,
      elapsedMs: Date.now() - start,
    })
  )
  await sessions.delete(session.id)
  console.log(JSON.stringify({ released: true }))
} catch (error) {
  console.error(
    JSON.stringify(
      error instanceof AppError
        ? { code: error.code, message: error.message }
        : { code: "VERIFICATION_FAILED", message: "验证失败，详情已隐藏。" }
    )
  )
  process.exitCode = 1
} finally {
  await sessions.dispose()
}
