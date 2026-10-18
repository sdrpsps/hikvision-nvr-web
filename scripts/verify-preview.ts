import { config } from "dotenv"
import { recordingsQuerySchema } from "../shared/contracts"
import { readNvrConfig } from "../server/config"
import { NvrService } from "../server/recordings"
import { remuxRecording } from "../server/remux"
import { AppError } from "../server/errors"
config({ quiet: true })
try {
  const query = recordingsQuerySchema.parse({
    track: process.argv[2],
    date: process.argv[3],
  })
  const service = new NvrService(readNvrConfig())
  const segment = (await service.queryRaw(query.track, query.date))[0]
  if (!segment) throw new AppError("RECORDING_NOT_FOUND", 404, "未找到录像。")
  const media = await remuxRecording(
    segment.playbackURI,
    service.config,
    new AbortController().signal
  )
  console.log(
    JSON.stringify({
      mode: "stream-copy",
      durationSeconds: media.durationSeconds,
      initBytes: media.init.length,
      mediaBytes: media.media.length,
      decodedOnServer: false,
      metadataCodec: segment.codec,
      codec: media.codec,
    })
  )
} catch (error) {
  console.error(
    JSON.stringify(
      error instanceof AppError
        ? { code: error.code, message: error.message }
        : { code: "VERIFICATION_FAILED", message: "验证失败，详情已隐藏。" }
    )
  )
  process.exitCode = 1
}
