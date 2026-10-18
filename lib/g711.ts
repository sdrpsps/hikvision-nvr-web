// G.711 expands 8-bit logarithmic samples to signed PCM on the user's machine.
export function decodeG711(bytes: Uint8Array, codec: "alaw" | "ulaw") {
  const samples = new Float32Array(bytes.length)
  for (let i = 0; i < bytes.length; i++) {
    let value: number
    if (codec === "alaw") {
      const a = bytes[i] ^ 0x55,
        segment = (a & 0x70) >> 4
      let magnitude = (a & 0x0f) << 4
      magnitude += segment === 0 ? 8 : 0x108
      if (segment > 1) magnitude <<= segment - 1
      value = a & 0x80 ? magnitude : -magnitude
    } else {
      const u = ~bytes[i] & 0xff
      const magnitude = (((u & 0x0f) << 3) + 0x84) << ((u & 0x70) >> 4)
      value = u & 0x80 ? 0x84 - magnitude : magnitude - 0x84
    }
    samples[i] = value / 32768
  }
  return samples
}
