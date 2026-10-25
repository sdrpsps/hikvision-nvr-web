# 浏览器媒体封装引擎验证 — 2026-10-25

本记录只覆盖 `lib/media-export/` 媒体引擎与新增只读实机验证脚本。引擎不调用解码器/编码器，不创建完整 Blob；输入为增量媒体块，输出等待每次 writer 写入完成。浏览器界面、文件选择器、Service Worker 和 OPFS 验收由主任务单独记录。

## 自动测试

执行 `pnpm exec vitest run tests/media-export.test.ts`：9 项通过。

- H.264 / HEVC 视频 fMP4 与分离 G.711 MOV 增量解析、原码封装 MKV。
- ffprobe 确认编码、尺寸和时长，FFmpeg 输出的每一帧解码 hash 与源合成素材一致。
- MPEG-PS 解析覆盖 IMKH 前缀、跨网络块的包头、跨 PES 的 Annex B NAL、同 PES 多访问单元、HEVC B 帧、PTS/DTS 及 G.711 A-law。
- 保存后从 1.5 秒定位并解码成功。
- 不支持 seek 的顺序 writer 不写错误的 `Duration=0`，保留视频 DefaultDuration 和稀疏 Cues；输出逐帧解码 hash、完整三秒媒体时间范围和定位解码通过。**限制：ffprobe 的 format.duration 可能未提供；任务统计时长仍准确，不能声称所有播放器会立即显示总长。**
- 音频先到三秒、视频只接受一秒的场景，输出容器时长恰好一秒；超前音频使用最多 2 MiB 队列，并裁剪到已接受的视频结束位置。
- 拒绝缓冲越限、截断媒体和没有完整关键帧的录制，传播磁盘写入失败。

`pnpm exec eslint lib/media-export scripts/verify-export-media.ts tests/media-export.test.ts` 与 `pnpm exec tsc --noEmit` 通过。

## 只读真实设备媒体

执行：

```sh
pnpm exec tsx scripts/verify-export-media.ts 101 2026-10-17 10 both
```

脚本从服务端配置读取连接参数；历史路径通过 `NvrService.recordings`、`resolveSegment` 和 `openRecordingDownload` 取得可信源，实时路径请求本机开发服务器 `/api/transfers/live`。与浏览器相同的 TypeScript 引擎在 Node 中处理媒体块，流式写入权限 0700 的 `/private/tmp` 目录及权限 0600 的文件。ffprobe 只返回脱敏编码/尺寸/数值；FFmpeg 本机解码到 null，不显示或保存解码画面和声音。成功/失败均删除真实媒体临时目录。

修复音频超前问题后的结果：

| 路径 | 源读取量 | MKV 大小 | 视频包数 | 成品时长 | 编码 | 解码 |
| --- | ---: | ---: | ---: | ---: | --- | --- |
| 原始历史 PS | 1,531,816 B | 1,339,496 B | 300 | 11.999999 秒 | HEVC，2560×1440；G.711 A-law，8 kHz 单声道 | 音视频无错误 |
| 实时 framed fMP4 / MOV | 1,224,253 B | 925,305 B | 300 | 12.000000 秒 | HEVC，2560×1440；G.711 A-law，8 kHz 单声道 | 音视频无错误 |

目标范围为文件内部前十秒，输出延伸到下一个关键帧，实际约十二秒。以上为**已验证（实机媒体）**，没有验证文件画面与北京时间钟表时刻的精确对应。音轨检查不等于人工听音验收；本条也不等于浏览器已通过验收。

初次实时验证发现视频 GOP 输出延迟时音频先抵达，文件原本会比已保存视频多出数秒。修复后，音频按已接受视频末尾限量排队和裁剪，双链路复验均为十二秒。所有真实临时媒体已经删除，脚本最终输出 `realMediaTemporaryFilesRemoved=true`。

脚本增加成品两秒位置的定位解码检查后，重跑 `pnpm exec tsx scripts/verify-export-media.ts 101 2026-10-17 10 history`：十二秒 HEVC / G.711 成品整体解码和定位解码均无错误，输出 `seekDecodedWithoutErrors=true`，真实媒体再次清理。

引擎启动媒体缓冲上限 16 MiB、超前音频队列上限 2 MiB、稀疏索引最多 2048 项。此记录确认实现边界及短时真实媒体正确性，长时间真实浏览器内存峰值、系统休眠和崩溃恢复需要主任务另行验证。
