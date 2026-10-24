# 海康 NVR 控制台

Next.js App Router + Hono + TypeScript，保留现有录像机的存储和录制方式。

**只启动一个 Next.js 实例。** `app/api/[[...route]]/route.ts` 将 Web Request 交给 Hono；设备查询、Digest、XML、分页和错误处理都在 `server/`，共享 Zod 契约在 `shared/`。

首页为多窗口实时预览，支持 1、2、4、8、16 路，默认 4 路。进入页面只读取通道列表，不自动创建媒体会话；选择通道后点击窗口中的“开始预览”才取流。`/playback` 将摄像头、日期与刷新集中在顶部，选片后优先显示画面，当日录像分布用于选片，完整片段列表按需展开；刷新旁的“设备信息”按需显示设备型号，以及固件、摄像头数量和时区。页面、通道列表、视频墙、全天时间轴、下拉列表和超高弹层统一使用 shadcn Scroll Area。

历史 RTSP 仍在 DESCRIBE 阶段返回 400。HTTP 文件回放支持整段 H.264 / H.265 录像：选择片段后点击“播放”，首个分片就绪后自动开始；可拖动进度、选择倍速档位或输入自定义倍速，并通过声音开关启用 G.711 音轨。录像检索与时间显示默认使用北京时间。

## 本地运行

需要 Node.js 20.9+、pnpm。查询页面不依赖媒体工具。预览需要在 Next.js 所在机器安装 FFmpeg；ffprobe 仅用于 P1 诊断。

```sh
pnpm install
cp .env.example .env
# 在本机编辑 .env，填写 NVR_HOST、NVR_USERNAME、NVR_PASSWORD 等。
pnpm dev
```

已有 `.env` 时直接编辑，勿覆盖。开发与生产启动均使用 Next.js 默认监听地址 `0.0.0.0`，默认端口为 `3000`；开发模式默认端口占用时会选择其他端口。本机可访问 `http://localhost:3000`，局域网设备使用运行机器的实际 IP 和端口访问。

按用户当前要求暂不实现前端鉴权。此版本用于受信任的本机或局域网验证，部署、HTTPS 和鉴权属于尚未完成的 P3。

生产构建与启动也只有一个实例：

```sh
pnpm build
pnpm start
```

环境变量说明见 `.env.example`。`NVR_HOST` 只接受主机名或 IP，不接受 scheme、路径、凭据或任意客户端 URL；所有 NVR 参数仅在服务端读取。修改设备配置后重启服务。

录像查询、当天日期和录像时间显示默认使用 **UTC+8（北京时间）**，配置为 `NVR_TIME_ZONE=Asia/Shanghai`；未设置时也使用该默认值。查询日界按此时区计算，内部/API 时间使用 UTC，不随浏览器或容器本地时区变化。

`NVR_RECORDING_TIME_MODE=device-local` 为当前固件默认适配：搜索请求的日期时间字段使用设备本地时间并保留原厂 `Z` 格式，响应中的同类字段按 `NVR_TIME_ZONE` 转回 UTC，避免再次加 8 小时。响应带明确 `+08:00` 等偏移时直接按该偏移解析。遵循标准 UTC 的固件设置为 `NVR_RECORDING_TIME_MODE=utc`。该配置只作用于录像搜索，不改设备时钟或原始媒体 URI。搜索的包含式日末边界在 API 中还原为次日零时的排除边界，页面显示 `24:00:00`。

## API

| GET | 返回内容 |
| --- | --- |
| `/api/health` | API 存活；不连接设备 |
| `/api/device` | 型号、固件，不包含序列号或 MAC |
| `/api/channels` | 轨道、配置启用状态、设备时区和当天日期 |
| `/api/recordings?track=<id>&date=<YYYY-MM-DD>` | UTC 片段时间、匿名 ID、编码、覆盖区间、未覆盖区间 |

`Enable=false` 不过滤轨道。搜索保留 `searchResultPostion` 原厂拼写；XML 实体由解析器处理。查询按配置时区计算 UTC 区间，再按录像接口时间模式序列化请求；API 区间为左闭右开。原始 `playbackURI` 仅留在本地查询/诊断的内存中，不返回浏览器。兼容字段 `warnings` 保留为空数组，页面不显示时间核对提示。

通道名称通过只读 `/ISAPI/ContentMgmt/InputProxy/channels` 获取，使用录像轨道 `SrcDescriptor/SrcChannel` 关联设备配置名称，保留原轨道 ID；不根据列表顺序或轨道编号猜测对应关系。名称缺失、接口无权限/超时或响应无效时保留原轨道名称。名称与通道列表一起缓存 20 秒，并合并并发读取；不将代理配置中的摄像头地址或账号返回浏览器。实时列表、窗口选择框与回放选择框共同使用此名称。

搜索每页 40 段，最多 100 页、2 个并发查询；检测重复和不推进的分页，异常时不返回不完整的成功结果。单次 ISAPI 请求默认超时 8 秒，搜索总时限约 30 秒（当前页请求可再占用一次请求超时）。轨道缓存 20 秒，结果缓存 30 秒、最多 32 项；相同查询合并，原始 URI 不进入响应缓存。

## 前端请求与 Hooks

前端业务 API 统一使用 TanStack Query v5。根布局挂载 `components/query-provider.tsx`，浏览器导航复用同一个 QueryClient，服务端渲染使用独立实例。`lib/api.ts` 负责底层请求、Zod 响应校验和错误转换，组件通过以下 hooks 读取数据或执行操作：

| Hook | 请求 | 使用位置 |
| --- | --- | --- |
| `useChannels()` | `GET /api/channels` | 实时页、回放页 |
| `useDevice({ enabled })` | `GET /api/device` | 按需打开的设备信息 |
| `useRecordings({ track, date })` | `GET /api/recordings` | 录像查询、时间轴 |
| `useCreateLiveStream()` | `POST /api/streams/live` | 实时播放器 |
| `useCreatePlaybackStream()` | `POST /api/streams/playback` | 文件播放器 |
| `useDeleteStream()` | `DELETE /api/streams/:id` | 关闭、切换、离开及异常清理 |
| `usePlaybackStatus(id)` | `GET /api/streams/:id/status` | 状态轮询及 `confirm(signal)` 结束确认 |
| `useStreamAudio(id)` | `GET /api/streams/:id/audio` | 本机音频解码器的按游标加载函数 |

前三个 hooks 从 `hooks/use-api.ts` 导出，媒体 hooks 从 `hooks/use-stream-api.ts` 导出。读取使用 `useQuery`，会话操作使用 `useMutation`；按播放进度发起的音频读取和结束确认由 hook 内的 `queryClient.fetchQuery` 管理。视频播放列表和分片继续由 Safari 原生 HLS / hls.js 按媒体协议加载。

通道列表在浏览器共享 30 秒新鲜缓存；设备详情只在弹层打开时请求，成功结果在缓存存活期间复用，保留 10 秒超时。录像按通道和日期区分缓存，切换参数时取消旧查询；手动刷新重新读取并立即关闭旧播放器。查询及会话创建不自动重试，窗口重新聚焦不刷新查询；失败通过现有按钮重试。状态和音频查询随会话关闭清除，音频数据不保留在 Query 缓存中。

## 多窗口实时预览

在首页选中窗口后，可从左侧通道列表或窗口名称选择框分配通道；左上角“通道”按钮可收起列表，折叠不影响正在播放的画面。每个窗口单独开始、停止，顶部工具栏支持“全部开始”和“全部停止”；没有连接或准备中的窗口时，“全部停止”禁用。“全部开始”只开启当前布局中已选通道且尚未开启的窗口，跳过正在连接和已有会话的窗口，再次点击可重试失败项。切换通道、缩小布局移除窗口、进入回放页或离开页面时释放相应会话；切换布局不会自动开启新增窗口。

媒体路径：可信通道列表 → 固定 RTSP 实时路径 → FFmpeg `-c:v copy` → 滚动内存 fMP4/HLS → 浏览器本机解码。Safari 使用原生 HLS，Chrome 使用 hls.js；实测 Chrome 声明支持原生 HLS，但真实 HEVC 实时流需使用 hls.js。不自动转码。

实时画面点击只选中窗口，不显示会让画面点击暂停的浏览器原生控件。声音、全屏、更多操作与停止浮在画面底部，窗口选中、悬停或键盘聚焦时显示，触屏持续显示；重新连接收入“更多播放操作”，失败或到期后直接提供“重试”。窄分屏保留按钮图标、悬停提示及无障碍名称。默认静音以满足自动播放规则，打开声音开关后在本机解码音频。当前支持 G.711 A-law / μ-law：FFmpeg `-c:a copy` 分离音频和时间戳，由浏览器 Web Audio 解码并按视频时钟调度，不在服务端解码或转码。音频不支持、缺失或请求失败时单独提示，视频继续播放。实机轨道 101 为 G.711 A-law、8 kHz、单声道；其他音频编码尚未支持。

- `POST /api/streams/live`：严格 JSON `{track}`，通道必须存在于服务端设备查询结果；不接受 URL 或主机。
- `GET /api/streams/:id/index.m3u8`、`init.mp4`、`:sequence.m4s`：滚动播放列表和内存媒体分片。
- `GET /api/streams/:id/audio?after=<sequence>`：同源的 G.711 编码音频块与时间戳，仅点击开启声音后拉取；不是服务器解码后的 PCM。
- `DELETE /api/streams/:id`：立即停止取流并释放内存。

最多 16 个实时会话（含准备中），启动超时 20 秒、RTSP I/O 超时 10 秒、30 秒无媒体访问回收、会话最长 10 分钟，到期后需手动重开。每路最多保留 6 个分片、媒体缓存最多 32 MiB、单个解析块和分片不超过 8 MiB，视频不落盘。Chrome 单路真实 HEVC 直播和停止清理已验证；16 路实机并发、长期稳定性与 Safari 实机播放待验证。

音频每路最多保留 80 块 / 512 KiB，单块解析缓冲最多 256 KiB；静音、停止、切换通道和离开时取消音频请求、停止已排程的声音并关闭 AudioContext。没有音轨时视频输出仍可继续，不为音频自动开启转码。

## 历史文件回放：浏览器本机解码

媒体路径：NVR 的 ISAPI HTTP 下载 → Hono Digest 读取 → FFmpeg `-c:v copy` / `-c:a copy` → 私有临时 fMP4 分片及 G.711 音频块 → 浏览器本机解码。Safari 使用原生 HLS；Chrome 使用 hls.js。服务端只解析容器和复制压缩媒体，不运行解码器、滤镜或编码器；[FFmpeg 的 streamcopy 说明](https://ffmpeg.org/ffmpeg.html#Streamcopy)解释了这一行为。

回放已取消 30 秒截断，边读取完整文件边输出 HLS EVENT 播放列表，完成后追加 ENDLIST。视频与查询区、当日录像区域使用相同内容宽度，保持 16:9。进度条使用 shadcn Slider，以完整文件的预估时长保持刻度，终点标注“约”，读取完成后按实际媒体总长校准；主色表示实际播放进度，浅色表示已读取范围。无法取得可靠估计或媒体超过估计时显示“时长确认中”，不把已读取时长当成总长。点击“定位”可输入文件内的 `分:秒` 或 `时:分:秒`；目标尚未读取时保留目标并显示等待，可取消或替换；目标超出最终文件长度时明确提示。拖动期间保持刻度，避免读取更新改变目标。

倍速档位为 0.25 / 0.5 / 0.75 / 1 / 1.25 / 1.5 / 2 / 4×，自定义支持 0.25–4×、两位小数。G.711 A-law / μ-law 在浏览器 Web Audio 解码，暂停、seek、倍速变化和静音均停止旧调度，并按当前位置重新调度。其他音频编码尚未支持；没有受支持音轨时单独提示，视频继续。

设备只报告按文件下载，文件时间与搜索时间的精确对应还未确认，因此全天时间轴用于选片段，不把点击位置当作准确播放时刻；进度条表示文件内部位置。支持 H.264 / AVC 和 H.265 / HEVC 原样换封装；不兼容浏览器明确提示，不自动进行服务端转码。Safari 真实设备播放仍待验证。

选中片段后可在播放器控制区打开“连续播放”，当前文件完整播放结束后会先关闭旧会话，再播放同一查询结果中的下一文件，保留倍速与声音偏好；默认关闭，到最后一个文件、关闭回放或失败时停止。常用倍速档位直接在倍速弹层选择，自定义输入按需展开；“从头播放”收入更多操作。手动选择片段不会自动开始播放，切换通道、日期或刷新查询会取消序列。覆盖摘要只统计本次查询时已过去的区间，未来时段不计入缺口；文件切换仍提示搜索结果中的未覆盖区间，需要重新准备，不代表按绝对时间无缝衔接。浏览器若拒绝恢复声音，会提示再次开启，视频仍可继续。

2026-10-24 的只读诊断已确认搜索时间会被请求边界裁剪：同一文件在日界查询、内部窄窗、扩展三天查询中分别报告 342、29、7224 秒，而已测完整媒体为 7224.04 秒。因此不能用搜索的 `startAt + 文件进度` 推算真实录像时刻，也不能只按元数据裁剪文件或直接跳到全天时间轴位置。当前保留 UTC 契约，时间核对提示已移除；媒体绝对时间锚点等待原生客户端/可信事件对照。

**编码以实际媒体为准。** 101 / 2026-10-17 首片段的搜索结果报告 H.264-BP，但 ffprobe 核实为 HEVC Main、2560×1440。播放器读取换封装后的 MP4 sample entry（avc1/avc3/hvc1/hev1）识别真实编码，不用搜索字段决定是否允许播放。Chrome 已验证人工 H.264、人工 H.265 和真实 HEVC 样本；HEVC 能否播放取决于浏览器/系统运行环境，见 [hls.js 编码支持说明](https://github.com/video-dev/hls.js#features)。

- `POST /api/streams/playback`：严格 JSON `{track,date,segmentId}`，ID 来自录像查询结果；不接受 URL、主机或自定义时刻。
- `GET /api/streams/:id/index.m3u8`、`init.mp4`、`:sequence.m4s`：仅返回该临时会话的播放数据。
- `GET /api/streams/:id/status`：`durationSeconds` 为实际已读取时长，`complete` 为完整读取状态；可选 `estimatedDurationSeconds` 为完整设备标签跨度的估计，`totalDurationSeconds` 仅在完整读取结束后提供实际媒体总长。POST 创建响应也可带这两个可选字段。读取期间播放器每 2 秒请求状态，完成后每 20 秒续约。
- `GET /api/streams/:id/audio?after=<sequence>&at=<seconds>`：只返回当前位置附近的编码音频块；向后 seek 时重置游标，不回传本地路径。
- `DELETE /api/streams/:id`：关闭会话。切换轨道/日期/片段、关闭回放或离开页面时自动释放。

最多 2 个会话（包含准备中），首帧准备上限 30 秒、完整下载/换封装上限 10 分钟、空闲 90 秒回收、绝对 TTL 6 小时。每个会话源数据最多 4 GiB，音视频临时输出合计最多 2 GiB，单个视频分片最多 16 MiB；磁盘保留至少 512 MiB 可用空间。文件目录权限 0700、媒体文件权限 0600，不提供任意文件访问；取消/失败/关闭/回收后删除分片并杀掉未完成的子进程，启动时清除失效进程拥有或超过最大 TTL 的遗留目录。读取中断会报告失败，不把部分文件标记为完整。普通查询与媒体资源使用同一个本机入口和同源限制；登录鉴权按用户要求暂缓，P3 尚未完成。

完整时长估计只使用未贴查询边界的文件标签。触及日界时，仅补查所需的前/后一个日历日，在服务端以同轨道和相同文件标识合并连续跨度，原始下载 URI 不变。补查共用 1500ms 预算，超时取消并归还查询槽位；原始查询已超过 5 秒则跳过补查。缺失匹配、仍被裁剪或补查失败时省略估计，文件仍可播放。这不等于确认了文件画面与录像日期上钟表时刻的对应。

`verify:preview` 保留为早期 30 秒内存换封装诊断；`verify:playback` 选择查询中元数据时长最短的文件验证完整读取，只输出模式、实际时长、分片数、音频格式等脱敏数值，并清理临时分片。两者都不解码或输出原始 URI。自动测试中的 `fixtures/synthetic-preview*.mp4` 是 FFmpeg 测试图生成的 3 秒人工素材；`fixtures/synthetic-g711-audio.mov` 是 FFmpeg 440 Hz 正弦波生成的 3 秒 G.711 A-law 音频，均与 NVR 录像无关。

## 验证与排障

```sh
pnpm test
pnpm typecheck
pnpm lint
pnpm test:e2e
pnpm verify:device 101 2026-10-17
pnpm diagnose:rtsp 101 2026-10-17 0 --live-control
pnpm verify:preview 101 2026-10-17
pnpm verify:playback 101 2026-10-17
pnpm verify:time 101 2026-10-17 --media-duration=7224.04
pnpm verify:live-wall 16 30
pnpm verify:synthetic-hls
```

浏览器测试使用本机 Chrome。默认只跑模拟数据场景，真实设备用例需显式启用：

```sh
# 使用已在运行的同一实例（根据实际端口调整 TEST_BASE_URL）。
TEST_BASE_URL=http://127.0.0.1:3000 NVR_INTEGRATION=1 pnpm test:e2e
```

未启动服务时 `pnpm test:e2e` 会启动本机 3100 端口；已有 dev 实例时须设置 `TEST_BASE_URL`，避免 Next.js dev 锁冲突。

`verify:device` 仅读取设备信息、轨道、录像和设备时钟，输出脱敏摘要。`diagnose:rtsp` 重新查询真实片段，先跑未改写 URI；输出 OPTIONS/DESCRIBE/SETUP/PLAY 的阶段码，不输出原始 URI、认证头、SDP 或视频。诊断失败/缺少工具退出码 1，历史源仍阻塞退出码 2。

诊断将取流地址写入权限为 0600 的短期本地 ffconcat 清单，凭据不进入进程参数；工具输出只在有上限的内存中解析，每个子进程最多运行 25 秒，并在正常退出、超时及处理 SIGINT/SIGTERM 后清理。只解码到 null，不保存画面或录像。强制杀死整个 Node 进程或机器断电无法保证 finally 执行，如发生异常中断，应在本机检查系统临时目录 `nvr-rtsp-*` 的残留。

`verify:time` 只读取设备时钟和搜索结果，对比 UTC 日界、当地墙钟文字加 Z、窄窗与扩展窗口，输出脱敏统计；可选媒体时长参数仅用于对照，不视为锚点校准。`verify:live-wall` 在 1–16 个真实通道上做 5–120 秒的受限 stream-copy 检查（默认 16 路、30 秒），不保存或解码媒体；并发检查结束后逐个复核失败通道，输出启动/推进/失败计数并清理子进程。该检查会实际占用设备取流会话，不代表浏览器解码或长期稳定性已验收。

`verify:synthetic-hls` 仅在 `127.0.0.1:3103` 提供人工 H.264 / HEVC HLS，用于 Safari 原生播放与关闭检查；不读取设备配置、不代理 API。结束后按 Ctrl+C 停止。Safari 原生合成素材播放与真实 NVR 媒体必须分别验收。

已完成和待验证项目见 [开发计划](docs/DEVELOPMENT_PLAN.md)，实机证据见 [2026-10-18 验证记录](docs/VALIDATION_2026-10-18.md)及[2026-10-24 验证记录](docs/VALIDATION_2026-10-24.md)。
