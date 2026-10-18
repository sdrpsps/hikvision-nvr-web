# P0 / P1 / P2 预览验证记录 — 2026-10-18

本文只保存脱敏摘要。未保存设备地址、账户、密码、原始 playbackURI、认证头、完整序列号、录像标识或视频画面。

## 范围和架构决定

用户在本轮明确要求 Hono 作为 Next.js 后端，不另开服务实例；暂不实现前端鉴权。实现保留根目录 Next.js 工程，`server/app.ts` 构建 Hono，`app/api/[[...route]]/route.ts` 只做 Web Request/Response 挂载。开发和本地生产启动默认绑定 loopback。

## P0 — 已验证部分

**设备：** DS-7816NB-K2/16P，V4.30.000。2026-10-18 13:48（Asia/Shanghai）读取：

- Digest 认证后的 deviceInfo、record/tracks、ContentMgmt/search、System/time 均成功。
- 轨道 16 条，101、201 等；16 条 configuredEnabled 均为 false，未据此过滤。
- `101 / 2026-10-17` 按计划基线查询，UTC 请求范围 `2026-10-16T16:00:00Z` 至 `2026-10-17T15:59:59Z`，实际返回 **13 个片段**，元数据编码 H.264-BP。
- API 和 Chrome 页面均显示 13 段；响应只有公开 DTO，不含 RTSP URI、序列号、MAC 或认证头。
- 原始片段不合并；覆盖区间单独去重、合并重叠和相邻，保留未覆盖区间。
- 基线最后 endAt 为 `2026-10-17T15:59:59Z`。内部全天范围为左闭右开，到下一午夜 `16:00:00Z`，因此计算有末尾 1 秒未覆盖；这可能由秒级、包含式检索上界引起，**不能据此断言 NVR 实际丢失了 1 秒录像**。

复现命令：

```sh
pnpm verify:device 101 2026-10-17
```

**时间语义风险，待验证：**

- System/time 返回的本地时刻约 `2026-10-18T13:48:12+08:00`、CST-8、NTP，与本机当前时刻吻合。
- 同时段对 2026-10-18 的搜索末段约为 `2026-10-18T13:50:44Z`。严格按 UTC 转为北京时间是 21:50:44，比实际当前时间晚约 8 小时。
- 推测：本固件可能将本地墙钟时间直接加 Z 标记，或搜索存在其他时间解释问题。**尚未用原生客户端/真实录像内容交叉确认，不能当作确定根因。**
- 当前遵守计划的 UTC 契约，不静默减 8 小时；检测到未来片段时 API 返回 `FUTURE_RECORDING_TIME`，页面提示核对。
- 下一步：对照同一实际事件在 NVR 原生回放中的时间与搜索结果，确定请求和响应的时间语义后，再以显式配置和测试处理固件差异。

## 自动化验证

2026-10-18 执行：

| 命令 | 结果与覆盖 |
| --- | --- |
| `pnpm test` / `node node_modules/vitest/vitest.mjs run` | **43 项通过**。Digest 标准向量、挑战、错误密码、stale nonce、有限重试、权限、断线、超时；XML 命名空间/实体/空结果/缺字段/危险声明；分页重叠与不推进；时区/DST/跨午夜/缺口；API 校验/隐私；并发/缓存/子进程超时与清单清理 |
| `pnpm typecheck` / `node node_modules/typescript/bin/tsc --noEmit` | **通过** |
| `pnpm lint` / `node node_modules/eslint/bin/eslint.js` | **通过**，早期未使用变量 warning 已修复 |
| `pnpm build` / `node node_modules/next/dist/bin/next build` | **通过**；静态首页和动态 `/api/[[...route]]`，没有独立 Hono 服务；`pnpm start --port 3001` 后再次运行全部 4 项浏览器验收通过 |
| `TEST_BASE_URL=http://127.0.0.1:3001 NVR_INTEGRATION=1 pnpm test:e2e` | **4 项通过**：桌面和 375px 移动布局、切换/缩放/片段选择/加载/空结果/超时/快速切换竞态、设备断线提示、真实 13 段 UI 和 DTO 验收 |

浏览器用例默认关闭实机测试，需 `NVR_INTEGRATION=1`；`TEST_BASE_URL` 按实际服务端口设置。本轮 3000 已有其他进程，启动的 Next.js 自动选择 3001；最终将本轮开发实例切换为同端口生产实例并复验通过，既有 3000 进程未改动。Safari 尚未实测。

额外检查：`.next/static` 的 11 个浏览器 JS 文件未检出配置中的 NVR 主机和密码、serialNumber 或 playbackURI 字段；`git check-ignore .env` 确认真实配置被忽略；`git diff --check` 通过。

环境问题已区分处理：初次 pnpm 因现有全局 store 与沙箱默认 store 不同失败，使用原 store 同步依赖后完成验证；初次 Chrome 在沙箱中启动受限，在工具许可范围内于本机重跑后通过；初次 E2E 另起 dev 时发生 Next dev 锁冲突，随后复用单个已运行实例通过。以上失败未当作功能通过证据。

## P1 — 历史 RTSP 仍阻塞

工具：FFmpeg/ffprobe 9.0.2；本轮安装到本机，未保存视频输出。查询得到第一片段后保持原始 URI 的路径、尾斜杠、时间和 name/size 作为基线。凭据通过本地权限 0600 的临时清单交给 FFmpeg，不进入命令行。每次最多 25 秒、输出内存 4 MiB，结束后删除清单，解码输出为 null。最终在本机仅统计进程名，FFmpeg 与 ffprobe 剩余进程数均为 0。

```sh
pnpm diagnose:rtsp 101 2026-10-17 0 --live-control
```

| 试验 | 实机结果 |
| --- | --- |
| 原始 URI，无凭据，TCP | OPTIONS 401，未进入 DESCRIBE |
| 原始 URI，仅用户名，TCP | OPTIONS 401，未进入 DESCRIBE |
| 原始 URI，完整凭据，TCP | OPTIONS 401 → 200；**DESCRIBE 400** |
| 原始 URI，完整凭据，UDP | OPTIONS 401 → 200；**DESCRIBE 400**，因此尚不能比较后续 RTP 传输行为 |
| 去掉尾随斜杠 | DESCRIBE 400 |
| 只去掉 name/size | DESCRIBE 400 |
| 换成 `/ISAPI/Streaming/...` | DESCRIBE 400 |
| 在去掉 name/size 基础上再去掉斜杠 | 直接 RTSP DESCRIBE 400 |
| 原始开始时间增加 60 秒（片段内） | 直接 RTSP DESCRIBE 400 |
| 第二个现存片段的原始 URI | 直接 RTSP DESCRIBE 400 |
| 增加显式 RTSP 端口、tracks 改为 Tracks | 单变量直接探测均 DESCRIBE 400 |
| 最小 URI 使用本地时刻加 Z 的时间变体 | 直接 RTSP DESCRIBE 400；**不能据此解决或排除时间语义问题** |
| 直播对照，同一设备/账户/轨道，TCP | OPTIONS 401 → 200，DESCRIBE 200，两个 SETUP 200，PLAY 200；FFmpeg 实际解码 **3 帧**，输出 null |

FFprobe 与直接 Node TCP/Digest 复核结果一致；历史 URI 未取得 SDP，未到 SETUP/PLAY。直播成功证明同一认证/工具链可用于直播，不证明历史回放权限或历史 URL 正确。

**已确认事实：** 失败发生在历史媒体描述阶段，并非本轮已经证实的编码不兼容。认证挑战同时宣告 Digest/Basic；完整 Digest 对 OPTIONS 成功。

**尚未确认：** 该账户的历史回放权限、原生客户端同段可播情况、固件历史 RTSP 请求约定、时间语义。VLC 早先人工事实为失败，本轮没有控制 VLC 播放，也没有检查或修改账户权限、设备设置。

## 首轮备选方案研究（当时尚未接入）

厂商公开说明提供搜索结果 URI 用于录像文件下载的流程；SDK 提供按时间回放并通过回调获取码流的能力。这些是候选途径，不能自动推断本型号/固件/平台可用：

- [Hikvision 搜索和下载 NVR 录像说明（PDF）](https://www.hikvisioneurope.com/eu/portal/portal/Technology%20Partner%20Program/03-How%20to/How%20to%20search%20and%20download%20the%20video%20file%20from%20NVR%20via%20ISAPI.pdf)
- [官方 SDK：NET_DVR_PlayBackByTime_V40](https://open.hikvision.com/hardware/definitions/NET_DVR_PlayBackByTime_V40.html)
- [官方型号级 ISAPI / OTAP 文档入口](https://tpp.hikvision.com/download/ISAPI_OTAP?type=1)，部分材料需合作伙伴权限；本轮未签署协议或申请账户。

首轮实现验收阶段仅执行了只读 `GET /ISAPI/ContentMgmt/download/capabilities`，实机报告：

```json
{ "byTime": false, "byFileName": true }
```

首轮验收时实际下载、HTTP 码流解码、SDK 集成均待验证。**后续 14:15 的研究补充已验证 HTTP 文件下载响应解码 3 帧，见下节；SDK 仍未引入。**

## 阶段门槛与下一步

P0 的基础实现和指定 13 段样本验收已完成，设备时间语义和 Safari 仍待验证。P1 标准历史 RTSP、任意指定时间回放仍阻塞；HTTP 文件下载响应的头部解码已在下节验证。该时点 P2/P3 未实施；后续用户授权的文件预览见文末记录。

最小下一步：在设备原生客户端确认同一日期/轨道可回放，核对当前账户的回放权限，并对照一处可信录像时间；按文件名下载的有限读取/解码已取得下节证据，下一步应验证完整文件、时间映射与定位行为。不要升级固件或修改配置来掩盖当前证据，也不要仅凭搜索或直播成功进入历史 Web 播放集成。


## 14:15 补充：官方 / GitHub 研究与 HTTP 历史数据解码

用户请求查询海康文档、互联网与 GitHub 的解决方案。本次未修改业务代码或设备配置；使用本地临时诊断脚本进行有上限的只读测试，媒体只在本机内存与管道中经过，未保存或对外发送画面。

### 来源与适用范围

- [海康搜索与下载 NVR 录像说明](https://www.hikvisioneurope.com/eu/portal/portal/Technology%20Partner%20Program/03-How%20to/How%20to%20search%20and%20download%20the%20video%20file%20from%20NVR%20via%20ISAPI.pdf)：搜索返回 playbackURI，可用于下载接口。该 PDF 的完整直接抓取多次失败；索引正文给出 GET query / POST XML 示例，实际行为以下面的本机验证为准。
- [HikLoad 的 ContentMgmt 源码](https://github.com/Tedyst/HikLoad/blob/master/hikload/hikvisionapi/_ContentMgmt.py) 与 [HTTP 实现](https://github.com/Tedyst/HikLoad/blob/master/hikload/hikvisionapi/utils.py)：GET /ISAPI/ContentMgmt/download，XML body 中放 playbackURI。Node fetch 不支持 GET body，若采用此旧式方式应使用能发送 GET body 的 HTTP 客户端；本机 POST XML 同样成功，优先考虑 POST。
- [hikvision-download-assistant](https://github.com/cfryanr/hikvision-download-assistant)：提供 GET + XML body 下载示例；作者明确仅在指定 IPC 上实测，NVR 兼容只是预期。不能仅凭其 README 宣称本型号可用，本次已另做实机验证。
- [FFmpeg MPEG-PS 解复用源码](https://github.com/FFmpeg/FFmpeg/blob/master/libavformat/mpeg.c)：包含 IMKH 头识别以及相关 CCTV 流处理。下载返回 IMKH 不意味着必须先去掉文件头或安装海康播放器；本次保留头部、使用 -f mpeg 直接解码成功。
- [ivms666 recordings.py](https://github.com/sadensmol/ivms666/blob/main/recordings.py)：作者将该设备的 CMSearch / RTSP 时间解释为带 Z 的本地墙钟时间，并显式转换为真正 UTC。与本机观察相似，但不构成本机时间语义已验证的证据。
- [CameraDashboard 诊断笔记](https://github.com/jasondillingham/CameraDashboard-portfolio/blob/main/notes.md)：作者的设备需要保留尾斜杠、使用主码流，并限制取流时长。我们原始基线已经保留尾斜杠、使用 101 主码流；因此这两条不能解释本机现有失败，且不应推广成所有型号的规则。
- [海康 iSecure Center 回放 URL 文档](https://open.hikvision.com/docs/16741aecc05944a6b0cd1341d68e4546)：playBackMode=1 属于平台返回短 URL 的说明，要求平台与取流服务；不能直接套用到本机 NVR 的 ISAPI 原始 URI。
- [官方 SDK 按时间回放接口](https://open.hikvision.com/hardware/definitions/NET_DVR_PlayBackByTime_V40.html)：可创建回放并配合播放控制与码流回调；作为后备研究，不代表本机已完成 SDK 或平台适配。

### RTSP 新增变体（仍失败）

均从当次搜索取得的原始 URI 开始，仅改变表中对应因素；不修改服务端配置、不打印 URI：

| 变体 | 实机结果 |
| --- | --- |
| 重新测试原始 URI | OPTIONS 401→200，DESCRIBE 400 |
| 时间中的 T/Z 改为小写 | DESCRIBE 400 |
| 时间去掉末尾 Z | DESCRIBE 400 |
| 紧凑时间改为带分隔符的 ISO 格式 | DESCRIBE 400 |
| Streaming 路径改为小写 | DESCRIBE 400 |

以上失败只能排除这些单独变体作为本机直接修复方案，不能证明已穷尽所有请求组合或确认固件根因。

### HTTP 下载路径：已验证（实机，有限读取/解码）

重新检索 101 / 2026-10-17 的第一个历史片段，保留原始 playbackURI 的尾斜杠、时间、name、size，XMLBuilder 正确转义 &。Digest 凭据从 .env 读取，认证头与 URI 均不输出。

请求形态（占位值）：

```http
POST /ISAPI/ContentMgmt/download
Content-Type: application/xml

<downloadRequest version="1.0" xmlns="http://www.isapi.org/ver20/XMLSchema">
  <playbackURI>搜索结果中的原始 URI，经 XML 实体转义</playbackURI>
</downloadRequest>
```

| 请求 | 实机结果 |
| --- | --- |
| POST + XML body | HTTP 200，IMKH 封装；有限读取约 64 KiB 后断开 |
| GET + XML body | HTTP 200，IMKH 封装；有限读取约 64 KiB 后断开 |
| GET query 中放 URL 编码的 playbackURI | HTTP 400，statusCode=6，subStatusCode=badXmlContent |
| POST + XML body → FFmpeg 管道 | HTTP 200，读取 1,693,712 字节；FFmpeg exitCode=0，**decodedFrames=3**，未超时，输出 null |

解码参数：

```sh
# 由本地 HTTP 客户端将已通过 Digest 认证的响应体送到 stdin。
# 凭据不进入 FFmpeg 参数，不落盘视频。
ffmpeg -nostdin -v error -f mpeg -i pipe:0 \
  -map 0:v:0 -frames:v 3 -an -f null - -progress pipe:1
```

诊断顺序为 POST XML、GET XML body、GET query，随后单独重开 POST 做有限解码；每个操作顺序执行。读取探测上限约 64 KiB（允许当前传输块），解码读取上限 8 MiB（允许当前传输块）、总时限 25 秒；子进程完成后关闭 HTTP 流。临时脚本只含配置读取逻辑与占位流程，未持久化原始媒体。

**证据边界：** 已证实本机能返回并解码指定历史片段请求的媒体数据，不能再把所有历史媒体获取视为完全阻塞。标准 RTSP 仍然 DESCRIBE 400；完整文件、文件与实际录像时间对应、音频、任意位置 seek、Range、跨片段和浏览器播放尚未验证。按文件名下载可能返回完整文件并忽略缩窄后的时间窗口，不能假定等同于按时间回放；可参考 [HikLoad #41](https://github.com/Tedyst/HikLoad/issues/41) 的实际报告。

**推荐下一步：** 把已验证的 HTTP XML 下载方式整理成正式的有限诊断 CLI，进一步验证完整文件与时间映射、首帧延迟及定位成本，再决定历史播放是否采用 HTTP 下载转封装的备选设计。P2 前仍需显式完成新的历史源验收，不把 3 帧解码直接当作播放器可用。

## 14:32 补充：HTTP 文件预览，浏览器本机解码

用户明确要求“解码留在本机而不是服务端解码”，授权先做可验证的 HTTP 替代路径。本轮先验证源的有限换封装，再集成播放器，没有把旧的 RTSP DESCRIBE 400 标记为解决。

### 实现与边界

- 仍为一个 Next.js Node.js 实例；Hono 处理查询、Digest、下载和媒体会话。Route Handler 新增 POST / DELETE 适配。
- 浏览器只提交轨道、日期、匿名片段 ID。服务端重新查询并匹配已签发的 ID，保留原始 playbackURI 用于固定 ISAPI 下载接口；不接受客户端 URL，也不返回原始 URI。
- HTTP 下载响应从管道进入 FFmpeg，`-f mpeg -i pipe:0 -map 0:v:0 -c:v copy -an -sn -dn -t 30`，输出 fragmented MP4。**服务端不进行视频解码、滤镜或编码**。容器结构解析计算时长，生成 VOD HLS；[FFmpeg streamcopy 文档](https://ffmpeg.org/ffmpeg.html#Streamcopy)、[fragmented MP4 文档](https://ffmpeg.org/ffmpeg-formats.html#mov_002c-mp4_002c-ismv)。
- Safari 分支使用原生 HLS，Chrome 使用 hls.js / `<video>` 在本机解码；**Safari 分支只实现，尚未实机验证**。
- 该轮提供文件开头最多 30 秒无声预览，可暂停并在预览内部 seek；当时误用搜索字段将其称作 H.264 预览。**后续 14:40 实测更正：同一首片段实际为 HEVC；现已按用户要求支持 H.264 / H.265，见下节。** 未把全天时间轴定位映射到文件位置，也不回退到服务端转码。
- 两个会话槽含准备中，TTL 120 秒，换封装时限 30 秒，源 32 MiB、输出 16 MiB 上限。全部媒体在内存中，不写视频文件；关闭/切换/离开请求清理，取消/超时中止下载并杀掉子进程，TTL 兜底。浏览器已经缓冲的数据不会因会话过期而被远程撤回。

### 实机证据

```sh
pnpm verify:preview 101 2026-10-17
```

输出：`mode=stream-copy`、`durationSeconds=30`、`initBytes=848`、`mediaBytes=4805418`、`decodedOnServer=false`。CLI 只做有限换封装和结构验证，不读取像素；后面的浏览器测试另行证明压缩视频可以解码。

```sh
TEST_BASE_URL=http://127.0.0.1:3001 NVR_INTEGRATION=1 pnpm test:e2e
```

7 项通过，包括查询的原有 13 段验收、合成 HLS 播放、失败/重试/取消及真实历史预览。真实片段连续打开两次：

| 操作 | 实机结果 |
| --- | --- |
| 创建预览 | 两次 POST 均 201，mode=stream-copy |
| 浏览器加载 | 两次 duration=30 秒，readyState ≥ 3 |
| 播放并读取本机解码计数 | getVideoPlaybackQuality().totalVideoFrames 为 20 / 9，均大于 3 |
| 暂停 | paused=true |
| 预览内 seek 第 10 秒并继续 | seeking=false，currentTime 接近 10，重新播放后继续增加 |
| 关闭 | DELETE 204；原 HLS 入口随后 GET 404 |
| 进程回收 | 测试后 pgrep -x ffmpeg 退出 1，无 FFmpeg 进程 |

测试禁用截图、视频和 trace，只读取帧数、时长及播放状态，未采集家中画面。另用人工素材截图检查 375px 布局，未出现页面横向溢出。仓库新增的 `synthetic-preview.mp4` 为 FFmpeg 人工测试图，与真实录像无关；复现命令为：

```sh
ffmpeg -nostdin -v error -f lavfi -i testsrc2=size=160x90:rate=12 \
  -t 3 -c:v libx264 -profile:v baseline -pix_fmt yuv420p -an \
  -movflags +frag_keyframe+empty_moov+default_base_moof \
  -frag_duration 1000000 -f mp4 fixtures/synthetic-preview.mp4
```

此命令仅生成测试素材，不是应用的媒体处理路径。

### 自动测试、修复与遗留项

- `pnpm test`：65 项通过。新增下载 Digest/错误/外部 URL 拒绝、fMP4 结构和时长、原样复制参数、会话并发/TTL/取消/过期/关闭、未知录像与不兼容编码，以及 FFmpeg 缺失、空输出、30 秒超时、源和输出容量上限的清理测试。
- `pnpm typecheck`、`pnpm lint`、`pnpm build` 通过。构建对外部 FFmpeg 可执行程序使用明确的 tracing 排除，不将整个项目作为动态可执行文件路径追踪。
- 首轮浏览器实机 POST 被同源检查误拦为 403：Next.js 规范化 request.url 后与浏览器 Origin 的主机不同。现用请求 Host 还原 authority，保留协议及端口检查和 cross-site 拒绝；补上回归测试，随后实机播放通过。
- 仍未完成：标准历史 RTSP、任意历史时刻定位、文件时间映射、全长/跨片段、音频、Safari、P3 部署和鉴权。真实帧数表示浏览器成功解码，不证明硬件加速启用，也不证明时间轴时刻已与画面核准。
- 下一步：对照一处可确认的录像时刻核准文件起点，测定位成本，再扩大预览时长或设计按需读取。当前最小预览已可使用，整个 P1/P2 仍不能标记完成。

## 14:40 更正与验收：H.264 / H.265 双编码

用户指出录像应为 H.265，并明确要求同时支持 H.264 与 H.265。先只读重查 101 / 2026-10-17 首片段，按原有 `-c:v copy` 流程换封装，再在本机以 ffprobe 读取编码概要；媒体仅在内存与管道中，不保存画面、不输出 URI 或设备凭据。

ffprobe 查询字段为 `stream=index,codec_name,codec_type,profile,width,height,pix_fmt`，探测限时 10 秒，输出上限 8 KiB。脱敏结果：

```json
{
  "metadataCodec": "H.264-BP",
  "actualStream": {
    "codec_name": "hevc",
    "codec_type": "video",
    "profile": "Main",
    "width": 2560,
    "height": 1440,
    "pix_fmt": "yuvj420p"
  }
}
```

**结论：该样本实际是 H.265，搜索报告编码不准确。** 之前成功的浏览器预览也是 HEVC，不能把搜索元数据当作真实编码，更不能由该样本推断所有轨道/日期均为同一编码。原样换封装没有把 H.265 变成 H.264。

本轮修正：

- 移除依赖搜索字段的 H.264 限制。换封装后读取实际 MP4 sample entry：avc1/avc3 识别为 h264，hvc1/hev1 识别为 hevc；其他编码报错并释放会话，不转码。
- 临时预览响应新增 `codec`，页面明确显示实际 H.264 / AVC 或 H.265 / HEVC。片段详情将原编码标记为“设备报告”。
- `verify:preview` 同时输出 `metadataCodec` 和实际 `codec`。正式 CLI 实机结果为 `metadataCodec=H.264-BP`、`codec=hevc`，duration=30 秒，init=848、media=4,805,418 字节，decodedOnServer=false。
- 新增人工 HEVC 素材，与真实录像无关。生成参数与此前人工 H.264 素材相同，但编码器改为 `-c:v libx265 -profile:v main -pix_fmt yuv420p -x265-params log-level=error:pools=1:frame-threads=1`。仅生成测试素材时编码，应用仍只进行 stream copy。

验证命令与结果：

| 命令 | 结果 |
| --- | --- |
| pnpm test | 66 项通过，含实际容器编码识别、错误/缺失搜索编码不阻断播放、非 AVC/HEVC 拒绝 |
| pnpm typecheck / pnpm lint / pnpm build | 均通过 |
| TEST_BASE_URL=http://127.0.0.1:3001 NVR_INTEGRATION=1 pnpm test:e2e | 8 项通过；人工 H.264、人工 H.265 本机解码/暂停/seek/关闭和 375px 无溢出；真实 HEVC 两次播放成功 |
| pnpm verify:preview 101 2026-10-17 | 实际 codec=hevc，与 ffprobe 一致 |
| pgrep -x ffmpeg | 退出 1，无残留 FFmpeg 进程 |

真实两次会话均 `codec=hevc`、duration=30，浏览器实际解码计数为 10 / 9；预览内第 10 秒 seek、继续播放及关闭后 404 均通过。H.264 的本轮证据来自人工素材浏览器测试，未声称该 NVR 的某一 H.264 历史样本已验证。全部真实媒体测试禁用截图、录屏和 trace。

**兼容性边界：** hls.js 的 [HEVC/fMP4 支持取决于运行环境](https://github.com/video-dev/hls.js#features)。当前本机 Chrome 实测可用；Safari 与其他系统组合仍待验证。不把双编码接入宣称为所有浏览器均能播放，不自动转码；文件起点映射、任意时间定位与完整历史回放的待验收项不变。

## 14:57 补充：默认四宫格与手动实时预览

用户要求将主界面改为多窗口实时预览，支持 1、2、4、8、16 路，默认 4 路；进入页面不立即请求画面，回放复用此组件。本轮范围为最小 P2 实时预览与共享播放组件，不改变标准历史 RTSP 的阻塞结论。

**已实现：**

- `/` 为实时预览，首次进入只读取 `/api/channels`。布局切换和通道分配均不取流，必须手动点击每个窗口的“开始预览”。
- `/playback` 保留原录像查询、时间轴与文件开头最多 30 秒预览。实时和回放共用 `VideoWall`、`StreamPlayer`、`HlsVideo`；回放目前仍只显示所选片段的单窗口预览。
- `POST /api/streams/live` 严格接受 `{track}`，验证轨道确实来自设备查询；固定实时 RTSP 路径，不接受 URL、主机或其他参数。
- FFmpeg 只做 `-c:v copy`，移除音频，压缩视频在有限内存中滚动保存，不生成视频文件。每路最多 6 分片 / 32 MiB；单个解析块和分片最多 8 MiB，初始化数据最多 256 KiB。最多 16 路（含准备中）、准备 20 秒、RTSP I/O 10 秒、媒体访问空闲 30 秒回收、10 分钟绝对 TTL。
- 停止、更换通道、布局移除窗口、全部停止、导航离开会释放会话；HLS 致命错误会主动删除会话。缺少关闭请求时由空闲回收和 TTL 兜底。

**自动测试：已验证。**

| 命令 | 结果 |
| --- | --- |
| `pnpm test` | 72 项通过；新增实时分片跨 chunk 解析、滚动保留、16 路上限、取消/启动超时/空闲/TTL/异常清理、通道白名单、输入/请求体/同源限制和匿名媒体入口测试 |
| `pnpm typecheck`、`pnpm lint`、`pnpm build`、`git diff --check` | 均通过；静态 `/`、`/playback` 与动态 Hono API 同一个 Next.js 构建 |
| `NVR_INTEGRATION=1 pnpm test:e2e --workers=1` | 15 项通过；本地新生产构建绑定 `127.0.0.1:3100`，Chrome；真实用例仅单路实时与既有历史查询/限时文件预览 |

默认四路、全部分屏和通道分配的浏览器测试捕获网络请求，确认没有 `/api/streams/*` 或录像查询请求，也没有 `<video>` 元素。人工 H.264 和人工 HEVC 均解码；切换通道、缩小布局、全部停止、进入回放页各触发会话删除。桌面和 375px 页面无横向溢出。截图审阅只使用模拟通道和未开启画面。

**单路 Chrome 直播：已验证（实机）。**

- 同一设备、已有只读配置、轨道 101，经服务端受控 RTSP 取流创建会话，响应 201；实际容器编码 HEVC Main，2560×1440。
- 首次原生 HLS 路径未播放，视频错误码 4、解码帧数 0。Chrome 虽返回 HLS capability，但此实时 HEVC 流应走 hls.js；改为 Safari 原生、Chrome hls.js 后，同一实机浏览器测试通过，观测 **32 个解码帧**，并验证帧数继续增长。
- 点击停止返回 DELETE 204；旧播放入口随后 404。`pgrep -x ffmpeg` 退出 1，无残留。
- 历史查询仍为 13 段；两次真实文件预览均 30 秒，解码帧数各 9，暂停、预览内第 10 秒 seek 和关闭后 404 均通过。
- 未保存或显示任何真实视频截图、录屏、原始播放 URI、认证数据或设备私密标识。媒体诊断仅保留编码、容器尺寸、状态码和帧数。

初期两次验证环境问题已排除：沙箱内 Chrome 启动 SIGABRT；旧的 3001 生产进程仍返回旧首页和 `/playback` 404。最终结果来自沙箱外 Chrome 与新构建的本地 3100 验证实例，不将早期失败记为产品功能通过。

**待验证与下一步：** 16 路真实并发和设备/浏览器负载、长时间运行、Safari 实机直播；真实 H.264 直播样本本轮未验证。建议下一次先验证 4 路指定通道并发与反复停止，再扩至 8 / 16 路。标准历史 RTSP、完整历史播放、时间映射、精确 seek 与部署鉴权仍保持原有未完成状态。

## 补充：设备通道名称只读关联

用户反馈已为摄像头设置名称。本轮实机只读检查：record/tracks 无名称，但各轨道含 `SrcDescriptor/SrcChannel`，分别关联到 InputProxy 的通道 ID；`GET /ISAPI/ContentMgmt/InputProxy/channels` 返回 16 条带名称配置。`System/Video/inputs/channels` 返回 403（未判断其原因）；Streaming/channels 的 channelName 为数字串，因此本轮不使用这两个来源。名称以已验证的 InputProxy 响应为准。

实现增加只读路径白名单及专用 XML 名称解析器；按明确的 SrcChannel 映射到原 track ID，空名称/未知关联/可选接口错误均保留原名。输出仅 id/name/configuredEnabled，源摄像头 IP、代理用户名、SrcUrl 和 SrcLogin 不进入前端响应。缓存 20 秒，并合并并发读取，避免“全部开始”时重复查询配置。

- `pnpm test`：87 项通过，其中新增 15 项名称相关测试；类型检查、lint、生产构建及 diff 格式检查通过。
- 实机核对：通道 16、配置名称 16、映射匹配 16；每条结果都只含三项公开字段。只记录数量和匹配布尔值，不保存具体名称或原始 XML。
- Chrome 实机数据 UI 验证：左侧 16 个名称、默认四个窗口下拉框全部选项、回放下拉框均与 `/api/channels` 一致；媒体请求数为 0，无真实画面截图或录屏。
- `pnpm test:e2e tests/browser/console.spec.ts --workers=1`：模拟回归 3 项通过，默认未启用的录像实机用例 1 项跳过。本轮实机证据来自上面的独立只读名称核对与 UI 检查，不将跳过用例记作通过。

## 补充：实时 G.711 音频与窗口点击暂停

实机只读 RTSP ffprobe 发现轨道 101 含 HEVC 视频与 `pcm_alaw` 音频（8000 Hz，单声道）。旧程序主动使用 `-an`，因此用户反馈音轨存在但无声属实；同时实时 `<video controls>` 的点击具有浏览器原生暂停行为。

修复实时控件：点击视频只选中窗口，独立控制声音和全屏。自动播放默认静音，用户点击“开启声音”后创建 AudioContext。FFmpeg 使用 tee 将视频和可选音频分别 stream copy；A-law / μ-law 编码样本由浏览器本机解码，服务器只解析容器元数据。以 HLS 原始 PTS 偏移将音频对齐视频时钟，视频缓冲/暂停/seek 时取消已调度音频，再次播放按当前时间调度。没有音轨或音频格式不支持时视频继续；不自动转码。

资源边界：服务器音频 80 块 / 512 KiB，单块解析上限 256 KiB，初始化上限 64 KiB；原有会话 TTL/并发/空闲回收适用于音频。客户端缓存最多 80 块，按需拉取；静音、停止、切换和离开时中止请求、停止音频源、关闭上下文。音频入口只用匿名会话 ID 和整数游标，不含设备地址或账号。

- `pnpm test`：92 项通过；A-law 与 μ-law 全部 256 码字与独立 FFmpeg s16le 参考 SHA-256 匹配，测试文件音频为人工 440 Hz 正弦波，非设备声音。
- `pnpm typecheck`、`pnpm lint`、`pnpm build`、`git diff --check`：通过。
- `pnpm test:e2e --workers=1`：16 项通过、3 项实机默认跳过；新增人工双视频编码的点击/跨窗选择不暂停、本机音频调度、非零人工样本、静音停止拉取、停止关闭上下文。既有查询、批量开始、取消、回放预览测试通过。
- 独立真实媒体检查：实时响应为 HEVC，音频状态 available、A-law / 8000 / mono，视频和音频起点均为 0；创建会话后已收到 7 个复制音频块。
- 独立 Chrome 实机检查：视频解码 34 帧，Web Audio 调度 3 个音频源，跨窗选择和点击后 `paused=false`，停止时关闭 1 个 AudioContext。未保存或展示真实视频/声音，未输出通道名称或原始 URI；只验证音频已送入浏览器播放图，不声称人工听音或长期音画同步已验收。

遗留范围：Safari 音频、其他音频编码（AAC 等）、长时/多路同步、历史文件音频尚未验证或实现。当前 HTTP 历史文件预览依旧无声，不扩展原有 30 秒和时间定位边界。
