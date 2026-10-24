<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# AGENTS.md — Hikvision NVR Web Console

> 本文件适用于仓库根目录及所有子目录中的 Coding Agents（包括 Codex）。
> **开始任何开发工作前，先阅读 `docs/DEVELOPMENT_PLAN.md`。** 以用户当前明确提出的任务为准；本文件是长期工程约束，不是一次性完成全部里程碑的授权。

## 1. 项目目标与边界

开发一个独立、跨平台、无需 ActiveX 的海康威视 NVR Web 管理界面，支持 macOS Safari/Chrome，逐步实现设备/通道查询、实时预览、历史录像检索、24 小时时间轴和回放。

- 用户**自行创建和维护仓库**。Agent 在收到具体实施任务后才修改项目；不要自行创建第二个项目、替换现有项目或擅自扩大范围。
- NVR 继续负责现有录像和硬盘存储；本项目只做只读查询、受控媒体转发与播放，不接管录像写入。
- 初期不实现设备配置修改、固件升级、磁盘操作、用户管理、PTZ、AI 分析或公网直连 NVR。
- 遵循 `docs/DEVELOPMENT_PLAN.md` 的 P0 → P1 → P2 → P3 顺序。可以并行诊断 P1，但**历史 RTSP 回放未验证成功前，不得声称该 RTSP 路径已可用**。2026-10-18 追加授权的 HTTP 文件限时预览例外见第 6 节；不能把此预览当作完整历史回放。

## 2. 固定技术栈

| 领域 | 选型 | 约束 |
| --- | --- | --- |
| Web 前端 | **Next.js App Router + React + TypeScript** | 专注页面、交互、时间轴和播放器。不要改用 Vue。 |
| API 后端 | **Hono.js + TypeScript（挂载 Next.js Node.js Runtime）** | ISAPI、Digest、XML、鉴权和媒体会话由 Hono 负责。 |
| 前后端契约 | TypeScript + Zod | 为输入、输出和错误结构建立共享契约。 |
| 依赖管理 | pnpm（推荐 workspaces） | 尽量复用仓库既有结构，不擅自迁移包管理器。 |
| 视频处理 | FFmpeg + MediaMTX（按验证结果选用） | 直播与历史回放必须分别设计；先确认源可播放再接入桥接。 |
| 浏览器播放 | HLS 优先；Safari 原生 HLS，其他浏览器可用 hls.js | 按用户要求在浏览器本机解码，不自动回退到服务端转码。 |
| 部署 | Docker Compose，目标 PVE 上的 Linux 环境 | 入口通过受控反向代理和 HTTPS；内部服务不暴露公网。 |

- 按用户 2026-10-18 明确要求：Hono 挂载于 `app/api/[[...route]]/route.ts`，只运行一个 Next.js 实例。Route Handler 仅适配 Request/Response，设备业务由 Hono 模块实现。
- 用户同日明确要求暂不做前端鉴权，先完成功能；按用户 2026-10-24 最新要求，开发与生产启动移除固定 loopback 的 `--hostname` 参数，使用 Next.js 默认监听地址。正式部署与访问控制仍属于 P3。
- 浏览器永远不直接连接 NVR 的管理接口，不接触 Digest 密码或原始 RTSP 凭据。
- 不强制引入数据库：第一版可从设备实时读取，并使用短期内存缓存和会话状态。

## 3. 已确认的设备事实（不是猜测）

- 设备型号：`DS-7816NB-K2/16P`；固件：`V4.30.000`（build `200508`）。
- `GET /ISAPI/System/deviceInfo`：成功；ISAPI 使用 HTTP Digest 认证。
- `GET /ISAPI/ContentMgmt/record/tracks`：成功；出现 `101`、`201` 等轨道。
- 轨道配置可能报告 `<Enable>false</Enable>`，**这不等于没有历史录像**。
- `POST /ISAPI/ContentMgmt/search`：成功；在设备按北京时间查询 `2026-10-17`、轨道 `101` 时获得 **13 段**连续录像及 `playbackURI`，搜索结果报告 `H.264-BP`。
- 同一查询首片段经原样换封装后，ffprobe 实测为 **HEVC / H.265 Main，2560×1440**。搜索编码元数据与真实媒体不一致；不得用搜索字段限制编码支持，播放时读取实际容器编码。用户明确要求同时支持 H.264 与 H.265，保持浏览器本机解码。
- **实测 XML 字段为 `searchResultPostion`**（注意原厂拼写）。不要“修正”为 `searchResultPosition`。该设备成功响应的请求不要求 `metadataList`。
- Mac 上 VLC **可以播放实时 RTSP**：`/Streaming/Channels/101`。
- Mac 上 VLC **尚不能播放历史 RTSP**：`/Streaming/tracks/101/?starttime=...&endtime=...&name=...&size=...`。根因未确认，不能把搜索成功当作历史播放成功。
- 一次早期的 `curl: (52) Empty reply from server` 是请求中忘记替换占位 IP，**不能引用为设备接口不兼容的证据**。

**不要把示例设备地址、账号、完整序列号或录像片段标识写死在代码中。** 所有设备连接参数来自服务端配置。

## 4. Agent 工作方式

每次开始新任务：

1. 阅读本文件、`docs/DEVELOPMENT_PLAN.md`，再检查实际仓库结构与已实现功能；不要假定文件、命令或依赖存在。
2. 将用户任务映射到 P0/P1/P2/P3 中**最小可验证**的工作单元，简要说明计划与验收方式。
3. 先阅读相关代码、已有测试和失败日志，再做最小必要修改；不要为了重构而重构。
4. 每次改动必须考虑正常场景、空结果、网络异常、认证失败、超时、错误输入和资源清理。
5. 执行最相关的测试/类型检查/构建；只有真实执行并通过，才报告“通过”。无法运行时说明环境限制，不虚构结果。
6. 输出：改动文件、关键设计决策、执行过的命令与结果、未解决问题、下一步。必要时更新开发计划的勾选项和验证记录。
7. 不要擅自升级 NVR 固件、修改 NVR 设置、删除录像、覆盖用户文件或执行破坏性的 Git 操作。涉及设备写操作或高风险动作，先征求用户明确授权。

**2026-10-24 用户工作流偏好：** 网页联调与浏览器实测默认使用 Next.js 开发服务器 `pnpm dev` 和热更新；生产构建留到交付前验收，或用于排查生产环境特有问题。若文件监听受沙箱限制，优先处理开发服务器运行环境，避免每轮修改后反复构建。

### 4.1 在合适的时候使用 Skills（必须遵守）

**先判断任务与可用 Skill 的描述是否匹配，再决定是否调用。不要为了使用 Skill 而使用 Skill。**

- 在当前 Codex/Agent 环境**提供 Skills 列表或发现机制时**，先查看可用的 Skill 名称、用途和触发条件；选择与当前任务**最具体、最匹配**的一个或少数几个。
- 匹配时，**先读取对应 `SKILL.md` / `skill.md` 或官方入口指令，然后按其工作流程执行**。如果 Skill 要求使用专用工具、验证步骤或特定输出，遵从该要求。
- 特别留意适用于以下工作的 Skills（**仅在环境中确实存在且任务匹配时使用**）：Next.js/React 前端实现与 UI 评审、Hono/API 设计、TypeScript 测试、浏览器测试、Docker/部署、故障分析、安全审查、开发文档编写。
- 若用户要求生成或编辑 PDF、Word、演示文稿或电子表格，优先检查对应的文档类 Skills；不要把普通 Markdown 文件任务强行归入文档转换流程。
- 若 Skill 不可用、执行环境不满足条件或与当前任务不相关，说明限制并采用可靠的常规开发方式，不因此阻断任务。
- 不要自行创建新的 Skill；只有用户明确要求创建/更新 Skill 时，才按对应工作流处理。
- Skill 不能覆盖用户明确需求、隐私保护、设备只读边界和测试真实性要求。

## 5. 海康 ISAPI 实现约定

- 使用 Hono 服务端持有 NVR 主机、端口、用户名、密码与设备时区；不在客户端或公开日志中暴露。
- Digest 客户端正确处理 `401` challenge、认证重试、超时、响应状态码和异常；设置有限重试和连接超时，避免无限循环。
- XML 解析器必须支持默认命名空间、XML 实体（特别是将 `&amp;` 转换为 `&`）及可选字段；不要用脆弱的正则直接解析 XML。
- 搜索结果可能分页，必须处理 `numOfMatches`、分页偏移、边界重复段和无录像时间段。
- 按用户 2026-10-24 明确要求，录像查询日期、今日日期及时间轴/片段时间显示**默认使用 UTC+8（北京时间，`Asia/Shanghai`）**，仍通过服务端 `NVR_TIME_ZONE` 配置。数据库/接口内部使用 UTC ISO 8601，不能依赖浏览器或容器本地时区。用户随后要求移除时间核对提示并修复时间逻辑；依据设备时钟/当天搜索对照，当前固件默认用 `NVR_RECORDING_TIME_MODE=device-local` 适配带 Z 的设备本地时间，只在搜索接口边界转换，显式偏移保持原义；标准 UTC 固件可设为 `utc`。原始媒体 URI 保持不变；文件开头可能早于查询起点，不能用裁剪后的搜索起点充当媒体锚点。
- `GET /api/recordings` 只返回前端需要的录制时间段、编码和不透明 ID；不得包含原始 `playbackURI`。
- 用户可指定轨道、日期和合法时间范围，但**不得提交任意 RTSP URL 或 NVR 主机**；媒体源只能来自服务端配置和可信的设备查询结果，以防 SSRF。

## 6. RTSP / HLS 排障优先级

当前核心阻塞为 **历史回放**，而不是直播：

1. 保留 ISAPI 返回的**原始 `playbackURI`**作为基线（含尾随斜杠、`name`、`size`）；先验证此 URI 的回放权限和传输行为。
2. 通过 VLC、`ffprobe`/FFmpeg 等工具分层观察 `DESCRIBE`、`SETUP`、`PLAY`、认证挑战、TCP/UDP 传输和错误状态；不要把所有失败都归类为“编码不兼容”。
3. 保证测试的录像片段真实存在、区间正确、设备时间和 UTC 转换正确；核对回放账户权限。
4. **基线失败后**，才逐项测试 URL 变体：尾随 `/`、移除 `name/size`、不同时段、其他设备文档中的回放路径；一次只改变一个变量并记录结果。
5. 先证明某一历史片段能在 VLC 或 FFmpeg 中解码，再实施 Hono 管理的历史播放会话、媒体封装和 Next.js 时间轴 seek。
6. 如果标准 RTSP 回放持续失败，单独调研 ISAPI 录像下载或设备 SDK 的替代方案；未经验证不标记为“支持”。

**2026-10-18 用户追加决定：** 解码留在用户本机。标准历史 RTSP 仍阻塞，但 HTTP 下载已成功读取并通过本机 FFmpeg 解码验证；用户授权先沿此替代路径实现有限文件预览，并明确要求支持 H.264 与 H.265。服务端仅 `-c:v copy` 换封装，视频由浏览器解码；不得自动回退到服务端转码。该例外仅覆盖文件开头最多 30 秒的无声预览，不代表历史 RTSP、全天任意 seek、文件时间映射或 Safari 已通过验收。后续以开发计划和验证记录为准。

**资源约束：** 媒体会话必须设置超时、TTL、并发上限及关闭/切换时的清理；子进程用安全的参数数组启动，不通过 Shell 拼接外部输入；HLS 临时文件设清理和容量边界。

**2026-10-19 用户追加授权：** 取消 HTTP 回放的 30 秒限制，播放整段文件；增加预设/自定义倍速、可拖动进度条，并修复回放声音。允许为整段定位保留受控临时分片，关闭、失败、空闲或 TTL 到期后清理。音视频仍由服务端 stream copy，G.711 在浏览器解码并随倍速/seek 调度。该授权覆盖 HTTP 文件回放，不代表历史 RTSP、全天精确时间映射、跨文件连续回放或 Safari 已通过验收；以上旧的 30 秒无声边界仅描述早期阶段。

## 7. 安全、隐私和日志

- 账号与密钥仅从环境变量 / Secret Store 读取；提交 `.env.example`，绝不提交真实 `.env`。
- 不记录或回传 NVR 密码、Digest `Authorization`、Cookie、原始 `playbackURI`、序列号、MAC 地址或家中视频画面。
- 诊断输出应脱敏：保留请求阶段、错误码、时间、耗时、轨道等必要信息；必要时使用匿名片段 ID。
- API、HLS/WebRTC 播放入口及相关临时资源都需要访问控制；只保护 JSON API 而公开媒体 URL 是不合格实现。
- 不把 NVR 的管理、RTSP 端口或 Hono 内部管理端口直接暴露到公网。
- 对 FFmpeg、URL、文件路径和所有客户端输入做校验及资源限制，防止 SSRF、命令注入、无限进程及磁盘写满。
- 未经用户同意，不把真实设备日志、视频或凭据发往外部服务、公开 issue 或第三方网站。

## 8. 测试与验收纪律

优先编写能在**没有真实 NVR** 时运行的单元与契约测试；需要设备时，明确标记为局域网集成测试：

- Digest 认证：challenge、错误密码、权限、超时、断线及有限重试。
- XML：命名空间、实体解码、成功/空结果、缺失字段、分页、片段重叠与相邻。
- 时间：北京时间 → UTC 日界、夏令时适用地区、零时跨日、片段缺口、不同系统时区。
- Hono：参数校验、稳定错误码、脱敏 JSON、不接受任意 RTSP URL。
- 前端：日期与轨道切换、时间轴缩放/定位、空状态、加载状态及失败提示。
- 媒体：直播成功与否分开记录；历史回放先本地解码、再浏览器验证；反复 seek/关闭后无僵尸进程。

**验收标签：** `已验证（实机）`、`已验证（自动测试）`、`待验证`、`阻塞`。不要把模拟响应测试的通过写成实机通过。每个阶段完成后，更新 `docs/DEVELOPMENT_PLAN.md`：执行日期、命令、摘要结果、遗留风险与下一个可验证步骤。

## 9. 首次交给 Codex 的执行约束

如用户只说“按计划继续”：优先读取当前代码和计划的未完成清单，选择下一个可验证任务，而不是直接实现所有后续功能。默认从 **P0（ISAPI 数据链路 / 录像时间轴）** 与 **P1（历史 RTSP 诊断）** 继续；**P2 历史播放器仍以 P1 成功为前置条件**。

给用户汇报时，使用中文，明确区分「实测事实」「代码已实现但未联调」「推测与排障假设」。遇到无法继续的技术阻塞，保留已完成部分、提交可复现信息并指出最小的下一步验证动作。
