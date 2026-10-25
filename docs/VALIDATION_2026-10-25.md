# 2026-10-25 验证记录

## 实时页侧栏收展动画

范围：P2 实时预览页面的通道列表交互。遵循 apple-design 的可中断、无回弹和减少动态效果约定，不改变媒体数据链路。

实现：

- 侧栏保持挂载，桌面通过两条固定结构的 grid 列轨道在标准宽度与零宽间过渡；手机通过独立侧栏的 `1fr → 0fr` 行轨道收展。布局过渡 280ms，侧栏内容透明度过渡 180ms。
- 外层裁剪，内层保留内容宽度、padding、分隔线和滚动，收起终态无残留宽度/高度；视频区同步调整。手机父网格明确使用 `auto minmax(0, 1fr)`，把额外高度留给视频行，避免单窗口时空白侧栏行被拉伸。
- 关闭立即设置 `inert` 和 `aria-hidden`，切换时焦点回到通道按钮。保留侧栏读取失败时的外部重试入口。播放器结构和 key 不受收展影响。
- `prefers-reduced-motion: reduce` 下明确关闭侧栏和布局过渡，无等待或延迟卸载定时器。

已验证（自动测试，Chrome 合成通道/媒体）：

| 命令 / 检查 | 结果 |
| --- | --- |
| `pnpm typecheck` | 通过 |
| `pnpm lint` | 通过 |
| `TEST_BASE_URL=http://localhost:3102 pnpm exec playwright test tests/browser/live.spec.ts --workers=1` | 10 通过，1 实机测试未启用；覆盖所有分屏、桌面/手机分配、手机 375×1200 单窗口收起后视频上方无留白、H.264/HEVC 折叠期间会话保持、音频及切换清理、失败重试和空通道 |
| 临时 Playwright 逐帧检查脚本 `node /tmp/hikvision-ui-review/sidebar-motion.cjs` | 1440/1000/375px 全通过，另覆盖手机 1 路在 900/1200px 高视口；展开尺寸分别为宽 192px、宽 168px、高 189px，收起终态均为 0；每个方向捕获 13 个中间帧，画面位置与侧栏尺寸差异 0px；80ms 时反向点击后正确回到展开终态；侧栏 DOM、列表滚动及切换按钮焦点保持；关闭时 inert/aria-hidden 生效；减少动态效果下无侧栏/布局动画 |
| `git diff --check` | 通过 |

运行环境：使用 `WATCHPACK_POLLING=true pnpm dev --webpack --port 3102` 和热更新。默认 Turbopack 启动后因沙箱内无法启动 FSEvent stream 退出，因此使用仓库既有的 polling 方案。初次以 `127.0.0.1` 访问时，Next.js 开发资源被跨源规则阻拦，页面未完成交互初始化；改用本开发服务器的 `localhost` 地址后，完整实时页回归通过。减少动态效果的逐帧检查最终仅统计侧栏/布局自身动画，避免把子按钮的颜色反馈计入布局动画。

独立复核发现手机单窗口下父网格隐式 auto 行会拉伸；补测复现收起后仍留 213.4px 高度。显式分配父网格行轨道后，900px 和 1200px 高视口的收起终态均为 0，已把高视口单窗口场景加入既有浏览器回归。

未进行真实 NVR 取流或 Safari 应用验收；媒体回归全部使用合成素材。本次未重复生产构建。下一步可在用户当前浏览器中检查侧栏收展手感；既有 P1/P2 其他验收边界见开发计划。

## 回放页同栏宽度与稳定的进度定位

范围：用户要求视频与页面其他元素同宽，并修复渐进读取时进度条总长不断增长、难以定位的问题。三个子代理分别负责同栏布局、服务端时长语义与取消、独立产品和代码复核，主代理负责播放器交互、整合和回归。

实现与语义：

- 移除 `.playback-player` 根据视口高度计算的窄宽度上限，使用内容栏的 100% 宽度，保留 16:9、`object-fit: contain` 和全屏规则。合成 H.264 空闲及播放两态测量：1440/1280/800/375px 视口下，播放器与当日录像外框分别同为 1392/1232/768/351px，左边界差均 0，无横向溢出。全屏表面和视频元素同为视口宽度。
- `durationSeconds` 保持已读取的真实媒体时长；新增可选 `estimatedDurationSeconds` 和只在完整读取后出现的 `totalDurationSeconds`。创建会话与状态契约均支持，直播契约排除这些回放字段。
- 可靠估计只来自未贴查询边界的完整设备标签跨度。日界片段只补查必要的前/后一个日历日，按同轨道、经过 URI 验证的 `name + size` 匹配连续区间，严格排除仍贴最外边界、缺失/不同标识及不连续结果。原始 URI 和原起止不改写。测试覆盖 342 秒裁剪标签恢复到 7224 秒、左右/双日界、跨年、配置时区的夏令时及重叠合并。
- 补查共用 1500ms 短预算；原始查询耗时超过 5 秒时直接跳过。取消信号贯穿 `queryRaw → IsapiClient → fetch`，超时归还查询槽位并继续原文件下载。失败或仍不确定时不返回估计；无估计仍能播放并清理。
- 有估计时进度条按该时长保持刻度，终点明确标“约”；完整读取后一次校准实际总长。主色轨道表示实际播放位置，浅色轨道表示已读取范围，待定位滑块表示用户请求的目标，等待期间显示实际播放位置标记。拖动过程中冻结当前刻度。无可靠估计或实际媒体超过估计时显示“时长确认中”，不使用持续增长的已读取长度冒充整段总长。
- 按需展开“定位”，输入文件内 `分:秒` / `时:分:秒`。目标未读取时保留为相对秒数并显示“正在读取至…，已读取至…”，支持取消和用新目标替换；媒体实际可 seek 后才设置 `currentTime`，保留播放/暂停状态。最终时长不足则明确报目标超出范围，不静默夹到末尾。关闭、切换和失败随播放器卸载取消等待。
- 状态轮询读取期间为 2 秒，完成后恢复 20 秒续约；状态独立于 session 对象，更新不重建 HLS/音频实例。时间滑块为辅助技术提供格式化时分秒；定位弹层跟随全屏容器。

已验证（自动测试，Chrome 合成通道/媒体）：

| 命令 / 检查 | 结果 |
| --- | --- |
| `pnpm test` | 10 个文件、138 项测试通过；包含估计来源、渐进实际时长、完整长度、取消归还查询槽位、未知估计照常播放及原有安全/资源清理 |
| `pnpm typecheck` | 通过 |
| `pnpm lint` | 通过 |
| `pnpm build` | Next.js 16.4.1 生产构建通过 |
| `TEST_BASE_URL=http://localhost:3102 pnpm exec playwright test --workers=1` | 28 通过、3 实机用例未启用；含所有原有直播/回放双编码、声音、倍速、全屏、连续播放、16 路合成解码/清理，以及新增渐进读取稳定刻度、等待定位、取消/替换、格式错误、最终越界和手机未知时长场景 |
| `node --import tsx /private/tmp/hikvision-playback-visual-qa.mjs` | 桌面 1440×900 / 手机 375×812 合成页面视觉检查通过；预估总长、已读取范围、定位弹层、等待/取消、全屏弹层均无溢出或遮挡；输入和跳转按钮点击命中正确，弹层位于全屏子树，无页面错误 |
| `git diff --check` | 通过 |

新增渐进浏览器测试使用同一人工 H.264 文件的媒体分片，将第二个片段的解码时间后移 3 秒，模拟 EVENT 从 3 秒扩展至 6 秒。测试先给 60 秒估计，验证目标 5 秒不能提前跳转，数据到达后暂停状态下准确定位，刻度保持 60 秒直至完整读取后校准为 6 秒。另一用例不提供估计，验证手机端可替换等待目标，完成后明确拒绝超过 3 秒实际长度的请求。

已修正的验证发现：Base UI 的 range input 在提交后会同步受控值；等待时将滑块值保持为目标秒数、实际播放进度单独绘制，避免输入事件把待定位目标覆盖回当前位置。浏览器断言限定产品提示文字，避免与 Next.js 自带 route announcer 的 alert 发生严格选择器冲突。

边界：完整设备标签时长仍是估计，实际总长以完整读取后的媒体为准；未读取位置需要等顺序下载到达，未实现任意文件范围的即时远程读取。定位始终相对文件开头，不换算成录像日期上的钟表时间。本次没有读取真实 NVR 媒体、没有 Safari 应用实机验收，原有历史 RTSP 和媒体绝对时间锚点状态不变。

## 设备信息层级与统一滚动

范围：设备信息替代查询工具栏原“北京时间”元素；所有实际滚动区使用 shadcn Scroll Area；按用户反馈建立设备信息的主次关系。对应 P0 查询交互与 P2 播放器布局，不改变设备访问边界。

实现：

- “设备信息”位于刷新旁，以 ghost 按钮作为辅助入口。弹层先显示小标题和较大、较重的设备型号，再通过留白与分隔线显示固件、摄像头数量及时区；型号不在参数列表中重复。保持按需读取、失败重试和已加载信息复用。
- 通过 shadcn CLI 添加 Base UI Scroll Area，统一页面、实时侧栏、手机通道列表、视频墙、全天横向时间轴、Select、超高 Popover 和直播长错误提示。Content 的 ResizeObserver 跟随动态加载、片段展开与布局变化刷新滚动条。
- 页面滚动移至真实 viewport，切换页面重置到顶部；时间轴语义、焦点和键盘横移保留。Select.List 与 ScrollArea.Viewport 合成同一元素，使键盘和已选项定位继续滚动正确节点。
- 桌面侧栏整体滚动；手机外侧栏仅负责收展裁剪，内部通道列表限高 8rem，避免同时出现两层列表滚动。视频墙和播放器 DOM 保持，侧栏动画、inert、已播放会话及滚动位置保留。
- Popover 保留 Portal、全屏容器、原 padding/gap 和焦点语义，在可用高度内滚动。长直播错误限制在画面内，重试仍可操作；局部覆盖 Base UI Root 的内联定位，避免错误区域被 flex 压成零高度。

已验证（自动测试，Chrome 模拟 API 和人工媒体）：

| 命令 / 检查 | 结果 |
| --- | --- |
| `pnpm typecheck`；`pnpm lint`；`pnpm build` | 通过，含并行 TanStack Query 改动落盘后的当前源码；最终测试 fixture 调整后另跑定向 ESLint |
| `TEST_BASE_URL=http://localhost:3102 pnpm exec playwright test tests/browser/console.spec.ts tests/browser/page-scroll.spec.ts tests/browser/scroll.spec.ts --workers=1 --output=/tmp/hikvision-scroll-final-results` | 10 通过，1 实机用例未启用；覆盖查询、详情懒加载/失败重试/缓存、动态页面滚动、路由重置、横向时间轴和64项下拉列表的键盘与重开定位 |
| `TEST_BASE_URL=http://localhost:3102 pnpm exec playwright test --workers=1 --output=/tmp/hikvision-ui-final-results` | 最终完整回归39通过、3实机用例未启用（1.5分钟）；覆盖当前工作区同时落盘的TanStack Query迁移，以及双编码解码、倍速、全屏、定位、连续播放、16路合成解码与会话清理 |
| `node /tmp/hikvision-ui-review/device.cjs` | 1440px/375px 与深色模式设备信息视觉检查；型号18px/600、次级参数13px，手机未越界 |
| 临时 Chrome 脚本 `/private/tmp/hikvision-live-scroll-qa.mjs`、`/private/tmp/hikvision-live-errors-qa.mjs` | 1440/1000/375px，64通道及全部分屏、单层列表滚动、侧栏DOM/scrollTop保留；长错误限制在画面内且重试可点，800×600画面墙实际溢出时显示自定义滚动条 |
| 临时 Chrome 脚本 `/private/tmp/hikvision-popover-scroll-qa.mjs` | 375×260日历/设备详情、800×260全屏自定义倍速均在稳定定位后可滚动且在视口内；1.35×应用成功，退出弹层焦点归还，直播声音错误与视频隔离；无pageerror |

联调发现及处理：

- 首次完整回归中手机第三次切换日期曾丢失弹层；稳定源码下原用例连续5次、独立事件追踪3次均成功，后续定向整组通过，未通过修改日期组件或放宽断言处理。原失败原因未证实；同一时段另一任务正在迁移数据请求层，并短暂出现新增hook尚未写入的编译失败。
- 数据请求层迁移后，设备详情的新挂载会在开发Strict Mode中取消首次请求再重新订阅。追踪3次确认首请求在约1.2–1.4ms被AbortError取消，第二次取数；Query已配置retry:false。原模拟“第一次失败、第二次成功”把取消当成设备恢复，现改为持续失败直至用户点击重试前才切换为可达，继续验证显式恢复和缓存不重复读取。

未进行真实 NVR 取流或 Safari 应用验收；本轮视觉截图仅含模拟数据和人工媒体。

## 前端 API 迁移至 TanStack Query

范围：按用户明确要求，将现有前端业务 API 请求全部迁移至 TanStack Query v5，为每个请求导出并实际使用 hook。覆盖 P0 通道/设备/录像查询与 P2 会话创建、关闭、状态续约、连续播放结束确认及 G.711 音频读取。保留工作区已有界面、滚动和媒体改动。

实现：

- 安装 `@tanstack/react-query@5.104.5`，根布局挂载 `QueryProvider`；浏览器复用 QueryClient，服务端每次渲染独立创建，避免跨请求共享数据。
- `hooks/use-api.ts` 导出 `useChannels`、`useDevice`、`useRecordings`；查询选项与 key 在 `lib/api-queries.ts`。通道在浏览器共享 30 秒新鲜缓存；设备详情按需挂载、关闭取消，成功结果缓存复用并保留 10 秒超时；录像按通道和日期隔离，切换取消旧请求，刷新立即卸载旧播放器并获取新快照。
- `hooks/use-stream-api.ts` 导出 `useCreateLiveStream`、`useCreatePlaybackStream`、`useDeleteStream`、`usePlaybackStatus`、`useStreamAudio`。创建/关闭使用 mutation，状态使用 query；结束确认与音频读取通过 hook 封装的 `queryClient.fetchQuery` 执行。视频列表和分片仍由原生 HLS / hls.js 加载。
- 所有前端显式 `fetch` 统一在 `lib/api.ts`；保留 Zod 校验、服务端错误码/中文消息、204 空响应与 Abort/Timeout 原因。组件和音频调度类不再直接请求 API。
- 禁止自动重试，窗口聚焦和恢复网络不自动刷新查询；本机 API 使用 `networkMode: always`，浏览器报告无互联网时仍实际请求并显示结果或错误。媒体关闭保留 `keepalive`，取消准备、迟到会话释放、过期、异常和离开清理继续执行。
- 状态首次延迟 2 秒，读取中每 2 秒、完整后每 20 秒续约，后台标签页继续请求。结束确认强制使用新查询；确认完整并成功 DELETE 后才推进下一文件。音频按游标/位置读取，已消费音频和临时确认查询立即移出缓存。

已验证（自动测试，浏览器使用合成 API / 人工媒体）：

| 命令 / 检查 | 结果 |
| --- | --- |
| `pnpm test` | 11 个文件、149 项通过；新增 11 项覆盖缓存合并/参数隔离、服务端渲染隔离、无互联网标记、取消后重取、认证错误不重试、响应校验、设备 10 秒超时和 DELETE 空响应 |
| `pnpm typecheck`；`pnpm lint` | 通过 |
| `pnpm build` | Next.js 16.4.1 生产构建通过 |
| `TEST_BASE_URL=http://localhost:3102 pnpm exec playwright test tests/browser/query.spec.ts --workers=1` | 7 项通过；跨路由缓存、切日期真实 AbortSignal 与迟到响应、设备详情关闭取消/重开、401/断网/无效 JSON 不自动重试并可恢复、刷新时 DELETE 旧会话 |
| `TEST_BASE_URL=http://localhost:3102 pnpm exec playwright test --workers=1` | 最终完整回归 39 通过、3 实机用例未启用；除请求迁移场景外，包含桌面/手机查询、滚动与焦点、H.264/HEVC 实际合成解码、G.711 音频、seek/倍速/全屏、渐进定位、连续播放及 16 路启停/取消/清理 |
| `pnpm exec prettier --check <本次改动的 TS/TSX 文件>`；`git diff --check` | 通过 |

验证发现及处理：设备详情初稿遗漏原有 10 秒超时、状态 query 默认暂停后台轮询，两项已在代码复核中修复并检查。Node 原生 `AbortSignal.timeout` 不使用 Vitest 假时钟，超时单元测试通过受控信号模拟其时钟后验证实际错误路径。开发 Strict Mode 会取消新挂载的首次 query 并重新订阅，测试以完成加载后的请求数为基线；设备故障模拟持续到用户点击重试前才恢复，避免把被取消请求当成一次有效失败。

运行环境沿用 `http://localhost:3102` 的 Next.js 开发服务器与热更新。普通沙箱不能启动 Chrome（SIGABRT / kill EPERM），通过自动审批后在允许启动 Chrome 的环境执行浏览器验收；未涉及真实设备数据或媒体。依赖安装沿用已有 pnpm store，未迁移现有依赖目录。

本次没有进行真实 NVR 或 Safari 应用实机验收，不提升标准历史 RTSP、绝对媒体时间映射或长期音画稳定性的验收状态。后续新增前端 API 按上述 hook 与请求层约定扩展。

## 全站操作反馈统一使用 Sonner

范围：按用户澄清的“操作反馈”复核 P0 查询交互与 P2 播放/保存操作。保留字段校验、加载/读取进度、选中状态、任务历史、能力说明，以及失败后的空状态和重试入口。

实现：

- 通道、录像和按需读取设备详情的请求失败统一通过 `useQueryErrorToast` 反馈，替代页内详细错误 Alert。每个视图复用一个通知 ID；同文案的新请求失败仍可再次通知，普通重渲染、关闭通知和侧栏收展不重放旧错误。查询成功和组件离开时移除旧通知；清理同时重置去重引用，兼容 StrictMode 的 effect 重放。
- 预览准备失败、超时、HLS 致命错误、播放/声音/文件内定位/恢复倍速/全屏操作失败使用 Sonner；输入格式和允许范围错误仍在字段旁显示。按播放器与操作使用稳定 ID，通道信息进入通知描述；同一次致命错误只处理一次。
- 连续播放未读完、跨片段搜索缺口使用 warning，播放到最后一段使用 info。手动关闭时若 DELETE 未能确认释放，告知画面已关闭、连接会按 TTL 回收；卸载、自动切换和其他后台清理不追加通知。
- 录制和下载的成功、部分保存、错误、超限及“查看任务”操作已使用 Sonner，本次沿用。全局仍仅一个 Toaster，沿用同一宿主随全屏迁移的机制。

已验证（自动测试；浏览器仅模拟 API 与合成媒体）：

| 命令 / 检查 | 结果 |
| --- | --- |
| `pnpm test` | 16 个文件、212 项通过，1.30 秒；包含工作区已有的保存改动 |
| `pnpm typecheck`；`pnpm lint`；本次 TS/TSX 文件 `prettier --check`；`git diff --check` | 全部通过；最后仅调整查询测试断言后，再次执行类型检查、该文件 ESLint、格式及差异检查，通过 |
| `TEST_BASE_URL=http://localhost:3000 NVR_INTEGRATION=0 RUN_NVR_SAVE_TESTS=0 RUN_NVR_LONG_SAVE_TESTS=0 pnpm exec playwright test --workers=1 --output=/private/tmp/hikvision-feedback-final-results` | 完整运行 2.0 分钟：58 通过、8 实机用例未启用，1 处新增测试断言失败；所有播放器、保存、全屏、滚动与 16 路合成媒体用例通过 |
| 同上环境，`pnpm exec playwright test tests/browser/query.spec.ts --workers=1 --output=/private/tmp/hikvision-feedback-query-final-results` | 修正缓存假设后 7/7 通过，11.6 秒；最终 59 个非设备用例已分批通过，未将其写成单次全量成功 |
| `pnpm build` | Next.js 16.4.1 生产构建通过；编译 1360 ms、TypeScript 2.5 秒、静态页面 5/5 |

完整运行的唯一失败来自新增测试的假设：预期手动刷新失败后切页不重新读取通道，实际请求增加。核对当前 `@tanstack/query-core@5.104.5` 的 error reducer，失败会使查询失效，重挂载可以重新读取；现断言该行为并继续检查新页面只有一个包含详细错误的 Sonner。应用请求逻辑未因测试修改。查询专项另覆盖认证失败、网络失败、无效 JSON 的不自动重试与显式恢复、取消/迟到响应、关闭设备详情和刷新清理。

环境：尝试启动 `3102` 后，Next.js 检测到同仓库已有 `3000` 开发实例并退出；改为复用健康的 `http://localhost:3000` 与热更新，没有停止已有服务。Chrome 启动受普通沙箱限制，自动审批后在允许启动 Chrome 的环境执行回归。没有读取真实 NVR 或生成真实画面产物；本轮不提升 Safari、历史 RTSP 或媒体绝对时间映射的验收结论。下一步仅按用户新任务继续；当前操作反馈迁移已完成。

## Safari 实时预览首帧与起播缓冲

用户报告 Safari 在出现预览画面后短暂停住。原生 Safari 27.0.1 的独立同源对照页使用真实 NVR HEVC 源与当前媒体接口，两次均在约 4.36 秒呈现首帧、约 12.35 秒触发 `playing`；期间播放时间保持 0，初始缓冲 4 秒，积累到三段共 12 秒后才连续播放。实测首帧停留约 8 秒，与用户报告的一两秒不完全相同，不能据此断言其原始操作的全部时序。立即显式调用 `video.play()` 的两次对照仍在约 12.33 / 12.34 秒开始播放，未缩短等待，未纳入实现。此前 Chrome 单路对照只测到约 22–23 ms 的续片等待，不能替代 Safari 结论。

实现沿用原生 HLS、`autoPlay` 和原码换封装。所有实时播放器在首次 `playing` 前用现有 `Empty` 显示“正在缓冲画面”，以不透明覆盖层挡住提前展示的静止首帧；视频本体仍为正常显示，避免触发 Safari 的不可见媒体策略。覆盖层不接收指针事件，控件保持在其上方。首次播放后永久移除该会话的起播层，后续普通 `stalled` 不重新遮挡或报错。新增 30 秒首次起播看门狗，失败走既有通知、释放与重试；首次 `playing`、失败和卸载均清理定时器。文件回放和录制链路不新增此等待逻辑。

**已验证（实机）**：原生 Safari 实际应用经临时同源 iframe 观测，首次 HEVC 帧约 4.365 秒出现时覆盖层仍在，约 12.375 秒触发 `playing` 后覆盖层撤下；视频本体始终 `display:block / visibility:visible / opacity:1`。从发起预览观察 36 秒，正常连续播放约 23 秒，首次起播之后没有观察到超过 200 ms 的呈现帧间隔，30 秒看门狗未误杀。正常停止及另一次 `loadeddata` 后、尚未播放时停止均返回 DELETE 204，播放列表随后 404，视频节点清零。临时网页、窗口与本机遥测服务均已删除/关闭，没有保存、截图或展示真实媒体产物。原生脚本通过 `/private/tmp/hikvision-safari-app-startup.mjs` 执行；不依赖 Safari 的 Apple Events JavaScript 开关，也未修改浏览器设置。

**已验证（自动测试；浏览器使用模拟 API 与合成媒体）**：

| 命令 / 检查 | 结果 |
| --- | --- |
| `pnpm test` | 16 个文件、212 项通过，1.87 秒 |
| `pnpm typecheck`；`pnpm lint`；改动 TSX/测试 Prettier 检查 | 通过 |
| `TEST_BASE_URL=http://localhost:3000 NVR_INTEGRATION=0 RUN_NVR_SAVE_TESTS=0 RUN_NVR_LONG_SAVE_TESTS=0 pnpm exec playwright test tests/browser/live.spec.ts tests/browser/preview.spec.ts --workers=1 --output=/private/tmp/hikvision-live-startup-results` | 22 通过、2 实机用例未启用，49.7 秒；新增首帧已解码但未播放的覆盖、停止与重开、旧节点迟到事件、真实播放后计时器取消、30 秒超时释放/通知/重试；包含 H.264 / HEVC、G.711、seek、连续播放与既有清理回归 |
| `pnpm build`；`git diff --check` | 通过；生产编译 1115 ms、TypeScript 1537 ms、静态页面 5/5 |

额外执行整份 `app/globals.css` 的 Prettier 检查，提示既有文件末尾 7 处单行规则不符合格式；核对 HEAD 同样存在这些问题，本次新增的两个 CSS 规则格式通过，未扩大改动整理无关样式。临时诊断页面及 `4317` 监听已清理，开发实例 `/api/health` 返回 `{"status":"ok"}`。

上述阶段仅修正起播状态。用户随后授权缩短实际等待，短分片实现与独立验证见下节；Safari 多路、声音、全屏与长期稳定性仍按各自范围验收。

## Safari 实时预览短分片与实际起播优化

实时预览专用 FFmpeg 输出改为约 500ms 的 fMP4 分片，音视频继续 stream copy，录制传输及历史文件回放的参数保持各自链路。此为普通 HLS 的短分片，没有增加 LL-HLS PART、阻塞刷新或转码。HEVC B 帧的相邻短片 PTS 范围可能重叠，因此 `splitFragmentedMp4` 新增 DTS 起点、DTS 时长、样本数及首样本关键帧标记，原有 PTS 字段继续服务历史回放；`EXTINF` 使用 DTS 时长，避免累计漂移。关键帧标记按 trun / first_sample_flags / tfhd / trex 的继承规则读取，缺省依赖状态保守处理。

连接开头的非关键帧分片被丢弃，首个接受的关键帧建立音画锚点；滚动窗口只在关键帧边界移动，不能因缩短分片而直接丢弃其依赖的 GOP。会话固定 `TARGETDURATION`，列表从首片开始，至少积累 `max(3秒, 3×TARGETDURATION)` 才返回就绪；没有声明全部分片独立。正常保留至少 `max(12秒, 6×TARGETDURATION)`，超过 32MiB 或 256 片后可沿关键帧收缩到至少 3 个目标时长，仍超限则返回 `LIVE_BUFFER_LIMIT` 并释放。异常分片时长、启动超时、取消及失败沿原有路径清理。

**已验证（实机，真实 NVR HEVC、Safari 27.0.1、实际应用）**：重新运行 `node /private/tmp/hikvision-safari-app-startup.mjs`，两次从点击到首个呈现帧为 3.455 / 3.481 秒，到 `playing` 为 **3.448 / 3.486 秒**；首帧随即推进，前述旧版约 12.35 秒才开始连续播放。第一轮从点击观察 36 秒，呈现 796 帧、媒体时间推进约 32 秒；第二轮观察约 15 秒、307 帧。两轮均未记录到超过 200ms 的呈现帧间隔；首轮在起播同一时刻有一次 `waiting`，紧接着再次 `playing`，之后未观察到停顿。首帧覆盖在播放后撤下，视频本体保持正常显示。停止后均 DELETE 204、播放列表 404、视频节点为 0。

新分片起播很快，第二轮脚本未捕获到可操作的 `loadeddata` 后、`playing` 前停留期，`stoppedDuringStartup=false`；该轮只能证明正常停止，准备中取消沿用前一阶段实机证据及本轮生命周期测试，不能把该字段写为新的准备中实机验收。临时同源页面、脚本创建的 Safari 窗口及 4317 遥测服务均已清理；未保存画面、截图或声音，也未修改 Safari Apple Events JavaScript 开关。

**已验证（原生 Safari，合成 H.264）**：`node node_modules/tsx/dist/cli.mjs /private/tmp/hikvision-safari-short-h264.mts` 使用当前实际 `LiveSessions`、既有 3 秒 GOP 合成素材，FFmpeg 仅复制生成半秒分片。从页面发起到 `loadeddata` 2.560 秒、首个呈现帧 2.563 秒、`playing` 2.572 秒；总观察 26.851 秒、媒体推进 24.278 秒、292 帧。没有 `waiting` / `stalled` / `error` 或超过 200ms 的呈现帧间隔。14.663 秒时列表已滚动至 sequence 6，随后继续播放约 12.19 秒，最高 sequence 30，检查到的窗口首片均为关键帧。DELETE 204、播放列表 404，活动假源和馈送计时器为 0；4318 服务与脚本新建窗口已关闭。此证据不扩写为真实 NVR H.264 或声音实机验收。

Chrome 的新增短片回归最初失败：滚动后实际只解码 32 / 41 帧。诊断 H.264 时约 3.026 秒进入 `playing`，媒体时间 1.0615 秒时缓冲从 `[0,3.5]` 变为 `[3,4]`，随后等待并跳到下一关键帧。原因是旧 `backBufferLength=0` 配置仅保留 hls.js 计算的一段时长；MSE 删除到下个关键帧时会越过当前播放位置。改为保留至少 12 秒后，对照 H.264 / HEVC 在约 14.9 秒分别解码 183 / 181 帧，采样无 `waiting` / `seeking`，缓冲回收后继续推进。没有放宽原先大于 100 帧的断言来掩盖问题。

**已验证（自动测试；浏览器均为模拟 API / 合成媒体）**：

| 命令 / 检查 | 结果 |
| --- | --- |
| `pnpm test` | 17 文件、235 项通过，2.47 秒；新增 MP4 DTS / 样本标记继承、双编码短分片、准备门槛、关键帧窗口、固定目标时长、容量收缩/失败与释放测试 |
| `pnpm typecheck`；`pnpm lint`；相关 TS / TSX Prettier 检查 | 通过 |
| `TEST_BASE_URL=http://localhost:3000 NVR_INTEGRATION=0 RUN_NVR_SAVE_TESTS=0 RUN_NVR_LONG_SAVE_TESTS=0 pnpm exec playwright test --workers=1 --grep-invert 'short live' --output=/private/tmp/hikvision-short-hls-regression-results` | 61 通过、8 实机用例未启用，2.0 分钟；包含预览、文件回放、声音、seek、连续播放、录制/下载、并发与清理。新增短流另行检查 |
| 同上环境，`pnpm exec playwright test tests/browser/live.spec.ts tests/browser/preview.spec.ts --workers=1 --output=/private/tmp/hikvision-short-hls-final-results` | 最终配置 24 通过、2 实机用例未启用，1.6 分钟；含两种编码的 500ms 分片实际解码、窗口滚动、依赖片中途重开、超过 100 帧，以及滚动后同时推进超过 2 秒和新增超过 20 帧，避免 seek 跳过缺口误判成功。首帧覆盖/超时、音频、历史 seek/连续播放及清理均通过 |
| `TEST_BASE_URL=http://localhost:3000 NVR_INTEGRATION=1 pnpm exec playwright test tests/browser/live.spec.ts --workers=1 -g 'real LAN live preview' --output=/private/tmp/hikvision-short-hls-device-results` | **已验证（实机）**：Chrome 真实 NVR HEVC 1/1 通过，6.0 秒；解码帧继续增长至 33，停止 DELETE 204、列表 404，无页面错误。仅为短验收，滚动稳定性由双编码合成专项与 Safari 原生观察分开覆盖 |
| `pnpm build` | 通过；生产编译 711ms、TypeScript 1876ms、静态页面 5/5 |

边界：本轮真实源为单路 HEVC；H.264 的 Safari 证据使用合成素材。Chrome 保留 12 秒已播放缓冲覆盖当前已测 3 / 4 秒 GOP，不承诺任意超过 12 秒的 GOP。起播耗时是本机两次对照，不是所有网络/设备的上限；多路负载、声音人工验收、休眠恢复和长期稳定性继续保持待验证。真实检查禁用截图、视频和 trace，只记录媒体时序及资源状态。

交付清理复核：FFmpeg 进程计数为 0，4317 / 4318 临时诊断端口均未监听，`public` 中无临时 Safari 页面；现有开发实例保留且 `/api/health` 返回 `{"status":"ok"}`。最终 `git diff --check` 通过。
