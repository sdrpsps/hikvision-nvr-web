# P0 / P1 验证记录 — 2026-10-18

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

## 备选方案研究，未接入

厂商公开说明提供搜索结果 URI 用于录像文件下载的流程；SDK 提供按时间回放并通过回调获取码流的能力。这些是候选途径，不能自动推断本型号/固件/平台可用：

- [Hikvision 搜索和下载 NVR 录像说明（PDF）](https://www.hikvisioneurope.com/eu/portal/portal/Technology%20Partner%20Program/03-How%20to/How%20to%20search%20and%20download%20the%20video%20file%20from%20NVR%20via%20ISAPI.pdf)
- [官方 SDK：NET_DVR_PlayBackByTime_V40](https://open.hikvision.com/hardware/definitions/NET_DVR_PlayBackByTime_V40.html)
- [官方型号级 ISAPI / OTAP 文档入口](https://tpp.hikvision.com/download/ISAPI_OTAP?type=1)，部分材料需合作伙伴权限；本轮未签署协议或申请账户。

本轮仅执行了只读 `GET /ISAPI/ContentMgmt/download/capabilities`，实机报告：

```json
{ "byTime": false, "byFileName": true }
```

**实际下载、HTTP 码流解码、SDK 集成均待验证。** 下载能力声明不等于已可替代浏览器播放。本轮未尝试下载视频，也未引入 SDK。

## 阶段门槛与下一步

P0 的基础实现和指定 13 段样本验收已完成，设备时间语义和 Safari 仍待验证。P1 历史解码、任意指定时间回放仍阻塞；P2/P3 保持未实施。

最小下一步：在设备原生客户端确认同一日期/轨道可回放，核对当前账户的回放权限，并对照一处可信录像时间；同时可单独验证按文件名下载的有限读取/解码路径。不要升级固件或修改配置来掩盖当前证据，也不要仅凭搜索或直播成功进入历史 Web 播放集成。
