<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Agent 工作约定

适用于仓库根目录及所有子目录。开始任务前阅读本文件和 `README.md`，以用户当前明确需求为准。当前功能已基本够用，默认以问题修复和必要维护为主，不主动扩展功能、替换项目或补齐所有待验收项；不自行重建 `docs` 或新增开发计划、验证流水文档。

## 工作要求

1. 先检查实际代码、依赖、相关测试与失败日志，再说明最小修改范围和验收方式；不假定文件或命令存在，不为重构而重构。
2. 修改时考虑正常、空结果、错误输入、网络/认证失败、超时、取消和资源清理，保留用户已有改动，不覆盖无关文件。
3. 网页联调使用 `pnpm dev` 和热更新，优先复用已有开发服务。文件监听受限时先处理运行环境，避免每轮修改反复构建。
4. 功能改动运行相关测试、`pnpm typecheck` 和 `pnpm lint`；生产构建留到交付验收或生产问题排查。仅文档改动检查内容、链接与差异，不为此取流或重跑功能测试。
5. 只报告实际执行的结果，区分自动测试、实机验证、待验证和阻塞；模拟通过不等于实机通过，未启用不算通过，分批回归不称为单次全量通过。
6. 使用中文汇报改动文件、关键决策、检查结果及遗留问题，区分事实、未联调实现与排障假设。阻塞时保留已完成工作并说明最小下一步；使用方式或长期约束变化时才更新 README 或本文件。
7. 只在明确授权范围内操作设备，不擅自升级固件、删除录像、修改其他设置或执行破坏性 Git 操作。通道改名功能已有授权，真实写入验收仍须有用户指定的通道和名称。
8. 用户仅说“继续”时，结合最近任务和当前代码推进明确的遗留问题；没有明确任务时确定方向，不把已知限制当作新功能或反复取流的授权。

## 代码风格与模块长度

- 按功能职责、变化原因和状态/资源所有权组织代码，由 Agent 主动判断拆分价值，不把判断逐文件交给用户。前端约 250 行、后端约 500 行是审查参考；未达到该长度但混杂独立功能或重复业务规则，也应考虑拆分或提取辅助函数。同一完整流程可以适当超过参考长度。
- 拆分应让一个功能能够独立理解，或让同一语义的公共逻辑只维护一份；优先复用已有组件、hooks 和依赖库。相关状态及其创建、更新、取消、清理应归同一模块所有，避免把同一闭包或生命周期切成跨文件读写大量共享状态的函数。
- 提取前确认职责边界和实际使用方。仅因行数而搬方法、建立纯透传层、传递庞大参数包，或使理解同一流程需要频繁跨文件跳转时，应保留在原处或合并。短函数可以留在所属功能文件中，不要求一函数一文件；类似实现只有业务语义一致时才共用，保留不同调用场景的错误与资源策略。
- 统计实际物理行，包含空行与注释。禁止把多行语句、条件分支、JSX、类型声明或其他代码压缩为一行来规避限制；保持正常格式，完成后用项目 Prettier 格式化改动代码。
- `pnpm lint` 对前端及共享业务代码超过 250 行、后端与维护脚本超过 500 行给出审查提示，不以行数通过作为维护性验收结论；同一行堆叠多条语句仍报错。`components/ui/` 中的 shadcn 基础组件保持上游组织方式，不纳入这些检查；测试、生成文件和样式文件不按业务模块的行数参考机械拆分。汇报以功能边界、复用收益和行为验证为主，不用入口行数下降代替改进说明。

## Skills

- 先检查可用 Skill 的用途与触发条件，选与任务最匹配的少数几个；使用前读取对应 `SKILL.md` 并遵循其工具和验证流程，不为使用而使用。
- 文档、PDF、表格或演示文稿任务优先匹配对应 Skill，普通 Markdown 不强行走文档转换流程。
- Skill 不可用或环境不满足时说明限制并采用可靠的常规方式，不因此阻断任务；不擅自创建或更新 Skill。
- Skill 不覆盖用户明确需求、设备操作边界、隐私保护和测试真实性要求。

## 技术与产品边界

- 沿用 Next.js App Router、React、TypeScript、pnpm 和 Zod；Hono 挂载于 `app/api/[[...route]]/route.ts`，仅一个 Next.js 实例、Node.js Runtime，Route Handler 只适配请求，设备业务位于 `server/`。
- UI 沿用 shadcn/Base UI、Sonner；业务请求使用 TanStack Query hooks，保留契约校验、取消和超时，不自动重试或因窗口聚焦刷新。nuqs 保存页面选择，打开页面/链接不自动取流。
- 不做网页登录、用户账号或应用登录会话鉴权；NVR 参数与凭据仅从服务端环境变量读取（本地可用 `.env`），保留设备 Digest 认证。开发和生产启动使用 Next.js 默认监听地址。
- 实时源为 RTSP；历史回放在设备明确支持时使用 SHTTP 按时间取流，明确不支持时保留 ISAPI HTTP 文件下载，片段保存仍走原文件下载。服务端只做 stream copy/封装，H.264/H.265 和 G.711 由浏览器本机处理，不自动回退到服务端转码。
- 浏览器 Worker 增量封装 MKV，保存任务跨应用内导航存活；观看倍速、暂停或静音不改变成品。当前 A/B 导出仅限文件相对时间，不承诺北京时间精确裁剪或跨文件导出。
- NVR 继续负责录像和存储。除通道改名外只读访问设备；改名通过显式 `SrcChannel` 映射读取单通道原配置，仅修改 `name`、PUT 后读回确认，不修改 OSD 或其他字段。

## 设备与时间兼容

- XML 使用解析器处理命名空间、实体和可选字段；保留原厂 `searchResultPostion` 拼写。处理搜索分页、重复段与缺口；`Enable=false` 不代表没有录像，搜索编码不能代替实际媒体编码。
- 查询和显示默认 `Asia/Shanghai`，内部/API 使用 UTC，不依赖系统本地时区。`NVR_RECORDING_TIME_MODE=device-local` 仅在搜索边界适配带 Z 的设备本地时间，显式偏移保持原义；标准 UTC 固件可用 `utc`。
- 按完整 `fileRange.startAt` 计算媒体偏移，不使用被查询边界裁剪的起点。设备标签映射不等于已验证 OSD 秒级绝对精度。
- SHTTP 通道通过可信 `SrcChannel` 和设备能力映射，不硬编码起始通道；SDK 起止时间按 `NVR_TIME_ZONE` 的本地墙钟编码。按 HK/PS 时钟及首个 IDR 内容证明实际媒体零点，不把请求时刻当作返回首帧时间；绝对时钟仅秒级精度。重新定位须先确认释放旧会话，设备声明支持后的认证、协议或时钟错误不得静默回退整文件下载。
- 标准历史 RTSP 仍阻塞于 DESCRIBE 400，不影响已有 HTTP 回放。仅在任务需要且有新证据或具体新方法时诊断；原始 URI 为基线，一次只改一个变量，未解码验证不得声称该路径可用。

## 安全与资源

- 浏览器不直连 NVR 管理接口，不接触设备密码或原始媒体 URI。API 不接受任意设备主机/媒体 URL，源仅来自服务端配置和可信查询；保留同源检查与输入校验。
- 不提交真实 `.env`，不硬编码设备地址、账号或私有标识，不在响应/日志中泄露凭据、Authorization、原始播放 URI、序列号或 MAC。诊断输出脱敏；未经同意不采集、保存或外发真实画面、声音及设备日志。
- 媒体会话保留超时、TTL、并发/容量上限与取消/关闭/失败清理；子进程使用安全参数数组，不用 Shell 拼接外部输入。资源默认值以 `server/live.ts`、`server/playback.ts`、`server/transfer.ts` 为准。
- 历史回放允许受控私有临时分片支持 seek，浏览器保存成品不在服务端生成；不能把保存链路不落盘描述为所有回放不落盘。
- 应用用于受信任网络；不直接公开 NVR 管理/RTSP 端口。若部署网络或反向代理访问限制，应覆盖页面、API 和媒体资源；同源检查不等于身份鉴权。
