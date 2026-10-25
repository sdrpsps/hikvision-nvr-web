import { config } from "dotenv"
import { Temporal } from "@js-temporal/polyfill"
import { recordingsQuerySchema } from "../shared/contracts"
import { readNvrConfig } from "../server/config"
import { openRecordingDownload } from "../server/download"
import { AppError } from "../server/errors"
import { NvrService, validatePlaybackUri } from "../server/recordings"
import { dayRange } from "../server/time"
import type { RawSegment } from "../server/xml"

// No media bytes, file identifiers, headers, or credentials are printed or saved.
// Read only a bounded prefix, sufficient to inspect the container clock structure.
const PREFIX_BYTES = 2 * 1024 ** 2
const round = (value: number) => Math.round(value * 1_000_000) / 1_000_000

function pts(data: Buffer, offset: number) {
  return (
    ((data[offset] & 14) * 536_870_912 +
      data[offset + 1] * 4_194_304 +
      (data[offset + 2] & 254) * 16_384 +
      data[offset + 3] * 128 +
      (data[offset + 4] & 254) / 2) /
    90_000
  )
}

function inspectPrefix(data: Buffer, nearDate: string) {
  const videoPts: number[] = []
  const audioPts: number[] = []
  const audioPayloadSizes: number[] = []
  const privatePayloadSizes = new Set<number>()
  const streams: {
    streamId: number
    streamType: number
    descriptorBytes: number
  }[] = []
  let privateDateCandidates = 0
  for (let offset = 0; offset + 16 < data.length; offset++) {
    if (data[offset] || data[offset + 1] || data[offset + 2] !== 1) continue
    const stream = data[offset + 3]
    const packetEnd = offset + 6 + data.readUInt16BE(offset + 4)
    if (packetEnd > data.length) continue
    if (stream === 0xbc && !streams.length) {
      let position = offset + 10 + data.readUInt16BE(offset + 8)
      if (position + 2 > packetEnd) continue
      const end = position + 2 + data.readUInt16BE(position)
      position += 2
      while (position + 4 <= Math.min(end, packetEnd)) {
        const descriptorBytes = data.readUInt16BE(position + 2)
        streams.push({
          streamType: data[position],
          streamId: data[position + 1],
          descriptorBytes,
        })
        position += 4 + descriptorBytes
      }
    }
    if (!((stream >= 0xc0 && stream <= 0xef) || stream === 0xbd)) continue
    if ((data[offset + 6] & 0xc0) !== 0x80) continue
    const start = offset + 9 + data[offset + 8]
    if (start > packetEnd) continue
    const timestamp =
      data[offset + 7] & 0x80 && data[offset + 8] >= 5
        ? pts(data, offset + 9)
        : undefined
    if (stream >= 0xe0 && timestamp !== undefined && videoPts.length < 12)
      videoPts.push(timestamp)
    if (stream >= 0xc0 && stream <= 0xdf && audioPts.length < 12) {
      audioPayloadSizes.push(packetEnd - start)
      if (timestamp !== undefined) audioPts.push(timestamp)
    }
    if (stream === 0xbd) {
      privatePayloadSizes.add(packetEnd - start)
      // This is a limited diagnostic, not a specification of the private format.
      // Check a common Hikvision packed date layout near the queried day only.
      for (let position = start; position + 4 <= packetEnd; position++) {
        for (const value of [
          data.readUInt32LE(position),
          data.readUInt32BE(position),
        ]) {
          const year = 2000 + (value >>> 26)
          const month = (value >>> 22) & 15
          const day = (value >>> 17) & 31
          const hour = (value >>> 12) & 31
          const minute = (value >>> 6) & 63
          const second = value & 63
          if (
            Math.abs(
              Date.UTC(year, month - 1, day, hour, minute, second) -
                Date.parse(nearDate)
            ) <
              2 * 86400_000 &&
            month >= 1 &&
            month <= 12 &&
            day >= 1 &&
            day <= 31 &&
            hour < 24 &&
            minute < 60 &&
            second < 60
          )
            privateDateCandidates++
        }
      }
    }
  }
  return {
    imkhHeader: data.subarray(0, 4).equals(Buffer.from("IMKH")),
    firstPsOffset: data.indexOf(Buffer.from([0, 0, 1, 0xba])),
    streams,
    firstVideoPtsSeconds: videoPts[0] === undefined ? null : round(videoPts[0]),
    videoPtsIntervalsSeconds: videoPts
      .slice(1)
      .map((value, index) => round(value - videoPts[index])),
    firstAudioOffsetFromVideoSeconds:
      audioPts[0] === undefined || videoPts[0] === undefined
        ? null
        : round(audioPts[0] - videoPts[0]),
    audioPtsIntervalsSeconds: audioPts
      .slice(1)
      .map((value, index) => round(value - audioPts[index])),
    audioPayloadSizes,
    privatePayloadSizes: [...privatePayloadSizes],
    commonPackedDateCandidatesInPrivatePayload: privateDateCandidates,
  }
}

async function readPrefix(segment: RawSegment, service: NvrService) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 15_000)
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  try {
    const response = await openRecordingDownload(
      segment.playbackURI,
      service.config,
      controller.signal
    )
    reader = response.body!.getReader()
    const chunks: Uint8Array[] = []
    let bytes = 0
    while (bytes < PREFIX_BYTES) {
      const next = await reader.read()
      if (next.done) break
      const chunk = next.value.subarray(0, PREFIX_BYTES - bytes)
      chunks.push(chunk)
      bytes += chunk.length
    }
    return {
      bytesRead: bytes,
      ...inspectPrefix(Buffer.concat(chunks), segment.startAt),
    }
  } finally {
    controller.abort()
    await reader?.cancel().catch(() => {})
    clearTimeout(timer)
  }
}

config({ quiet: true })
try {
  const query = recordingsQuerySchema.safeParse({
    track: process.argv[2],
    date: process.argv[3],
  })
  if (!query.success || process.argv.length !== 4)
    throw new AppError(
      "INVALID_ARGUMENTS",
      400,
      "用法：pnpm exec tsx scripts/diagnose-media-clock.ts <track> <YYYY-MM-DD>"
    )
  const service = new NvrService(readNvrConfig())
  const segments = await service.queryRaw(query.data.track, query.data.date)
  if (!segments.length)
    throw new AppError("RECORDING_NOT_FOUND", 404, "指定日期没有录像。")
  const range = dayRange(query.data.date, service.config.NVR_TIME_ZONE)
  const previous =
    Date.parse(segments[0].startAt) <= Date.parse(range.startAt)
      ? await service.queryRaw(
          query.data.track,
          Temporal.PlainDate.from(query.data.date)
            .subtract({ days: 1 })
            .toString()
        )
      : []
  const sameFile = (a: RawSegment, b: RawSegment) => {
    const left = validatePlaybackUri(a.playbackURI, service.config).searchParams
    const right = validatePlaybackUri(
      b.playbackURI,
      service.config
    ).searchParams
    return (
      !!left.get("name") &&
      !!left.get("size") &&
      left.get("name") === right.get("name") &&
      left.get("size") === right.get("size")
    )
  }
  const indexes = [
    ...new Set([
      0,
      Math.min(1, segments.length - 1),
      Math.floor(segments.length / 2),
    ]),
  ]
  const samples: Array<
    {
      index: number
      searchStartAt: string
      searchEndAt: string
      fullLabelStartAt: string
      matchedPreviousDay: boolean
      filenameHasCompactTimestamp: boolean
    } & Awaited<ReturnType<typeof readPrefix>>
  > = []
  for (const index of indexes) {
    const segment = segments[index]
    const matches = previous.filter((candidate) => sameFile(segment, candidate))
    const fullLabelStart = [segment, ...matches].reduce(
      (earliest, item) =>
        Date.parse(item.startAt) < Date.parse(earliest)
          ? item.startAt
          : earliest,
      segment.startAt
    )
    const name =
      validatePlaybackUri(segment.playbackURI, service.config).searchParams.get(
        "name"
      ) ?? ""
    samples.push({
      index,
      searchStartAt: segment.startAt,
      searchEndAt: segment.endAt,
      fullLabelStartAt: fullLabelStart,
      matchedPreviousDay: matches.length > 0,
      filenameHasCompactTimestamp: /(?:19|20)\d{12}/.test(name),
      ...(await readPrefix(segment, service)),
    })
  }
  const comparisons = samples.slice(1).map((sample, index) => {
    const prior = samples[index]
    const labelDifference =
      (Date.parse(sample.fullLabelStartAt) -
        Date.parse(prior.fullLabelStartAt)) /
      1000
    const ptsDifference =
      sample.firstVideoPtsSeconds === null ||
      prior.firstVideoPtsSeconds === null
        ? null
        : sample.firstVideoPtsSeconds - prior.firstVideoPtsSeconds
    return {
      fromIndex: prior.index,
      toIndex: sample.index,
      labelDifferenceSeconds: round(labelDifference),
      ptsDifferenceSeconds:
        ptsDifference === null ? null : round(ptsDifference),
      differenceSeconds:
        ptsDifference === null ? null : round(labelDifference - ptsDifference),
    }
  })
  console.log(
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        track: query.data.track,
        date: query.data.date,
        samples,
        comparisons,
        mediaAnchorVerified: false,
        mediaSavedToDisk: false,
        note: "PTS差与文件标签差相近只能支持时基一致；不能独立证明绝对媒体时间。私有字段未识别不等于不存在时间字段。",
      },
      null,
      2
    )
  )
} catch (error) {
  console.error(
    JSON.stringify(
      error instanceof AppError
        ? { code: error.code, message: error.message }
        : {
            code: "MEDIA_CLOCK_DIAGNOSTIC_FAILED",
            message: "媒体时钟诊断失败，内部详情已隐藏。",
          }
    )
  )
  process.exitCode = 1
}
