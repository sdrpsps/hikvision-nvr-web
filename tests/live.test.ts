import { readFileSync } from "node:fs"
import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import type { ChildProcess } from "node:child_process"
import { describe, it, expect, vi } from "vitest"
import { LiveSessions, liveArguments, MAX_LIVE_SESSIONS } from "../server/live"
import { readNvrConfig } from "../server/config"
import { splitFragmentedMp4 } from "../server/mp4"
import { createApp } from "../server/app"
import { NvrService } from "../server/recordings"
import { PreviewSessions } from "../server/preview"

const config = readNvrConfig({
  NVR_HOST: "nvr.test",
  NVR_USERNAME: "test-user",
  NVR_PASSWORD: "test-secret",
})
const media = splitFragmentedMp4(
  readFileSync(new URL("../fixtures/synthetic-preview.mp4", import.meta.url))
)
function setup(ttl?: number, automatic = true) {
  const children: (ChildProcess & {
    output: PassThrough
    audio: PassThrough
  })[] = []
  const launcher = vi.fn(() => {
    const child = Object.assign(new EventEmitter(), {
      output: new PassThrough(),
      stderr: new PassThrough(),
      audio: new PassThrough(),
      kill: vi.fn(),
    })
    Object.assign(child, {
      stdout: child.output,
      stdio: [null, child.output, child.stderr, child.audio],
    })
    children.push(child as unknown as (typeof children)[number])
    if (automatic)
      queueMicrotask(() => {
        child.output.write(media.init)
        child.output.write(media.media)
      })
    return child as unknown as ChildProcess
  })
  return { sessions: new LiveSessions(launcher, ttl), children, launcher }
}
const signal = () => new AbortController().signal
const resolve = async () => "101"

describe("live copy-only lifecycle", () => {
  it("builds a fixed trusted RTSP path with copy-only output", () => {
    const args = liveArguments(config, "101")
    expect(args[args.indexOf("-i") + 1]).toBe(
      "rtsp://test-user:test-secret@nvr.test:554/Streaming/Channels/101"
    )
    expect(args.slice(args.indexOf("-c:v"), args.indexOf("-c:v") + 2)).toEqual([
      "-c:v",
      "copy",
    ])
    expect(args.at(-1)).toContain("pipe:1")
    expect(args.at(-1)).toContain("pipe:3")
    expect(args).toContain("0:a:0?")
    expect(args).not.toContain("-an")
    expect(args.join(" ")).not.toMatch(/libx26| -vf | -filter/)
  })
  it("parses chunk boundaries, maintains a bounded rolling playlist and cleans on delete", async () => {
    const { sessions, children } = setup(undefined, false)
    try {
      const pending = sessions.create(config, resolve, signal())
      await Promise.resolve()
      const all = Buffer.concat([media.init, media.media])
      for (let at = 0; at < all.length; at += 37)
        children[0].output.write(all.subarray(at, at + 37))
      const session = await pending
      expect(session.codec).toBe("h264")
      expect(JSON.stringify(session)).not.toMatch(/rtsp:|test-secret|nvr.test/)
      expect(sessions.asset(session.id, "init.mp4")).toEqual(media.init)
      expect(sessions.playlist(session.id)).not.toContain("ENDLIST")
      for (let index = 0; index < 10; index++)
        children[0].output.write(media.media)
      const playlist = sessions.playlist(session.id)
      expect((playlist.match(/#EXTINF/g) ?? []).length).toBe(6)
      expect(playlist).not.toContain("\n0.m4s")
      expect(() => sessions.asset(session.id, "0.m4s")).toThrow()
      expect(() => sessions.asset(session.id, "../secret")).toThrow()
      sessions.delete(session.id)
      sessions.delete(session.id)
      expect(children[0].kill).toHaveBeenCalledExactlyOnceWith("SIGKILL")
      expect(() => sessions.playlist(session.id)).toThrow()
    } finally {
      sessions.dispose()
    }
  })
  it("serves bounded copied audio with timestamps and cursor validation, and isolates audio failures", async () => {
    const { sessions, children } = setup()
    try {
      const session = await sessions.create(config, resolve, signal())
      const audioFile = readFileSync(
        new URL("../fixtures/synthetic-g711-audio.mov", import.meta.url)
      )
      expect(sessions.audio(session.id, -1).status).toBe("pending")
      for (let at = 0; at < audioFile.length; at += 71)
        children[0].audio.write(audioFile.subarray(at, at + 71))
      const result = sessions.audio(session.id, -1)
      expect(result.status).toBe("available")
      expect(result.chunks[0]).toMatchObject({
        codec: "alaw",
        sampleRate: 8000,
        channels: 1,
        startSeconds: 0,
      })
      const last = result.chunks.at(-1)!
      expect(sessions.audio(session.id, last.sequence).chunks).toHaveLength(0)
      const service = new NvrService(config)
      const app = createApp(() => service, new PreviewSessions(), sessions)
      expect(
        (await app.request(`/api/streams/${session.id}/audio?after=-1`)).status
      ).toBe(200)
      expect(
        (await app.request(`/api/streams/${session.id}/audio?after=bad`)).status
      ).toBe(400)
      children[0].audio.write(Buffer.alloc(256 * 1024 + 1))
      expect(sessions.audio(session.id, -1)).toMatchObject({
        status: "unsupported",
        chunks: [],
      })
      expect(sessions.playlist(session.id)).toContain("#EXTM3U")
      sessions.delete(session.id)
      expect(
        (await app.request(`/api/streams/${session.id}/audio`)).status
      ).toBe(404)
    } finally {
      sessions.dispose()
    }
  })
  it("caps pending and ready sessions at sixteen", async () => {
    const { sessions, children } = setup()
    try {
      for (let index = 0; index < MAX_LIVE_SESSIONS; index++)
        await sessions.create(config, resolve, signal())
      await expect(
        sessions.create(config, resolve, signal())
      ).rejects.toMatchObject({ code: "MEDIA_BUSY" })
      sessions.dispose()
      expect(
        children.every((child) => vi.mocked(child.kill).mock.calls.length === 1)
      ).toBe(true)
      await expect(
        sessions.create(config, resolve, signal())
      ).resolves.toMatchObject({ codec: "h264" })
    } finally {
      sessions.dispose()
    }
  })
  it("cleans up on cancellation, failure, malformed output and missing channel", async () => {
    const { sessions, children, launcher } = setup(undefined, false)
    try {
      await expect(
        sessions.create(
          config,
          async () => {
            throw new Error("lookup failed")
          },
          signal()
        )
      ).rejects.toThrow("lookup failed")
      expect(launcher).not.toHaveBeenCalled()
      const controller = new AbortController()
      const pending = sessions.create(config, resolve, controller.signal)
      await Promise.resolve()
      controller.abort()
      await expect(pending).rejects.toMatchObject({ code: "MEDIA_CANCELLED" })
      expect(children[0].kill).toHaveBeenCalled()
      const broken = sessions.create(config, resolve, signal())
      await Promise.resolve()
      children[1].emit("error", new Error("private RTSP data"))
      await expect(broken).rejects.toMatchObject({
        code: "MEDIA_TOOL_UNAVAILABLE",
      })
      const malformed = sessions.create(config, resolve, signal())
      await Promise.resolve()
      children[2].output.write(Buffer.alloc(8))
      await expect(malformed).rejects.toMatchObject({
        code: "LIVE_INVALID_MEDIA",
      })
    } finally {
      sessions.dispose()
    }
  })
  it("expires, reaps idle sessions and bounds startup time", async () => {
    vi.useFakeTimers()
    const first = setup(1000),
      idle = setup(),
      waiting = setup(undefined, false)
    try {
      const one = await first.sessions.create(config, resolve, signal())
      await vi.advanceTimersByTimeAsync(1001)
      expect(() => first.sessions.playlist(one.id)).toThrow()
      const two = await idle.sessions.create(config, resolve, signal())
      const pending = waiting.sessions.create(config, resolve, signal())
      const rejection = expect(pending).rejects.toMatchObject({
        code: "LIVE_TIMEOUT",
      })
      await vi.advanceTimersByTimeAsync(20_001)
      await rejection
      await vi.advanceTimersByTimeAsync(11_000)
      expect(() => idle.sessions.playlist(two.id)).toThrow()
      expect(idle.children[0].kill).toHaveBeenCalled()
    } finally {
      first.sessions.dispose()
      idle.sessions.dispose()
      waiting.sessions.dispose()
      vi.useRealTimers()
    }
  })
  it("validates channel membership and body/origin; serves opaque same-origin media", async () => {
    const { sessions, launcher } = setup()
    const service = new NvrService(config)
    vi.spyOn(service, "channels").mockResolvedValue([
      { id: "101", name: "test", configuredEnabled: false },
    ])
    const app = createApp(() => service, new PreviewSessions(), sessions)
    const post = (body: unknown, headers = {}) =>
      app.request("/api/streams/live", {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
      })
    try {
      for (const body of [
        { track: "rtsp://external.test" },
        { track: "101", url: "http://external.test" },
        {},
        { track: "101", padding: "a".repeat(2000) },
      ])
        expect((await post(body)).status).toBe(400)
      expect(
        (await post({ track: "101" }, { origin: "http://external.test" }))
          .status
      ).toBe(403)
      expect((await post({ track: "201" })).status).toBe(404)
      expect(launcher).not.toHaveBeenCalled()
      const response = await post({ track: "101" }),
        session = await response.json()
      expect(response.status).toBe(201)
      const playlist = await app.request(session.playlistUrl)
      expect(playlist.status).toBe(200)
      expect(playlist.headers.get("cache-control")).toBe("no-store")
      expect(
        (await app.request(`/api/streams/${session.id}/init.mp4`)).status
      ).toBe(200)
      expect(
        (await app.request(`/api/streams/${session.id}/0.m4s`)).status
      ).toBe(200)
      expect(
        (await app.request(`/api/streams/${session.id}/other`)).status
      ).toBe(404)
      expect(
        (await app.request(`/api/streams/${session.id}`, { method: "DELETE" }))
          .status
      ).toBe(204)
      expect((await app.request(session.playlistUrl)).status).toBe(404)
    } finally {
      sessions.dispose()
    }
  })
})
