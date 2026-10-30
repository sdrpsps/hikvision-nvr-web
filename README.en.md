# Hikvision NVR Web

[简体中文](README.md) | [English](README.en.md)

View live video and recordings from a Hikvision NVR in your browser, record live video, and download clips without an ActiveX plugin. The NVR continues to record and store footage. Apart from channel names you explicitly save, the application does not change device settings or delete recordings.

**There is no web login.** Anyone who can access the application can use it, so run it on a trusted computer or LAN. Device credentials are configured on the server; you do not enter them in the web interface.

## Why this project exists

The author wanted to play Hikvision NVR recordings on macOS, but the web playback plugin was available only for Windows. The macOS Hikvision client was outdated, and available GitHub projects did not meet the author's needs. This project provides live viewing, recording searches, and clip saving directly in a browser on macOS, without depending on the Windows plugin.

## Features

- View 1, 2, 4, 8, or 16 live panes, each with its own channel, sound, and fullscreen controls.
- Find recordings by camera and date, seek on a full-day timeline, and play with audio at 0.25×–4× speed.
- Record live video or download a clip from the current recording file as MKV.
- Rename an NVR channel using an account with the required configuration permission.

H.264 and H.265 video are supported. H.265 playback depends on browser and operating system decoding support; unsupported video is not automatically transcoded. The interface currently uses Chinese labels; key labels appear below.

## Run the application

### Use Docker (recommended)

Install and start Docker, and make sure the application computer can reach the NVR. Replace the address, username and password below with your NVR details, then start the container:

```sh
docker run -d --name hikvision-nvr-web --restart unless-stopped \
  -p 3000:3000 \
  -e NVR_HOST=nvr-address \
  -e NVR_USERNAME=nvr-username \
  -e NVR_PASSWORD=nvr-password \
  ghcr.io/sdrpsps/hikvision-nvr-web:latest
```

`NVR_HOST` must be an IP address or hostname without a scheme, path or credentials. Open [http://localhost:3000](http://localhost:3000). The image includes FFmpeg. Recreate the container after changing device settings. The container needs network access to the NVR's HTTP, RTSP and supported playback ports, and enough temporary space for recorded playback.

The default HTTP port is `80`, RTSP port is `554`, and query and display time zone is `Asia/Shanghai`. `NVR_RECORDING_TIME_MODE` defaults to `device-local` for the tested device's timestamp format; use `utc` for firmware using standard UTC timestamps. Other settings are listed in [.env.example](.env.example) and can be passed using additional `-e` options.

### Run from source

The application computer needs Node.js 24, pnpm 11, FFmpeg available on the command line, network access to the NVR, and a device account with viewing permissions. Install FFmpeg on the application server; a separate browser computer does not need it. `ffprobe` is only used for diagnostics.

In the project directory, install dependencies and create the configuration:

```sh
pnpm install
cp -n .env.example .env
```

`cp -n` preserves an existing configuration. In Windows PowerShell, use `if (-not (Test-Path .env)) { Copy-Item .env.example .env }` instead. Edit `.env` and fill in at least:

| Variable | Value |
| --- | --- |
| `NVR_HOST` | NVR IP address or hostname, without a scheme, path or credentials |
| `NVR_USERNAME` | Device username |
| `NVR_PASSWORD` | Device password |

See [.env.example](.env.example) for other settings and restart the application after changes. Do not commit or share a populated `.env`.

Start the development server:

```sh
pnpm dev
```

Open the address printed in the terminal, usually [http://localhost:3000](http://localhost:3000); if that port is occupied, use the reported address. For production, stop the development server and run `pnpm build` followed by `pnpm start`. No separate API service is required.

### Access from another computer

Computers on the LAN can connect using the application server's IP address and actual port. **Recording or downloading from another computer requires HTTPS**; saving through `http://localhost` works locally. Configure HTTPS and any reverse proxy for your environment. The application has no login; access restrictions must cover pages, APIs and media resources. Do not expose NVR management or RTSP ports directly to the internet.

## Usage

### Watch and record live video

The home page starts with four panes. Select a pane, assign a camera from the channel list or the pane's selector, then click the central play button. **Start all** (全部开始) starts all assigned panes. Opening the page or adding panes does not start streams. Changing channels, reducing the layout or leaving the live page stops the affected previews. Each preview lasts at most 10 minutes; start it again after it expires.

Choose **Record** (录制) in a pane and select a destination and duration. The default is 30 minutes; 15 and 60 minutes are also available, and you can stop and save earlier. Recording stays tied to the original channel and continues when you change channels or layout, stop the preview, or navigate within the application. Use **Recordings and downloads** (录制与下载) to view progress or stop a task.

Where folder saving is supported, a recording produces a file approximately every 5 minutes. Single-file saving and Safari's native download path produce one file. A page supports up to four simultaneous recording or download tasks. **Keep the page open and the computer awake while recording.** Refreshing, closing the page, browser freezing or sleep may interrupt a task; reopening the page does not resume it. Completed segments remain available, but unfinished files may not be recoverable.

Use the pencil beside a channel to rename it. Names are trimmed and limited to 1–32 UTF-8 bytes. This changes the NVR channel name, not the on-screen display (OSD) text in the video.

### Play recordings and download clips

1. Open **Recorded playback** (录像回放) and select a camera and date.
2. Click the central play button to start the first segment of the day, select a segment from the list, or click or drag the player's full-day timeline to a time. Times without footage show a notice. After a fully read segment ends, playback advances to the next segment that day, indicates gaps and stops after the last segment.
3. Choose **Download clip** (下载片段), set the start and end times, and select a destination. Use the time selector or mark the current position; once the file duration is known, you can also drag the selection.

Adjust playback speed and audio in the player; click the video to pause. The `←` / `→` keys seek by a configurable step, 0.5 seconds by default and adjustable from 0.1 to 2 seconds in the step-size panel (步长). Playback starts with audio enabled; if the browser blocks audio or the track is unsupported, video can still play. Live previews start muted.

Clip selection is limited to **the current recording file on the selected query date**; cross-day and cross-file exports are not supported. The saved range may extend slightly to keyframes so the video can play, and the task shows the actual coverage. Saved clips retain their original speed and are unaffected by playback speed, pause or mute. Changing the query or closing playback does not stop a submitted download. Absolute alignment between device recording times and the video OSD has not been calibrated.

Devices supporting SHTTP time-based playback can start reading near the target. Devices without support use HTTP file playback, where seeking to a later point may require waiting for earlier content to be read. Clip downloads still read the original file, so a short clip near the end can also take time and transfer more than the selected range. Real-device transitions between files and long-term stability of automatic advancement remain unverified; seamless transitions are not guaranteed.

### Saved files and page selections

Recordings and clips are saved as **MKV**, preserving original H.264/H.265 video and supported G.711 audio without recompressing the video. Unsupported audio may be omitted, in which case the task reports **Partially saved** (部分保存). Use a compatible player such as VLC or IINA. With native browser downloads, including Safari, check the browser download list after the application reports **Transfer complete** (传送完成). Some players may not immediately show the duration or seek smoothly.

The browser receives and writes saved files incrementally. Recorded playback uses controlled temporary fragments on the server for seeking; these are cleaned up when playback closes or expires.

Copy or bookmark the current page URL to retain selections such as channel, date, timeline zoom, layout and sidebar. Opening a link or refreshing does not start streams. URLs do not contain device credentials, media addresses or recording tasks. Browser Back and Forward restore playback camera and date changes; navigating to the other page opens its default address.

## Compatibility and limitations

Real-device checks used a Hikvision `DS-7816NB-K2/16P` with firmware `V4.30.000`. Other models and firmware need separate validation.

| Browser | Verified scope |
| --- | --- |
| Desktop Chrome | Live viewing, full recording playback, recording and clip downloads; SHTTP starts near the end of a file, same-file reseeking and session release; a 30-minute single-channel recording, 5-minute segmentation and independently stopping two simultaneous recordings. |
| Safari 27.0.1 | Short single-channel HEVC live viewing, short recordings, clip downloads, cancellation, channel and layout changes, in-app navigation and brief backgrounding while saving. Full playback with audio, seeking and fullscreen, and long or multi-channel saves remain unverified. |
| Edge | Not separately tested. |

The 16-pane layout does not mean 16 simultaneous real-camera streams have been verified; performance depends on the NVR, network and computer. Sixty-minute recordings, long multi-channel saves, and recovery after sleep or crashes remain unverified. Channel renaming has passed mocked tests and real-device read-only checks; **real-device writes and persistence remain unverified**.

## Development and releases

The project uses Next.js, React, TypeScript and Hono in a single application. See [AGENTS.md](AGENTS.md) for development conventions. Common checks:

```sh
pnpm test
pnpm typecheck
pnpm lint
pnpm test:e2e
```

Browser tests use mocked data by default. Set `TEST_BASE_URL` to reuse a running development server; otherwise the tests start one on port 3100. Real-device tests require explicit opt-in; see the cases in `tests/browser/`.

### Releases

After a push to `main`, Release Please creates or updates a release PR from the commit history. Merging it creates a GitHub Release and version tag and publishes a Docker image. Manually pushed tags must match the version in `package.json`. For release configuration, see the [release workflow](.github/workflows/release.yml) and [image workflow](.github/workflows/docker-publish.yml).
