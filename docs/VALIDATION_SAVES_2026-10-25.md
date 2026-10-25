# 浏览器录制与选区下载验证 — 2026-10-25

## 范围与最终行为

本次实现实时手动录制、当前历史文件的 A/B 选区导出，以及浏览器增量文件写入。服务端不为这些保存任务落盘或生成成品：历史源通过 Digest 代理直接传给浏览器；实时源由 FFmpeg 复制编码音视频并做 RTSP/HTTP 协议桥接，浏览器 Worker 负责解析、选区及 MKV 封装。现有历史回放用于 seek 的服务端临时缓存仍按原实现运行，不能将保存链路不落盘写成全部回放均不落盘。

界面使用现有 shadcn/Base UI 体系，根布局挂载保存 Provider。实时窗口录制固定原通道；通道/布局切换、停止预览、应用内实时/回放导航不终止录制，也不弹窗打断。同一页面会话中的重复窗口共用任务，用户通过全局“录制与下载”查看或停止，最多四个活动任务。录制可选择 15 / 30 / 60 分钟（默认 30），支持文件夹时约每五分钟在关键帧处完成分段；单文件及原生下载方式保存一个文件。

回放“下载片段”支持文件内部 A/B 标记、时间输入、已知总长时的范围拖动、前后各扩展三十秒。保存原始 H.264 / H.265 视频与受支持的 G.711 A-law / μ-law，保持原速和源音轨。观看倍速、暂停、静音和全屏不影响输出。原码裁剪从可解码关键帧开始，结束到后续关键帧边界；任务显示所选范围与实际覆盖，不能承诺逐帧切点。

文件选择在读取媒体前完成；取消选择器不建立媒体连接。失败、取消、用户停止、正常完成及部分保存分开报告。浏览器写入失败/传输中断后尝试完成可用内容并释放上游；后续分段写入失败时保留此前已提交的文件，并将最终实际覆盖回退到其末端。任务完成列表移除不删除磁盘文件。

MPEG-PS 声明尚不支持的音轨，或音轨晚到而未写入成品头部时，保留可用视频并标记部分保存，明确提示“音轨未保存”。

音轨超前时，Worker 保留尚未对应到视频的样本，让它们进入下一段；音轨滞后时，暂存后续视频并最多等待三秒覆盖切点。手动停止固定已接收视频的结束点，只继续补齐对应音频，忽略停止后抵达的新视频，期间保持 `stopping`。等待、视频暂存与超前音频都有容量/时间上限；尾音不足保留可用内容并标记部分保存。

历史成品文件名显式包含查询日期及“文件内”起止时间，以免将相对偏移误认为绝对钟表时间。该命名及界面选区都不代表按北京时间精确裁剪。

## 实现文件

- `components/browser-save-provider.tsx`：根级任务生命周期、重复通道约束、任务列表和实时录制入口。
- `components/clip-export.tsx`：当前文件选区编辑与参数检查。
- `lib/browser-save/runner.worker.ts`：增量取流、媒体时间选区、原速封装、分段、实际覆盖及异常收尾。
- `lib/browser-save/destination.ts`、`public/browser-save-sw.js`：File System Access 写入及同源自托管 Service Worker 原生下载回退。
- `lib/media-export/`：MPEG-PS/PES/NAL、fMP4/MOV 增量读取及 MKV 原码封装。
- `server/transfer.ts`、Hono `/api/transfers/*`：可信源校验、Digest 代理、实时复制、背压、取消、TTL 与容量边界。

历史代理不向客户端暴露 `playbackURI`、主机或凭据；实时入口仅接受可信通道 ID。两个入口保留同源检查，不接受任意媒体 URL。四个连接共享并发上限，源最多 8 GiB，三十秒无推进取消；历史 TTL 三十分钟、实时 TTL 两小时，实时启动最多二十秒。客户端另按录制选择限制时长。

## 自动测试与检查

Safari 握手修复前的源码执行 `pnpm test`：**15 个测试文件、205 项通过（1.94 秒）**；`pnpm typecheck`、`pnpm lint`、`pnpm build`、`git diff --check` 均通过。该阶段构建为 Next.js 16.4.1 / Turbopack，编译 615 ms、TypeScript 1516 ms、静态生成 5/5。Safari 握手、版本校验及看门狗修复后的自动检查，以及后续 UI 回归，分别记录在本文后续章节，不将此前结果视为最新源码的单次完整回归。

媒体引擎 13 项、保存 Worker 18 项回归包含：H.264 / HEVC、G.711、PTS/DTS、跨网络块及跨 PES NAL、B 帧、前置 IMKH、首关键帧缺失、磁盘失败、缓冲上限、时长及定位。音轨超前/滞后分别覆盖 300 秒切段及 303 秒限时；每段实际音频样本、首尾覆盖、内部及跨段 gap/overlap 均独立核对。手动停止固定视频终点、补齐尾音、三秒超时、保持 `stopping`、历史提前停止及已提交文件范围回退均有覆盖。

MPEG-PS 私有流中的 AAC / G.726 等已知不支持音轨会明确标记，不把私有元数据误报为音轨。实时桥接只在服务端内部有界解析首输入音轨：分类前最多等三秒、暂存 1 MiB；只放行 `pcm_alaw` / `pcm_mulaw`，其他编码或音频 slave 失败发脱敏 `unsupported` 状态，保留视频并标记部分保存。源确实没有音轨时不误报，原始 FFmpeg stderr 不记录、不回传，预览默认行为不变。transfers + live 相关 28 项回归含真实 FFmpeg 的纯合成媒体对照。

服务端提前 TTL 结束会保留可用内容并标记 `partial`，无有效视频为 `failed`；客户端已达到预设终点后，同块到达的服务器结束状态不反向改为失败。三个对应回归先复现错误，再验证修复。

完整 Chrome 回归执行：

```sh
TEST_BASE_URL=http://localhost:3102 NVR_INTEGRATION=0 \
  RUN_NVR_SAVE_TESTS=0 RUN_NVR_LONG_SAVE_TESTS=0 \
  pnpm exec playwright test --workers=1 \
  --output=/private/tmp/hikvision-browser-final-aligned
```

结果：**51 项通过、7 项实机专用用例未启用，1.9 分钟**。七项未启用为原三项设备场景、三项保存短测及一项十五分钟长测，真实保存结果另见下节。随后仅修改服务端 TTL 结束的 Worker 异常分支，再定向执行当前保存场景：

```sh
TEST_BASE_URL=http://localhost:3102 NVR_INTEGRATION=0 \
  RUN_NVR_SAVE_TESTS=0 RUN_NVR_LONG_SAVE_TESTS=0 \
  pnpm exec playwright test tests/browser/saves.spec.ts --workers=1 \
  --output=/private/tmp/hikvision-save-timeout-final
```

结果：**7 项通过，20.5 秒**。完整套件与最后异常分支回归的代码阶段分别记录，不把分开运行伪称为最后源码单次完整回归。

完整回归前曾观察到 HEVC 合成源时基失配：视频 PTS 为 `1/6 → 3+1/6` 秒，G.711 原为 `0 → 3` 秒，因此尾音不足应报告部分保存。仅在测试源中偏移音频 `tfdt`，保留视频 B 帧和源负载；最终 HEVC 用例验证三秒成品、23,999 个实际 G.711 样本，以及音频首尾、内部 gap/overlap ≤2 ms，未放宽产品完整性检查。另一次手机页启动出现开发态 `Unexpected end of JSON input`，随后该场景连续三次通过，最后完整套件也通过；未复现其根因，没有据此修改业务代码。

浏览器用例位于：

| 文件 | 验证内容 |
| --- | --- |
| `tests/browser/saves.spec.ts` | 真实 Worker/文件句柄写入；换通道/布局/路由/停止预览继续；重复窗口；双编码与 G.711；后台 tab；刷新离开提示取消后继续、完成后不再提示；选择器取消；磁盘异常；A/B、倍速及静音独立性 |
| `tests/browser/stream-save.spec.ts` | 自托管 Service Worker 原生下载精确 16 MiB 及 hash、单块背压、未读取时暂停、取消/释放生产者 |
| `tests/browser/saves-device.spec.ts` | 显式开启真实 NVR 的录制、选区、原生下载和十五分钟自然结束；禁用 trace、截图及视频产物 |

Safari 排查期间另增加生产 SW 的延迟端口交接、显式 `writer-ready` 与单块额度回归，媒体 Worker 启动确认、启动/停止无回应看门狗，以及旧 SW 回执缺少协议版本的提前失败检查。新协议在 `started` 后等待真正的媒体写入端接管，再授予写入额度，不新增媒体缓存；SW 登记回执校验 `protocol: 2`，注册 URL 带版本并设置 `updateViaCache: 'none'`。修复后的全仓 209 项单测、Chrome 保存专项 14 项及生产构建两项保存浏览器验收均通过，具体命令与范围见最终复核。

自动化选择器返回 OPFS 的真实 `FileSystemFileHandle` / `FileSystemDirectoryHandle`，后续 Worker、`createWritable`、磁盘写入及关闭均为浏览器原生实现。替代的是需要人在桌面选择路径的 UI；这批自动化本身不覆盖操作系统目录选择与授权交互。后续另在普通 Chrome 原生界面完成目录选择/授权、单文件“另存为”和真实成品核验，见本文末尾的原生界面补测。短测和长测提取均按明确的 256 KiB `File.slice` 读取，等待当前块写入私有临时文件后才读取下一块，不构建整文件数组、base64 或媒体 Blob；生产链路本身也不做整文件缓存。

## Chrome 真实设备端到端

最终短测：

```sh
RUN_NVR_SAVE_TESTS=1 RUN_NVR_LONG_SAVE_TESTS=0 TEST_BASE_URL=http://localhost:3102 \
  pnpm exec playwright test tests/browser/saves-device.spec.ts --workers=1 \
  --output=/private/tmp/hikvision-short-save-device-results-final-2
```

结果：**3 项通过、1 项长测未启用，29.2 秒**，使用现有 `pnpm dev` 实例。两项 OPFS 短测实际覆盖多个 256 KiB 切片的读取和顺序写盘，先验证最终长测共用的提取工具。

| 场景 | 保存结果与验收 |
| --- | --- |
| 实时录制后切换视图、非 GOP 边界停止 | 成品 12.52 秒；原通道任务继续，HEVC 2560×1440 + `pcm_alaw` 8 kHz 单声道 |
| 回放 4×/暂停后的 OPFS 选区 | 当前文件内选区，成品 7.999999 秒；保留原速 HEVC 与 G.711 |
| Service Worker 原生下载回退 | 浏览器下载器生成成品，媒体时间范围 8 秒；HEVC 与 G.711 均保留 |

三条路径均经 ffprobe 检查容器/轨道、FFmpeg `-xerror` 全片音视频解码到 null，未展示或保存解码画面及声音。结束后活动 transfer、新增 FFmpeg、私有真实媒体均归零，OPFS 及下载文件按测试 finally 清理。人工听音未执行，不将解码和时间戳通过扩写为人工听音验收。

Service Worker 为顺序 writer，MKV 省略无法回填的最终 Duration 字段；八秒范围按实际 packet 时间核验，不保证所有播放器立即显示总长或具有相同定位体验。可 seek 的文件句柄会回填最终时长。媒体引擎细节见 [媒体引擎记录](./VALIDATION_EXPORT_ENGINE_2026-10-25.md)。

## 真实十五分钟自然结束及分段

```sh
RUN_NVR_SAVE_TESTS=0 RUN_NVR_LONG_SAVE_TESTS=1 TEST_BASE_URL=http://localhost:3102 \
  pnpm exec playwright test tests/browser/saves-device.spec.ts --workers=1 \
  -g 'fifteen-minute live recording' \
  --output=/private/tmp/hikvision-long-save-device-results-final-2
```

结果：**1 项通过，17.4 分钟**。真实 UI 选择十五分钟，没有点击停止，由产品自然结束；约第 902 秒报告 `complete`，之后完成全部成品提取、解码、逐包核对和清理，总验证墙钟时间为 1040.972 秒。

| 检查项 | 实测结果 |
| --- | --- |
| 文件与媒体长度 | 恰好三段，每段 300 秒，总计 900 秒 |
| 视频 | 每段 HEVC 2560×1440，FFmpeg `-xerror` 全片解码通过 |
| 视频连续性 | 首尾包 SHA-256、PTS、关键帧与源匹配；源覆盖 900 秒，跨段间隔 ≤2 ms |
| 音频 | 每段 `pcm_alaw`、8 kHz 单声道，起止均为 0 → 300 秒 |
| 实际音频样本 | 每段 2,400,000，总计 7,200,000 |
| 音频跨段间隙 | 两处分段均为 0 |
| 音频段内 gap/overlap | 约 `5×10⁻¹⁴` 秒，仅浮点误差；满足 ≤2 ms |
| 源视频包 / 接收字节 | 22,513 包 / 69,180,346 B |
| 成品写入 | 69,203,651 B |
| 结束后的资源 | 活动传输 0、新增 FFmpeg 0；finally 后独立复核 FFmpeg 总数 0、私有媒体目录 0 |

录制过程中没有后续导航、崩溃或开发刷新。约第 1042 秒的导航/HMR 出现在全部成品断言通过后的 finally 清理中。真实媒体只经过 OPFS 和权限 0700/0600 的私有临时目录，均已清理。

此前一轮同样自然录满 900 秒、三文件，但成品提取时 Chrome 的 `File.stream()` 单次返回约 1.94 MiB，超过测试工具假定的 1 MiB；该轮没有完成解码及连续性验收，不能计为通过。之后只修测试提取为明确的 256 KiB 切片，先经三短实机验证，再获得上述完整长测通过结果。另一次早期尝试约三分钟时页面重载，原因未确认；最终两轮全仓冻结录制均自然完成，最终验收不依赖早期失败。

## 合成界面与文件末尾边界复核

真实安装的 Chrome 中，分别以桌面 1280×900 和手机 390×844 检查录制 popover、任务面板及选区导出，共六种视图。全部使用独立合成通道、媒体及模拟 Worker，不连接真实设备、不包含真实画面或音频。源码冻结后等待面板 `opacity=1`，以禁用动画的截图模式拍摄，再逐张用图像查看工具检查。

| 面板 | 桌面面板尺寸 | 手机面板尺寸 | 结果 |
| --- | --- | --- | --- |
| 录制 popover | 288×220 | 288×220 | 完全位于 viewport |
| 任务面板 | 400×261.375 | 366×261.375 | 完全位于 viewport |
| 选区导出 | 400×458.75 | 366×458.75 | 完全位于 viewport |

六种视图均无页面横向溢出；输入框、15 / 30 / 60 分钟选项、开始/停止和保存按钮完整可见，长通道名适当换行或截断，未出现 `pageerror`。六张合成截图仅保留于 `/tmp/hikvision-save-ui-{desktop,mobile}-{record-popover,task-panel,clip-export}.png`，不加入仓库。模拟 Worker 的截图只证明视觉布局，文件保存仍以上述真实 Worker / File System API 和实机测试为准。

文件末尾的小数秒边界另经 Chrome 定向回归，一项通过：已知文件总长 2.2 秒、位置 2.1 秒时标记终点，输入展示可取整到 3 秒；向后扩展三十秒仍限制为 3，输入 4 会提示越界，最终提交给真实 Worker 的 `source.endSeconds` 为 2.2。该用例继续走真实 Worker + OPFS 写入，避免显示取整造成文件末端无法导出。

```sh
TEST_BASE_URL=http://localhost:3102 pnpm exec playwright test tests/browser/saves.spec.ts \
  --grep 'fractional file end' --workers=1 --output=/tmp/hikvision-save-fractional-tests
```

结果为 **1 项通过，4.6 秒**。视觉复核使用本机临时脚本 `node /tmp/review-save-ui.mjs`，未将该临时脚本或截图加入仓库。

## Safari 实测与兼容范围

**已验证（实机）：系统 Safari 27.0.1 在实际应用中完成实时录制、当前历史文件 A/B 选区下载和原生下载取消后的清理。** 使用安全上下文、生产 Service Worker 与真实媒体 Worker，由 Safari 下载器增量写入本机；下载列表与实际成品分别核对，未用独立 WebKit 代替原生应用验收。

| 场景 | 实测结果 |
| --- | --- |
| 实时录制并手动停止 | 113.56 秒，18,939,999 B；HEVC 2560×1440 + `pcm_alaw` 8 kHz 单声道 |
| 实时成品音视频范围 | 视频 2,839 包，PTS 0 → 113.56 秒；音频 1,439 包，PTS 0 → 113.56 秒 |
| 录制不中断 | 录制中切到通道 201、单路布局、`/playback`，再切普通浏览器后台 tab 约数十秒，原任务继续并完成 |
| 历史选区 | 查询日期 2026-10-25 的第二文件，文件内 A/B 0 → 8 秒；581,278 B，UI 实际覆盖 0 → 8 秒 |
| 历史成品音视频范围 | 视频 200 包，PTS 0 → 8 秒；音频 393 包，PTS 0.139 → 8 秒；HEVC 2560×1440 + `pcm_alaw` 8 kHz 单声道 |
| 原速与音轨 | 播放器 4× 已由辅助功能树确认选中，暂停且静音时导出仍保持原速与源音轨 |
| 文件完成确认 | 下载列表显示 18.9 MB、581 KB，均已完成；两个成品均经 FFmpeg `-xerror` 全片音视频解码通过 |
| 原生下载取消 | 下载列表停止另一次约 4.1 MB 的实时下载后，应用提示“下载已取消或磁盘无法继续写入。”并进入终态，无 FFmpeg 遗留；历史回放随后也已关闭，确认无 FFmpeg |

早期实际应用曾在媒体读取前等待 `started` 超时，后因桌面锁定暂停排查；解锁后又观察到目的地已返回、媒体写入等待超时的不同失败。可复现的首个 `pull` 端口交接竞态已通过显式 `writer-ready` 修复。新握手的原生 Safari 独立源及实际应用同源 32 KiB 合成下载通过，包含延迟 200 ms 转移端口及关闭已转移原端口的对照；同源临时 fixture 加载真实 Webpack 媒体 Worker 后，生产 SW + NVR 十秒保存得到 1,475,444 B、HEVC/G.711 成品，全片解码通过。随后增加 SW 协议版本守卫，取得上表实际应用结果。

最初 `started` 超时根因仍未确认；“首次新握手重试仍由旧 active SW 响应”保持为排障假设，没有因最终成功而反向认定根因。此前独立 Playwright WebKit 27.2 的 32 KiB 分层成功仅是独立引擎证据。完整过程见 [Safari 流式保存诊断](./SAFARI_STREAM_SAVE_2026-10-25.md)，临时公开诊断文件已移除。

顺序 MKV 无法回填最终 Duration，媒体范围按 packet 时间核验，部分播放器显示总长及定位的兼容性仍有限制。不能仅凭 SW `closed` 消息声称最终磁盘提交，本次另经下载列表和实际成品确认。Safari 长时间/多路保存、真实休眠或崩溃、人工听音及内存峰值仍待验收；Edge 及其他浏览器的系统文件选择交互也未因此通过。文件直写和 Service Worker 均要求安全上下文，正式局域网访问需 HTTPS，本机 localhost 可开发验证。

## 时间、资源与生命周期边界

- 当前选区使用首视频 PTS 为零点的文件内相对时间。真实源首 PTS 非零、搜索区间会被查询边界裁剪；绝对钟表锚点仍未获独立对照，因此**没有开放按北京时间精确输入或跨文件/跨日导出**。三份真实源的结构调查见 [媒体时钟记录](./MEDIA_CLOCK_2026-10-25.md)。
- 设备按整文件顺序下载时，浏览器仍需接收并丢弃选区前的数据。增量写入避免完整内存缓存和服务器成品，不保证 NVR 到客户端的总流量仅等于选区。
- 媒体启动缓冲最多 16 MiB、超前音频最多 2 MiB、稀疏索引最多 2048 项；选区保留的关键帧范围最多 32 MiB。超前音频只写到已接受视频结束处，避免实时 GOP 延迟时成品出现多余音频尾巴。
- 流式写入仍会使用浏览器/操作系统缓存。File System API 可先写本机临时磁盘文件，关闭后提交；不声称零内存、零缓存、浏览器崩溃也能恢复未完成分段。
- 实时保存连接的视频 fMP4 约每 0.5 秒输出分片，缩短手动停止时尚未抵达浏览器的尾部；预览连接保持原有封装策略。停止保留已收到的完整可用媒体，不承诺停止点击精确到帧。
- 应用内路由切换不等于浏览器页面关闭。真正关闭/刷新网页时才尝试触发浏览器原生 `beforeunload` 提示；页面冻结、电脑休眠、浏览器退出也可能中断。提示是否显示及 `pagehide` 收尾均受浏览器控制，Worker 不能保证浏览器后台永久存活。
- 十五分钟单路自然结束和两次五分钟真实分段已经验证；三十/六十分钟、多路长时保存、系统磁盘写满、真实休眠/崩溃恢复、人工听音及内存峰值仍待验证。

## 最终复核

下表的自动检查、Chrome 保存专项及原生 Safari 为握手和协议版本修复后的结果；完整 Chrome 回归、短实机和十五分钟长测保留此前阶段证据，按实际执行范围分别列示。

| 检查 | 结果 |
| --- | --- |
| `pnpm test` | **已验证（自动测试）**：16 文件、209 项，2.31 秒；含真实 MessageChannel 延迟交接、重复 ready 不增加额度、新旧 SW 版本不符释放及 Worker 启动/停止超时 |
| `pnpm typecheck` / `pnpm lint` | 通过 |
| 差异及新增文件空白检查 | `git diff --check` 通过；另对 27 个未跟踪文件执行 `git diff --no-index --check /dev/null <file>`，无空白错误 |
| `pnpm build` | 通过：编译 713 ms、TypeScript 2.2 秒、静态生成 5/5 |
| 修复后 Chrome 保存/流式下载专项 | 14/14 通过，28.6 秒；使用开发服务器 `localhost:3102`，覆盖两种编码/音轨、跨通道/路由/后台、刷新取消、磁盘失败、A/B、原生下载、背压/取消及线程无响应期限 |
| 生产构建浏览器验收 | `pnpm start --port 3104` 后运行 HEVC/G.711 文件保存及原生流式下载两项合成场景，2/2 通过，5.5 秒；实际 JS Worker 引导和 chunks、文件解码及原生下载完成均通过，不将旁路 `.ts` URL 资产误判为 Worker 入口 |
| 此前完整 Chrome 回归 | 51 通过、7 实机未启用，1.9 分钟；TTL 异常分支补充后保存场景再 7/7 通过，20.5 秒 |
| 此前 Chrome 最终短实机 | 3 通过，29.2 秒：12.52 秒实时、7.999999 秒 OPFS 选区、8 秒原生下载 |
| 十五分钟单路录制 | 1 通过，17.4 分钟：3×300 秒；全片解码、音视频逐包连续性及 7,200,000 个音频样本通过 |
| 结束清理 | 活动传输 0、新增 FFmpeg 0；独立复核 FFmpeg 总数 0、私有真实媒体目录 0 |
| 原生 Safari | **已验证（实机）**：实际应用录制 113.56 秒/18,939,999 B，选区 8 秒/581,278 B，HEVC/G.711 全片解码、切通道/布局/路由/短时后台 tab 与原生下载取消清理通过 |

本轮真实 Safari 成品和取消残片已按精确任务文件名删除；临时诊断服务器、公开静态 fixture 已移除，私有回放目录文件/子目录及 FFmpeg 数均为 0。没有删除用户原有下载。

此前曾在普通 Chrome 独立标签页尝试系统目录选择，但未取得目录授权与成品的完整证据；那次临时标签页和空目录已清理。后续已通过原生目录选择/授权、单文件“另存为”及成品核验，证据见本文末尾，不将早期尝试计为通过。

Safari 长时间或多路保存、三十/六十分钟与多路真实长录制、冻结/休眠/崩溃恢复、人工听音、内存峰值和绝对钟表时间选区仍按本文边界待验。Safari 已通过范围以原生实际应用及成品核验为依据，没有将独立 WebKit 或 Chrome 成功替代 Safari 验收。

## 录制与下载的状态反馈及控件对齐

2026-10-25 按用户反馈调整 P2 保存界面：

- 录制设置和 A/B 下载设置从 popover 改为可用 Escape 关闭的对话框；任务详情改为独立侧栏，活动任务优先排列。取消设置不创建任务，关闭详情保持原任务继续。
- 实时页和回放页在导航下方常驻显示进行中的任务，录制显示红色状态/计时，下载显示主题色状态/写入量；读取选区前的数据时显示读取量。可以直接停止并保存，收尾时禁用重复操作；结果和失败保留可关闭的提示。移除会滞留的启动通知，避免已开始录制后仍显示“准备录制”。
- 直播视频表面持续显示录制状态与计时。全屏表面提供任务入口，任务侧栏和片段设置对话框使用当前全屏容器，避免打开到不可见的页面背景。最后一个任务结束后保留“保存已结束 / 保存异常”和查看结果入口，其他任务仍活动时也标明既有异常。
- 顶部任务入口与导航同为 36px；直播录制与通道选择框同为 28px。下载触发器使用稳定的控件类匹配窄容器规则，避免 Base UI trigger 的 `data-slot` 覆盖使其无法缩为 28px 方按钮。
- 新增四项合成媒体浏览器测试：常驻录制与跨路由、常驻下载与关闭详情、390px 控件对齐/对话框边界、全屏标记及 portal。原停止超时用例增加“收尾中”和按钮禁用检查。Chrome 定向测试均通过，桌面/手机/侧栏/下载对话框合成截图已目视检查；截图与动画等待仅用于诊断，未保留在测试中。

最终检查：

| 命令 | 结果 |
| --- | --- |
| `pnpm test` | 16 文件、209 项通过，1.82 秒 |
| `pnpm typecheck`、`pnpm lint` | 通过 |
| 改动 TS/TSX 的 `pnpm exec prettier --check`、`git diff --check`、5 个新增 UI/测试文件的独立空白检查 | 通过 |
| `TEST_BASE_URL=http://localhost:3102 NVR_INTEGRATION=0 RUN_NVR_SAVE_TESTS=0 RUN_NVR_LONG_SAVE_TESTS=0 pnpm exec playwright test --workers=1 --output=/private/tmp/hikvision-save-ui-final-results` | **已验证（自动测试）**：57 通过、7 设备测试未启用，2.0 分钟；覆盖本轮四项 UI 场景及既有查询、播放、16 路生命周期、保存/流式下载和清理 |
| `pnpm build` | 通过：编译 1294 ms、TypeScript 2.1 秒、静态生成 5/5 |

该次完整自动回归仅使用模拟 API 和合成媒体，没有读取或截取真实监控画面；随后补充的原生浏览器真实源验证单独列在下文。

## 四路保存并发与独立停止

**已验证（自动测试，合成素材）**：在既有 57 通过、7 设备测试未启用的完整回归之后，新增一项四路并发测试，并单独执行；没有声称重新完成 58 项全量回归。

```sh
TEST_BASE_URL=http://localhost:3102 NVR_INTEGRATION=0 \
  RUN_NVR_SAVE_TESTS=0 RUN_NVR_LONG_SAVE_TESTS=0 \
  pnpm exec playwright test tests/browser/saves.spec.ts --workers=1 \
  -g 'four concurrent saves' \
  --output=/private/tmp/hikvision-save-concurrency-results
```

结果：**1/1 通过，测试 7.7 秒、总计 8.8 秒**。四个真实媒体 Worker、四个 OPFS 文件句柄与四个源连接同时工作；第五项历史导出在创建源与任务前被拒绝。单独停止通道 2 后，其余三个任务继续保存且未重连；停止全部后四项均完成、源连接归零。四份三秒 H.264/G.711 成品分别经 ffprobe 和 FFmpeg `-xerror` 全片解码通过。针对测试文件的 lint、Prettier 与差异空白检查通过。

## 新保存界面的原生浏览器补测

使用 `http://localhost:3102` 开发实例、真实 NVR 源和本机原生 Safari/Chrome 界面，未拍摄监控画面或录制桌面影像。媒体只在本机核验，不上传第三方。下列结果补充对话框、侧栏、常驻状态条和系统选择器的实际交互证据；不扩大为绝对钟表选区、跨文件下载、原生 Safari 全屏或 Chrome HEVC 播放验收。

| 场景 | 实测结果 |
| --- | --- |
| Safari 27.0.1 新录制对话框 | 从新对话框启动真实录制，常驻状态条由准备转为录制，计时与写入量推进；打开/关闭任务侧栏及实时→回放导航后仍继续，通过常驻条停止并显示结果，原生下载列表显示完成 |
| Safari 本机录制成品 | 8,987,236 B；HEVC 2560×1440 + `pcm_alaw` 8 kHz 单声道；视频及音频 PTS 均为 0→75.64 秒，FFmpeg `-xerror` 全片解码通过 |
| Safari 新下载对话框 | 暂停/静音的历史文件内输入 0→6 秒后启动下载；常驻条显示下载状态，关闭回放不影响独立导出；任务侧栏显示选择 0→6、实际 0→8 秒 |
| Safari 本机选区成品 | 581,278 B；HEVC + `pcm_alaw`；视频 0→8 秒，音频 0.139→8 秒，FFmpeg `-xerror` 全片解码通过 |
| Chrome 原生目录选择与授权 | 在原生系统目录选择器中选择新建的专用临时目录，并完成仅针对该目录的修改授权；未用 OPFS 替换选择器。录制进行中本机临时 `.crswap` 文件增长，停止后成品提交，临时交换文件为 0 |
| Chrome 本机录制成品 | 3,617,036 B；HEVC 2560×1440 + `pcm_alaw` 8 kHz 单声道；视频及音频 0→29.56 秒，FFmpeg `-xerror` 全片解码通过 |
| Chrome 原生单文件“另存为” | 在新下载对话框输入文件内 0→6 秒，使用真实 `showSaveFilePicker` 系统保存面板写入同一专用目录；关闭回放后下载独立完成，页面显示“已保存到本机硬盘” |
| Chrome 本机选区成品 | 581,289 B；HEVC 2560×1440 + `pcm_alaw` 8 kHz 单声道；视频 0→8 秒，音频 0.139→8 秒，实际覆盖按关键帧扩展；ffprobe 及 FFmpeg `-v error -xerror` 全片解码通过，临时交换文件为 0 |

核验后精确删除本次新生成的两份 Safari 下载文件、两份 Chrome 临时目录内成品及其专用空目录；未触及其他下载文件。通过 Chrome 工具栏的文件访问提示撤销本次文件和目录权限，图标消失后关闭自建验收标签页。两浏览器均已关闭回放，独立进程检查确认 FFmpeg 为 0。最终 `pnpm typecheck`、`pnpm lint` 和 `git diff --check` 再次通过。

## 操作提示统一为 Sonner

按用户要求安装 `sonner@2.0.8` 并接入项目主题。成功、部分保存、失败、并发超限和重复录制使用对应类型的 toast，提示带通道和“查看任务”操作，可关闭；成功默认 7 秒，警告和错误 12 秒。原结果提示条及其重复消息移除，进行中的常驻状态条、任务详情里的状态记录和全屏结果入口保留。全局仅一个 Toaster，通过移动稳定 Portal 宿主进入/退出全屏，避免通知重复或重置计时。

最终 `pnpm build` 通过：编译 1573 ms、TypeScript 3.3 秒、静态生成 5/5；改动 TS/TSX 的 Prettier 检查通过。

**已验证（自动测试，合成素材）**：`TEST_BASE_URL=http://localhost:3102 NVR_INTEGRATION=0 RUN_NVR_SAVE_TESTS=0 RUN_NVR_LONG_SAVE_TESTS=0 pnpm exec playwright test tests/browser/saves.spec.ts --workers=1 --output=/private/tmp/hikvision-sonner-results`，14/14 通过，43.5 秒。覆盖成功 toast 打开任务侧栏、两个 Worker 超时错误提示、第五项并发限制警告、全屏内 toast 可见且属于全屏容器、退出全屏仍可见且仅有一个 Toaster，以及既有保存与清理场景。`pnpm typecheck`、`pnpm lint`、`git diff --check` 通过；本轮没有读取真实 NVR，也没有重新验收原生 Safari。首次 Chrome 在文件系统沙箱内启动被系统终止，改为沙箱外运行同一专项后通过。

## 录制、下载及播放界面信息精简

删除活动条重复的任务计数标题和任务入口，导航保留统一入口与活动数量；每项任务仍持续显示通道、状态、进度和停止操作。任务类型合入标题行，历史下载等待写入时显示读取进度，写入后只显示成品指标；所选范围与实际范围相同时不再重复列示。仅过滤已知的普通状态说明，错误、部分保存、音轨异常及浏览器原生下载确认保留。

任务侧栏仅在有活动任务时提示保持网页开启和避免休眠。录制设置去除质量、到时结束和手动停止的重复解释，分段说明按当前目录选择能力显示；下载设置删除整文件顺序读取等实现细节，保留当前文件相对时间、原速和源音轨、实际范围可能扩展的简短说明。

播放页只保留画面中央的加载状态及取消操作，移除底部重复说明、时间轴旁常驻操作提示和无缺口切段成功说明；录像缺口、末尾及失败提示保留。沿用并调整已有测试断言，没有为文案变更新增测试。

**已验证（自动测试，合成素材）**：临时 Playwright 配置继承仓库配置，仅将合成页面截图设为 `on`；执行 `TEST_BASE_URL=http://localhost:3102 NVR_INTEGRATION=0 RUN_NVR_SAVE_TESTS=0 RUN_NVR_LONG_SAVE_TESTS=0 pnpm exec playwright test --config=/private/tmp/hikvision-density.config.ts --workers=1 --output=/private/tmp/hikvision-density-results`，完整 58 通过、7 实机未启用，2.2 分钟。覆盖录制/下载/任务入口、全屏通知、窄屏对齐、单一加载状态与取消、连续播放及既有媒体清理。合成页面截图检查未见重复加载或布局溢出。`pnpm typecheck`、`pnpm lint` 通过；本轮未读取真实设备，也没有重新进行 Safari 实机验收。

最终改动 TS/TSX 的 Prettier 与 `git diff --check` 通过；生产构建通过，编译 923 ms、TypeScript 2.6 秒、静态生成 5/5。

## 录制入口辨识与导航配色

实时入口由空心圆图标改为 REC 圆点图标配“录制”，活动时显示停止图标和“停止”，收尾显示加载图标和“收尾”并禁用重复操作。按钮保持 28px 高。查看首轮 16 分屏合成截图后，发现常驻文字明显压缩通道名称，因此对不超过 192px 的小窗仅显示图标，并保留完整悬停提示及辅助技术名称；宽窗与手机单列保留短文案。

顶部任务按钮和导航共用默认、悬停与选中配色。任务数量仍由 Badge 表达；打开侧栏时 `aria-expanded=true` 并使用选中配色，关闭后恢复默认，活动数量不再独立改变整颗按钮底色。已有布局测试补充逐格不溢出、按钮高度、下拉不被遮盖和宽度对应文案显示；既有 390px 用例补充浅色/深色主题下的默认、展开及恢复配色比较，没有新增测试用例。

**已验证（自动测试，合成素材）**：使用开发服务器和此前临时截图配置，执行 `TEST_BASE_URL=http://localhost:3102 NVR_INTEGRATION=0 RUN_NVR_SAVE_TESTS=0 RUN_NVR_LONG_SAVE_TESTS=0 pnpm exec playwright test tests/browser/live.spec.ts tests/browser/saves.spec.ts --config=/private/tmp/hikvision-density.config.ts --workers=1 --output=/private/tmp/hikvision-record-entry-final-results`，24 通过、1 项实机测试未启用，1.2 分钟。覆盖桌面/手机的 1/2/4/8/16 分屏、浅色/深色导航配色、录制与下载生命周期、全屏及并发清理。合成截图已目视检查。`pnpm typecheck`、`pnpm lint`、改动 TS/TSX 的 Prettier 与 `git diff --check` 通过；本轮未读取真实设备、未重新验收原生 Safari，也未重新执行生产构建。

## 默认三十分钟与真实双路补验

既有长录制用例新增 `NVR_LONG_SAVE_MINUTES=15|30|60`，默认保留十五分钟；录制上限按钮、总时长、分段数和运行期限随参数变化。源帧哈希与时间戳仍只采样五分钟边界附近，覆盖所选总时长，最多 6000 样本；每份成品继续全片解码，并核对所有段间的视频和音频连续性。另新增单独以 `RUN_NVR_MULTI_SAVE_TESTS=1` 启用的双路实机用例，检查停止一路后另一原始连接和写入仍推进、两份成品解码及清理。以上脚本改动的类型检查、定向 ESLint、Prettier 和差异检查通过；脚本可运行不等于实机场景已通过。

**已验证（实机）**：三十分钟测试在开发实例 `localhost:3102` 使用真实 Chrome、真实 NVR 及 OPFS 文件句柄，关闭 trace、截图和录像产物。结果 **1/1 通过，总计 38.6 分钟**；其中录制恰好 1800 秒，之后执行有界成品复制及逐段完整核验。

| 检查 | 实测结果 |
| --- | --- |
| 自然结束及成品 | 六段各 300 秒，合计 1800 秒、260,074,098 B；HEVC 2560×1440、G.711 A-law 8 kHz 单声道；全部 FFmpeg `-xerror` 完整解码通过 |
| 视频源匹配 | 各段首尾源视频包 hash/PTS 匹配，跨段误差不超过 2 ms；源覆盖合计 1800 秒，观察到 45,013 个源视频包 |
| 音频连续性 | 各段内部及所有五个段间核对通过；段间 gap 均为 0，实际音频样本合计 14,400,000 个 |
| 生命周期 | 只建立一条保存源；自然结束后活动传输及新增 FFmpeg 均为 0；测试浏览器退出，OPFS 与本机临时成品清理 |

较十五分钟样本，本次码率和成品体积更大，浏览器到验证工具的有界复制及完整解码实际需要额外约八分半钟。最初 36 分钟总预算不足，录制已完成后在同一测试进程调用公开 `testInfo.setTimeout` 将总预算延长至 45 分钟，并同步到测试源码；没有重启录制，没有改变任何媒体断言，录制循环的独立 32 分钟期限保留。该次仅用于调整本机验证预算的临时 Node 调试器随后已关闭并确认端口不再监听。

独立本机观察器每三十秒读取测试 Chrome 子进程、Next 服务进程与 FFmpeg 的 RSS，仅记录聚合数值，不读取进程参数或真实画面。录制阶段取得 60 个样本：

| 进程范围 | 最小 / 中位数 / 最大 RSS（MiB） |
| --- | --- |
| 七个测试 Chrome 进程求和 | 535.33 / 596.80 / 869.23 |
| 单个 FFmpeg 协议桥接进程 | 9.41 / 9.86 / 13.30 |
| Next 开发服务监听进程 | 55.09 / 111.37 / 1373.34 |

Chrome 录制阶段末次求和为 603.80 MiB；观察期没有随成品体积出现持续线性增长。RSS 求和可能重复计算共享页，采样不能视为精确峰值、JavaScript 堆或媒体缓冲大小，也不能将 Next 开发实例的波动当成生产资源基准。原始聚合记录保留在本机 `/private/tmp/hikvision-save-30m-memory-1792896064.jsonl`，没有真实媒体、文件标识或凭据。后续成品验证阶段的采样不混入上述录制阶段统计。

```sh
TEST_BASE_URL=http://localhost:3102 NVR_INTEGRATION=0 \
  RUN_NVR_SAVE_TESTS=0 RUN_NVR_LONG_SAVE_TESTS=1 NVR_LONG_SAVE_MINUTES=30 \
  pnpm exec playwright test tests/browser/saves-device.spec.ts --workers=1 \
  -g 'fifteen-minute live recording' --output=/private/tmp/hikvision-save-30m-results
```

随后单独执行真实双路测试，避免混入上述内存观测：**1/1 通过，27.5 秒**。两条可信通道各生成一份 14.079999 秒 HEVC / G.711 成品，完整解码通过。先停止一路后，另一路的原始请求对象仍连接、字节继续增加，没有重连；再停止另一路后两项均完成，活动源及新增 FFmpeg 均为 0，测试 finally 清理 OPFS 与本机临时文件。

```sh
TEST_BASE_URL=http://localhost:3102 NVR_INTEGRATION=0 \
  RUN_NVR_SAVE_TESTS=0 RUN_NVR_LONG_SAVE_TESTS=0 RUN_NVR_MULTI_SAVE_TESTS=1 \
  pnpm exec playwright test tests/browser/saves-device.spec.ts --workers=1 \
  -g 'two real channels' --output=/private/tmp/hikvision-save-two-channel-results
```

本次两项实机使用 OPFS 句柄代替系统选择交互；原生 Chrome 目录选择/授权、单文件“另存为”及 Safari 原生下载验收仍以此前独立记录为证据。六十分钟、Safari 长时间/多路、真实磁盘低空间、冻结/休眠/崩溃恢复和精确内存峰值没有因此通过。当前文件 A/B 选区符合本次片段下载范围；按北京时间输入全天范围、跨文件/跨日导出仍为明确未实现的后续能力。

## 本次录制与片段下载交付复核

| 命令或检查 | 最终结果 |
| --- | --- |
| `pnpm test` | 16 文件、209 项通过，2.33 秒 |
| `pnpm typecheck`、`pnpm lint` | 通过 |
| 改动及新增 TypeScript 的 Prettier | 39 文件通过；发现并修正一处既有新测试文件的格式问题，无逻辑变更 |
| `git diff --check` 及新增文件独立空白检查 | 通过，另检查 30 个未跟踪文件 |
| `pnpm build` | 通过：编译 880 ms、TypeScript 2.0 秒、静态页面 5/5 |
| 本轮真实浏览器 | 三十分钟自然录制 1/1、真实双路独立停止 1/1 均通过；此前最近 UI 专项 24 通过、1 项设备用例未启用，原生 Safari/Chrome 系统交互证据分别保留 |
| 独立清理复核 | 实机测试临时媒体目录/文件/字节均为 0；私有回放目录文件/子目录/字节均为 0；FFmpeg 和本次防休眠进程均为 0，临时调试器已关闭；开发实例健康接口返回 `ok` |

本次交付覆盖浏览器实时手动录制、固定源跨界面继续、文件内 A/B 片段下载、原速原音轨、增量写盘，以及持续状态、Sonner、任务详情与异常清理。文件内选区由用户在画面中标记或输入偏移；不会将查询日期当作媒体零点。上述交付不代表整个 P2、全天绝对时间或跨文件导出已完成，后续能力继续保留在开发计划中。
