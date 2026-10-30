# 海康官方插件 DLL 解包与静态分析指引

本指引长期保留分析方法、样本身份、可复查入口和结论边界，不维护优化任务状态或验收流水。整理日期：2026-10-30（Asia/Shanghai）。地址只适用于下列固定样本，换版本必须重新定位。

## 安全边界与证据等级

- 默认只读静态分析，不执行安装包、DLL、Wine 或插件，不注册组件，不启动原厂本地服务。只研究公开软件，不绕过设备认证。
- 安装包、解压文件、反汇编和研究脚本放仓库外隔离目录，不提交 DLL、安装包或真实设备数据。不上传二进制至第三方在线反编译服务；遵守软件及工具许可。
- 分析指引不是设备操作授权。取流前另行明确范围；不升级、重启、写配置或删除录像。保留项目的凭据、媒体隐私、stream copy 和资源清理约束。
- 导出名/字符串只是线索；调用链确认属于静态证据；模拟协议通过只证明本地实现；目标设备接受并返回正确可解码媒体才属于实机证据。分别报告，不跨级推断。
- 研究产物可含公开软件内部字符串，但不要夹入真实设备地址、凭据、原始媒体 URI、设备日志、画面或声音。生产观测不输出媒体 hash。

## 一、固定样本与现存材料

官方来源：[LocalServiceComponents.exe](https://hikdownload.ys7.com/web/webplugin/windows/local-service-components/v1.0.0.0/standard/LocalServiceComponents.exe)。URL 不等于不可变版本，以 SHA256 识别；哈希一致性不是 Authenticode 签名验证。本轮没有执行安装包或验证签名。

已有研究目录：`/private/tmp/hik-static-localservice-1Y2tRF`。临时目录可能被系统清理，不能作为永久依赖；不存在时按后续步骤重新取公开样本并核验。目录中的编号是先前提取时的本地命名，不是厂商组件编号。

| 文件                         | PE 导出表模块名         | 大小（字节） | 职责                            |
| ---------------------------- | ----------------------- | -----------: | ------------------------------- |
| `LocalServiceComponents.exe` | 安装包                  |     13128176 | Inno Setup 容器                 |
| `filtered-20.dll`            | `NetStream.dll`         |       512000 | 会话、SHTTP、下载和本地播放协调 |
| `filtered-28.dll`            | `StreamTransClient.dll` |       720896 | RTSP/RTP 传输                   |
| `filtered-32.dll`            | `video_control.dll`     |      1060352 | 上层 JSON/UI 命令适配           |
| `filtered-22-playctrl.dll`   | `PlayCtrl.dll`          |      6552064 | 本地解码、帧与显示控制          |

2026-10-30 重新计算的 SHA256：

```text
d543a5db2b7397b5432703bbf8d712dc5b0eaae8e4f85a4fd1fecdd16d1ad93d  LocalServiceComponents.exe
ca7f535679dfae47cd30a439d53d0e817aad30de974065ebf81f58a5bdf31b39  filtered-20.dll
fa1f6089296caf2126cd84c448980121188de74ecbb100fc06307504304bbf52  filtered-28.dll
091dfa0881f4c0e2647a4157f026a0a616c38108ed0613540f8352b5d3cd958b  filtered-32.dll
7d24d523ce8c40b10410aab4e2b11d3693833c4097fd353febace51388dfd4c9  filtered-22-playctrl.dll
```

这些 DLL 是 PE32/i386，ImageBase 均为 `0x10000000`。同一虚拟地址在不同 DLL 中含义不同；引用证据必须包含模块、样本哈希、VA 和上下文。

现有 `netstream.disasm.txt`、`streamtrans.disasm.txt`、`video_control.disasm.txt` 对应已还原的 filtered 样本。`solid-stream.bin` 是已有解压中间产物；`carve-*.dll` 只是初步切出的 PE，不能作为调用目标地址的可信依据。

## 二、优先使用成熟解包器

先核查已有工具，不为静态分析擅自安装依赖、提升权限或运行原厂软件。本轮环境没有 `innoextract`，因此下列标准解包流程只核对了上游文档，未在本轮执行；当前可复查的是上节的既有提取物。

[innoextract 官方说明](https://constexpr.org/innoextract/)与[参数手册](https://constexpr.org/innoextract/innoextract.1)说明其可不运行安装程序而提取 Inno Setup 内容。获得合适工具后，在仓库外新建工作目录操作，例如：

```sh
WORK="$(mktemp -d /private/tmp/hik-dll-analysis.XXXXXX)"
curl --fail --location \
  'https://hikdownload.ys7.com/web/webplugin/windows/local-service-components/v1.0.0.0/standard/LocalServiceComponents.exe' \
  --output "$WORK/LocalServiceComponents.exe"
shasum -a 256 "$WORK/LocalServiceComponents.exe"
file "$WORK/LocalServiceComponents.exe"
```

确认哈希匹配后，先检查工具帮助和列表，再提取；不要因为文件扩展名是 EXE 就运行它：

```sh
innoextract --version
innoextract --help
innoextract --list "$WORK/LocalServiceComponents.exe"
innoextract --extract --output-dir "$WORK/unpacked" \
  "$WORK/LocalServiceComponents.exe"
rg --files "$WORK/unpacked" | rg -i '(NetStream|StreamTransClient|video_control|PlayCtrl)\.dll$'
```

重新计算目标 DLL 哈希、解析 PE 模块名，并确认架构和 section 后才使用本文地址。如果哈希不匹配，先排查提取流程或样本版本；不要强行套用地址，也不要对成熟解包器的输出再次盲目执行指令过滤。

## 三、解包失败时的人工还原路径

仅在成熟解包器失败且任务确有必要时采用。当前目录保留了先前研究时参考的 `inno-block.cpp`、`inno-chunk.cpp`、`inno-filter.cpp`、`inno-exefilter.hpp`，但没有完整可直接重跑的自定义解包脚本。本节是重建路径，不是假称已有一键复现工具。

1. 识别容器：此固定安装包可见 `Inno Setup Setup Data (5.3.5)`。结合元数据解析 chunk/file 条目，不靠一个 `zlb` 或 `MZ` 字符串就猜偏移。
2. 还原压缩流：参考 innoextract 的 block/chunk reader，正确处理块边界、长度、压缩方式及校验；不能把整段 payload 随意交给通用解压器后忽略尾部或错误。
3. 提取文件：从 solid stream 按文件元数据取范围。若只能扫描 PE 候选，必须验证 `e_lfanew`、PE 签名、section 表、原始数据边界与导出模块名，不能把映像 `SizeOfImage` 当磁盘文件长度。
4. 还原指令过滤：Inno 为压缩可变换 x86 CALL/JMP 操作数。只切出 PE 可能依然能看到正确字符串、导出名，但反汇编 CALL/JMP 目标是错的。应按文件元数据选择过滤器，并在每个文件起点重置其状态，不在整个 solid stream 上一次性过滤。
5. 校验结果：以文件校验值、上节已知哈希及正常的控制流交叉检查。未通过时停止调用链推理，不用“函数名看起来正确”替代验证。

过滤算法参考上游 [exefilter.hpp](https://github.com/dscharrer/innoextract/blob/master/src/stream/exefilter.hpp)。其中 5200 解码器和 5309 的高字节处理不同，不能一律使用同一布尔选项；应依据实际文件过滤类型。复刻时保留工具许可，并记录实际使用的上游提交，不把浮动 `master` 当固定算法版本。

公开结构参考入口为 [innoextract 源码](https://github.com/dscharrer/innoextract)，优先搜索 `chunk_reader::get`、`file_reader::get`、`InstructionFilter5200`、`InstructionFilter5309`。本地参考文件名不保证与上游当前路径一一相同。

## 四、从入口追到真正的网络或解码行为

只读复查现有样本：

```sh
ROOT=/private/tmp/hik-static-localservice-1Y2tRF
shasum -a 256 "$ROOT/filtered-20.dll"
strings -a "$ROOT/filtered-20.dll" | rg -i 'sdk/play|pause|resume|reconnect|buffer'
rg -n 'NS_Pause|NS_Resume|NS_SetDisplayBuf|NS_SetReconnectInfo' \
  "$ROOT/netstream.disasm.txt"
/usr/bin/objdump -d --x86-asm-syntax=intel \
  --start-address=0x10029951 --stop-address=0x100299c1 \
  "$ROOT/filtered-20.dll"
```

当前 macOS `/usr/bin/objdump` 使用 LLVM 实现；其他平台先查帮助，不照搬不支持的参数。可以使用已有 Ghidra 等本地静态工具，但不因此执行 DLL 或开真实设备调试。

分析顺序：

1. 解析 PE export/import、模块名、section 和 ImageBase；字符串搜索只用于找入口。需要 UTF-16 字符串时使用支持的本地工具，不假定 ASCII 搜索涵盖所有内容。
2. 从导出/上层 JSON 方法追到管理器、会话对象、协议分支，再判断是 socket 发送还是本地播放库 vtable 调用。
3. 对发送器核查命令白名单、包长、大小端、参数来源、类型检查和错误返回；同值出现不等于同协议，找不到 ACK 不承诺成功。
4. 做字符串交叉引用时，先将文件偏移映射成 RVA/VA，不能把 `strings` 的文件偏移当反汇编地址。通常 `VA = ImageBase + RVA`，磁盘偏移需按所属 section 换算。
5. objdump 对内部函数可能显示“最近的导出名+偏移”，不代表真实函数名；虚表槽位未识别时也不能凭槽位数猜语义。
6. 用上层 JS 的能力判断、参数转换和失败处理交叉验证，但保留 JS 版本来源差异。某后端方法可能只是空实现，名称存在不代表所有模式都有效。

每条结论至少附“模块身份、地址/入口、调用链、直接观察、未确认部分”。不往本指引持续追加逐次实验日志。

## 五、已确认的静态入口及误判防线

### SHTTP 回放控制

在固定 `NetStream.dll`：

| 行为       | 调用链或地址                                                  | 静态结论                                    |
| ---------- | ------------------------------------------------------------- | ------------------------------------------- |
| 暂停       | `NS_Pause 0x10019278 → 0x10021bd1 → 0x1001c492 → 0x10029951`  | 专用方法提交 `0x30107` 至发送器             |
| 继续       | `NS_Resume 0x10019397 → 0x10021d7a → 0x1001c573 → 0x10029989` | 专用方法提交 `0x30108` 至发送器             |
| 控制发送器 | `0x100287a0`                                                  | 正常控制包为 36 字节；检查参数与命令分支    |
| 特殊配置   | `0x30127` 分支，初始化调用附近 `0x1002a20b`                   | 60 字节包，疑似播放转换配置，不能标成 seek  |
| 关闭清理   | `0x100298b7`                                                  | 关线程/socket、释放缓存，不是继续或重新打开 |

暂停/继续方法检查内部类型 `0x3e9` 或 `0x3eb`，这些类型的完整语义与当前固件行为未确认。成功发送命令也不代表设备已经暂停媒体。

`NS_ChangeRange 0x100193db` 经过本地解码清理和 generic transport，尚未证明它能让 SHTTP 同连接 seek。现有按时间回放仍以释放旧会话后重新建流为准。

### 实时预览与缓冲

- `NS_SetDisplayBuf 0x1001965a → 0x100221e7 → 0x1001d996`：将配置限制在 1–50，保存到全局 `0x10067dd4`。`0x1001e11f` / `0x1001e815` 附近把该值交给本地解码对象，不是已确认的设备端低延迟命令。
- `NS_SetReconnectInfo 0x1001a0b9 → 0x10022e25 → 0x1001f02f`：末端检查并复制不足 256 字节的字符串，设置内部标志；不能把它直接解释为重试次数/间隔参数。
- `video_control.dll` 的 `VC_SetReconnectInfo 0x10088d10` 为上层入口，继续研究需还原 JSON 和实际回调语义，而非只凭重连日志制定自动重试策略。
- `PlayCtrl.dll` 的 `PlayM4_SetDisplayBuf 0x10132ff0`、`PlayM4_SetStreamOpenMode 0x1012ef40`、`PlayM4_SetSmartFirstKeyFrameDisplay 0x1013e670` 属本地播放库研究入口。不能直接搬到跨平台网页或认为设置它们就能让 NVR 立即发 IDR。
- NetStream 的 `PlayBackCtrl suspend/continue getting stream` 及约 0.8/0.9 的缓冲阈值出现在回放控制路径；不能把它们当作已经确认的实时低延迟算法。

官方 [预览结构说明](https://open.hikvision.com/hardware/v2/%E7%BB%93%E6%9E%84%E4%BD%93/NET_DVR_PREVIEWINFO.html)也区分协议、码流类型与播放库显示缓冲；不同 SDK 的编号不要混用。[实时数据回调示例](https://open.hikvision.com/hardware/definitions/NET_DVR_SetRealDataCallBack.html)将取流和 PlayM4 本地解码分开。

### 下载、逐帧与倒放

- NetStream：`NS_StartDownload 0x10019684`、`NS_StartDownloadEx 0x10019700`；`0x1001310b` 引用 `DoDownloadByTime` 日志。后续应追到请求构造、输入读取与本地筛选，未证明 HTTP Range 或设备按时裁剪。
- `NS_FrameForward 0x100193ca → 0x1001c982` 可见本地 decoder 调用；PlayCtrl 还有倒放、帧位置、系统时间等导出。导出存在不代表浏览器可直接逐帧或设备支持远程倒放。
- 设备 HK 绝对时钟精度仍按秒，不因 `GetOSDTime`、PTS 小数或本地系统时间接口而变为毫秒精度。

### 上层 JavaScript 对照

现有临时辅助材料，不作为可永久获取的源码：

| 文件                                                     | 搜索入口                                   | 用途                                                                         |
| -------------------------------------------------------- | ------------------------------------------ | ---------------------------------------------------------------------------- |
| `/private/tmp/hikvision-public-webVideoCtrl-readable.js` | `I_StartRealPlay`、`startShttpRealPlay`    | 能力支持且 TCP 时选 SHTTP，流索引与原生通道转换；路径模板 `/SDK/play/%s/004` |
| `/private/tmp/firmware-playback-readable.js`             | `createPlayBackUrl`                        | 回放原生通道与时间参数形成方式                                               |
| `/private/tmp/firmware-jsVideoPlugin-readable.js`        | `JS_SetReconnectInfo`、`aVideoFrameBuffer` | 不同播放后端、已解码帧缓冲；有的方法在特定后端为空实现                       |

这些 readable 文件并非全部来自本安装包，也不能一概称为当前设备固件的实现。缺失时从任务允许的公开 SDK 或既有获准材料重新确认来源，不自行连接设备下载固件资源，不假造其版本哈希。

## 六、与项目实现对照

- 实时：`server/live.ts` 管理 RTSP/TCP、copy 封装、起播门槛、滚动窗口和清理；`components/player/use-hls-media.ts` 决定 hls.js/原生 HLS；`lib/live-audio.ts` 负责 G.711 调度。
- 回放：`server/playback-capabilities.ts` 做可信通道能力映射，`server/shttp-replay.ts` 管理协议，`server/playback-input.ts` 接实际时钟，`server/playback-frame-proof.ts` 对首帧内容证明，`server/playback.ts` 管会话与临时分片。不要因新控制能力绕过既有校验。
- 下载：`server/download.ts`、`server/transfer.ts` 和 `lib/media-export/`，文件坐标和保存生命周期不能随观看窗口改变。
- 当前标准历史 RTSP 仍受 DESCRIBE 400 阻塞；没有新证据不重复排列请求，也不能把 SHTTP 成功报告为标准 RTSP 已打通。

## 七、如何验证后续实现

先做合成/模拟协议测试，再在明确授权范围内开展有时间、字节上限的单路实机；多路另行确认。任何阶段都要有取消、错误、超时和 `finally` 清理。只读分析本身不要求取流或重跑功能测试。

| 对象     | 脱敏观测                                                 | 不能替代的验收                                             |
| -------- | -------------------------------------------------------- | ---------------------------------------------------------- |
| 实时起播 | 首媒体/关键帧/分片、API ready、浏览器首显示耗时，p50/p95 | `200`、非空分片、`playing` 不等于已经显示正确帧            |
| 直播延迟 | 媒体边缘减播放位置、前向缓冲、卡顿、丢帧                 | 媒体落后量不等于摄像头到屏幕绝对延迟                       |
| 多路资源 | socket/FFmpeg 数量、CPU/RSS、流量，停止后恢复基线        | 逻辑缓存上限不等于实测 RSS；支持 16 窗口不等于已验证 16 路 |
| 回放控制 | 上游字节变化、保活、恢复耗时、时钟连续性                 | 命令发送成功不等于媒体停止；自然结束不等于覆盖完整         |
| 导出     | 读取字节量、实际覆盖、独立解码、音轨                     | 非空文件或 code 0 不等于内容、坐标正确                     |

观测仅记录白名单阶段、数字和错误枚举，不输出原始 FFmpeg 命令/stderr、设备响应、URI、认证信息或媒体 hash，不截图/录音。Chrome/hls.js 与 Safari 原生 HLS 分开验收；功能修改后按 AGENTS 执行相关测试、typecheck 和 lint，报告实际执行范围。

后续交接保持最小：给出固定样本身份、函数/源码入口、已确认事实、一个可证伪假设及成功/失败判据。稳定协议结论或使用方式变化才更新长期文档，不把本指引变成待办或逐次实验流水。
