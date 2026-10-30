import type { ReactNode } from "react"
import type { PlaybackTimeRequest } from "@/lib/playback-clock"

export type PlaybackPreferences = {
  rate: number
  sound: boolean
  stepSeconds?: number
}

export type StreamSource =
  | { track: string; date: string; segmentId: string; live?: false }
  | { track: string; live: true }

export type StreamPlayerHandle = { start: () => void }
export type PlaybackOptions = {
  channelName?: string
  timeZone?: string
  autoStart?: boolean
  initialPreferences?: PlaybackPreferences
  onPreferencesChange?: (preferences: Partial<PlaybackPreferences>) => void
  onPlaybackEnded?: () => void
  onStop?: () => void
  onActivityChange?: (active: boolean) => void
  requestedTime?: PlaybackTimeRequest
  onPlaybackTimeChange?: (at: string | undefined) => void
  timeline?: ReactNode
}
