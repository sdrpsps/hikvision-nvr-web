# 海康威视 NVR 无插件 Web 管理后台 — 开发计划

> 文档版本：v1.1 · 2026-10-18
> 面向：使用 Codex 自行创建项目并分阶段实施
> 技术栈：**Next.js（前端）+ Hono.js（后端）+ TypeScript**
> 说明：**各项状态以文末验证记录为准。P0 基础实现与 13 段样本查询已验证；设备时间语义仍待核对。P1 历史 RTSP 仍阻塞，P2/P3 未开展。**
> 用户最新架构决定（2026-10-18）：**Hono 挂载为 Next.js 后端，只运行一个实例；暂不做前端鉴权。** 下面已据此更新。

## 1. 项目背景与目标

现有海康 NVR 的旧版 Web 后台依赖 Windows ActiveX，macOS Safari/Chrome 无法完成预览和回放。拟创建独立 Web 应用，不修改录像机固件、录像方式和硬盘存储，以浏览器取代原生插件。

**第一阶段产品目标：**

1. 查询和展示可用摄像头/录像轨道。
2. macOS 浏览器中无插件查看实时画面。
3. 按摄像头和日期检索历史录像，绘制 24 小时时间轴。
4. 在历史 RTSP 回放打通后，支持点击时间轴进行播放、暂停与跳转。
5. 可通过 Docker Compose 部署在家庭 PVE 上的 Linux 容器或虚拟机。

**非目标（初期不做）：** 重写 NVR 录制服务、修改设备配置/录像策略、格式化硬盘、升级固件、PTZ 控制、AI 识别、云端录像备份、面向公网直接暴露 NVR、完整替代海康的全部管理功能。

**实施原则：先实测、再集成；读操作优先；每阶段必须有可重复的验收证据。**

## 2. 设备事实与当前验证状态

| 项目 | 状态 | 已有证据或注意事项 |
| --- | --- | --- |
| NVR | **已确认** | `DS-7816NB-K2/16P`；固件 `V4.30.000`，build `200508` |
| 设备信息 | **成功** | `GET /ISAPI/System/deviceInfo`，HTTP Digest 可用 |
| 录像轨道 | **成功** | `GET /ISAPI/ContentMgmt/record/tracks`，轨道 `101`、`201` 等 |
| 轨道 `Enable=false` | **已观察** | 部分或多个轨道返回 false，但 `101` 确有历史录像，不能以此判断无录像 |
| 历史录像搜索 | **成功** | `POST /ISAPI/ContentMgmt/search`；旧版 XML 可不包含 `metadataList` |
| 搜索样本 | **成功** | 轨道 `101`；北京时间 2026-10-17 全天，返回 **13** 段连续录像 |
| 搜索响应 | **成功** | `responseStatus=true`、`numOfMatches=13`、片段 `startTime/endTime`、`playbackURI` |
| 录像编码 | **仅元数据确认** | 搜索结果报告 `H.264-BP`；尚须 `ffprobe` 验证实际流和音频 |
| RTSP 实时预览 | **成功** | Mac VLC 可播放 `rtsp://<user>@<host>:554/Streaming/Channels/101` |
| RTSP 历史回放 | **阻塞** | VLC 无法打开搜索返回的历史 `playbackURI`；原因尚未查明 |
| 浏览器播放 | **未实施** | 历史源尚未验证，P2 未开始 |
| 本项目查询与页面 | **已验证（实机）** | 16 条轨道；101 / 2026-10-17 API 和 Chrome 页面均为 13 段 |
| 本轮历史 RTSP | **阻塞** | OPTIONS 认证后 200；DESCRIBE 400，未到 SETUP/PLAY |
| 时间语义 | **待验证** | 当天末段 Z 时间若按 UTC 解释，比设备当前时间晚约 8 小时 |
| 下载能力 | **已验证（实机，仅能力声明）** | 按文件名 true，按时间 false；实际下载未验证 |

**重要纠正：** 早期的 `curl: (52) Empty reply from server` 是测试命令没有替换占位 IP 所致。修正 URL 后，同一搜索接口已成功。它不是固件不支持搜索的证据。

### 2.1 已验证的搜索请求结构

```xml
<?xml version="1.0" encoding="UTF-8"?>
<CMSearchDescription>
  <searchID>e7b41230-955f-44bc-b42f-8d38a936a0f4</searchID>
  <trackIDList><trackID>101</trackID></trackIDList>
  <timeSpanList>
    <timeSpan>
      <startTime>2026-10-16T16:00:00Z</startTime>
      <endTime>2026-10-17T15:59:59Z</endTime>
    </timeSpan>
  </timeSpanList>
  <maxResults>40</maxResults>
  <searchResultPostion>0</searchResultPostion>
</CMSearchDescription>
```

注意：`searchResultPostion` 是该固件已验证可用的旧版字段拼写；**不要擅自更名**。录像机按北京时间（`Asia/Shanghai`）使用时，前端日期必须显式转换为 UTC 查询，不能依赖运行容器的本地时区。

返回的示例历史回放地址形态：

```text
rtsp://<nvr-host>/Streaming/tracks/101/?starttime=20261016T160000Z&endtime=20261016T160542Z&name=<segment-name>&size=<segment-size>
```

- 原始 XML 的 `&amp;` 应由 XML 解析器解码成 `&`。
- 首先**完整保留**录像机返回的 URI（包括 `/101/` 末尾的斜杠、`name`、`size`）作为基线，不要未经诊断就替换为猜测的 URL。
- `playbackURI` 不得原样返回前端，也不要在默认日志中打印完整地址。

## 3. 技术架构与职责划分

```text
浏览器
  │ 同源请求
  ▼
单个 Next.js 实例（Node.js Runtime）
  ├─ App Router / React：页面、时间轴
  └─ /api/* → Hono 挂载
       ├─ Zod 契约、Digest、ISAPI、XML
       ├─ 分页、短期缓存、覆盖区间
       └─ 后续媒体会话（P1 通过后）
                │
                ▼
          Hikvision NVR（现有硬盘录像）

P2 经验证后再接入 FFmpeg / MediaMTX。
```

### 3.1 明确技术选型

| 层 | 建议 | 原因 |
| --- | --- | --- |
| 前端 | Next.js App Router、React、TypeScript | 负责 UI，不直接访问 NVR 或管理视频凭证 |
| 后端 | **Hono.js** + TypeScript，挂载 Next.js Node.js Runtime | 单实例 /api/*，封装 Digest、XML、后续取流生命周期 |
| Monorepo | pnpm workspaces（建议） | 保留根目录 Next.js，server/ 封装 Hono，shared/ 共用契约 |
| 数据校验 | Zod | 参数、返回 DTO 的运行时校验 |
| XML | 能正确处理命名空间和实体的 XML 解析库 | 处理海康返回的 XML `xmlns`、`&amp;` |
| 媒体 | MediaMTX + FFmpeg，按场景组合 | 直播可复用长期拉流；历史录像需要动态、按区间的临时取流 |
| Web 播放 | Safari 优先原生 HLS；其他浏览器可选 hls.js | 不要求 ActiveX，便于排查兼容性 |
| 部署 | Docker Compose | 适合现有 PVE 的 Linux 宿主环境 |

### 3.2 不应误用的能力边界

- **ISAPI 搜索成功 ≠ 历史 RTSP 可播放。** 后者仍是当前主要阻塞点。
- **VLC 实时预览可播 ≠ 回放 URL 正确。** 历史回放可能存在不同的认证、RTSP 路径、时间区间或 `SETUP/PLAY` 行为。
- **MediaMTX 不会自动解决历史回放源无效的问题。** 应在 P1 排障成功后再做流媒体接入。
- **HLS 时间轴不等于录像机的原始 24 小时时间轴。** 按历史时间跳转通常需要后端停止旧会话并创建新的取流会话。
- 初期不需要持久化视频或数据库；可先使用进程内会话缓存。多实例部署后再考虑外部状态存储。

## 4. 建议模块与接口约定

用户自行创建工程时，可参考此逻辑划分（目录名不作强制要求）：

```text
app/          # Next.js 页面和 /api/[[...route]] 挂载
components/   # 查询控制台与 shadcn UI
server/       # Hono、Digest、ISAPI、XML、时区、RTSP 诊断
shared/       # 共享 DTO / Zod 契约
scripts/      # 局域网只读验证与脱敏诊断 CLI
fixtures/     # 人工合成 XML，无真实标识
tests/        # 单元、契约、浏览器测试
docs/         # 计划与验证记录
```

### 4.1 Hono API 规划

| 方法及路径 | 描述 | 阶段 |
| --- | --- | --- |
| `GET /api/health` | 检查 API 存活，不主动连 NVR | P0 |
| `GET /api/device` | 只读设备概要；过滤设备序列号等敏感字段 | P0 |
| `GET /api/channels` | 摄像头/录像轨道，区分通道配置与历史录像存在性 | P0 |
| `GET /api/recordings?track=101&date=2026-10-17` | 按 NVR 时区检索并返回录像片段时间段 | P0 |
| `POST /api/streams/live` | 为可信通道启动/复用实时预览会话 | P2 |
| `POST /api/streams/playback` | 请求历史录像指定轨道与时间区间的新会话 | P2 |
| `GET /api/streams/:id` | 返回临时播放状态及**受保护**的播放入口 | P2 |
| `DELETE /api/streams/:id` | 关闭回放会话、清理子进程和文件 | P2 |

建议 `GET /api/recordings` 的 JSON 示例（**不含 RTSP URI**）：

```json
{
  "trackId": "101",
  "date": "2026-10-17",
  "timeZone": "Asia/Shanghai",
  "segments": [
    {
      "id": "opaque-segment-id",
      "startAt": "2026-10-16T16:00:00Z",
      "endAt": "2026-10-16T16:05:42Z",
      "codec": "H.264-BP",
      "recordType": "timing"
    }
  ]
}
```

要求：前端只传合法的轨道 ID、日期或目标时间；Hono 仅从已检索并缓存/验证的录像片段内部取得 RTSP URI，禁止接受客户端自定义远程 URL，以防 SSRF。

## 5. 里程碑与完成标准

### P0 — 工程基础、ISAPI 查询和时间轴（先做）

- [x] 保留已有 Next.js 工程，加入 Hono.js + TypeScript 模块及开发/构建命令。**已验证（自动测试/构建）**
- [x] 按用户新要求使用 Next.js /api/* → Hono 单实例挂载，不另开 API 服务。**已验证（开发态与生产态实机、构建）**
- [x] Digest 客户端：挑战、有限认证重试、超时、异常转换。**已验证（自动测试、实机成功认证）**
- [x] 设备/轨道/录像 XML：命名空间、实体、旧字段。**已验证（自动测试、实机）**
- [x] 分页、重复段、覆盖合并、边界和缺口；不以 Enable=false 过滤。**已验证（自动测试）；实机轨道全部 false 仍可查**
- [x] 通道/日期选择、全天时间轴、缩放、片段提示、加载/空/失败反馈。**已验证（浏览器自动测试、Chrome 实机数据）**
- [x] 合成 XML 单元测试和局域网 101 / 2026-10-17 查询；API、页面均 13 段。**已验证（自动测试、实机）**
- [ ] 交叉核对固件的 Z 时间标记与真实录像时间；当天元数据显示约 8 小时疑点，不能静默修正。**待验证**
- [ ] Safari 查询交互。**待验证**（本轮浏览器自动化使用 Chrome）

**验收：** 用户在 Mac 浏览器选 2026-10-17，轨道 `101` 显示与设备搜索相符的 13 个片段。无播放功能时明确标注“待联调”，不要伪造进度条可播放状态。

### P1 — 历史 RTSP 精准排障（当前阻塞项）

- [x] 保持原始 playbackURI 建立基线。**已验证（实机）**
- [x] ffprobe：全部参数、无凭据、仅用户名、完整凭据、TCP/UDP。**已验证（实机，历史均失败）**
- [ ] VLC 使用当前配置重新验证。**待验证**（早先人工事实为失败，本轮未操作 VLC）
- [x] 阶段码脱敏：历史 OPTIONS 401→200，DESCRIBE 400；未到 SETUP/PLAY。直接 RTSP 与 FFmpeg 一致。直播对照至 PLAY 200 并实际解码 3 帧。**已验证（实机）**
- [x] 基线失败后逐项检查斜杠、name/size、时间、第二片段和 ISAPI 等变体，仍 DESCRIBE 400。**已验证（实机）**
- [x] RTSP Digest 挑战、现存录像区间和设备当前时钟。**已验证（实机）**
- [ ] 账户历史回放权限、原生客户端同段可播性与固件时间语义。**待验证**
- [x] 查询厂商下载/SDK 资料；实机下载能力报告按文件名 true、按时间 false。**已验证（实机，仅能力声明）**
- [ ] 实际下载、HTTP 码流解码或 SDK 备选路径。**待验证，尚未实现**
- [x] 保存 [脱敏验证记录](./VALIDATION_2026-10-18.md)，含复现命令、结果和下一步。

**验收：** 通过 VLC 或 FFmpeg 成功解码指定历史片段，并可确定从任意指定时间开始回放的行为。未完成此项前不要将浏览器历史回放标记为成功。

#### 诊断命令参考

**A. 查询历史录像（只读）**：将 `<NVR_HOST>` 替换为实际局域网地址；用户名使用 `-u` 的交互式密码提示。

```bash
curl --noproxy '*' --digest -u admin \
  -H 'Content-Type: application/xml' \
  --data-binary @search.xml \
  'http://<NVR_HOST>/ISAPI/ContentMgmt/search'
```

**B. 使用真实搜索结果的 RTSP URI 检查媒体信息（Mac/Linux）**：

```bash
# 将 XML 解析后的原始 playbackURI 置入环境变量；不要把账号密码写进代码或 Git。
# 如 ffprobe 需要凭据，先通过受信任的本地工具配置；注意命令行 URI 可能被进程列表读取。
ffprobe -v verbose -rtsp_transport tcp -i "$PLAYBACK_URI"
```

`ffprobe` 可以帮助判断是否成功进入 RTSP 建连/取流流程，但它无法解决不正确的设备回放 URL。排障日志只保留状态码、阶段、时间，脱敏认证头和用户信息。

**C. RTSP 诊断决策表**：

| 现象 | 可能原因 | 继续行动 |
| --- | --- | --- |
| `401` / `403` | 认证或回放权限 | 核对 Digest 认证及账户录像回放权限 |
| `404` | 历史 URI、路径、参数或时间段无效 | 比对完整原始 URI 与受控变体 |
| `454` / `461` | RTSP 会话/传输方式问题 | 分别检查 SETUP、PLAY；切换 TCP/UDP |
| `503` | 录像资源、会话限制或设备负载 | 降低并发；验证同段在 NVR 原生端可播 |
| `DESCRIBE` 成功、`PLAY` 失败 | RTSP 会话问题 | 提取后续响应，不误判为“编码问题” |
| VLC 能播，浏览器黑屏 | HLS 封装、编码/音频兼容性 | `ffprobe` 检查流，必要时转码 |

### P2 — 直播与历史 Web 播放

- [ ] 实时预览：由 Hono 管理受控通道，MediaMTX 输出 Web 可消费的 HLS/WebRTC。
- [ ] 历史播放：Hono 根据已验证的片段信息创建按需 FFmpeg/媒体服务会话。
- [ ] 浏览器播放器：优先 HLS，支持 Safari/Chrome；兼容性不足时评估转码。
- [ ] 时间轴点击/拖动：定位片段与时间偏移、启动新回放会话、释放旧会话。
- [ ] 对无录像时间段、跨片段、加载超时、设备断连、音频缺失给出明确 UI 状态。
- [ ] 加入会话 TTL、并发上限、用户离开时清理、浏览器断开时回收资源。

**验收：** macOS Safari/Chrome 无插件查看实时画面，并能在真实历史录像上完成播放、暂停、跳转、跨片段处理；不会产生无限存活的转码进程。

### P3 — 部署、安全与运行稳定性

- [ ] Docker Compose 运行 Web、Hono 与媒体组件，录像仍只存 NVR。
- [ ] 通过反向代理统一 HTTPS 入口；Hono 和媒体内部管理接口仅在受信任网络监听。
- [ ] 设计本地 Web 登录与会话鉴权；媒体播放 URL 也必须鉴权，不能只保护 JSON API。
- [ ] 限制 RTSP 并发、HLS 临时文件占用、CPU/内存使用；异常自动清理。
- [ ] 增加健康检查、关键失败日志和部署文档；对用户时间、录像机时间、系统时间做一致性验证。

**验收：** 在 PVE 的 Linux 环境稳定运行，重启后恢复服务；没有公开暴露录像机的 80/554 端口或 Hono 管理端口。

### P4 — 可选扩展（完成核心需求之后）

- [ ] 录像区间导出与 MP4 下载。
- [ ] 录像事件类型过滤、录像日历、多个设备支持。
- [ ] 移动端响应式布局、快捷键、截图、分屏预览。

## 6. 安全与隐私准则

1. NVR 的用户名和密码只放服务端环境变量或 secrets；提交 `.env.example` 而非 `.env`。
2. 不将 NVR 原始 `playbackURI`、Digest 响应、序列号、MAC、认证 Header 暴露给前端或默认日志。
3. 不允许浏览器传入任意 RTSP 主机/IP/URL；限定到后台配置的 NVR 和合法轨道。
4. HTTP Basic（如果选择）必须配合 HTTPS；更推荐应用登录会话，播放器地址也须防未授权访问。
5. 流媒体、FFmpeg 会话必须受生命周期管理约束；使用最小权限的设备账户，优先仅直播/回放权限。
6. 首期不调用会修改录像计划、用户权限、硬盘或固件的写接口。
7. 调试视频内容属于家庭隐私信息，不提交录制样本或公开播放地址到 GitHub。

## 7. 测试策略与证据记录

- **单元测试：** XML 解析、Digest 认证、UTC/北京时间转换、分页与录像段合并/缺口、参数校验。
- **接口测试：** Hono 对设备断开、401、搜索结果为空、结构变化、超时有确定的错误响应；不泄露内部 URI。
- **播放器测试：** VLC/ffprobe 成功后，再验证 Safari 与 Chrome 的 HLS 播放；至少测一段有录像、一段无录像、跨片段和多次 seek。
- **资源测试：** 反复打开/关闭页面，确认 FFmpeg/MediaMTX session 被正确回收；多路并发时限制资源。
- **证据格式：** 每个任务记录测试日期、设备固件、命令（脱敏）、实际输出摘要、通过/失败、下一步，不凭假设勾选。

## 8. 给 Codex 的执行说明（直接复制为首轮任务）

> 按本文件实现海康 NVR 无插件管理后台。用户会自行创建仓库；技术栈固定为 **Next.js App Router + TypeScript 前端、Hono.js + TypeScript 后端，挂载于同一个 Next.js 实例**。不要改成 Vue。Next.js Route Handler 只做 Hono 的 Request/Response 适配，设备业务仍由 Hono 实现。先执行 P0 与 P1：创建 Digest ISAPI 客户端、XML 解析器、录像查询 API、录像时间轴和可复现的历史 RTSP 探测。必须把设备实测事实与未验证假设分开。历史 RTSP 目前 VLC 无法播放，不允许假定已解决；在成功播放前不要开展 P2 历史播放器集成。使用服务端配置读取 NVR 地址和凭据，不允许明文提交、泄露到浏览器或日志。只调用只读设备接口，分阶段提供实际执行的测试、失败原因和未完成清单。每通过一个阶段，再更新本开发计划中的勾选项与验证记录。

## 9. 首轮行动顺序

1. 用户创建空仓库，保存本文件为 `docs/DEVELOPMENT_PLAN.md`。
2. Codex 读取本文，列出 P0 最小任务及要验证的设备字段。
3. 完成 ISAPI 数据层和对应自动化测试，不修改 NVR。
4. 并行复现历史 RTSP 失败并定位到认证 / URL / RTSP 会话阶段。
5. 仅在有实测证据后推进 P2 浏览器视频播放；最后进行 P3 Docker 部署。

---

**当前核心判断：** NVR 历史录像**能查到**、实时 RTSP **能播放**；历史 RTSP **尚未能播放**。开发计划必须围绕这一边界推进，不能因为查询成功就承诺完整的浏览器录像回放已经可用。


## 10. 2026-10-18 实施状态

- **P0 基础实现、样本查询：已验证（自动测试、实机）**。Chrome 中 101 / 2026-10-17 显示 13 段。43 项单元/契约测试、4 项浏览器测试通过；类型检查、lint、生产构建通过。设备时间语义与 Safari 保留待验证，不将整个 P0 宣称为全部验收完成。
- **P1：阻塞**。原始历史 URI 认证后 DESCRIBE 400；尚无历史视频帧，任意时刻回放未验证。权限、时间语义和 VLC 复验待完成。
- **P2/P3：未开始**。不把直播解码成功当成历史解码成功；不提前集成历史 Web 播放。按用户要求鉴权暂缓。
- 具体日期、命令、结果、风险和下一步见 [VALIDATION_2026-10-18.md](./VALIDATION_2026-10-18.md)。
