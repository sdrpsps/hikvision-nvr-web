import type { EncodedPacket } from "../media-export"
import type { SaveTask, SaveWorkerEvent, SaveWorkerRequest } from "./types"
import { SaveOutput } from "./runner-output"
import { SaveMediaSource } from "./runner-source"

export type SaveWorkerScope = {
  onmessage: ((event: MessageEvent<SaveWorkerRequest>) => void) | null
  postMessage(value: SaveWorkerEvent): void
}

// Selection, audio coverage, segment boundaries and manual stop share one
// timeline. Keep their mutable state private to this single save task.
export function createSaveTask(
  request: Extract<SaveWorkerRequest, { type: "start" }>,
  scope: SaveWorkerScope,
  initialStopped = false
) {
  const { source, destination, filename } = request
  const controller = new AbortController()
  const signal = controller.signal
  const output = new SaveOutput(destination, filename)
  let stopped = initialStopped
  let requestStop: (() => void) | undefined
  let media: SaveMediaSource | undefined
  let received = 0
  let origin: number | undefined
  let actualStart: number | undefined
  let actualEnd = 0
  let committedEnd = 0
  let segmentStart: number | undefined
  let lastProgress = 0
  let previousState: SaveTask["state"] | undefined
  let reachedEnd = false
  let sourceEnded = false
  let videoConfig: EncodedPacket["video"]
  let audioConfig: EncodedPacket["audio"]
  let audioIncomplete = false
  let sourceAudioUnsupported = false
  let receivedAudioEnd: number | undefined
  let videoEnd: number | undefined
  let replayVideoEnd: number | undefined
  let manualStopEnd: number | undefined
  let manualStopAt: number | undefined
  let manualStopRequested = false
  let manualStopTimer: ReturnType<typeof setTimeout> | undefined
  const audioQueue: EncodedPacket[] = []
  let audioQueueBytes = 0
  let boundary:
    | {
        kind: "segment" | "end"
        cut: number
        startedAt: number
        video: EncodedPacket[]
        bytes: number
      }
    | undefined
  const buffered: EncodedPacket[] = []
  let bufferedBytes = 0
  let selected = source.mode === "live"
  let hasKeyframe = false
  let acceptedVideo = 0
  let lastSourceVideoEnd = 0
  const earlyPackets: EncodedPacket[] = []
  const start = source.mode === "history" ? source.startSeconds : 0
  const end =
    source.mode === "history" ? source.endSeconds : source.limitSeconds

  requestStop = () => {
    if (manualStopRequested) return
    manualStopRequested = true
    manualStopAt = Date.now()
    manualStopEnd = Math.max(
      videoEnd ?? -Infinity,
      replayVideoEnd ?? -Infinity,
      boundary?.video.reduce(
        (end, packet) =>
          Math.max(
            end,
            packet.pts +
              (packet.duration ?? packet.video?.frameDuration ?? 0.04)
          ),
        -Infinity
      ) ?? -Infinity
    )
    if (
      !Number.isFinite(manualStopEnd) ||
      !audioConfig ||
      (receivedAudioEnd ?? -Infinity) >= manualStopEnd - 0.002
    ) {
      stopped = true
      controller?.abort()
      return
    }
    // Freeze video at the stop request, but allow a short audio-only drain.
    // A separate deadline also interrupts a read that started before stop.
    if (!boundary)
      boundary = {
        kind: "end",
        cut: manualStopEnd,
        startedAt: manualStopAt,
        video: [],
        bytes: 0,
      }
    manualStopTimer = setTimeout(() => {
      if ((receivedAudioEnd ?? -Infinity) >= manualStopEnd! - 0.002) return
      stopped = true
      controller?.abort()
    }, 3000)
    patch("stopping", "正在补齐停止前画面的声音并保存…")
  }

  function audioWarning() {
    return sourceAudioUnsupported
      ? "源音轨编码暂不支持，音轨未保存；已保留可用视频。"
      : output.audioOmitted
        ? "源音轨到达较晚，部分音轨未保存；已保留可用视频。"
        : audioIncomplete
          ? "音轨未覆盖完整已保存画面，已保留收到的音视频。"
          : ""
  }

  function patch(state?: SaveTask["state"], message?: string, done = false) {
    const nextState =
      state ??
      (manualStopRequested
        ? "stopping"
        : output.hasVideoWritten
          ? "saving"
          : "preparing")
    if (!done && previousState === nextState && Date.now() - lastProgress < 500)
      return
    lastProgress = Date.now()
    previousState = nextState
    const stats = output.progress(done)
    scope.postMessage({
      type: done ? "done" : "progress",
      patch: {
        state: nextState,
        bytes: stats.bytes,
        sourceBytes: received,
        durationSeconds: stats.durationSeconds,
        audioPackets: stats.audioPackets,
        actualStartSeconds: actualStart,
        actualEndSeconds: actualEnd,
        files: stats.files,
        message,
      },
    })
  }

  async function writePacket(packet: EncodedPacket) {
    if (packet.kind === "video") {
      if (segmentStart === undefined) segmentStart = packet.pts
      packet = { ...packet, video: packet.video ?? videoConfig }
      acceptedVideo++
      const duration = packet.duration ?? packet.video?.frameDuration ?? 0.04
      videoEnd = Math.max(videoEnd ?? packet.pts, packet.pts + duration)
      actualEnd = Math.max(actualEnd, packet.pts - origin! + duration)
    } else {
      packet = { ...packet, audio: packet.audio ?? audioConfig }
    }
    await output.write(packet, audioConfig)
  }

  async function finishOutput() {
    const committed = await output.finish(audioConfig)
    if (!committed) return
    // A rejected packet may already have advanced tentative coverage.
    actualEnd = Math.max(committedEnd, (committed.endPts ?? origin!) - origin!)
    committedEnd = actualEnd
  }

  // Future audio stays with the task so it can cross output file boundaries.
  async function flushAudio(limit = videoEnd) {
    if (limit === undefined) return
    while (audioQueue.length) {
      const packet = audioQueue[0]
      const config = packet.audio ?? audioConfig!
      const frames = Math.min(
        packet.data.length / config.channels,
        Math.floor((limit - packet.pts) * config.sampleRate + 0.000001)
      )
      if (frames <= 0) break
      const bytes = frames * config.channels
      audioQueueBytes -= bytes
      if (bytes === packet.data.length) audioQueue.shift()
      else
        audioQueue[0] = {
          ...packet,
          pts: packet.pts + frames / config.sampleRate,
          dts: undefined,
          data: packet.data.subarray(bytes),
          duration:
            (packet.data.length - bytes) / config.channels / config.sampleRate,
        }
      await writePacket({
        ...packet,
        data: packet.data.subarray(0, bytes),
        duration: frames / config.sampleRate,
      })
    }
  }

  async function finishBoundary(force = false) {
    const current = boundary
    if (!current) return
    const covered =
      !audioConfig || (receivedAudioEnd ?? -Infinity) >= current.cut - 0.002
    if (!covered && !force) return
    if (!covered) audioIncomplete = true
    if (current.kind === "segment")
      replayVideoEnd = current.video.reduce(
        (end, packet) =>
          Math.max(
            end,
            packet.pts +
              (packet.duration ?? packet.video?.frameDuration ?? 0.04)
          ),
        -Infinity
      )
    boundary = undefined
    await flushAudio(current.cut)
    if (current.kind === "end") {
      reachedEnd = true
      return
    }
    try {
      await finishOutput()
      segmentStart = current.cut
      await output.open()
      for (const packet of current.video) {
        await writePacket(packet)
        await flushAudio()
      }
    } finally {
      replayVideoEnd = undefined
    }
    if (manualStopEnd !== undefined && !reachedEnd)
      await beginBoundary("end", manualStopEnd)
  }

  async function beginBoundary(
    kind: "segment" | "end",
    cut: number,
    packet?: EncodedPacket
  ) {
    boundary = {
      kind,
      cut,
      startedAt: manualStopAt ?? Date.now(),
      video: packet ? [packet] : [],
      bytes: packet?.data.byteLength ?? 0,
    }
    await finishBoundary()
  }

  async function emit(packet: EncodedPacket) {
    if (packet.kind === "audio") {
      const config = packet.audio ?? audioConfig
      if (!config) throw new Error("音轨缺少有效的采样参数。")
      packet = { ...packet, audio: config }
      audioQueue.push(packet)
      audioQueueBytes += packet.data.byteLength
      receivedAudioEnd = Math.max(
        receivedAudioEnd ?? packet.pts,
        packet.pts + packet.data.length / config.channels / config.sampleRate
      )
      if (
        audioQueueBytes > 2 * 1024 * 1024 ||
        receivedAudioEnd - (videoEnd ?? audioQueue[0].pts) > 3
      )
        throw new Error("音频超前画面超过缓冲上限，已停止并保留可用部分。")
      await flushAudio()
      await finishBoundary()
      return
    }
    if (boundary) {
      if (boundary.kind === "segment") {
        boundary.video.push(packet)
        boundary.bytes += packet.data.byteLength
      }
      if (boundary.bytes > 8 * 1024 * 1024 || packet.pts - boundary.cut > 3)
        throw new Error(
          "等待音轨覆盖分段边界超过缓冲上限，已停止并保留可用部分。"
        )
      return
    }
    if (
      destination.type === "directory" &&
      segmentStart !== undefined &&
      packet.keyframe &&
      packet.pts - segmentStart >= 300
    ) {
      await beginBoundary("segment", packet.pts, packet)
      return
    }
    await writePacket(packet)
    await flushAudio()
  }

  async function finishReceived() {
    await finishBoundary(true)
    await flushAudio()
    await finishOutput()
    if (
      audioConfig &&
      origin !== undefined &&
      (receivedAudioEnd ?? -Infinity) < origin + actualEnd - 0.002
    )
      audioIncomplete = true
  }

  async function consume(packets: EncodedPacket[]) {
    for (const packet of packets) {
      if (packet.video) videoConfig = packet.video
      if (packet.audio) audioConfig = packet.audio
      if (packet.kind === "video" && origin === undefined) origin = packet.pts
    }
    if (origin === undefined) {
      earlyPackets.push(...packets)
      if (
        earlyPackets.reduce(
          (size, packet) => size + packet.data.byteLength,
          0
        ) >
        1024 * 1024
      )
        throw new Error("尚未收到视频，音频缓冲已达上限。")
      return
    }
    if (earlyPackets.length) {
      packets = [...earlyPackets, ...packets]
      earlyPackets.length = 0
    }
    for (const packet of packets) {
      if (reachedEnd) return
      if (manualStopRequested && packet.kind === "video") continue
      if (packet.video) videoConfig = packet.video
      if (packet.audio) audioConfig = packet.audio
      if (packet.kind === "video" && origin === undefined) origin = packet.pts
      if (origin === undefined) continue
      const relative = packet.pts - origin
      if (packet.kind === "video") {
        lastSourceVideoEnd = Math.max(
          lastSourceVideoEnd,
          relative + (packet.duration ?? 0)
        )
        if (
          !boundary &&
          packet.keyframe &&
          relative >= end &&
          selected &&
          acceptedVideo
        ) {
          await beginBoundary("end", packet.pts)
          continue
        }
      }
      if (!selected) {
        if (packet.kind === "video" && packet.keyframe && relative <= start) {
          buffered.length = 0
          bufferedBytes = 0
          hasKeyframe = true
          actualStart = relative
        }
        if (!hasKeyframe && packet.kind === "video" && packet.keyframe) {
          hasKeyframe = true
          actualStart = relative
        }
        if (hasKeyframe) {
          buffered.push(packet)
          bufferedBytes += packet.data.byteLength
          if (bufferedBytes > 32 * 1024 * 1024)
            throw new Error(
              "录像关键帧间隔或单帧过大，已停止以避免占用过多内存。"
            )
        }
        if (packet.kind === "video" && relative >= start && hasKeyframe) {
          selected = true
          for (const item of buffered) await emit(item)
          buffered.length = 0
          bufferedBytes = 0
        }
      } else {
        if (
          actualStart === undefined &&
          packet.kind === "video" &&
          packet.keyframe
        )
          actualStart = relative
        await emit(packet)
      }
      patch()
    }
  }

  async function run() {
    try {
      // Permission/file creation is resolved before media is requested.
      if (destination.type !== "directory") await output.open()
      media = await SaveMediaSource.open(source, signal)
      const consumer = {
        consume,
        reachedEnd: () => reachedEnd,
        audioUnsupported: () => {
          sourceAudioUnsupported = true
          if (source.mode === "live") patch(undefined, audioWarning())
        },
      }
      while (!stopped && !reachedEnd) {
        const item = await media.read(boundary?.startedAt)
        if (item.done) {
          sourceEnded = true
          break
        }
        received += item.value.byteLength
        await media.push(item.value, consumer)
        patch()
      }
      if (sourceEnded) await media.finish(consumer)

      if (sourceEnded) await finishBoundary(true)
      if (!acceptedVideo && output.completedBytes === 0)
        throw new Error(
          source.mode === "history"
            ? "所选范围没有可导出的完整视频，请调整起止时间。"
            : "尚未收到可保存的视频，未生成有效录像。"
        )
      if (source.mode === "live" && sourceEnded && !stopped && !reachedEnd)
        throw new Error("实时连接提前结束。")
      await finishReceived()
      const missingStart =
        source.mode === "history" &&
        (actualStart === undefined || actualStart > start + 0.05)
      const incompleteSelection =
        source.mode === "history" &&
        (missingStart ||
          (!reachedEnd && lastSourceVideoEnd + 0.15 < end) ||
          stopped ||
          manualStopRequested)
      const warnings: string[] = []
      if (incompleteSelection)
        warnings.push(
          missingStart
            ? "所选开头缺少可解码关键帧，已保留可用部分，未覆盖完整选区。"
            : "已保留可用部分，未覆盖完整选区。"
        )
      if (audioWarning()) warnings.push(audioWarning())
      patch(
        warnings.length ? "partial" : "complete",
        warnings.length
          ? warnings.join(" ")
          : destination.type === "download"
            ? "媒体传送完成，请在浏览器下载列表中确认文件。"
            : "已保存到本机硬盘。",
        true
      )
    } catch (error) {
      const hasVideo = acceptedVideo > 0 || output.completedBytes > 0
      let saved = output.completedBytes > 0
      let currentFailed = false
      if (hasVideo) {
        try {
          await finishReceived()
          saved = true
        } catch {
          currentFailed = true
          await output.discard()
          actualEnd = committedEnd
        }
      } else {
        await output.abort()
      }

      const ordinaryStop = stopped && signal.aborted
      if (!saved) actualStart = undefined
      patch(
        saved
          ? ordinaryStop &&
            source.mode === "live" &&
            !currentFailed &&
            !audioWarning()
            ? "complete"
            : "partial"
          : ordinaryStop
            ? "cancelled"
            : "failed",
        `${
          ordinaryStop && saved
            ? "已停止并保存已接收的录像。"
            : `${saved ? "已保留有效部分；" : ""}${error instanceof Error ? error.message : "保存中断，请重试。"}`
        }${saved && audioWarning() ? ` ${audioWarning()}` : ""}`,
        true
      )
    } finally {
      clearTimeout(manualStopTimer)
      requestStop = undefined
      try {
        await media?.cancel()
      } catch {
        /* The request may already be aborted. */
      }
      controller.abort()
    }
  }

  return {
    run,
    stop() {
      if (requestStop) requestStop()
      else {
        stopped = true
        controller.abort()
      }
    },
  }
}
