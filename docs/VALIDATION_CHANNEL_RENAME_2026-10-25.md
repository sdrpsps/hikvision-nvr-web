# 通道名称修改验证 — 2026-10-25

## 范围与实现

用户明确要求增加海康通道名称修改，本次作为设备只读边界的有限例外；其他设备配置写入仍未开放。历史 RTSP 阻塞状态保持。

接口依据：海康编写的 [Intelligent Security API (General Application) Developer Guide](https://raw.githubusercontent.com/loozhengyuan/hikvision-sdk/master/resources/isapi.pdf)，15.2.8 / 表 15-11、15-12：`GET/PUT /ISAPI/ContentMgmt/InputProxy/channels/<ID>`，配置结构为 `InputProxyChannel`、名称为 `name`。此处是公开镜像中的原厂文档；不能仅凭文档认定当前固件已验证写入。

- 前端：实时页通道右侧及回放页工具栏的铅笔入口；shadcn Dialog / Field / Input，TanStack Query mutation，不自动重试；保存期间禁用重复操作及关闭，失败保留输入并使用 Sonner 提示。成功重新读取共享通道缓存，更新实时窗口和回放选项。
- 共享契约：名称去除首尾空白，非空、保守限制 32 UTF-8 字节，拒绝控制字符、非法 XML 字符及额外字段。该上限是应用保守限制，不代表已读取设备能力集。
- 本应用接口：`PUT /api/channels/:trackId/name`，JSON `{ "name": "新名称" }`。Hono 限制请求大小、来源和字段；Next.js Route Handler 仅转发 PUT。
- 设备链路：重新读取录像轨道，通过显式 `SrcChannel` 找到数字通道；映射缺失/轨道不唯一则拒绝。GET 单通道原配置，XML 解析和构建保留顺序、命名空间、属性及未知配置，仅替换直接子元素 `name`；Digest PUT 后校验 `ResponseStatus`，再次 GET 核对保存结果。已有同名则跳过 PUT。
- 不返回设备配置、源地址或凭据；只返回应用轨道 ID 和确认后的名称。设备写操作串行化，成功与失败后都清除服务端通道缓存。未加入 OSD 叠字修改。

## 已验证（自动测试）

| 命令 | 结果 |
| --- | --- |
| `pnpm test` | 18 个文件、254 项通过；含新增改名测试 |
| `pnpm typecheck` | 通过 |
| `pnpm lint` | 通过 |
| `git diff --check` | 通过 |
| `pnpm build` | 通过；Next.js 16.4.1，静态页面 5/5 |
| `TEST_BASE_URL=http://localhost:3000 pnpm exec playwright test tests/browser/channel-rename.spec.ts --workers=1` | 新增桌面/手机两项通过 |
| `TEST_BASE_URL=http://localhost:3000 pnpm exec playwright test tests/browser/channel-rename.spec.ts tests/browser/live.spec.ts tests/browser/query.spec.ts tests/browser/console.spec.ts --workers=1` | 29 通过，2 项真实设备媒体测试未启用，约 1.6 分钟 |

覆盖显式源通道与轨道 ID 不相等、同源轨道名称刷新、命名空间与未知字段/属性保留、XML 特殊字符、UTF-8 边界、权限/认证/断网/超时失败、HTTP 200 内部错误、读回名称不一致、无映射/无轨道、并发拒绝、跨站/额外字段/坏 JSON/请求过大、Digest PUT 方法和正文保持以及路径白名单。

浏览器使用模拟设备 API 和既有合成媒体；覆盖前端输入校验、成功持久化模拟、共享名称刷新、回放入口、权限错误、取消恢复、提交中 Escape/重复提交阻止、390px 无横向溢出，以及原有播放器/查询回归。不能据此声称真实 NVR 已修改成功。

首次浏览器运行尝试启动 3100，因现有 Next.js 开发服务器锁未启动，之后复用 3000；沙箱中 Chrome 启动 SIGABRT，经沙箱外运行通过。未停止用户已有开发服务。

## 已验证（实机，只读）

通过读取 `.env` 的临时诊断脚本，使用现有 Digest 客户端 GET 录像轨道并选择显式关联的源通道，再 GET `/ISAPI/ContentMgmt/InputProxy/channels/<ID>`。确认：

- 轨道 `101` 存在显式源映射。
- 当前固件单通道配置可以读取，名称字段存在。
- 原配置可以通过只替换名称的 XML 构建器；未输出原始配置、名称或任何凭据。

该脚本已清除；诊断未发送 PUT，未改变真实通道名称。

## 待验证与下一步

- 用户通过铅笔入口保存实际需要的新名称，检查设备 PUT 成功且读回一致，再刷新页面/重启应用确认名称保持；当前账号的配置写权限和设备实际持久化尚未验证。
- Safari 的改名交互未实测。
- 部分固件对通道配置字段和名称长度可能有额外约束；设备拒绝时显示失败，不尝试其他设备写入路径或改动其他设置。

## 后续调整：仅在实时页提供改名

按用户最新要求，移除录像回放页的 `RenameChannel` 导入和工具栏入口；实时页仍可修改，回放页继续显示共享缓存中的最新名称。既有浏览器用例调整为在实时页覆盖保存失败，再导航回放页验证名称同步且不存在改名按钮。以上早期回放入口验收描述仅代表调整前状态。

调整后验证：`pnpm typecheck`、`pnpm lint`、`git diff --check` 通过；`TEST_BASE_URL=http://localhost:3000 pnpm exec playwright test tests/browser/channel-rename.spec.ts --workers=1` 两项通过（模拟 API，4.3 秒）。未访问真实设备。
