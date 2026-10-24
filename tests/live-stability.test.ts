import { readFileSync } from "node:fs"
import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import type { ChildProcess } from "node:child_process"
import { describe, expect, it, vi } from "vitest"
import { LiveSessions } from "../server/live"
import { readNvrConfig } from "../server/config"
import { splitFragmentedMp4 } from "../server/mp4"

const config = readNvrConfig({
  NVR_HOST: "synthetic.test",
  NVR_USERNAME: "synthetic-user",
  NVR_PASSWORD: "synthetic-password",
})
const media = splitFragmentedMp4(
  readFileSync(new URL("../fixtures/synthetic-preview.mp4", import.meta.url))
)

function syntheticLauncher() {
  const children: (EventEmitter & { kill: ReturnType<typeof vi.fn> })[] = []
  const launch = vi.fn(() => {
    const stdout = new PassThrough(),
      stderr = new PassThrough(),
      audio = new PassThrough()
    const child = Object.assign(new EventEmitter(), {
      stdout,
      stderr,
      stdio: [null, stdout, stderr, audio],
      kill: vi.fn(),
    })
    children.push(child)
    queueMicrotask(() => {
      stdout.write(media.init)
      stdout.write(media.media)
    })
    return child as unknown as ChildProcess
  })
  return { launch, children }
}

describe("sixteen pending live sessions", () => {
  it("reserves capacity before channel lookup and never starts a late cancelled source", async () => {
    vi.useFakeTimers()
    const { launch, children } = syntheticLauncher(),
      sessions = new LiveSessions(launch)
    let finishLookup!: (track: string) => void
    const lookup = new Promise<string>((resolve) => {
      finishLookup = resolve
    })
    const controllers = Array.from({ length: 16 }, () => new AbortController())
    const pending = controllers.map((controller) =>
      sessions.create(config, () => lookup, controller.signal)
    )
    const settled = Promise.allSettled(pending)
    try {
      await expect(
        sessions.create(config, async () => "101", new AbortController().signal)
      ).rejects.toMatchObject({ code: "MEDIA_BUSY" })
      expect(launch).not.toHaveBeenCalled()
      for (const controller of controllers) controller.abort()
      finishLookup("101")
      const results = await settled
      expect(
        results.every(
          (result) =>
            result.status === "rejected" &&
            result.reason.code === "MEDIA_CANCELLED"
        )
      ).toBe(true)
      expect(launch).not.toHaveBeenCalled()
      expect(vi.getTimerCount()).toBe(0)
      const reopened = await Promise.all(
        Array.from({ length: 16 }, (_, index) =>
          sessions.create(
            config,
            async () => String((index + 1) * 100 + 1),
            new AbortController().signal
          )
        )
      )
      expect(new Set(reopened.map((session) => session.id)).size).toBe(16)
      expect(launch).toHaveBeenCalledTimes(16)
      for (const session of reopened)
        expect(sessions.playlist(session.id)).toContain("#EXTM3U")
      sessions.dispose()
      // Late close events cannot kill another process or resurrect a timer.
      for (const child of children) child.emit("close", 0)
      expect(
        children.every((child) => child.kill.mock.calls.length === 1)
      ).toBe(true)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      finishLookup("101")
      sessions.dispose()
      await settled
      vi.useRealTimers()
    }
  })

  it("releases all reservations and timers when concurrent channel lookups fail", async () => {
    vi.useFakeTimers()
    const { launch } = syntheticLauncher(),
      sessions = new LiveSessions(launch)
    let failLookup!: (error: Error) => void
    const lookup = new Promise<string>((_resolve, reject) => {
      failLookup = reject
    })
    const settled = Promise.allSettled(
      Array.from({ length: 16 }, () =>
        sessions.create(config, () => lookup, new AbortController().signal)
      )
    )
    try {
      failLookup(new Error("Synthetic channel lookup disconnected"))
      const results = await settled
      expect(results.every((result) => result.status === "rejected")).toBe(true)
      expect(launch).not.toHaveBeenCalled()
      expect(vi.getTimerCount()).toBe(0)
      await expect(
        sessions.create(config, async () => "101", new AbortController().signal)
      ).resolves.toMatchObject({ codec: "h264" })
    } finally {
      sessions.dispose()
      vi.useRealTimers()
    }
  })
})
