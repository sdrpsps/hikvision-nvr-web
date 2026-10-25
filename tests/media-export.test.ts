import { spawnSync } from "node:child_process"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  FragmentedMp4Demuxer,
  MatroskaMuxer,
  MpegPsDemuxer,
  type EncodedPacket,
} from "../lib/media-export"

const roots: string[] = []
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  )
})
function tool(name: string, args: string[]) {
  const result = spawnSync(name, args, {
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  })
  if (result.status !== 0) throw new Error(`${name} failed: ${result.stderr}`)
  return result.stdout
}
async function directory() {
  const root = await mkdtemp(join(tmpdir(), "hikvision-export-synthetic-"))
  roots.push(root)
  return root
}
async function demuxFixture(name: string) {
  const bytes = await readFile(new URL(`../fixtures/${name}`, import.meta.url))
  const demuxer = new FragmentedMp4Demuxer(),
    packets: EncodedPacket[] = []
  for (let at = 0; at < bytes.length; at += 157)
    packets.push(...demuxer.push(bytes.subarray(at, at + 157)))
  packets.push(...demuxer.finish())
  return packets
}
async function mux(packets: EncodedPacket[], path: string, sequential = false) {
  // This buffer is deliberately limited to small synthetic test fixtures. The
  // production writer is the user's FileSystemWritableFileStream.
  let bytes = new Uint8Array(0),
    position = 0
  const muxer = new MatroskaMuxer({
    async write(chunk) {
      if (position + chunk.length > bytes.length) {
        const next = new Uint8Array(position + chunk.length)
        next.set(bytes)
        bytes = next
      }
      bytes.set(chunk, position)
      position += chunk.length
    },
    ...(sequential
      ? {}
      : {
          async seek(value: number) {
            position = value
          },
        }),
  })
  for (const packet of packets) await muxer.add(packet)
  const stats = await muxer.finish()
  await writeFile(path, bytes)
  return stats
}
function probe(path: string) {
  return JSON.parse(
    tool("ffprobe", [
      "-v",
      "error",
      "-show_streams",
      "-show_format",
      "-of",
      "json",
      path,
    ])
  ) as {
    streams: {
      codec_name: string
      codec_type: string
      width?: number
      height?: number
      sample_rate?: string
      channels?: number
    }[]
    format: { duration: string }
  }
}
function decodedFrames(path: string) {
  return tool("ffmpeg", [
    "-v",
    "error",
    "-i",
    path,
    "-map",
    "0:v:0",
    "-f",
    "framemd5",
    "-",
  ])
    .split("\n")
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => line.split(",").at(-1)?.trim())
}

function joinBytes(...chunks: Uint8Array[]) {
  const result = new Uint8Array(
    chunks.reduce((total, chunk) => total + chunk.length, 0)
  )
  let offset = 0
  for (const chunk of chunks) {
    result.set(chunk, offset)
    offset += chunk.length
  }
  return result
}
function timestamp(seconds: number, prefix: number) {
  const value = Math.round(seconds * 90000)
  return Uint8Array.from([
    (prefix << 4) | ((Math.floor(value / 0x40000000) & 7) << 1) | 1,
    Math.floor(value / 0x400000) & 255,
    ((Math.floor(value / 0x8000) & 127) << 1) | 1,
    Math.floor(value / 128) & 255,
    ((value & 127) << 1) | 1,
  ])
}
function parameterNals(config: Uint8Array, hevc: boolean) {
  const result: Uint8Array[] = []
  if (hevc) {
    let at = 23
    for (let i = 0; i < config[22]; i++) {
      at++
      const count = config[at] * 256 + config[at + 1]
      at += 2
      for (let j = 0; j < count; j++) {
        const size = config[at] * 256 + config[at + 1]
        at += 2
        result.push(config.slice(at, at + size))
        at += size
      }
    }
  }
  return result
}
function annexB(packet: EncodedPacket) {
  const nals = packet.keyframe
    ? parameterNals(packet.video!.codecPrivate, packet.codec === "hevc")
    : []
  for (let at = 0; at < packet.data.length;) {
    const size = new DataView(
      packet.data.buffer,
      packet.data.byteOffset + at,
      4
    ).getUint32(0)
    at += 4
    nals.push(packet.data.subarray(at, at + size))
    at += size
  }
  return joinBytes(
    ...nals.map((nal) => joinBytes(Uint8Array.from([0, 0, 0, 1]), nal))
  )
}
function pes(
  id: number,
  data: Uint8Array,
  presentation?: number,
  decode?: number
) {
  const time =
    presentation === undefined
      ? new Uint8Array(0)
      : joinBytes(
          timestamp(presentation, decode === undefined ? 2 : 3),
          ...(decode === undefined ? [] : [timestamp(decode, 1)])
        )
  const length = 3 + time.length + data.length
  return joinBytes(
    Uint8Array.from([
      0,
      0,
      1,
      id,
      length >>> 8,
      length & 255,
      128,
      time.length === 10 ? 192 : time.length ? 128 : 0,
      time.length,
    ]),
    time,
    data
  )
}

describe("browser streaming media export", () => {
  it.each(["synthetic-preview.mp4", "synthetic-preview-hevc.mp4"])(
    "copies %s and G.711 into playable seekable MKV",
    async (name) => {
      const root = await directory(),
        output = join(root, "output.mkv")
      const video = await demuxFixture(name),
        audio = await demuxFixture("synthetic-g711-audio.mov")
      expect(video.length).toBeGreaterThan(10)
      expect(video[0].video?.codecPrivate.length).toBeGreaterThan(10)
      const stats = await mux(
        [...video, ...audio].sort(
          (a, b) => (a.dts ?? a.pts) - (b.dts ?? b.pts)
        ),
        output
      )
      const info = probe(output)
      expect(info.streams.map((stream) => stream.codec_name)).toEqual([
        name.includes("hevc") ? "hevc" : "h264",
        "pcm_alaw",
      ])
      expect(Number(info.format.duration)).toBeCloseTo(3, 1)
      expect(stats.videoPackets).toBe(video.length)
      expect(stats.audioPackets).toBeGreaterThan(0)
      expect(decodedFrames(output)).toEqual(
        decodedFrames(new URL(`../fixtures/${name}`, import.meta.url).pathname)
      )
      tool("ffmpeg", [
        "-v",
        "error",
        "-ss",
        "1.5",
        "-i",
        output,
        "-frames:v",
        "1",
        "-f",
        "null",
        "-",
      ])
    },
    20_000
  )

  it("parses MPEG-PS incrementally across packet/NAL boundaries and skips the vendor prefix", async () => {
    const root = await directory(),
      ps = join(root, "source.ps"),
      output = join(root, "output.mkv")
    const source = new URL("../fixtures/synthetic-preview.mp4", import.meta.url)
      .pathname
    tool("ffmpeg", [
      "-v",
      "error",
      "-i",
      source,
      "-c:v",
      "copy",
      "-bsf:v",
      "h264_mp4toannexb",
      "-an",
      "-f",
      "mpeg",
      ps,
    ])
    const data = await readFile(ps),
      demuxer = new MpegPsDemuxer(),
      packets: EncodedPacket[] = []
    packets.push(
      ...demuxer.push(
        Uint8Array.from([73, 77, 75, 72, ...new Array(36).fill(0)])
      )
    )
    for (let at = 0; at < data.length; at += 61)
      packets.push(...demuxer.push(data.subarray(at, at + 61)))
    packets.push(...demuxer.finish())
    expect(
      packets.filter((packet) => packet.kind === "video").length
    ).toBeGreaterThan(10)
    await mux(packets, output)
    expect(probe(output).streams[0].codec_name).toBe("h264")
    expect(Number(probe(output).format.duration)).toBeCloseTo(3, 1)
    expect(decodedFrames(output)).toEqual(decodedFrames(source))
  }, 20_000)

  it("preserves HEVC and G.711 from device-style PS with fragmented PES and reordered video", async () => {
    const root = await directory(),
      output = join(root, "device-style.mkv")
    const video = await demuxFixture("synthetic-preview-hevc.mp4"),
      audio = await demuxFixture("synthetic-g711-audio.mov")
    const chunks = [
      Uint8Array.from([73, 77, 75, 72, ...new Array(36).fill(0)]),
      Uint8Array.from([
        0, 0, 1, 188, 0, 18, 224, 255, 0, 0, 0, 8, 36, 224, 0, 0, 144, 192, 0,
        0, 0, 0, 0, 0,
      ]),
    ]
    for (const packet of [...video, ...audio].sort(
      (a, b) => (a.dts ?? a.pts) - (b.dts ?? b.pts)
    )) {
      if (packet.kind === "audio")
        chunks.push(pes(192, packet.data, packet.pts + 100))
      else {
        const data = annexB(packet)
        for (let at = 0; at < data.length; at += 211)
          chunks.push(
            pes(
              224,
              data.subarray(at, at + 211),
              at ? undefined : packet.pts + 100,
              at || packet.dts === undefined ? undefined : packet.dts + 100
            )
          )
      }
    }
    const data = joinBytes(...chunks),
      demuxer = new MpegPsDemuxer(),
      packets: EncodedPacket[] = []
    for (let at = 0; at < data.length; at += 73)
      packets.push(...demuxer.push(data.subarray(at, at + 73)))
    packets.push(...demuxer.finish())
    await mux(packets, output)
    const info = probe(output)
    expect(info.streams.map((stream) => stream.codec_name)).toEqual([
      "hevc",
      "pcm_alaw",
    ])
    expect(info.streams[0].width).toBe(160)
    expect(info.streams[0].height).toBe(90)
    expect(Number(info.format.duration)).toBeCloseTo(3, 1)
    expect(decodedFrames(output)).toEqual(
      decodedFrames(
        new URL("../fixtures/synthetic-preview-hevc.mp4", import.meta.url)
          .pathname
      )
    )
  }, 20_000)

  it.each([
    { name: "AAC", type: 0x0f, unsupported: true, audioPackets: 0 },
    { name: "G.726", type: 0x92, unsupported: true, audioPackets: 0 },
    { name: "G.711", type: 0x90, unsupported: false, audioPackets: 1 },
    {
      name: "private metadata",
      type: 0x06,
      unsupported: false,
      audioPackets: 0,
    },
  ])(
    "identifies $name in private_stream_1 while preserving the video",
    async ({ type, unsupported, audioPackets }) => {
      const video = await demuxFixture("synthetic-preview-hevc.mp4")
      const data = joinBytes(
        Uint8Array.from([
          0,
          0,
          1,
          0xbc,
          0,
          18,
          0xe0,
          0xff,
          0,
          0,
          0,
          8,
          0x24,
          0xe0,
          0,
          0,
          type,
          0xbd,
          0,
          0,
          0,
          0,
          0,
          0,
        ]),
        pes(0xbd, new Uint8Array(160).fill(0xd5), 100),
        ...video.map((packet) =>
          pes(
            0xe0,
            annexB(packet),
            packet.pts + 100,
            packet.dts === undefined ? undefined : packet.dts + 100
          )
        )
      )
      const demuxer = new MpegPsDemuxer(),
        packets: EncodedPacket[] = []
      for (let at = 0; at < data.length; at += 23)
        packets.push(...demuxer.push(data.subarray(at, at + 23)))
      packets.push(...demuxer.finish())
      expect(demuxer.audioUnsupported).toBe(unsupported)
      expect(packets.filter((packet) => packet.kind === "audio")).toHaveLength(
        audioPackets
      )
      expect(packets.filter((packet) => packet.kind === "video")).toHaveLength(
        video.length
      )
    }
  )

  it("rejects malformed/truncated MP4, excessive buffered data, and recordings without keyframes", async () => {
    const demuxer = new FragmentedMp4Demuxer()
    demuxer.push(Uint8Array.from([0, 0, 0, 20, 109, 111, 111, 118]))
    expect(() => demuxer.finish()).toThrow("不完整")
    expect(() =>
      new MpegPsDemuxer().push(new Uint8Array(17 * 1024 * 1024))
    ).toThrow("上限")
    const packets = await demuxFixture("synthetic-preview.mp4")
    const muxer = new MatroskaMuxer({ async write() {} })
    await muxer.add({ ...packets[0], keyframe: false })
    await expect(muxer.finish()).rejects.toThrow("关键帧")
  })

  it("propagates disk failures and awaits each write instead of accumulating completed media", async () => {
    const packets = await demuxFixture("synthetic-preview.mp4")
    let calls = 0
    const muxer = new MatroskaMuxer(
      {
        async write() {
          if (++calls === 3) throw new Error("磁盘空间不足")
        },
      },
      { audio: null }
    )
    await muxer.add(packets[0])
    await expect(muxer.add(packets[1])).rejects.toThrow("磁盘空间不足")
  })

  it.each(["synthetic-preview.mp4", "synthetic-preview-hevc.mp4"])(
    "keeps duration and seeking with a sequential-only download sink for %s",
    async (name) => {
      const root = await directory(),
        output = join(root, "sequential.mkv")
      const video = await demuxFixture(name),
        audio = await demuxFixture("synthetic-g711-audio.mov")
      await mux(
        [...video, ...audio].sort(
          (a, b) => (a.dts ?? a.pts) - (b.dts ?? b.pts)
        ),
        output,
        true
      )
      const info = probe(output)
      // A forward-only Matroska stream has no patched Segment Duration. Its
      // packet timeline must still be complete, and seeking must still work.
      if (info.format.duration !== undefined)
        expect(Number(info.format.duration)).toBeCloseTo(3, 1)
      const timeline = JSON.parse(
        tool("ffprobe", [
          "-v",
          "error",
          "-show_entries",
          "packet=pts_time,duration_time",
          "-of",
          "json",
          output,
        ])
      ) as {
        packets: { pts_time: string; duration_time?: string }[]
      }
      expect(
        Math.max(
          ...timeline.packets.map(
            (packet) =>
              Number(packet.pts_time) + Number(packet.duration_time ?? 0)
          )
        )
      ).toBeCloseTo(3, 1)
      expect(decodedFrames(output)).toEqual(
        decodedFrames(new URL(`../fixtures/${name}`, import.meta.url).pathname)
      )
      tool("ffmpeg", [
        "-v",
        "error",
        "-ss",
        "1.5",
        "-i",
        output,
        "-frames:v",
        "1",
        "-f",
        "null",
        "-",
      ])
    },
    20_000
  )

  it("bounds audio that arrives ahead of the last accepted video frame", async () => {
    const root = await directory(),
      output = join(root, "audio-ahead.mkv")
    const video = await demuxFixture("synthetic-preview.mp4"),
      audio = await demuxFixture("synthetic-g711-audio.mov")
    const stats = await mux([...audio, ...video.slice(0, 12)], output)
    expect(stats.durationSeconds).toBeCloseTo(1, 3)
    expect(Number(probe(output).format.duration)).toBeCloseTo(1, 3)
    expect(probe(output).streams.map((stream) => stream.codec_name)).toEqual([
      "h264",
      "pcm_alaw",
    ])
  })
})
