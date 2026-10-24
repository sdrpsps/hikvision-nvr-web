import { createServer } from "node:http"
import { readFileSync } from "node:fs"
import { splitFragmentedMp4 } from "../server/mp4"

// A standalone loopback-only fixture server. It never imports device config or
// proxies application APIs, so native browser checks cannot contact the NVR.
const port = Number(process.argv[2] ?? 3103)
if (!Number.isInteger(port) || port < 1024 || port > 65535)
  throw new Error("Provide a port between 1024 and 65535.")

const assets = new Map<string, { type: string; data: Buffer }>()
for (const codec of ["h264", "hevc"] as const) {
  const file = readFileSync(
    new URL(
      `../fixtures/${codec === "h264" ? "synthetic-preview.mp4" : "synthetic-preview-hevc.mp4"}`,
      import.meta.url
    )
  )
  const { init, media } = splitFragmentedMp4(file)
  assets.set(`/${codec}/init.mp4`, { type: "video/mp4", data: init })
  assets.set(`/${codec}/0.m4s`, { type: "video/iso.segment", data: media })
  assets.set(`/${codec}/index.m3u8`, {
    type: "application/vnd.apple.mpegurl",
    data: Buffer.from(
      '#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:3\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:3.000000,\n0.m4s\n#EXT-X-ENDLIST\n'
    ),
  })
}

const html = `<!doctype html>
<html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>合成素材 · 原生 HLS 验证</title>
<style>body{font:16px system-ui;max-width:1000px;margin:32px auto;padding:0 16px}video{display:block;width:480px;max-width:100%;background:#111}button{margin:12px 8px 8px 0;padding:8px}pre{white-space:pre-wrap;background:#eee;padding:12px}</style>
<h1>合成素材 · 原生 HLS 验证</h1>
<p>仅使用仓库内的三秒人工视频；不连接录像机。此页面直接使用 video 原生 HLS，不加载 hls.js。</p>
<div id="players"></div><button id="release">关闭全部媒体</button><pre id="metrics"></pre>
<script>
const state = { engine: navigator.vendor, nativeHls: document.createElement('video').canPlayType('application/vnd.apple.mpegurl'), samples: {} };
for (const codec of ['h264', 'hevc']) {
  const section = document.createElement('section');
  section.innerHTML = '<h2>' + (codec === 'h264' ? 'H.264' : 'H.265 / HEVC') + '</h2><video muted playsinline controls preload="none" aria-label="' + codec + ' 人工视频"></video><button>播放 ' + codec + '</button><button>定位 ' + codec + ' 1秒</button>';
  document.getElementById('players').append(section);
  const video = section.querySelector('video');
  video.muted = true;
  state.samples[codec] = { started: false, seeked: false, released: false };
  const buttons = section.querySelectorAll('button');
  buttons[0].onclick = async () => { video.src = '/' + codec + '/index.m3u8'; video.loop = true; try { await video.play(); state.samples[codec].started = true; } catch (error) { state.samples[codec].playError = error.name; } };
  buttons[1].onclick = () => { try { video.currentTime = 1; } catch (error) { state.samples[codec].seekError = error.name; } };
  video.addEventListener('seeked', () => { state.samples[codec].seeked = true; });
  video.addEventListener('error', () => { state.samples[codec].mediaError = video.error?.code; });
  setInterval(() => { Object.assign(state.samples[codec], { readyState: video.readyState, paused: video.paused, currentTime: Number(video.currentTime.toFixed(2)), frames: video.getVideoPlaybackQuality?.().totalVideoFrames ?? video.webkitDecodedFrameCount ?? 0, duration: Number.isFinite(video.duration) ? video.duration : null }); }, 200);
}
document.getElementById('release').onclick = () => { for (const video of document.querySelectorAll('video')) { video.pause(); video.removeAttribute('src'); video.load(); } for (const sample of Object.values(state.samples)) sample.released = true; };
setInterval(() => { document.getElementById('metrics').textContent = JSON.stringify(state, null, 2); }, 250);
</script></html>`

const server = createServer((request, response) => {
  response.setHeader("Cache-Control", "no-store")
  response.setHeader("X-Content-Type-Options", "nosniff")
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405).end()
    return
  }
  const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname
  const asset =
    path === "/"
      ? { type: "text/html; charset=utf-8", data: Buffer.from(html) }
      : assets.get(path)
  if (!asset) {
    response.writeHead(404).end()
    return
  }
  response.setHeader("Content-Type", asset.type)
  response.setHeader("Accept-Ranges", "bytes")
  let start = 0,
    end = asset.data.length - 1
  const range = request.headers.range
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range)
    if (!match || (!match[1] && !match[2])) {
      response
        .writeHead(416, { "Content-Range": `bytes */${asset.data.length}` })
        .end()
      return
    }
    if (match[1]) {
      start = Number(match[1])
      if (match[2]) end = Math.min(Number(match[2]), end)
    } else start = Math.max(0, asset.data.length - Number(match[2]))
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start > end
    ) {
      response
        .writeHead(416, { "Content-Range": `bytes */${asset.data.length}` })
        .end()
      return
    }
    response.statusCode = 206
    response.setHeader(
      "Content-Range",
      `bytes ${start}-${end}/${asset.data.length}`
    )
  }
  response.setHeader("Content-Length", end - start + 1)
  response.end(
    request.method === "HEAD" ? undefined : asset.data.subarray(start, end + 1)
  )
})
server.listen(port, "127.0.0.1", () => {
  console.log(`Synthetic native HLS fixtures: http://127.0.0.1:${port}`)
})
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => server.close(() => process.exit(0)))
