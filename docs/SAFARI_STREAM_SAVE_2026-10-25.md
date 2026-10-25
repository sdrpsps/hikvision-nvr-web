# Safari 流式保存诊断 — 2026-10-25

本记录区分 Safari 真机观察、Chrome 对照和未确认原因。诊断不展示或输出设备画面、声音、凭据、原始媒体 URI 或片段标识。

## 当前原生 Safari 验收结果

**已验证（实机）：系统 Safari 27.0.1 在实际应用中完成实时手动录制、当前文件 A/B 选区下载，以及浏览器下载列表取消后的释放。** 本次使用安全上下文、生产 Service Worker、真实媒体 Worker 和 NVR 源，成品由 Safari 原生下载器写入本机；结果不依赖独立 Playwright WebKit。

| 场景 | 原生应用与成品结果 |
| --- | --- |
| 实时录制 | 手动停止完成，113.56 秒、18,939,999 B；HEVC 2560×1440，`pcm_alaw` 8 kHz 单声道 |
| 实时视频时间范围 | 2,839 包，PTS 0 → 113.56 秒 |
| 实时音频时间范围 | 1,439 包，PTS 0 → 113.56 秒 |
| 录制中切换 | 切到通道 201、单路布局和 `/playback`；再切普通浏览器后台 tab 约数十秒，原任务继续并最终保存 |
| 历史 A/B 下载 | 查询日期 2026-10-25 的第二文件，文件内 0 → 8 秒；581,278 B，HEVC 2560×1440 + `pcm_alaw` 8 kHz 单声道；应用显示实际覆盖 0 → 8 秒 |
| 历史音视频时间范围 | 视频 200 包，PTS 0 → 8 秒；音频 393 包，PTS 0.139 → 8 秒 |
| 观看状态独立性 | 4× 已由辅助功能树确认选中，同时暂停并静音；导出仍为原速并保留源音轨 |
| 本机文件确认 | Safari 下载列表分别显示 18.9 MB、581 KB，均已完成；两个成品均经 FFmpeg `-xerror` 全片音视频解码通过 |
| 取消与清理 | 在 Safari 下载列表停止另一次约 4.1 MB 的实时下载，应用提示“下载已取消或磁盘无法继续写入。”并进入终态；未遗留 FFmpeg。历史回放随后也已关闭，确认无 FFmpeg |

音视频范围按实际 packet 时间核验；未进行人工听音，也未将此次约两分钟录制扩写成 Safari 长时间或多路保存验收。顺序 MKV 不回填最终 Duration，部分播放器的总长与定位兼容性仍有限制。原生下载是否完成需要浏览器下载列表或实际文件确认，不能只凭 Service Worker 的 `closed` 消息断言最终磁盘提交。

## 新对话框与状态反馈的原生复核

2026-10-25 在同一实际应用中补测新录制/片段对话框、任务侧栏和常驻状态条。Safari 27.0.1 启动录制后，计时与写入量推进；打开和关闭侧栏、从实时页导航至回放页后继续，经常驻条停止并在原生下载列表确认完成。新成品为 8,987,236 B，HEVC 2560×1440 + `pcm_alaw` 8 kHz 单声道，音视频范围均为 0→75.64 秒。

历史文件暂停且静音时，经新下载对话框输入文件内 0→6 秒，关闭回放后独立下载完成；侧栏显示实际关键帧覆盖 0→8 秒。成品为 581,278 B，HEVC/G.711，视频 0→8 秒、音频 0.139→8 秒。两个成品均经 FFmpeg `-xerror` 全片解码通过，没有拍摄或展示实际监控画面。本次未重测原生 Safari 全屏界面，也未扩大长时间、多路或绝对钟表选区结论。

## 故障观察与已实施修复

### 本轮回归：下载停在准备状态

用户报告 Chrome 正常选择位置、Safari 一直“准备录制”后，在原生 Safari 的实际应用中复现：下载列表显示“正在准备下载”，任务保持 0 B，最终提示“等待浏览器写入磁盘超时，保存已中断。”。仅记录阶段与计数的临时观测确认 `register`、`registered`、`started` 和媒体 Worker `ready` 均成功，媒体已读取 131,115 B；下载端收到首次 `pull`，但未收到媒体写入端的 `writer-ready`。因此本次故障发生在端口交接之后，不能归为选择位置弹窗未出现或设备没有数据。

用同源 4 KiB 合成数据进行时序对照：发送端在 `postMessage` 后立即关闭已转交的 `port2` 时，可以完成写入；等待 `registered` 回执后再关闭同一个旧句柄时，原生 Safari 不再将写入端的 `writer-ready` 送达 SW，复现实际应用的等待状态。原代码的 `finally` 正是在回执后执行 `channel.port2.close()`。修复为：成功转交后由接收端拥有端口，仅在结构化克隆抛错、没有转交成功时关闭发送端句柄；取消和失败仍通过独立 `release-save` 通道释放远端与 iframe。此前“关闭旧句柄”的成功对照没有覆盖这次确认失败的关闭时序，不能证明所有时序都安全。

同时给浏览器的 SW 注册等待增加 15 秒超时和立即取消，防止注册 Promise 不结束时永久停在准备状态；迟到的注册结果不会启动已取消的下载。Safari 入口改为“开始录制”，并说明保存到浏览器下载位置；Chrome 保留“选择位置并录制”。Safari 是否先显示“另存为”由浏览器下载设置决定，应用不再承诺弹出 Chrome 的文件选择器。

**已验证（实机）**：刷新载入修复后，原生 Safari 实际应用进入“录制中”，观察到 22 秒 / 5.3 MiB，手动停止后在下载列表确认成品完成（7.5 MB）。实际文件为 7,503,079 B，HEVC 2560×1440、G.711 A-law 8 kHz 单声道；900 个视频包与 543 个音频包均覆盖 0→36.00 秒。`ffprobe` 与 FFmpeg `-xerror` 全片音视频解码通过，退出码 0、错误输出 0 行；检查时没有 FFmpeg 进程。失败诊断留下的两个空下载已在原生下载列表停止，临时观测代码已从仓库移除。本次没有重做 Safari 长时间、多路录制或文件内选区实机验收。

**已验证（自动测试）**：`pnpm test` 16 文件 / 212 项通过；`pnpm typecheck`、`pnpm lint`、改动源码/测试的 Prettier 检查、`git diff --check` 和 `pnpm build` 通过。`TEST_BASE_URL=http://localhost:3000 NVR_INTEGRATION=0 RUN_NVR_SAVE_TESTS=0 RUN_NVR_LONG_SAVE_TESTS=0 pnpm exec playwright test tests/browser/saves.spec.ts tests/browser/stream-save.spec.ts --workers=1 --output=/private/tmp/hikvision-safari-start-final` 20/20 通过（44.6 秒），仅使用模拟接口与合成媒体，包括新增无文件选择器的应用原生下载与文件完整性核验。Chrome 在沙箱内启动时 SIGABRT，最终回归在普通本机环境执行；磁盘失败测试的 Worker 注入适配原始模块类型及 Turbopack 启动 hash，保留原有磁盘错误与连接释放断言。

以下早期记录保留当时的观测，不作为本轮回归已经不存在的依据。

早期已确认 Safari 处于安全上下文，Service Worker 注册、激活和 MessageChannel 登记成功，但生产入口曾等待 `started` 超时；该通知由响应流首次 `pull` 发送，早期失败发生在启动媒体 Worker、读取媒体源之前。随后 Mac 锁屏，中断原生诊断；解锁后恢复分层检查。

原生 Safari 的独立生产 SW 对照只增加 fetch/stream 阶段观测，保持 `highWaterMark=0` 和隐藏 iframe，已下载完整 32,768 B 并核对 hash，下载列表显示完成。实际应用随后出现另一种失败：保存目的地已返回，任务仍为 0 B，最终明确报告“等待浏览器写入磁盘超时，保存已中断。”；这与早期 `started` 超时发生在不同阶段。

代码中可复现的首个 `pull` 交接竞态已修复：页面在等待 `started` 时开启端口消息派发，首个写入额度可能在媒体 Worker 接管前被消费；现在 SW 先保留读取需求，待媒体写入端安装监听并发送 `writer-ready` 后再授予唯一额度。重复 readiness 不增加额度，后续仍保持单块背压，不新增媒体缓存。媒体 Worker 另返回启动确认，Provider 为启动和停止设置有界看门狗，避免任务永久停在准备或收尾状态。

新握手在独立源及实际应用同源均通过 32 KiB 原生合成下载，包括延迟 200 ms 后转移端口、关闭已转移的原端口句柄两种对照。实际应用同源的临时静态 fixture 又加载真实 Webpack 媒体 Worker，经生产 SW 保存真实 NVR 约十秒成品：1,475,444 B，HEVC 2560×1440 + `pcm_alaw` 8 kHz 单声道，FFmpeg `-xerror` 全片解码通过。

新握手首次实际应用重试仍曾 0 B 超时。为避免新旧 SW 静默混用，新增协议版本 `2`：`registered` 回执必须声明版本，页面在版本缺失或不符时明确失败并释放任务，不进入媒体读取；注册 URL 带 `?v=2`，并设置 `updateViaCache: 'none'`。带版本注册后，实际应用取得上表中的录制、选区下载和取消验收结果。

**最初 `started` 超时的根因仍未确认。** 首个 `pull` 交接问题有代码回归与修复；“首轮新握手重试仍被旧 active SW 响应”仅为排障假设，没有独立证据证明它就是那次失败原因。实际应用现在成功，不构成对这些历史失败根因的反向证明。临时公开诊断入口及文件已移除，生产页面不保留调试入口。

## 独立合成数据对照

临时诊断使用独立 Service Worker scope 和八个 4 KiB 合成数据块，共 32 KiB。没有连接 NVR，也没有使用完整媒体 Blob、OPFS、CacheStorage 或 IndexedDB。诊断可分别显示注册、请求进入、流创建、首次读取和逐块确认，并对照 `highWaterMark=0/1`、链接导航、iframe 与受控 fetch。

真实安装的 Chrome 中，以下组合均通过：

- iframe 下载，`highWaterMark=0` 和 `1`：两份文件均为 32768 字节，SHA-256 一致。
- scope 内受控 fetch，`highWaterMark=0` 和 `1`：均读取完整 32768 字节并关闭流。
- 真实链接导航，新标签页与当前标签页两种目标：均下载完整文件，原页面 URL 保持不变。

这些结果只证明诊断页面和相同协议在 Chrome 中正常，不能说明 Safari 的失败位置。两个临时公开诊断入口已移除，生产页面不保留它们。验证脚本仅留在本机临时目录，未输出或保存真实媒体。

## 独立 Playwright WebKit 分层诊断

项目现有 Playwright 1.64.1 使用官方 WebKit 27.2（build v2370），下载到任务专用 `/private/tmp/hikvision-webkit-diagnostic-browsers`，没有新增项目依赖或修改系统 Safari 设置。沙箱内启动在 AppKit 应用注册阶段 `SIGABRT`；同一精确命令经自动审核在普通本机环境运行后可正常启动。该启动差异发生在创建网页之前，不是 Service Worker 或下载故障。

```sh
PLAYWRIGHT_BROWSERS_PATH=/private/tmp/hikvision-webkit-diagnostic-browsers \
  pnpm exec playwright install webkit
PLAYWRIGHT_BROWSERS_PATH=/private/tmp/hikvision-webkit-diagnostic-browsers \
  node /private/tmp/hikvision-webkit-diagnostic.cjs webkit production
DIAG_ORIGIN=http://localhost:3102 \
  PLAYWRIGHT_BROWSERS_PATH=/private/tmp/hikvision-webkit-diagnostic-browsers \
  node /private/tmp/hikvision-webkit-diagnostic.cjs webkit production
```

全部媒体为八个 4 KiB 合成块，共 32768 字节；不调用 NVR 媒体接口。独立源只读加载生产 Service Worker，保留其 `video/x-matroska`、`Content-Disposition`、CSP 等响应头；HWM=1 对照只修改临时响应文本，仓库源码保持不变。

| 层级 | 场景 | 结果 |
| --- | --- | --- |
| 最小独立流 | HWM=0/1 × iframe、受控 fetch、当前页链接、新标签页链接 | 8 种组合全部进入 fetch、创建流、首次 pull、逐块确认及关闭；6 个下载均为 32768 字节，hash 一致 |
| 生产 SW 独立源 | HWM=0/1 × 有手势 iframe、无手势 iframe、受控 fetch、当前页链接、新标签页链接 | 10 种组合全部收到 `registered`、`started`、逐块 `pull` / `ack` 与 `closed`；8 个下载均为 32768 字节，hash 一致 |
| 现有开发实例的原生产 SW | HWM=0，相同五种入口；只请求 `/api/health`、SW 和合成保存路径 | 5 种组合均通过；4 个下载为 32768 字节、hash 一致，受控 fetch 读取 32768 字节且状态 200 |

所有下载 SHA-256 均为 `4fdb9962246d3d93ec397b768b6df176cbcdaa70e54ed8d65207af2c192b9e80`，`download.failure()` 为 null，合成下载文件在检查后删除，临时服务器与 WebKit 进程已经关闭。测试没有触发应用 HMR，也没有更改正在运行的真实录制任务。

**独立 WebKit 27.2 未复现系统 Safari 的启动握手超时。** 没有据此修改生产 HWM、导航入口或媒体类型。这些结果保留为独立引擎的分层诊断证据；系统 Safari 的验收依据是本文开头的原生实际应用结果。

## 保留的验收边界

- Safari 长时间或多路录制、真实冻结/休眠/崩溃、人工听音及内存峰值尚未验收；普通后台 tab 短时继续不等于浏览器永久后台存活。
- Safari 当前文件相对选区已验证；绝对钟表锚点仍需独立对照，按北京时间精确裁剪及跨文件/跨日下载尚未开放。
- 顺序 MKV 没有可回填的最终 Duration，`closed` 仅表示流生产结束；本次已另由原生下载列表和成品核验完成状态。
- Chrome/Edge 的系统文件选择与授权交互、其他浏览器版本或部署环境，不能从本次 Safari 结果直接推定通过。Chrome 原生目录选择和授权另有独立实机记录，见浏览器录制下载记录。

完整保存验收、自动检查与既有 Chrome 长测见 [浏览器录制下载记录](./VALIDATION_SAVES_2026-10-25.md)。
