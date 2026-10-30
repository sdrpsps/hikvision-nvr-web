# Hikvision NVR Web

[简体中文](README.md) | [English](README.en.md)

A browser-based client for viewing live video and recordings from a Hikvision NVR, recording a live channel to your computer, and downloading clips without an ActiveX plugin.

The NVR continues to record and store footage as usual. This application provides viewing and local saving. Apart from channel names that you explicitly save, it does not change device settings or delete recordings on the NVR.

**There is no web login.** Device connection settings come from server-side environment variables, and anyone who can access the application can use it. Run it on a trusted local computer or LAN.

The current feature set largely covers the author's everyday needs. Future work focuses on fixes and necessary maintenance. This README describes usage and known limitations; development rules are in [AGENTS.md](AGENTS.md).

## Why this project exists

The author wanted to play Hikvision NVR recordings on macOS, but the web playback plugin was available only for Windows. The macOS Hikvision client was outdated, and available GitHub projects did not meet the author's needs. This project provides live viewing, recording searches, and clip saving directly in a browser on macOS, without depending on the Windows plugin.

## Features

- **Rename channels:** use the pencil beside a channel on the live page to save a new name to the NVR. The device account needs the corresponding configuration permission.
- **Live viewing:** choose 1, 2, 4, 8, or 16 panes, assign a camera to each pane, and start it with the central play button. A loading indicator appears while connecting and buffering.
- **Recorded playback:** search by camera and date, start from the central play button, and seek using the player's full-day timeline. Dragging shows the target time; releasing seeks and starts playback. Audio and playback speeds from 0.25× to 4× are supported.
- **Live recording:** choose a destination and record until stopped manually or until a 15-, 30-, or 60-minute limit is reached.
- **Clip downloads:** mark a start and end within the current recording file and save that range. Saved footage stays at its original speed, regardless of playback speed, pause, or mute settings.

H.264 and H.265 video are supported. **H.265 playback depends on the browser and operating system's decoding support.** There is no automatic fallback to server-side transcoding.

## Getting started

### Requirements

On the computer running the application, install or provide:

- Node.js 20.9 or later and pnpm.
- FFmpeg, with `ffmpeg` available on the command line. Live viewing, recorded playback, and live recording use it; listing channels and searching recordings do not require it.
- Network access to the NVR and a device account with the required viewing permissions.

FFmpeg runs on the **application server**, so it does not need to be installed on a separate computer used only as a browser client. `ffprobe` is used for diagnostics and verification, not everyday playback or saving.

### Configure the NVR

In the project directory, run:

```sh
pnpm install
cp -n .env.example .env
```

The copy command above is for a Unix-like shell; `cp -n` preserves an existing `.env`. In PowerShell, use this instead of the copy command:

```powershell
if (-not (Test-Path .env)) { Copy-Item .env.example .env }
```

Edit `.env` and fill in at least these three settings. Alternatively, inject the same environment variables when starting the application.

| Variable | Value |
| --- | --- |
| `NVR_HOST` | NVR IP address or hostname only, without `http://`, a path, or credentials |
| `NVR_USERNAME` | Device username |
| `NVR_PASSWORD` | Device password |

The usual defaults are HTTP port `80`, RTSP port `554`, and time zone `Asia/Shanghai`. Search dates and recording times are displayed in Beijing time by default.

`NVR_RECORDING_TIME_MODE` defaults to `device-local` to handle the recording timestamp format of the tested device. For firmware using standard UTC timestamps, set it to `utc`. See [.env.example](.env.example) for all settings, including binary paths. Restart the application after changing configuration.

These credentials authenticate the server to the NVR; you do not enter them in the web interface. Only the server reads the username and password and performs the device's Digest authentication. **Do not commit or share a populated `.env`.**

### Start the application

```sh
pnpm dev
```

Open the address printed in the terminal, usually [http://localhost:3000](http://localhost:3000). The development server may choose another port if 3000 is occupied; use the address it reports.

Other computers on the LAN can use the application server's IP address and actual port. **Recording or downloading from another computer requires HTTPS: an ordinary LAN HTTP address does not meet the browser's file-writing requirements.** Saving locally through `http://localhost` is supported.

For a production build, stop the development server first, then run:

```sh
pnpm build
pnpm start
```

Only this application needs to run; there is no separate API service to start. Configure HTTPS, reverse proxies, and deployment settings for your environment.

## Usage

The interface currently uses Chinese labels. The relevant labels are included below to help you find each action.

### Watch live video

The home page starts with four panes. Select a pane, assign a camera from the left channel list or the pane's selector, and click the central play button. A spinner appears during connection and initial buffering. The top **Start all** (全部开始) action starts the assigned panes together.

Opening the page or adding panes does not start streams automatically. Each pane can be stopped, unmuted, or opened fullscreen independently. Changing its channel, reducing the layout, or leaving the live page stops the corresponding preview.

Each live preview currently lasts **at most 10 minutes**, after which you must start it again. Independent recording tasks are not affected by this preview limit.

Live viewing starts at a random-access frame near the media edge while retaining the preceding GOP dependencies. Excessive lag can skip old content to catch up, without changing an independent recording's source or output. This remains ordinary HLS, not LL-HLS, and does not measure camera-to-screen latency. Failures still require a manual retry; there is no infinite reconnect loop.

### Keep page selections in the URL

Page selections use nuqs. Copying or bookmarking the current address, or refreshing it, restores the state represented by these parameters:

| Page | Parameters | Meaning |
| --- | --- | --- |
| Playback | `track`, `date`, `zoom` | Camera track, query date in the device time zone, and timeline zoom (`1`, `2`, or `4`) |
| Live | `layout`, `window`, `sidebar`, `slots` | Pane count (`1`, `2`, `4`, `8`, or `16`), selected pane (one-based), channel sidebar visibility, and channel assignments |

For example, `/playback?track=201&date=2026-10-24&zoom=2` selects that track and date with 2× timeline zoom. `/?layout=2&slots=1:201,2:101&sidebar=false` restores two assigned panes and hides the sidebar. In `slots`, `3:0` explicitly leaves pane 3 unassigned.

Changing the playback camera or date creates a history entry that browser Back/Forward can restore. Zoom, layout, sidebar, and live-pane changes replace the current entry. Defaults are usually omitted. Without a date or track, playback uses today in the device time zone and the first available channel. Query or zoom changes also write the effective channel and date into the URL so a shared link identifies a fixed query.

Invalid parameters fall back to defaults. A removed playback channel falls back to the first available channel; an invalid live assignment appears unassigned. URLs do not store device addresses, credentials, media URIs, sessions, clip selections, audio settings, or recording tasks. Opening a link or refreshing does not start streams. The top navigation opens the other page's default address; copy the full URL or use browser Back to retain a particular selection.

### Rename a channel

Click the pencil beside a channel, enter a name, and choose **Save** (保存). Names are trimmed and conservatively limited to **1–32 UTF-8 bytes**; a Chinese character typically uses three bytes. Duplicate submissions are disabled while saving. Failed saves retain the input and show the reason. After the name is read back from the device and confirmed, the shared channel list used by live viewing and playback is refreshed.

This changes the NVR digital channel's configured name, without separately changing the on-screen display (OSD) text in the video. Mocked automated tests and read-only configuration checks on a real device have passed; **real-device writes and persistence remain unverified**.

The endpoint is `PUT /api/channels/:trackId/name`, accepting only JSON such as `{ "name": "New name" }`. The server uses the actual `SrcChannel` mapping to locate `/ISAPI/ContentMgmt/InputProxy/channels/<ID>`, reads the original configuration, preserves other fields, updates the name, then reads it again to confirm. Missing mappings are rejected. The endpoint accepts neither device addresses nor complete XML documents.

### Record live video

Choose **Record** (录制) in a pane, select a duration and destination, and start recording. The default duration is 30 minutes. Use **Stop and save** (停止并保存) to finish earlier.

A recording remains tied to its original channel. Switching channels, changing the pane layout, stopping the preview, or navigating to playback within the application does not stop it. It can also continue during a brief switch to another browser tab. The top **Recordings and downloads** (录制与下载) area and task status bars show progress and let you stop the original channel's recording.

When saving to a folder is supported, recordings are split into files approximately every **5 minutes**, with the final segment completed when recording stops. Single-file saving and Safari's native download path produce one file. A page supports at most **4 simultaneous recording or download tasks**.

**Keep the page open and the computer awake while recording.** Refreshing or closing the page, quitting the browser, a frozen page, or computer sleep can interrupt a task. Leave-page warnings and final saving are best effort. Tasks do not resume automatically when you reopen the page. Completed segments remain available, but unfinished files are not guaranteed to be recoverable.

### Find recordings and download clips

1. Open **Recorded playback** (录像回放) and choose a camera and date.
2. Click the central play button to start the day's first recording segment. Alternatively, click or drag the player's full-day timeline; releasing seeks and plays, including when paused or before playback has started. Selecting a segment from the list starts it immediately.
3. Choose **Download clip** (下载片段), set the start and end, and select a destination.

On devices supporting SHTTP time-based playback, the server starts reading near the selected time at a keyframe, then seeks to the target without downloading the preceding hours of the file. A new target within the same file releases the old session before opening a new time-based stream. Devices explicitly lacking support retain HTTP file playback: only already-read content can be sought directly, so later targets may still wait for the preceding content. Authentication, protocol, or clock-validation failures on a supported device produce an error rather than silently falling back to a slow full-file download.

Clip boundaries use **recording clock times on the selected query date**, in Beijing time by default. Click the start or end time to select hours, minutes, and seconds on three [React Wheel Picker](https://github.com/ncdai/react-wheel-picker) columns using the mouse wheel, dragging, touch gestures, or the keyboard, such as `14:20:00` to `14:21:00`; the date follows the current playback query. You can also mark the playback position or drag the range once the full file duration is known. The dialog subtitle shows the available range within that day and file. `24:00:00` means the end of the selected day. Task ranges, actual coverage, and filenames retain full recording dates and times.

The saved range may extend slightly before or after the selection so that the video remains playable. The task shows the actual covered range. Once a download starts, changing the camera, date, or file, or closing playback, does not affect that submitted task.

Downloads preserve the original speed and supported audio from the source. Playback at 4× speed, pausing, or muting does not change the saved content. Downloads currently work only **within one file**. Files spanning midnight are limited to the selected query date; cross-day and cross-file exports are unsupported. Clock times are mapped using the complete file start reported by the device. Absolute alignment with the on-screen clock is unverified, and keyframes may slightly expand the saved range.

Click the video to pause and the central button to resume. A loading indicator appears while connecting, buffering, or seeking. Opening the page does not start a stream. When the current segment ends and has been fully read, the old session is released before playback automatically advances to the day's next segment, retaining speed and audio preferences. Gaps are indicated, and playback stops after the last segment. Closing playback, changing the query, or a playback failure cancels advancement; there is no separate continuous-playback switch.

Playback has one full-day timeline inside the player, including fullscreen. Its cursor follows the displayed frame time. Dragging shows the target time; releasing seeks and plays. A time with no footage produces a notice and leaves the current position unchanged. The interface does not duplicate the day's coverage, selected time, or full file range elsewhere. HTTP file playback uses the complete file start recovered by the server. SHTTP establishes the media origin from the device's frame-time marker and a verified first frame, rather than assuming the returned stream starts exactly at the requested time. While waiting for a target that has not yet been read, the player frame and waiting/cancel controls remain visible. Unconfirmed file or frame times produce an explicit error.

Device absolute-time markers have one-second precision; subsecond agreement with the video OSD is not guaranteed. Integration with native Safari playback still needs validation. Download selections continue to use positions relative to the complete file, not the current viewing window.

## Saved files and data flow

Recordings and clips are saved as **MKV**, preserving the original H.264/H.265 video and supported G.711 audio without recompressing the video. Unsupported audio may be omitted; the task then reports **Partially saved** (部分保存). Open the result with a compatible player such as VLC or IINA.

Saving receives, processes, and writes data incrementally instead of collecting the entire recording in browser memory first. The browser and operating system still use buffers or local temporary files.

The server connects to the NVR and forwards data; live streams also use FFmpeg to remux the transport format. The browser creates the final recording and download files. **Recorded playback does keep controlled temporary fragments on the server to support seeking**, with cleanup when closed or expired.

Clip downloads still read the original file-download interface, not the SHTTP viewing window. If the device only supports sequential reads from the beginning of a file, downloading a later clip must first read the preceding content. Even when viewing can seek quickly, selecting a short clip download does not guarantee immediate disk writes or that only the selected range travels over the network.

With native browser downloads, including Safari's path, check the browser's download list after the application reports **Transfer complete** (传送完成) to confirm that the file has finished downloading. Some players may not immediately show the duration of these MKV files, and seeking compatibility varies.

## Compatibility and known limitations

The documented real-device checks used a Hikvision **`DS-7816NB-K2/16P`** with firmware **`V4.30.000`**. Other models and firmware need separate validation. The following is the project's reported verification scope, not a guarantee for every environment:

| Browser | Reported verification scope |
| --- | --- |
| Desktop Chrome | Real-device live viewing, full recording playback, live recording, and clip downloads; SHTTP time-based starts near a file's end, same-file reseeking, and session release; a 30-minute single-channel recording, 5-minute segmentation, and independently stopping two simultaneous recordings were checked. |
| Safari 27.0.1 | Short single-channel HEVC live viewing; short recordings, clip downloads, cancellation, channel/layout changes, in-app navigation, and brief backgrounding while saving were checked. Full playback combined with audio, seeking, and fullscreen, plus long-running or multi-channel saving, remain unverified. |
| Edge | Not separately tested. |

Additional limitations:

- A 16-pane interface does not mean stable simultaneous playback of 16 real cameras has been verified. Device streaming capacity, network conditions, and client decoding performance all matter.
- 60-minute recordings, long-running multi-channel saving, and file recovery after sleep or crashes remain unverified. Browser recording is for occasional local copies; the NVR remains responsible for continuous recording.
- Supported devices use SHTTP time-based playback; other devices retain HTTP file playback. SHTTP is a vendor-specific protocol, not standard RTSP, and the standard historical RTSP path is still not working. Automatic advancement is implemented, but real-device file transitions and long-term stability still need acceptance testing. Seamless transitions between files are not guaranteed.
- There is no application login or user account system. Use a trusted network. If you add network or reverse-proxy access restrictions, cover pages, APIs, and media resources; same-origin checks are not authentication. Do not expose NVR management or RTSP ports directly to the public internet.

## Development

The project uses Next.js, React, TypeScript, and Hono. Frontend and backend run in one Next.js application. Pages are in `app/`, UI components in `components/`, device integrations and media services in `server/`, and shared contracts in `shared/`.

Common checks:

```sh
pnpm test
pnpm typecheck
pnpm lint
pnpm test:e2e
```

Browser tests use mocked data by default. To reuse an existing development server, set `TEST_BASE_URL`; otherwise the test setup starts a server on port 3100. For example, in a Unix-like shell:

```sh
TEST_BASE_URL=http://localhost:3000 pnpm test:e2e
```

In PowerShell:

```powershell
$env:TEST_BASE_URL = "http://localhost:3000"
pnpm test:e2e
```

Real-device tests require explicit opt-in environment variables. Check the individual cases in `tests/browser/` and confirm the scope of streaming, saving, and device operations before running them. Follow [AGENTS.md](AGENTS.md) for development constraints. Report test results in the task response rather than maintaining separate development plans or verification logs.

The active video element's `data-live-startup` attribute exposes numeric startup diagnostics. `server` separates the first output byte, complete media fragment, independent fragment, and buffer readiness. Browser timings start at the preview request and distinguish the API response, player mount, `playing`, and the first `requestVideoFrameCallback`. The latter observes a frame submitted for display without reading pixels; unsupported browsers leave `firstFrameMs` as `null`, rather than substituting `playing`. These diagnostics live only with the current player, with no persistent logs or media capture. Compare cold-page and repeated starts alongside failures, stalls, and decoded/dropped frames; synthetic results do not establish a device speedup.
