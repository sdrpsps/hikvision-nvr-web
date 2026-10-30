import { createHash, type Hash } from "node:crypto"
import { Temporal } from "@js-temporal/polyfill"

const PTS_HZ = 90_000
const PTS_WRAP = 2 ** 33
const MAX_BUFFER_BYTES = 128 * 1024
const MAX_SCAN_BYTES = 1024 * 1024

export type HikPsClockError = "HIK_PS_CLOCK_INVALID" | "HIK_PS_CLOCK_LIMIT"

function isPack(bytes: Buffer, offset = 0) {
  return bytes.length >= offset + 4 && bytes.readUInt32BE(offset) === 0x000001ba
}

function timestamp(bytes: Buffer, offset: number, prefix: number) {
  if (
    bytes[offset] >>> 4 !== prefix ||
    !(bytes[offset] & 1) ||
    !(bytes[offset + 2] & 1) ||
    !(bytes[offset + 4] & 1)
  )
    return undefined
  return (
    ((bytes[offset] >>> 1) & 7) * 2 ** 30 +
    bytes[offset + 1] * 2 ** 22 +
    (bytes[offset + 2] >>> 1) * 2 ** 15 +
    bytes[offset + 3] * 2 ** 7 +
    (bytes[offset + 4] >>> 1)
  )
}

/**
 * Reads the observed HK v01/00 PSM clock, never a requested playback time.
 * HK stores recorder-local whole seconds; PTS interpolation does not improve
 * that absolute precision. Only the first E0 packet's presentation PTS is used.
 * The optional random-access gate hashes the complete first IDR NAL so callers
 * can prove the muxer did not discard that picture and reset a later origin.
 */
export class HikPsClock {
  readonly precisionSeconds = 1
  private buffer: Buffer = Buffer.alloc(0)
  private scannedBytes = 0
  private initialized = false
  private stopped = false
  private pendingClock?: bigint
  private firstPts?: number
  private candidateOrigin?: string
  private origin?: string
  private failure?: HikPsClockError
  private readonly maxBytes: number
  private readonly requireRandomAccess: boolean
  private videoCodec?: 0x1b | 0x24
  private parameterSets = 0
  private randomAccessReady = false
  private inNal = false
  private nalZeros = 0
  private nalHeader: number[] = []
  private nalHasPayload = false
  private vclHash?: Hash
  private videoHash?: string
  private hashBuffer = Buffer.alloc(4096)
  private hashLength = 0
  private requireVclBoundary = false

  constructor(
    private readonly timeZone: string,
    options: { maxBytes?: number; requireRandomAccess?: boolean } = {}
  ) {
    this.maxBytes = options.maxBytes ?? MAX_SCAN_BYTES
    this.requireRandomAccess = options.requireRandomAccess ?? false
    if (
      !Number.isInteger(this.maxBytes) ||
      this.maxBytes < 1 ||
      this.maxBytes > MAX_SCAN_BYTES
    ) {
      this.fail("HIK_PS_CLOCK_LIMIT")
      return
    }
    try {
      Temporal.Instant.fromEpochMilliseconds(0).toZonedDateTimeISO(timeZone)
    } catch {
      this.fail("HIK_PS_CLOCK_INVALID")
    }
  }

  get startAt() {
    return this.origin
  }

  get firstVideoPtsSeconds() {
    return this.firstPts === undefined ? undefined : this.firstPts / PTS_HZ
  }

  get firstVideoHash() {
    return this.videoHash
  }

  get error() {
    return this.failure
  }

  push(chunk: Uint8Array): void {
    let offset = 0
    while (offset < chunk.length && !this.stopped) {
      const count = Math.min(
        chunk.length - offset,
        MAX_BUFFER_BYTES - this.buffer.length,
        this.maxBytes - this.scannedBytes
      )
      if (!count) {
        this.fail("HIK_PS_CLOCK_LIMIT")
        return
      }
      this.buffer = Buffer.concat([
        this.buffer,
        chunk.subarray(offset, offset + count),
      ])
      this.scannedBytes += count
      offset += count
      this.parse()
      if (!this.stopped && this.scannedBytes === this.maxBytes)
        this.fail("HIK_PS_CLOCK_LIMIT")
    }
  }

  private fail(error: HikPsClockError) {
    this.failure = error
    this.stopped = true
    this.pendingClock = undefined
    this.candidateOrigin = undefined
    this.vclHash = undefined
    this.videoHash = undefined
    this.hashLength = 0
    this.hashBuffer.fill(0)
    this.buffer = Buffer.alloc(0)
  }

  private initialize() {
    if (this.buffer.length < 4) return false
    if (this.buffer.readUInt32BE(0) === 0x494d4b48) {
      // These are the two observed IMKH header sizes, not a payload search.
      if (this.buffer.length < 44) return false
      if (isPack(this.buffer, 40)) this.buffer = this.buffer.subarray(40)
      else {
        if (this.buffer.length < 68) return false
        if (!isPack(this.buffer, 64)) {
          this.fail("HIK_PS_CLOCK_INVALID")
          return false
        }
        this.buffer = this.buffer.subarray(64)
      }
    } else if (!isPack(this.buffer)) {
      this.fail("HIK_PS_CLOCK_INVALID")
      return false
    }
    this.initialized = true
    return true
  }

  private parse() {
    if (!this.initialized && !this.initialize()) return
    while (this.buffer.length >= 4 && !this.stopped) {
      if (
        this.buffer[0] !== 0 ||
        this.buffer[1] !== 0 ||
        this.buffer[2] !== 1
      ) {
        this.fail("HIK_PS_CLOCK_INVALID")
        return
      }
      const id = this.buffer[3]
      if (id === 0xb9) {
        if (this.requireRandomAccess && !this.randomAccessReady) {
          this.fail("HIK_PS_CLOCK_INVALID")
          return
        }
        this.stopped = true
        this.buffer = Buffer.alloc(0)
        return
      }
      let length: number
      if (id === 0xba) {
        if (this.buffer.length < 14) return
        if (
          (this.buffer[4] & 0xc4) !== 0x44 ||
          !(this.buffer[6] & 4) ||
          !(this.buffer[8] & 4) ||
          !(this.buffer[9] & 1) ||
          (this.buffer[12] & 3) !== 3 ||
          (this.buffer[13] & 0xf8) !== 0xf8
        ) {
          this.fail("HIK_PS_CLOCK_INVALID")
          return
        }
        length = 14 + (this.buffer[13] & 7)
      } else {
        if (id < 0xbb) {
          this.fail("HIK_PS_CLOCK_INVALID")
          return
        }
        if (this.buffer.length < 6) return
        length = 6 + this.buffer.readUInt16BE(4)
        if (length === 6 && id === 0xe0) {
          this.fail("HIK_PS_CLOCK_INVALID")
          return
        }
      }
      if (this.buffer.length < length) return
      const packet = this.buffer.subarray(0, length)
      if (id === 0xbc) this.readMap(packet)
      else if (id === 0xe0) this.readVideo(packet)
      this.buffer = this.stopped
        ? Buffer.alloc(0)
        : this.buffer.subarray(length)
    }
  }

  private descriptors(
    bytes: Buffer,
    start: number,
    end: number,
    clock: boolean
  ) {
    let value: bigint | undefined
    for (let offset = start; offset < end;) {
      if (offset + 2 > end) throw new Error()
      const tag = bytes[offset]
      const length = bytes[offset + 1]
      const next = offset + 2 + length
      if (next > end) throw new Error()
      const body = bytes.subarray(offset + 2, next)
      if (clock && tag === 0x40 && body[0] === 0x48 && body[1] === 0x4b) {
        if (length < 9 || body[2] !== 1 || body[3] !== 0 || value !== undefined)
          throw new Error()
        // Observed HK v01/00: year byte, then M4/D5/h5/m6/s6/unknown6.
        const packed = body.readUInt32BE(5)
        value = Temporal.PlainDateTime.from(
          {
            year: 2000 + body[4],
            month: packed >>> 28,
            day: (packed >>> 23) & 31,
            hour: (packed >>> 18) & 31,
            minute: (packed >>> 12) & 63,
            second: (packed >>> 6) & 63,
          },
          { overflow: "reject" }
        ).toZonedDateTime(this.timeZone, {
          disambiguation: "reject",
        }).epochNanoseconds
      }
      offset = next
    }
    return value
  }

  private readMap(bytes: Buffer) {
    this.pendingClock = undefined
    try {
      if (bytes.length < 16 || (bytes[6] & 0xe0) !== 0xe0 || bytes[7] !== 0xff)
        throw new Error()
      const infoEnd = 10 + bytes.readUInt16BE(8)
      if (infoEnd + 6 > bytes.length) throw new Error()
      const clock = this.descriptors(bytes, 10, infoEnd, true)
      const mapEnd = infoEnd + 2 + bytes.readUInt16BE(infoEnd)
      if (mapEnd + 4 !== bytes.length) throw new Error()
      let codec: 0x1b | 0x24 | undefined
      for (let offset = infoEnd + 2; offset < mapEnd;) {
        if (offset + 4 > mapEnd) throw new Error()
        const end = offset + 4 + bytes.readUInt16BE(offset + 2)
        if (end > mapEnd) throw new Error()
        this.descriptors(bytes, offset + 4, end, false)
        if (this.requireRandomAccess && bytes[offset + 1] === 0xe0) {
          const type = bytes[offset]
          if (codec !== undefined || (type !== 0x1b && type !== 0x24))
            throw new Error()
          codec = type
        }
        offset = end
      }
      if (this.requireRandomAccess) {
        if (this.firstPts !== undefined && codec !== this.videoCodec)
          throw new Error()
        this.videoCodec = codec
      }
      this.pendingClock = clock
    } catch {
      this.fail("HIK_PS_CLOCK_INVALID")
    }
  }

  private readVideo(bytes: Buffer) {
    if (
      bytes.length < 9 ||
      (bytes[6] & 0xc0) !== 0x80 ||
      9 + bytes[8] > bytes.length
    ) {
      this.fail("HIK_PS_CLOCK_INVALID")
      return
    }
    const flags = bytes[7] >>> 6
    if (flags === 0 && !this.requireRandomAccess) return
    if (flags !== 0 && (flags === 1 || bytes[8] < (flags === 3 ? 10 : 5))) {
      this.fail("HIK_PS_CLOCK_INVALID")
      return
    }
    const pts = flags === 0 ? undefined : timestamp(bytes, 9, flags)
    if (
      (flags !== 0 && pts === undefined) ||
      (flags === 3 && timestamp(bytes, 14, 1) === undefined) ||
      (this.requireRandomAccess &&
        (this.videoCodec === undefined ||
          (this.firstPts === undefined && pts === undefined) ||
          (!this.randomAccessReady &&
            pts !== undefined &&
            this.firstPts !== undefined &&
            pts !== this.firstPts &&
            !(this.vclHash && this.nalHasPayload))))
    ) {
      this.fail("HIK_PS_CLOCK_INVALID")
      return
    }
    if (
      this.requireRandomAccess &&
      !this.randomAccessReady &&
      pts !== undefined &&
      this.firstPts !== undefined &&
      pts !== this.firstPts
    )
      this.requireVclBoundary = true
    this.firstPts ??= pts
    if (
      this.candidateOrigin === undefined &&
      this.pendingClock !== undefined &&
      pts !== undefined &&
      this.firstPts !== undefined
    ) {
      // The bounded prefix cannot establish wrap counts beyond half a PTS cycle.
      const delta =
        ((this.firstPts - pts + PTS_WRAP / 2 + PTS_WRAP) % PTS_WRAP) -
        PTS_WRAP / 2
      const origin =
        this.pendingClock + BigInt(Math.round((delta * 1e9) / PTS_HZ))
      this.candidateOrigin = Temporal.Instant.fromEpochNanoseconds(
        origin
      ).toString({
        smallestUnit: "millisecond",
      })
      this.pendingClock = undefined
    }
    if (this.requireRandomAccess && !this.randomAccessReady)
      this.readAnnexB(bytes.subarray(9 + bytes[8]))
    if (
      !this.failure &&
      this.candidateOrigin !== undefined &&
      (!this.requireRandomAccess || this.randomAccessReady)
    ) {
      this.origin = this.candidateOrigin
      this.stopped = true
    }
  }

  private readAnnexB(bytes: Buffer) {
    for (const byte of bytes) {
      if (this.stopped || this.randomAccessReady) return
      if (byte === 0) {
        this.nalZeros++
        continue
      }
      if (byte === 1 && this.nalZeros >= 2) {
        if (this.inNal) {
          if (
            this.nalHeader.length !== (this.videoCodec === 0x1b ? 1 : 2) ||
            !this.nalHasPayload
          ) {
            this.fail("HIK_PS_CLOCK_INVALID")
            return
          }
          if (this.vclHash) {
            this.vclHash.update(this.hashBuffer.subarray(0, this.hashLength))
            this.videoHash = this.vclHash.digest("hex")
            this.vclHash = undefined
            this.hashLength = 0
            this.hashBuffer.fill(0)
            this.randomAccessReady = true
            return
          }
          const type = this.nalType()
          if (this.videoCodec === 0x1b) {
            if (type === 7) this.parameterSets |= 1
            if (type === 8) this.parameterSets |= 2
          } else if (type >= 32 && type <= 34) {
            this.parameterSets |= 1 << (type - 32)
          }
        }
        this.inNal = true
        this.nalZeros = 0
        this.nalHeader = []
        this.nalHasPayload = false
        continue
      }
      if (!this.inNal || this.requireVclBoundary) {
        this.fail("HIK_PS_CLOCK_INVALID")
        return
      }
      while (this.nalZeros && !this.stopped) {
        this.nalZeros--
        this.readNalByte(0)
      }
      if (!this.stopped) this.readNalByte(byte)
    }
  }

  private nalType() {
    return this.videoCodec === 0x1b
      ? this.nalHeader[0] & 31
      : (this.nalHeader[0] >>> 1) & 63
  }

  private readNalByte(byte: number) {
    const headerSize = this.videoCodec === 0x1b ? 1 : 2
    if (this.nalHeader.length < headerSize) {
      this.nalHeader.push(byte)
      if (
        this.nalHeader[0] & 0x80 ||
        (headerSize === 2 &&
          this.nalHeader.length === 2 &&
          (!(byte & 7) || this.nalHeader[0] & 1 || byte >>> 3))
      ) {
        this.fail("HIK_PS_CLOCK_INVALID")
        return
      }
      if (this.nalHeader.length !== headerSize) return
      const type = this.nalType()
      const supported =
        headerSize === 1
          ? (type === 5 && (byte & 0x60) !== 0) ||
            [6, 7, 8, 9, 12, 13].includes(type)
          : type === 19 || type === 20 || (type >= 32 && type <= 40)
      const isVcl = headerSize === 1 ? type === 5 : type <= 31
      if (
        !supported ||
        (isVcl &&
          (this.parameterSets !== (headerSize === 1 ? 3 : 7) ||
            (headerSize === 2 && (byte & 7) !== 1)))
      )
        this.fail("HIK_PS_CLOCK_INVALID")
      else if (isVcl) {
        this.vclHash = createHash("sha256")
        for (const header of this.nalHeader) this.hashNalByte(header)
      }
      return
    }
    if (headerSize === 1 ? this.nalType() === 5 : this.nalType() <= 31) {
      // Require the first slice, not a later slice in an already-started picture.
      if (!this.nalHasPayload && !(byte & 0x80)) {
        this.fail("HIK_PS_CLOCK_INVALID")
        return
      }
      this.hashNalByte(byte)
    }
    this.nalHasPayload = true
  }

  private hashNalByte(byte: number) {
    this.hashBuffer[this.hashLength++] = byte
    if (this.hashLength === this.hashBuffer.length) {
      this.vclHash!.update(this.hashBuffer)
      this.hashLength = 0
    }
  }
}
