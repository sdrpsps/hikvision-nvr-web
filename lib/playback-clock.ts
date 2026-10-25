export type PlaybackTimeRequest = { at: string; revision: number }

export function playbackOffset(at: string, startAt: string) {
  return (Date.parse(at) - Date.parse(startAt)) / 1000
}

export function playbackInstant(startAt: string, seconds: number) {
  return new Date(Date.parse(startAt) + seconds * 1000).toISOString()
}
