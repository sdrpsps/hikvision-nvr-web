# nuqs URL 状态 — 2026-10-25

## 范围

按用户要求加入 nuqs，将页面中可恢复的选择保存到 URL。属于 P0 查询状态及 P2 实时布局的小范围增强，不改变设备接口和媒体处理路径，也不访问真实 NVR。

采用 `nuqs@2.10.2` 和 Next.js App Router 的 `NuqsAdapter`，参考 [适配器文档](https://nuqs.dev/docs/adapters)、[批量状态文档](https://nuqs.dev/docs/batching) 和 [选项文档](https://nuqs.dev/docs/options)。已读取仓库本地 Next.js `use-search-params` 指南，为两个页面入口加入 Suspense；保存任务 Provider 位于边界外，浅层 URL 更新不会卸载任务。

## 参数与行为

| 页面 | 参数 | 校验及默认值 |
| --- | --- | --- |
| 回放 | `track` | 合法数字轨道 ID；缺省/设备不存在时首个可用轨道 |
| 回放 | `date` | 严格合法 `YYYY-MM-DD`；保留字符串，缺省为服务端设备时区今日 |
| 回放 | `zoom` | 1 / 2 / 4，默认 1 |
| 实时 | `layout` | 1 / 2 / 4 / 8 / 16，默认 4 |
| 实时 | `window` | 1–16，默认 1；显示时限制在当前分屏内 |
| 实时 | `sidebar` | 严格接受 true / false，默认 true |
| 实时 | `slots` | `1:201,2:101,3:0`；从 1 开始的窗口号，0 表示明确不分配；最多 16 项、240 字符，拒绝重复窗口和非法轨道 |

- 使用 `useQueryStates`，shallow 更新、保持滚动位置。
- 回放切换通道/日期使用 push，允许前进后退；缩放和实时布局/窗口/分配/通道栏使用 replace，避免每次细微调整增加历史项。
- 回放操作把当前有效通道和日期一并写入 URL；空地址仍表示动态今日。默认布局、缩放等通常省略。
- URL 无效内容不会传给设备 API；现有服务端校验保持。失效实时通道显示未分配。
- 不保存名称、设备地址、凭据、原始媒体 URI、会话、片段、声音、倍速、播放进度或录制任务。打开/刷新链接只恢复选择，播放和录制仍由用户启动。
- 顶部页面导航保留原有默认地址，不额外记忆另一页面的查询；完整链接和浏览器历史负责恢复。

## 验证

- `pnpm test`：19 文件、257 项通过，包含 URL 日期/轨道/窗口/分屏/缩放/布尔及分配解析测试。
- `pnpm typecheck`、`pnpm lint`、`git diff --check`：通过。
- `pnpm build`：Next.js 16.4.1 生产构建通过，5/5 静态页面。
- 新增浏览器用例覆盖回放链接、通道/日期前进后退、刷新恢复、缩放、实时分配/通道栏/分屏恢复，以及非法参数回退和不自动取流。

首轮定向测试：15 通过、1 实机未启用、1 失败。失败发现 nuqs 内置布尔解析把任意非 true 字符串解释为 false，已改为严格解析并增加断言；最终完整回归通过，结果如下。

最终命令：`TEST_BASE_URL=http://localhost:3000 NVR_INTEGRATION=0 RUN_NVR_SAVE_TESTS=0 RUN_NVR_LONG_SAVE_TESTS=0 pnpm exec playwright test --workers=1`。**68 通过、8 项实机测试未启用，约 3.0 分钟**。包含三个新增 URL 状态用例，以及改名、查询取消/错误恢复、两种视频编码、实时 16 路合成解码、回放/连续播放、录制/下载、全屏和导航回归。没有重新请求真实媒体。

安装时复用项目既有 pnpm store，仅新增 nuqs 及 `@standard-schema/spec`；没有升级其他依赖。`pnpm peers check` 仍报告已有 vitest 5 与 `@types/node` 20 的 peer 范围不匹配，未扩大任务升级该依赖；本轮全部实际自动检查结果如上。

## 验收边界

自动测试使用模拟 API 与合成媒体，真实设备、Safari 历史导航未在本轮实测。设备名称写入、历史 RTSP 和其他既有未验收项不因本次 URL 状态接入而提升结论。
