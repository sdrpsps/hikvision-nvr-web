import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"
import { HikPsClock } from "../server/hik-ps-clock"

const PTS_WRAP = 2 ** 33
const pack = Buffer.from([0, 0, 1, 0xba, 0x44, 0, 4, 0, 4, 1, 0, 0, 3, 0xf8])

function packet(id: number, body: Buffer) {
  const header = Buffer.from([0, 0, 1, id, 0, 0])
  header.writeUInt16BE(body.length, 4)
  return Buffer.concat([header, body])
}

function hk(
  parts: number[] = [2026, 10, 29, 10, 2, 3],
  tail = Buffer.from([0, 0xff, 0xff, 0xff, 0xff])
) {
  const [year, month, day, hour, minute, second] = parts
  const body = Buffer.alloc(9)
  body.set([0x48, 0x4b, 1, 0, year - 2000])
  body.writeUInt32BE(
    (month * 2 ** 28 +
      day * 2 ** 23 +
      hour * 2 ** 18 +
      minute * 2 ** 12 +
      second * 2 ** 6 +
      32) >>>
      0,
    5
  )
  return Buffer.concat([
    Buffer.from([0x40, body.length + tail.length]),
    body,
    tail,
  ])
}

function map(info = hk(), esInfo = Buffer.alloc(0), codec = 0x24) {
  const es = Buffer.concat([
    Buffer.from([codec, 0xe0, 0, esInfo.length]),
    esInfo,
  ])
  const body = Buffer.concat([
    Buffer.from([0xe0, 0xff, info.length >>> 8, info.length & 255]),
    info,
    Buffer.from([es.length >>> 8, es.length & 255]),
    es,
    Buffer.alloc(4),
  ])
  return packet(0xbc, body)
}

function stamp(value: number, prefix: number) {
  return Buffer.from([
    (prefix << 4) | ((Math.floor(value / 2 ** 30) & 7) << 1) | 1,
    Math.floor(value / 2 ** 22) & 255,
    ((Math.floor(value / 2 ** 15) & 127) << 1) | 1,
    Math.floor(value / 2 ** 7) & 255,
    ((value & 127) << 1) | 1,
  ])
}

function video(pts: number, payload = Buffer.from([1]), dts?: number) {
  const timestamps = Buffer.concat([
    stamp(pts, dts === undefined ? 2 : 3),
    ...(dts === undefined ? [] : [stamp(dts, 1)]),
  ])
  return packet(
    0xe0,
    Buffer.concat([
      Buffer.from([0x80, dts === undefined ? 0x80 : 0xc0, timestamps.length]),
      timestamps,
      payload,
    ])
  )
}

function parse(bytes: Buffer, timeZone = "Asia/Shanghai", size = bytes.length) {
  const clock = new HikPsClock(timeZone)
  for (let offset = 0; offset < bytes.length; offset += size)
    clock.push(bytes.subarray(offset, offset + size))
  return clock
}

function continuation(payload: Buffer) {
  return packet(0xe0, Buffer.concat([Buffer.from([0x80, 0, 0]), payload]))
}

function annexB(...nals: number[][]) {
  return Buffer.concat(
    nals.map((nal, index) =>
      Buffer.from([...(index % 2 ? [0, 0, 1] : [0, 0, 0, 1]), ...nal])
    )
  )
}

function closedAnnexB(...nals: number[][]) {
  return Buffer.concat([annexB(...nals), Buffer.from([0, 0, 1])])
}

const h264Parameters = [
  [0x67, 0x80],
  [0x68, 0x80],
]
const hevcParameters = [
  [0x40, 1, 0x80],
  [0x42, 1, 0x80],
  [0x44, 1, 0x80],
]

function parseRandomAccess(bytes: Buffer, size = bytes.length) {
  const clock = new HikPsClock("Asia/Shanghai", { requireRandomAccess: true })
  for (let offset = 0; offset < bytes.length; offset += size)
    clock.push(bytes.subarray(offset, offset + size))
  return clock
}

describe("bounded HK Program Stream clock", () => {
  it.each([1, 2, 3, 4, 7, 13, 67, 1024])(
    "reads a structured PS clock with %i-byte chunks",
    (size) => {
      const clock = parse(
        Buffer.concat([pack, map(), video(90_000)]),
        undefined,
        size
      )
      expect(clock.startAt).toBe("2026-10-29T02:02:03.000Z")
      expect(clock.firstVideoPtsSeconds).toBe(1)
      expect(clock.precisionSeconds).toBe(1)
      expect(clock.error).toBeUndefined()
    }
  )

  it.each([40, 64])(
    "accepts only observed %i-byte initial IMKH headers",
    (size) => {
      const header = Buffer.alloc(size)
      header.write("IMKH")
      expect(
        parse(Buffer.concat([header, pack, map(), video(0)]), undefined, 1)
          .startAt
      ).toBe("2026-10-29T02:02:03.000Z")
    }
  )

  it("maps an earlier first presentation PTS from a later clock anchor", () => {
    const first = video(100_000)
    const direct = parse(Buffer.concat([pack, map(), first]))
    const later = parse(
      Buffer.concat([
        pack,
        first,
        video(130_000),
        map(hk([2026, 10, 29, 10, 2, 7])),
        video(460_000),
      ])
    )
    expect(later.startAt).toBe(direct.startAt)
    expect(later.firstVideoPtsSeconds).toBe(100_000 / 90_000)
  })

  it("preserves relative PTS milliseconds without claiming subsecond HK precision", () => {
    const clock = parse(
      Buffer.concat([pack, video(90_000), map(), video(112_500)])
    )
    expect(clock.startAt).toBe("2026-10-29T02:02:02.750Z")
    expect(clock.precisionSeconds).toBe(1)
  })

  it("uses PTS, not DTS, including initial B-frame reordering", () => {
    const clock = parse(
      Buffer.concat([
        pack,
        video(180_000, undefined, 90_000),
        map(),
        video(90_000, undefined, 270_000),
      ])
    )
    expect(clock.startAt).toBe("2026-10-29T02:02:04.000Z")
    expect(clock.firstVideoPtsSeconds).toBe(2)
  })

  it.each([
    [PTS_WRAP - 90_000, 90_000],
    [90_000, PTS_WRAP - 90_000],
  ])("handles a 33-bit PTS wrap from %i to %i", (first, anchor) => {
    const clock = parse(
      Buffer.concat([pack, video(first), map(), video(anchor)])
    )
    expect(clock.startAt).toBe(
      first > anchor ? "2026-10-29T02:02:01.000Z" : "2026-10-29T02:02:05.000Z"
    )
  })

  it("does not find HK, PSM or PTS bytes inside PES, padding or ES descriptors", () => {
    const fake = Buffer.concat([pack, map(), video(90_000)])
    const clock = parse(
      Buffer.concat([
        pack,
        packet(0xbd, fake),
        packet(0xbe, fake),
        video(90_000, fake),
        map(Buffer.alloc(0), hk()),
        video(180_000),
      ]),
      undefined,
      3
    )
    expect(clock.startAt).toBeUndefined()
    expect(clock.firstVideoPtsSeconds).toBe(1)
    expect(clock.error).toBeUndefined()
  })

  it("requires a clock-associated video PTS and never uses audio PTS", () => {
    const audio = Buffer.from(video(90_000))
    audio[3] = 0xc0
    const noPts = packet(0xe0, Buffer.from([0x80, 0, 0, 1]))
    const clock = parse(Buffer.concat([pack, map(), audio, noPts]))
    expect(clock.startAt).toBeUndefined()
    expect(clock.firstVideoPtsSeconds).toBeUndefined()
    clock.push(video(180_000))
    expect(clock.startAt).toBe("2026-10-29T02:02:03.000Z")
    expect(clock.firstVideoPtsSeconds).toBe(2)
  })

  it("does not use a valid clock before a newer clockless map", () => {
    const clock = parse(
      Buffer.concat([pack, map(), map(Buffer.alloc(0)), video(0)])
    )
    expect(clock.startAt).toBeUndefined()
    expect(clock.error).toBeUndefined()
  })

  it.each([
    [2026, 2, 30, 10, 2, 3],
    [2026, 0, 29, 10, 2, 3],
    [2026, 10, 0, 10, 2, 3],
    [2026, 10, 29, 24, 2, 3],
    [2026, 10, 29, 10, 60, 3],
    [2026, 10, 29, 10, 2, 60],
  ])("rejects invalid HK date fields %j", (...parts) => {
    const clock = parse(Buffer.concat([pack, map(hk(parts)), video(0)]))
    expect(clock.startAt).toBeUndefined()
    expect(clock.error).toBe("HIK_PS_CLOCK_INVALID")
  })

  it("rejects unknown HK versions, short bodies and multiple clock descriptors", () => {
    const unknown = hk()
    unknown[4] = 2
    const short = Buffer.from([0x40, 4, 0x48, 0x4b, 1, 0])
    for (const info of [unknown, short, Buffer.concat([hk(), hk()])]) {
      const clock = parse(Buffer.concat([pack, map(info), video(0)]))
      expect(clock.startAt).toBeUndefined()
      expect(clock.error).toBe("HIK_PS_CLOCK_INVALID")
    }
  })

  it("accepts opaque descriptor tails and ignores unknown non-HK descriptors", () => {
    for (const tail of [Buffer.alloc(0), Buffer.from([19, 28, 37])]) {
      const info = Buffer.concat([
        Buffer.from([0x40, 3, 1, 2, 3]),
        hk(undefined, tail),
      ])
      expect(parse(Buffer.concat([pack, map(info), video(0)])).startAt).toBe(
        "2026-10-29T02:02:03.000Z"
      )
    }
  })

  it("rejects invalid descriptor, program-map and elementary-map lengths", () => {
    const descriptor = hk()
    descriptor[1] += 1
    const program = map()
    program.writeUInt16BE(0xffff, 8)
    const elementary = map()
    elementary.writeUInt16BE(0xffff, 10 + hk().length)
    const esDescriptor = map(Buffer.alloc(0), Buffer.from([0x40, 9, 0x48]))
    for (const bytes of [map(descriptor), program, elementary, esDescriptor]) {
      const clock = parse(Buffer.concat([pack, bytes, video(0)]))
      expect(clock.startAt).toBeUndefined()
      expect(clock.error).toBe("HIK_PS_CLOCK_INVALID")
    }
  })

  it("rejects non-current maps and marker errors before trusting their clock", () => {
    const future = map()
    future[6] &= 0x7f
    const marker = map()
    marker[7] &= 0xfe
    const partialDescriptor = map(Buffer.from([0x40]))
    for (const bytes of [future, marker, partialDescriptor]) {
      const clock = parse(Buffer.concat([pack, bytes, video(0)]))
      expect(clock.startAt).toBeUndefined()
      expect(clock.error).toBe("HIK_PS_CLOCK_INVALID")
    }
  })

  it("uses only the explicit device time zone, and rejects DST folds and gaps", () => {
    const bytes = Buffer.concat([pack, map(), video(0)])
    expect(parse(bytes, "UTC").startAt).toBe("2026-10-29T10:02:03.000Z")
    expect(parse(bytes, "America/New_York").startAt).toBe(
      "2026-10-29T14:02:03.000Z"
    )
    for (const parts of [
      [2026, 11, 1, 1, 30, 0],
      [2026, 3, 8, 2, 30, 0],
    ]) {
      expect(
        parse(
          Buffer.concat([pack, map(hk(parts)), video(0)]),
          "America/New_York"
        ).error
      ).toBe("HIK_PS_CLOCK_INVALID")
    }
    expect(new HikPsClock("invalid/zone").error).toBe("HIK_PS_CLOCK_INVALID")
  })

  it("rejects PTS/DTS marker, prefix and optional-header errors", () => {
    const marker = video(0)
    marker[11] &= 0xfe
    const prefix = video(0)
    prefix[9] |= 0x10
    const dts = video(90_000, undefined, 0)
    dts[14] = 0x21
    const length = video(0)
    length[8] = 100
    const forbidden = video(0)
    forbidden[7] = 0x40
    for (const bytes of [marker, prefix, dts, length, forbidden]) {
      expect(parse(Buffer.concat([pack, map(), bytes])).error).toBe(
        "HIK_PS_CLOCK_INVALID"
      )
    }
  })

  it("skips system headers and full maximum-length packets across chunks", () => {
    const stuffed = Buffer.concat([
      Buffer.from(pack),
      Buffer.from([0xff, 0xff, 0xff]),
    ])
    stuffed[13] |= 3
    const clock = parse(
      Buffer.concat([
        stuffed,
        packet(0xbb, Buffer.from([1, 2, 3])),
        packet(0xbe, Buffer.alloc(65_535, 0xff)),
        map(),
        video(0),
      ]),
      undefined,
      65536
    )
    expect(clock.startAt).toBe("2026-10-29T02:02:03.000Z")
  })

  it("bounds the entire scan, including many individually valid packets", () => {
    const padding = packet(0xbe, Buffer.alloc(60_000))
    const clock = new HikPsClock("UTC")
    clock.push(pack)
    for (let i = 0; i < 20; i++) clock.push(padding)
    expect(clock.startAt).toBeUndefined()
    expect(clock.error).toBe("HIK_PS_CLOCK_LIMIT")
    clock.push(Buffer.concat([map(), video(0)]))
    expect(clock.startAt).toBeUndefined()
  })

  it("does not invent a clock from truncated input and enforces smaller scan budgets", () => {
    const bytes = Buffer.concat([pack, map(), video(0)])
    const truncated = parse(bytes.subarray(0, -1), undefined, 1)
    expect(truncated.startAt).toBeUndefined()
    expect(truncated.error).toBeUndefined()
    const limited = new HikPsClock("UTC", { maxBytes: bytes.length - 1 })
    limited.push(bytes)
    expect(limited.startAt).toBeUndefined()
    expect(limited.error).toBe("HIK_PS_CLOCK_LIMIT")
    for (const maxBytes of [0, -1, 1.5, 1024 * 1024 + 1, Infinity])
      expect(new HikPsClock("UTC", { maxBytes }).error).toBe(
        "HIK_PS_CLOCK_LIMIT"
      )
  })

  it("stops retaining or interpreting bytes after a result or program end", () => {
    const bytes = Buffer.concat([pack, map(), video(0)])
    const ready = new HikPsClock("UTC", { maxBytes: bytes.length })
    ready.push(Buffer.concat([bytes, Buffer.alloc(2 * 1024 * 1024)]))
    ready.push(Buffer.from("arbitrary payload"))
    expect(ready.startAt).toBe("2026-10-29T10:02:03.000Z")
    expect(ready.error).toBeUndefined()
    const ended = parse(
      Buffer.concat([pack, Buffer.from([0, 0, 1, 0xb9]), map(), video(0)])
    )
    expect(ended.startAt).toBeUndefined()
    expect(ended.error).toBeUndefined()
  })

  it("rejects unsupported packet boundaries without searching arbitrary bytes", () => {
    const header = Buffer.alloc(80)
    header.write("IMKH")
    for (const bytes of [
      Buffer.concat([Buffer.from("junk"), pack, map(), video(0)]),
      Buffer.concat([header, pack, map(), video(0)]),
      Buffer.concat([
        pack,
        Buffer.from([0, 0, 1, 0x67, 0, 0]),
        map(),
        video(0),
      ]),
      Buffer.concat([
        pack,
        Buffer.from([0, 0, 1, 0xe0, 0, 0]),
        map(),
        video(0),
      ]),
    ]) {
      const clock = parse(bytes)
      expect(clock.startAt).toBeUndefined()
      expect(clock.error).toBe("HIK_PS_CLOCK_INVALID")
    }
  })
})

describe("HK clock first random-access access-unit gate", () => {
  const profiles = [
    {
      name: "H264 IDR",
      codec: 0x1b,
      parameters: h264Parameters,
      idr: [0x65, 0xb8],
    },
    {
      name: "HEVC IDR_W_RADL",
      codec: 0x24,
      parameters: hevcParameters,
      idr: [0x26, 1, 0xa0],
    },
    {
      name: "HEVC IDR_N_LP",
      codec: 0x24,
      parameters: hevcParameters,
      idr: [0x28, 1, 0xa0],
    },
  ]

  it.each(profiles)(
    "accepts only the first $name after its parameter sets",
    (profile) => {
      const bytes = Buffer.concat([
        pack,
        map(undefined, undefined, profile.codec),
        video(90_000, closedAnnexB(...profile.parameters, profile.idr), 0),
      ])
      for (const size of [1, 2, 3, 7, 64, 65_536]) {
        const clock = parseRandomAccess(bytes, size)
        expect(clock.startAt).toBe("2026-10-29T02:02:03.000Z")
        expect(clock.firstVideoPtsSeconds).toBe(1)
        expect(clock.firstVideoHash).toBe(
          createHash("sha256").update(Buffer.from(profile.idr)).digest("hex")
        )
        expect(clock.error).toBeUndefined()
      }
    }
  )

  it.each(profiles)(
    "retains prefixes, NAL headers and parameter sets across PES for $name",
    (profile) => {
      const payload = closedAnnexB(...profile.parameters, profile.idr)
      for (let split = 0; split < payload.length; split++) {
        for (const hasPts of [false, true]) {
          const tail = payload.subarray(split)
          const bytes = Buffer.concat([
            pack,
            map(undefined, undefined, profile.codec),
            video(90_000, payload.subarray(0, split)),
            hasPts ? video(90_000, tail) : continuation(tail),
          ])
          const clock = parseRandomAccess(bytes, 1)
          expect(
            clock.error,
            `split=${split}, hasPts=${hasPts}`
          ).toBeUndefined()
          expect(clock.startAt).toBe("2026-10-29T02:02:03.000Z")
        }
      }
    }
  )

  it("does not publish a cached clock until the complete first VCL header and first-slice bit", () => {
    const clock = parseRandomAccess(
      Buffer.concat([pack, map(), video(90_000, annexB(...hevcParameters))])
    )
    expect(clock.startAt).toBeUndefined()
    expect(clock.firstVideoPtsSeconds).toBe(1)
    clock.push(map(Buffer.alloc(0)))
    clock.push(continuation(Buffer.from([0, 0])))
    clock.push(continuation(Buffer.from([1, 0x26])))
    expect(clock.startAt).toBeUndefined()
    clock.push(continuation(Buffer.from([1])))
    expect(clock.startAt).toBeUndefined()
    clock.push(continuation(Buffer.from([0xa0])))
    expect(clock.startAt).toBeUndefined()
    expect(clock.firstVideoHash).toBeUndefined()
    clock.push(continuation(Buffer.from([0, 0, 1])))
    expect(clock.startAt).toBe("2026-10-29T02:02:03.000Z")
    expect(clock.error).toBeUndefined()
  })

  it("does not replace an already cached time anchor with a later map", () => {
    const clock = parseRandomAccess(
      Buffer.concat([pack, map(), video(90_000, annexB(...hevcParameters))])
    )
    clock.push(map(hk([2026, 10, 29, 10, 2, 9])))
    clock.push(video(90_000, closedAnnexB([0x26, 1, 0xa0])))
    expect(clock.startAt).toBe("2026-10-29T02:02:03.000Z")
    expect(clock.error).toBeUndefined()
  })

  it("can interpolate a later clock only after the first random-access AU is proven", () => {
    const clock = parseRandomAccess(
      Buffer.concat([
        pack,
        map(Buffer.alloc(0)),
        video(100_000, closedAnnexB(...hevcParameters, [0x26, 1, 0xa0])),
      ])
    )
    expect(clock.startAt).toBeUndefined()
    clock.push(map(hk([2026, 10, 29, 10, 2, 7])))
    clock.push(video(460_000, annexB([0x02, 1, 0x80])))
    expect(clock.startAt).toBe("2026-10-29T02:02:03.000Z")
    expect(clock.firstVideoPtsSeconds).toBe(100_000 / 90_000)
  })

  it.each(profiles)(
    "hashes only the complete first $name NAL, excluding prefixes and all trailing zeros",
    (profile) => {
      const extraBody = [0, 0, 3, 1, 0x42, 0x7f]
      const first = [...profile.idr, ...extraBody]
      const payload = annexB(
        ...profile.parameters,
        [...first, 0, 0, 0, 0],
        profile.idr
      )
      const clock = parseRandomAccess(
        Buffer.concat([
          pack,
          map(undefined, undefined, profile.codec),
          video(0, payload),
        ]),
        1
      )
      expect(clock.startAt).toBe("2026-10-29T02:02:03.000Z")
      expect(clock.firstVideoHash).toBe(
        createHash("sha256").update(Buffer.from(first)).digest("hex")
      )
      expect(clock.error).toBeUndefined()
    }
  )

  it("closes the proven first VCL on a next-PES boundary with a new PTS without hashing the next AU", () => {
    const idr = [0x26, 1, 0xa0, 0x55]
    const clock = parseRandomAccess(
      Buffer.concat([pack, map(), video(0, annexB(...hevcParameters, idr))])
    )
    expect(clock.startAt).toBeUndefined()
    expect(clock.firstVideoHash).toBeUndefined()
    clock.push(video(90_000, Buffer.from([0])))
    clock.push(continuation(Buffer.from([0])))
    expect(clock.startAt).toBeUndefined()
    clock.push(continuation(Buffer.from([1, 0x02, 1, 0x80])))
    expect(clock.startAt).toBe("2026-10-29T02:02:03.000Z")
    expect(clock.firstVideoHash).toBe(
      createHash("sha256").update(Buffer.from(idr)).digest("hex")
    )
    expect(clock.error).toBeUndefined()
  })

  it("rejects new-PTS continuation bytes before the first VCL boundary", () => {
    const clock = parseRandomAccess(
      Buffer.concat([
        pack,
        map(),
        video(0, annexB(...hevcParameters, [0x26, 1, 0xa0])),
        video(90_000, Buffer.from([0, 0, 3, 0x55, 0, 0, 1])),
      ])
    )
    expect(clock.startAt).toBeUndefined()
    expect(clock.firstVideoHash).toBeUndefined()
    expect(clock.error).toBe("HIK_PS_CLOCK_INVALID")
  })

  it("incrementally hashes a large split NAL without retaining its payload", () => {
    const idr = Buffer.concat([
      Buffer.from([0x26, 1, 0xa0]),
      Buffer.alloc(70_000, 0x55),
    ])
    const payload = Buffer.concat([
      annexB(...hevcParameters),
      Buffer.from([0, 0, 1]),
      idr,
    ])
    const clock = parseRandomAccess(
      Buffer.concat([pack, map(), video(0, payload.subarray(0, 60_000))]),
      7
    )
    expect(clock.startAt).toBeUndefined()
    clock.push(continuation(payload.subarray(60_000)))
    clock.push(continuation(Buffer.alloc(500)))
    expect(clock.firstVideoHash).toBeUndefined()
    clock.push(continuation(Buffer.from([0, 0, 1])))
    expect(clock.firstVideoHash).toBe(
      createHash("sha256").update(idr).digest("hex")
    )
    expect(clock.startAt).toBe("2026-10-29T02:02:03.000Z")
    expect(clock.error).toBeUndefined()
  })

  it("does not publish a valid IDR header without its complete NAL boundary", () => {
    const clock = parseRandomAccess(
      Buffer.concat([
        pack,
        map(),
        video(0, annexB(...hevcParameters, [0x26, 1, 0xa0])),
      ])
    )
    expect(clock.startAt).toBeUndefined()
    expect(clock.firstVideoHash).toBeUndefined()
    clock.push(Buffer.from([0, 0, 1, 0xb9]))
    expect(clock.startAt).toBeUndefined()
    expect(clock.firstVideoHash).toBeUndefined()
    expect(clock.error).toBe("HIK_PS_CLOCK_INVALID")
  })

  it.each([1, 2, 3, 4, 19, 20, 21])(
    "never skips a leading H264 type %i to find a later IDR",
    (type) => {
      for (const samePacket of [true, false]) {
        const first = annexB(...h264Parameters, [0x60 | type, 0xb8])
        const later = annexB(...h264Parameters, [0x65, 0xb8])
        const clock = parseRandomAccess(
          Buffer.concat([
            pack,
            map(undefined, undefined, 0x1b),
            video(0, samePacket ? Buffer.concat([first, later]) : first),
            ...(samePacket ? [] : [video(90_000, later)]),
          ]),
          3
        )
        expect(clock.startAt).toBeUndefined()
        expect(clock.error).toBe("HIK_PS_CLOCK_INVALID")
      }
    }
  )

  it.each([0, 1, 8, 16, 17, 18, 21, 22, 31])(
    "never skips leading HEVC type %i, including CRA and BLA",
    (type) => {
      const first = annexB(...hevcParameters, [type << 1, 1, 0x80])
      const later = annexB(...hevcParameters, [0x26, 1, 0xa0])
      for (const samePacket of [true, false]) {
        const clock = parseRandomAccess(
          Buffer.concat([
            pack,
            map(),
            video(0, samePacket ? Buffer.concat([first, later]) : first),
            ...(samePacket ? [] : [video(90_000, later)]),
          ])
        )
        expect(clock.startAt).toBeUndefined()
        expect(clock.error).toBe("HIK_PS_CLOCK_INVALID")
      }
    }
  )

  it.each(profiles)("rejects a middle slice of the first $name", (profile) => {
    const idr = profile.idr.slice()
    idr[idr.length - 1] &= 0x7f
    const clock = parseRandomAccess(
      Buffer.concat([
        pack,
        map(undefined, undefined, profile.codec),
        video(0, annexB(...profile.parameters, idr)),
      ])
    )
    expect(clock.startAt).toBeUndefined()
    expect(clock.error).toBe("HIK_PS_CLOCK_INVALID")
  })

  it.each(profiles)(
    "rejects missing or incomplete parameter sets before $name",
    (profile) => {
      for (let missing = -1; missing < profile.parameters.length; missing++) {
        const parameters =
          missing < 0
            ? []
            : profile.parameters.filter((_, index) => index !== missing)
        const clock = parseRandomAccess(
          Buffer.concat([
            pack,
            map(undefined, undefined, profile.codec),
            video(0, annexB(...parameters, profile.idr)),
          ])
        )
        expect(clock.startAt).toBeUndefined()
        expect(clock.error).toBe("HIK_PS_CLOCK_INVALID")
      }
      const emptyParameter = profile.parameters.map((nal) => nal.slice(0, -1))
      expect(
        parseRandomAccess(
          Buffer.concat([
            pack,
            map(undefined, undefined, profile.codec),
            video(0, annexB(...emptyParameter, profile.idr)),
          ])
        ).error
      ).toBe("HIK_PS_CLOCK_INVALID")
    }
  )

  it("requires the first E0 PES to have a valid PTS even when it only carries parameters", () => {
    const clock = parseRandomAccess(
      Buffer.concat([
        pack,
        map(),
        continuation(annexB(...hevcParameters)),
        video(0, annexB([0x26, 1, 0xa0])),
      ])
    )
    expect(clock.startAt).toBeUndefined()
    expect(clock.error).toBe("HIK_PS_CLOCK_INVALID")
  })

  it("rejects a new presentation timestamp before the first VCL, including across wrap", () => {
    for (const [first, next] of [
      [0, 90_000],
      [PTS_WRAP - 1, 0],
    ]) {
      const clock = parseRandomAccess(
        Buffer.concat([
          pack,
          map(),
          video(first, annexB(...hevcParameters)),
          video(next, annexB([0x26, 1, 0xa0])),
        ])
      )
      expect(clock.startAt).toBeUndefined()
      expect(clock.error).toBe("HIK_PS_CLOCK_INVALID")
    }
  })

  it("does not infer the codec from payload bytes or an absent, duplicate or changed E0 map", () => {
    const missing = map()
    missing[10 + hk().length + 3] = 0xe1
    const duplicate = map()
    const esStart = 10 + hk().length + 2
    const duplicateBody = Buffer.concat([
      duplicate.subarray(6, esStart + 4),
      duplicate.subarray(esStart, esStart + 4),
      Buffer.alloc(4),
    ])
    duplicateBody.writeUInt16BE(8, 10 + hk().length - 6)
    const payload = closedAnnexB(...hevcParameters, [0x26, 1, 0xa0])
    for (const psm of [
      map(undefined, undefined, 2),
      missing,
      packet(0xbc, duplicateBody),
    ]) {
      const clock = parseRandomAccess(
        Buffer.concat([pack, psm, video(0, payload)])
      )
      expect(clock.startAt).toBeUndefined()
      expect(clock.error).toBe("HIK_PS_CLOCK_INVALID")
    }
    const changed = parseRandomAccess(
      Buffer.concat([
        pack,
        map(),
        video(0, annexB(...hevcParameters)),
        map(undefined, undefined, 0x1b),
        video(0, annexB(...h264Parameters, [0x65, 0xb8])),
      ])
    )
    expect(changed.startAt).toBeUndefined()
    expect(changed.error).toBe("HIK_PS_CLOCK_INVALID")
    expect(
      parseRandomAccess(Buffer.concat([pack, video(0, payload)])).error
    ).toBe("HIK_PS_CLOCK_INVALID")
  })

  it("rejects forbidden bits, unsupported NAL types, layers and temporal IDs", () => {
    for (const idr of [
      [0xa6, 1, 0xa0],
      [0x26, 0, 0xa0],
      [0x27, 1, 0xa0],
      [0x26, 9, 0xa0],
      [0x26, 2, 0xa0],
      [0x52, 1, 0xa0],
    ]) {
      const clock = parseRandomAccess(
        Buffer.concat([pack, map(), video(0, annexB(...hevcParameters, idr))])
      )
      expect(clock.startAt).toBeUndefined()
      expect(clock.error).toBe("HIK_PS_CLOCK_INVALID")
    }
    for (const idr of [
      [0xe5, 0xb8],
      [5, 0xb8],
      [0, 0xb8],
      [0x78, 0xb8],
    ]) {
      expect(
        parseRandomAccess(
          Buffer.concat([
            pack,
            map(undefined, undefined, 0x1b),
            video(0, annexB(...h264Parameters, idr)),
          ])
        ).error
      ).toBe("HIK_PS_CLOCK_INVALID")
    }
    const forbiddenParameter = annexB(
      [0xc0, 1, 0x80],
      ...hevcParameters,
      [0x26, 1, 0xa0]
    )
    expect(
      parseRandomAccess(
        Buffer.concat([pack, map(), video(0, forbiddenParameter)])
      ).error
    ).toBe("HIK_PS_CLOCK_INVALID")
  })

  it("rejects leading junk and empty NALs instead of scanning ahead to an IDR", () => {
    const payload = closedAnnexB(...hevcParameters, [0x26, 1, 0xa0])
    for (const leading of [
      Buffer.from("junk"),
      Buffer.from([1]),
      Buffer.from([0, 0, 2]),
      Buffer.from([0, 0, 1]),
      Buffer.from([0, 0, 1, 0x40]),
    ]) {
      const clock = parseRandomAccess(
        Buffer.concat([
          pack,
          map(),
          video(0, Buffer.concat([leading, payload])),
        ]),
        1
      )
      expect(clock.startAt).toBeUndefined()
      expect(clock.error).toBe("HIK_PS_CLOCK_INVALID")
    }
    expect(
      parseRandomAccess(
        Buffer.concat([
          pack,
          map(),
          video(0, Buffer.concat([Buffer.alloc(19), payload])),
        ]),
        1
      ).startAt
    ).toBe("2026-10-29T02:02:03.000Z")
  })

  it("never scans nested clock or random-access bytes from non-video packets", () => {
    const payload = closedAnnexB(...hevcParameters, [0x26, 1, 0xa0])
    const fake = Buffer.concat([pack, map(), video(0, payload)])
    const clock = parseRandomAccess(
      Buffer.concat([
        pack,
        map(Buffer.alloc(0)),
        packet(0xbd, fake),
        packet(0xbe, fake),
        video(0, payload),
      ]),
      1
    )
    expect(clock.startAt).toBeUndefined()
    expect(clock.firstVideoHash).toBeDefined()
    expect(clock.error).toBeUndefined()
    const nested = parseRandomAccess(
      Buffer.concat([pack, map(), video(0, fake)])
    )
    expect(nested.startAt).toBeUndefined()
    expect(nested.error).toBe("HIK_PS_CLOCK_INVALID")
    const audio = Buffer.from(video(0, payload))
    audio[3] = 0xc0
    const onlyParameters = parseRandomAccess(
      Buffer.concat([pack, map(), audio, video(0, annexB(...hevcParameters))])
    )
    expect(onlyParameters.startAt).toBeUndefined()
    expect(onlyParameters.error).toBeUndefined()
  })

  it("waits for split VCL payload, then rejects incomplete or all-zero access units at program end", () => {
    for (const tail of [
      [],
      [0, 0, 1],
      [0, 0, 1, 0x26],
      [0, 0, 1, 0x26, 1],
      [0, 0, 0],
    ]) {
      const clock = parseRandomAccess(
        Buffer.concat([
          pack,
          map(),
          video(
            0,
            Buffer.concat([annexB(...hevcParameters), Buffer.from(tail)])
          ),
        ])
      )
      expect(clock.startAt).toBeUndefined()
      expect(clock.error).toBeUndefined()
      clock.push(Buffer.from([0, 0, 1, 0xb9]))
      expect(clock.startAt).toBeUndefined()
      expect(clock.error).toBe("HIK_PS_CLOCK_INVALID")
    }
  })

  it("keeps the total 1 MiB scan bound while waiting for the first VCL", () => {
    const clock = parseRandomAccess(
      Buffer.concat([pack, map(), video(0, Buffer.alloc(0))])
    )
    const zeros = continuation(Buffer.alloc(60_000))
    for (let i = 0; i < 20; i++) clock.push(zeros)
    expect(clock.startAt).toBeUndefined()
    expect(clock.error).toBe("HIK_PS_CLOCK_LIMIT")
    clock.push(video(0, annexB(...hevcParameters, [0x26, 1, 0xa0])))
    expect(clock.startAt).toBeUndefined()
    expect(clock.error).toBe("HIK_PS_CLOCK_LIMIT")
  })

  it("stops at a proven first AU without consuming later arbitrary input", () => {
    const bytes = Buffer.concat([
      pack,
      map(),
      video(0, closedAnnexB(...hevcParameters, [0x26, 1, 0xa0])),
    ])
    const clock = new HikPsClock("UTC", {
      requireRandomAccess: true,
      maxBytes: bytes.length,
    })
    clock.push(Buffer.concat([bytes, Buffer.alloc(2 * 1024 * 1024)]))
    expect(clock.startAt).toBe("2026-10-29T10:02:03.000Z")
    expect(clock.error).toBeUndefined()
  })

  it("preserves the legacy timestamp-only behavior when the gate is explicitly disabled", () => {
    const clock = new HikPsClock("UTC", { requireRandomAccess: false })
    clock.push(
      Buffer.concat([pack, map(), video(0, Buffer.from("not an IDR"))])
    )
    expect(clock.startAt).toBe("2026-10-29T10:02:03.000Z")
    expect(clock.error).toBeUndefined()
  })
})
