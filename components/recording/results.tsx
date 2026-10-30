"use client"

import { ArchiveIcon, PlayIcon } from "lucide-react"
import type { RecordingConsoleState } from "@/hooks/use-recording-console"
import { PreviewPlayer } from "@/components/preview-player"
import { Button } from "@/components/ui/button"
import { RecordingLoading } from "./loading"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import { RecordingDistribution } from "./distribution"
import { RecordingSegmentList } from "./segment-list"

export function RecordingResults({ state }: { state: RecordingConsoleState }) {
  const {
    resources,
    resourceError,
    error,
    loading,
    data,
    segment,
    selectionKey,
    track,
    date,
    requestedTime,
    updatePlaybackTime,
    updatePlaybackActivity,
    automatic,
    preferences,
    updatePreferences,
    nextSegment,
    stopSequence,
    selectSegment,
  } = state
  const distribution = data ? (
    <RecordingDistribution {...state} data={data} />
  ) : null

  return (
    <section
      className="recording-content"
      aria-label="录像查询结果"
      aria-busy={loading || (!resources && !resourceError)}
    >
      {resourceError || error ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>暂时无法显示录像</EmptyTitle>
            <EmptyDescription>请刷新后重试。</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : null}
      {!resources && !resourceError ? (
        <RecordingLoading label="正在读取设备" />
      ) : null}
      {resources && !resources.channels.length ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>暂无可用摄像头</EmptyTitle>
            <EmptyDescription>
              请检查设备连接和账号查询权限，再刷新。
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : null}
      {loading ? <RecordingLoading /> : null}
      {data && (
        <>
          {data.segments.length > 0 ? (
            <div className="playback-focus">
              {segment ? (
                <>
                  <PreviewPlayer
                    key={`${selectionKey}|${segment.id}`}
                    track={track}
                    date={date}
                    segmentId={segment.id}
                    timeZone={data.timeZone}
                    requestedTime={requestedTime}
                    onPlaybackTimeChange={updatePlaybackTime}
                    onActivityChange={updatePlaybackActivity}
                    timeline={distribution}
                    channelName={
                      resources?.channels.find(
                        (channel) => channel.id === track
                      )?.name
                    }
                    autoStart={automatic === segment.id}
                    initialPreferences={preferences}
                    onPreferencesChange={updatePreferences}
                    onPlaybackEnded={nextSegment}
                    onStop={stopSequence}
                  />
                </>
              ) : (
                <div className="playback-player playback-selection">
                  <Empty className="playback-selection-empty">
                    <Button
                      className="playback-center-button"
                      size="icon-lg"
                      aria-label="播放"
                      title="播放"
                      onClick={() => selectSegment(data.segments[0].id)}
                    >
                      <PlayIcon />
                    </Button>
                  </Empty>
                  {distribution}
                </div>
              )}
            </div>
          ) : (
            <div className="playback-player playback-selection">
              <Empty className="playback-selection-empty">
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <ArchiveIcon />
                  </EmptyMedia>
                  <EmptyTitle>这一天没有检索到录像</EmptyTitle>
                  <EmptyDescription>试试其他日期或摄像头。</EmptyDescription>
                </EmptyHeader>
              </Empty>
              {distribution}
            </div>
          )}
          {data.segments.length > 0 && (
            <RecordingSegmentList {...state} data={data} />
          )}
        </>
      )}
    </section>
  )
}
