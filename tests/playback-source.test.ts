import { describe, expect, it } from "vitest"
import { replayRecording } from "../server/playback-source"
import type { RawSegment } from "../server/xml"
import {
  historyTransferRequestSchema,
  previewRequestSchema,
} from "../shared/contracts"

const segment: RawSegment = {
  trackId: "101",
  startAt: "2026-10-28T00:00:00.000Z",
  endAt: "2026-10-28T03:00:00.000Z",
  fileRange: {
    startAt: "2026-10-28T00:00:00.000Z",
    endAt: "2026-10-28T03:00:00.000Z",
  },
  playbackURI:
    "rtsp://nvr.test/Streaming/tracks/101/?starttime=20261028T080000Z&endtime=20261028T110000Z&name=synthetic&size=123",
}

describe("trusted server-side replay window", () => {
  it("starts near the selected tail, not at the beginning of its long file", () => {
    const result = replayRecording(segment, "2026-10-28T02:59:00.500Z")
    expect(result.playbackURI).toBe(segment.playbackURI)
    expect(result.replay).toEqual({
      startAt: "2026-10-28T02:58:58.000Z",
      endAt: segment.endAt,
      requestedAt: "2026-10-28T02:59:00.500Z",
    })
    expect(result).not.toHaveProperty("mediaStartAt")
    expect(result.fileDurationSeconds).toBe(10800)
    expect(result.fileRange).toEqual(segment.fileRange)
  })
  it("never prerolls before the complete file beginning", () => {
    const result = replayRecording(segment)
    expect(result.replay.startAt).toBe(segment.fileRange?.startAt)
    expect(result.replay.requestedAt).toBe(segment.startAt)
  })
  it("keeps a clipped day coverage separate from its full-file download position", () => {
    const result = replayRecording({
      ...segment,
      fileRange: { startAt: "2026-10-27T23:00:00.000Z", endAt: segment.endAt },
    })
    expect(result.replay.startAt).toBe("2026-10-27T23:59:58.000Z")
    expect(result.fileDurationSeconds).toBe(14400)
    expect(result).not.toHaveProperty("mediaStartAt")
  })
  it.each(["invalid", "2026-10-27T23:59:59Z", "2026-10-28T03:00:00Z"])(
    "rejects an invalid or out-of-coverage target %s",
    (at) => {
      expect(() => replayRecording(segment, at)).toThrow(
        expect.objectContaining({ code: "INVALID_PLAYBACK_TIME" })
      )
    }
  )
  it("refuses an unconfirmed full file clock instead of silently playing another time", () => {
    expect(() => replayRecording({ ...segment, fileRange: undefined })).toThrow(
      expect.objectContaining({ code: "MEDIA_CLOCK_UNCONFIRMED" })
    )
  })
  it.each([
    { startAt: "invalid" },
    { endAt: "invalid" },
    { endAt: segment.startAt },
    { fileRange: { startAt: segment.endAt, endAt: segment.startAt } },
    { fileRange: { startAt: segment.endAt, endAt: segment.endAt } },
  ])("rejects invalid trusted ranges %j", (invalid) => {
    expect(() => replayRecording({ ...segment, ...invalid })).toThrow(
      expect.objectContaining({ code: "MEDIA_CLOCK_UNCONFIRMED" })
    )
  })
  it("adds the target only to playback, never to file-relative downloads", () => {
    const source = {
      track: "101",
      date: "2026-10-28",
      segmentId: "a".repeat(32),
      at: segment.startAt,
    }
    expect(previewRequestSchema.parse(source).at).toBe(segment.startAt)
    expect(historyTransferRequestSchema.safeParse(source).success).toBe(false)
  })
})
