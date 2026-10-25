import {
  FragmentedMp4Demuxer,
  MpegPsDemuxer,
  MatroskaMuxer,
  type EncodedPacket,
} from "../media-export"
import type {
  LocalWritable,
  SaveTask,
  SaveWorkerEvent,
  SaveWorkerRequest,
} from "./types"

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<SaveWorkerRequest>) => void) | null
  postMessage(value: SaveWorkerEvent): void
}
let controller: AbortController | undefined
let stopped = false
let requestStop: (() => void) | undefined
scope.onmessage = (event) => {
  if (event.data.type === "stop") {
    if (requestStop) requestStop()
    else {
      stopped = true
      controller?.abort()
    }
  } else if (!controller) {
    controller = new AbortController()
    scope.postMessage({ type: "ready", patch: {} })
    void run(event.data)
  }
}

function portWriter(port: MessagePort): LocalWritable {
  let sequence = 0
  let allowance = 0
  let failure: Error | undefined
  let waiter: (() => void) | undefined
  let closed = false
  const acknowledged = new Set<number>()
  port.onmessage = (event) => {
    if (event.data.type === "pull") allowance++
    if (event.data.type === "ack") acknowledged.add(event.data.sequence)
    if (event.data.type === "closed") closed = true
    if (event.data.type === "cancel")
      failure = new Error("下载已取消或磁盘无法继续写入。")
    waiter?.()
    waiter = undefined
  }
  port.start()
  port.postMessage({ type: "writer-ready" })
  async function wait(predicate: () => boolean) {
    const deadline = Date.now() + 45000
    while (!predicate()) {
      if (failure) throw failure
      if (Date.now() > deadline)
        throw new Error("等待浏览器写入磁盘超时，保存已中断。")
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(resolve, 1000)
        waiter = () => {
          clearTimeout(timeout)
          resolve()
        }
      })
    }
    if (failure) throw failure
  }
  return {
    async write(bytes) {
      if (!(bytes instanceof Uint8Array))
        throw new Error("当前保存方式不支持定位写入。")
      await wait(() => allowance > 0)
      allowance--
      const id = ++sequence
      const copy = bytes.slice().buffer
      port.postMessage({ type: "chunk", sequence: id, bytes: copy }, [copy])
      await wait(() => acknowledged.has(id))
      acknowledged.delete(id)
    },
    async close() {
      port.postMessage({ type: "close" })
      await wait(() => closed)
      port.close()
    },
    async abort() {
      port.postMessage({ type: "error" })
      port.close()
    },
  }
}

async function run(request: Extract<SaveWorkerRequest, { type: "start" }>) {
  const { source, destination, filename } = request
  const signal = controller!.signal
  let output: LocalWritable | undefined
  let muxer: MatroskaMuxer | undefined
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  let received = 0
  let completedBytes = 0
  let completedDuration = 0
  let completedAudio = 0
  let fileCount = 0
  let committedFiles = 0
  let currentOutputName: string | undefined
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
  let muxerHasAudio = false
  let audioOmitted = false
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
  const startupPackets: EncodedPacket[] = []
  let startupBytes = 0
  let startupAt: number | undefined
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
      : audioOmitted
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
        : muxer?.stats.videoPackets
          ? "saving"
          : "preparing")
    if (!done && previousState === nextState && Date.now() - lastProgress < 500)
      return
    lastProgress = Date.now()
    previousState = nextState
    const stats = muxer?.stats
    scope.postMessage({
      type: done ? "done" : "progress",
      patch: {
        state: nextState,
        bytes: completedBytes + (stats?.bytesWritten ?? 0),
        sourceBytes: received,
        durationSeconds: completedDuration + (stats?.durationSeconds ?? 0),
        audioPackets: completedAudio + (stats?.audioPackets ?? 0),
        actualStartSeconds: actualStart,
        actualEndSeconds: actualEnd,
        files: done ? committedFiles : fileCount,
        message,
      },
    })
  }

  async function openOutput() {
    currentOutputName = filename.replace(
      /\.mkv$/,
      `_${String(fileCount + 1).padStart(3, "0")}.mkv`
    )
    if (destination.type === "download") output = portWriter(destination.port)
    else {
      const file =
        destination.type === "file"
          ? destination.file
          : await destination.directory.getFileHandle(currentOutputName, {
              create: true,
            })
      output = await file.createWritable()
    }
    fileCount++
    // The muxer is created once both tracks are known; OS pipe scheduling may
    // deliver an entire video fragment before the first audio fragment.
  }

  function createMuxer() {
    const writable = output!
    muxerHasAudio = !!audioConfig
    muxer = new MatroskaMuxer(
      {
        write: (bytes) => writable.write(bytes),
        ...(writable.seek
          ? { seek: (position: number) => writable.seek!(position) }
          : {}),
      },
      { audio: audioConfig ?? null, waitForAudioSeconds: 0 }
    )
  }

  async function flushStartup() {
    if (!startupPackets.length) return
    if (!output) await openOutput()
    if (!muxer) createMuxer()
    for (const packet of startupPackets) await muxer!.add(packet)
    startupPackets.length = 0
    startupBytes = 0
  }

  async function finishOutput() {
    await flushStartup()
    if (!muxer || !output) return
    await muxer.finish()
    await output.close()
    // A rejected packet may already have advanced the tentative progress.
    // Report only coverage that the completed muxer actually accepted.
    actualEnd = Math.max(
      committedEnd,
      (muxer.stats.endPts ?? origin!) - origin!
    )
    committedFiles++
    committedEnd = actualEnd
    completedBytes += muxer.stats.bytesWritten
    completedDuration += muxer.stats.durationSeconds
    completedAudio += muxer.stats.audioPackets
    muxer = undefined
    output = undefined
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
      if (muxer && !muxerHasAudio) audioOmitted = true
    }
    if (!muxer) {
      startupAt ??= Date.now()
      startupPackets.push(packet)
      startupBytes += packet.data.byteLength
      if (
        audioConfig ||
        Date.now() - startupAt > 3000 ||
        startupBytes >= 8 * 1024 * 1024
      )
        await flushStartup()
      return
    }
    await muxer!.add(packet)
  }

  // Audio can arrive on either side of the video pipe. Keep future samples in
  // the runner, where they can cross file boundaries, instead of handing them
  // to a muxer whose finish() deliberately trims beyond its final video.
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
      await openOutput()
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

  async function readSource() {
    if (!boundary) return reader!.read()
    const remaining = 3000 - (Date.now() - boundary.startedAt)
    if (remaining <= 0)
      throw new Error("等待音轨覆盖边界超时，已停止并保留可用部分。")
    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        reader!.read(),
        new Promise<ReadableStreamReadResult<Uint8Array>>((_, reject) => {
          timeout = setTimeout(
            () =>
              reject(new Error("等待音轨覆盖边界超时，已停止并保留可用部分。")),
            remaining
          )
        }),
      ])
    } finally {
      clearTimeout(timeout)
    }
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

  try {
    // Permission/file creation is resolved before media is requested.
    if (destination.type !== "directory") await openOutput()
    const body =
      source.mode === "live"
        ? { track: source.track }
        : {
            track: source.track,
            date: source.date,
            segmentId: source.segmentId,
          }
    const response = await fetch(`/api/transfers/${source.mode}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
      cache: "no-store",
    })
    if (!response.ok) {
      const data = await response.json().catch(() => null)
      throw new Error(data?.error?.message ?? "无法读取录像源，请重试。")
    }
    if (!response.body) throw new Error("浏览器未收到媒体数据。")
    reader = response.body.getReader()
    const video = new FragmentedMp4Demuxer()
    const audio = new FragmentedMp4Demuxer()
    const ps = new MpegPsDemuxer()
    let pending = new Uint8Array(0)
    while (!stopped && !reachedEnd) {
      const item = await readSource()
      if (item.done) {
        sourceEnded = true
        break
      }
      received += item.value.byteLength
      if (source.mode === "history") {
        const packets = ps.push(item.value)
        sourceAudioUnsupported ||= ps.audioUnsupported
        await consume(packets)
      } else {
        const next = new Uint8Array(pending.length + item.value.length)
        next.set(pending)
        next.set(item.value, pending.length)
        pending = next
        while (pending.length >= 5) {
          const length = new DataView(
            pending.buffer,
            pending.byteOffset
          ).getUint32(1)
          if (length > 16 * 1024 * 1024)
            throw new Error("实时媒体块超出安全大小。")
          if (pending.length < length + 5) break
          const kind = pending[0],
            bytes = pending.slice(5, 5 + length)
          pending = pending.slice(5 + length)
          if (kind === 1) await consume(video.push(bytes))
          else if (kind === 2) await consume(audio.push(bytes))
          else if (kind === 3) {
            const event = JSON.parse(new TextDecoder().decode(bytes))
            if (event.type === "audio" && event.status === "unsupported") {
              sourceAudioUnsupported = true
              patch(undefined, audioWarning())
            }
            if (event.type === "error")
              throw new Error(event.message ?? "实时媒体中断。")
            if (event.type === "end") {
              if (!reachedEnd)
                throw new Error(
                  event.reason === "timeout"
                    ? "实时录制连接已达到最长时限，录制提前结束。"
                    : "实时录制连接提前结束。"
                )
              break
            }
          } else throw new Error("实时媒体传输格式无效。")
        }
        if (pending.byteLength > 16 * 1024 * 1024 + 5)
          throw new Error("媒体接收缓冲超过上限。")
      }
      patch()
    }
    if (sourceEnded && source.mode === "history") {
      const packets = ps.finish()
      sourceAudioUnsupported ||= ps.audioUnsupported
      await consume(packets)
    }
    if (sourceEnded) await finishBoundary(true)
    if (!acceptedVideo && completedBytes === 0)
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
    const hasVideo = acceptedVideo > 0 || completedBytes > 0
    let saved = completedBytes > 0
    let currentFailed = false
    if (hasVideo) {
      try {
        await finishReceived()
        saved = true
      } catch {
        currentFailed = true
        try {
          await output?.abort?.()
        } catch {
          /* The stream may be errored. */
        }
        if (destination.type === "directory" && currentOutputName) {
          try {
            await destination.directory.removeEntry?.(currentOutputName)
          } catch {
            /* Permission may be gone. */
          }
        }
        muxer = undefined
        output = undefined
        actualEnd = committedEnd
      }
    } else {
      try {
        await output?.abort?.()
      } catch {
        /* Nothing committed. */
      }
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
      await reader?.cancel()
    } catch {
      /* The request may already be aborted. */
    }
    controller?.abort()
  }
}
