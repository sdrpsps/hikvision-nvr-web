# 海康 NVR 录像控制台

Next.js App Router + Hono + TypeScript，保留现有录像机的存储和录制方式。

**只启动一个 Next.js 实例。** `app/api/[[...route]]/route.ts` 将 Web Request 交给 Hono；设备查询、Digest、XML、分页和错误处理都在 `server/`，共享 Zod 契约在 `shared/`。

目前可读取设备概要、录像轨道、按设备日期检索录像并查看全天时间轴、缩放和片段信息。历史 RTSP 仍在 DESCRIBE 阶段返回 400，页面没有播放功能。设备当天返回的 Z 时间戳还存在约 8 小时的语义疑点，页面会提示未来录像时间异常。

## 本地运行

需要 Node.js 20.9+、pnpm。FFmpeg/ffprobe 仅用于本地 P1 诊断，不是查询页面的运行依赖。

```sh
pnpm install
cp .env.example .env
# 在本机编辑 .env，填写 NVR_HOST、NVR_USERNAME、NVR_PASSWORD 等。
pnpm dev
```

已有 `.env` 时直接编辑，勿覆盖。服务默认绑定 `127.0.0.1:3000`；端口占用时 Next.js 会选择其他端口。

按用户当前要求暂不实现前端鉴权。此版本仅用于受信任的本机验证，部署、HTTPS 和鉴权属于尚未完成的 P3。

生产构建与启动也只有一个实例：

```sh
pnpm build
pnpm start
```

环境变量说明见 `.env.example`。`NVR_HOST` 只接受主机名或 IP，不接受 scheme、路径、凭据或任意客户端 URL；所有 NVR 参数仅在服务端读取。修改设备配置后重启服务。

## API

| GET | 返回内容 |
| --- | --- |
| `/api/health` | API 存活；不连接设备 |
| `/api/device` | 型号、固件，不包含序列号或 MAC |
| `/api/channels` | 轨道、配置启用状态、设备时区和当天日期 |
| `/api/recordings?track=<id>&date=<YYYY-MM-DD>` | 原始片段时间、匿名 ID、编码、覆盖区间、未覆盖区间、时间异常提示 |

`Enable=false` 不过滤轨道。搜索保留 `searchResultPostion` 原厂拼写；XML 实体由解析器处理。查询按配置时区转换为 UTC，API 区间为左闭右开。原始 `playbackURI` 仅留在本地查询/诊断的内存中，不返回浏览器。

搜索每页 40 段，最多 100 页、2 个并发查询；检测重复和不推进的分页，异常时不返回不完整的成功结果。单次 ISAPI 请求默认超时 8 秒，搜索总时限约 30 秒（当前页请求可再占用一次请求超时）。轨道缓存 20 秒，结果缓存 30 秒、最多 32 项；相同查询合并，原始 URI 不进入响应缓存。

## 验证与排障

```sh
pnpm test
pnpm typecheck
pnpm lint
pnpm test:e2e
pnpm verify:device 101 2026-10-17
pnpm diagnose:rtsp 101 2026-10-17 0 --live-control
```

浏览器测试使用本机 Chrome。默认只跑模拟数据场景，真实设备用例需显式启用：

```sh
# 使用已在运行的同一实例（根据实际端口调整 TEST_BASE_URL）。
TEST_BASE_URL=http://127.0.0.1:3000 NVR_INTEGRATION=1 pnpm test:e2e
```

未启动服务时 `pnpm test:e2e` 会启动本机 3100 端口；已有 dev 实例时须设置 `TEST_BASE_URL`，避免 Next.js dev 锁冲突。

`verify:device` 仅读取设备信息、轨道、录像和设备时钟，输出脱敏摘要。`diagnose:rtsp` 重新查询真实片段，先跑未改写 URI；输出 OPTIONS/DESCRIBE/SETUP/PLAY 的阶段码，不输出原始 URI、认证头、SDP 或视频。诊断失败/缺少工具退出码 1，历史源仍阻塞退出码 2。

诊断将取流地址写入权限为 0600 的短期本地 ffconcat 清单，凭据不进入进程参数；工具输出只在有上限的内存中解析，每个子进程最多运行 25 秒，并在正常退出、超时及处理 SIGINT/SIGTERM 后清理。只解码到 null，不保存画面或录像。强制杀死整个 Node 进程或机器断电无法保证 finally 执行，如发生异常中断，应在本机检查系统临时目录 `nvr-rtsp-*` 的残留。

已完成和待验证项目见 [开发计划](docs/DEVELOPMENT_PLAN.md)，实机证据见 [2026-10-18 验证记录](docs/VALIDATION_2026-10-18.md)。
