import type { LocalDirectory, LocalFile, SaveDestination } from "./types"
import { downloadDestination } from "./download-destination"
export { releaseDestination } from "./download-destination"

type PickerWindow = Window & {
  showSaveFilePicker?: (options: unknown) => Promise<LocalFile>
  showDirectoryPicker?: (options: unknown) => Promise<LocalDirectory>
}

export function saveCapability() {
  if (typeof window === "undefined") return "pending"
  if (!window.isSecureContext) return "insecure"
  if ((window as PickerWindow).showSaveFilePicker) return "direct"
  return "serviceWorker" in navigator ? "download" : "unsupported"
}

export async function chooseDestination(
  id: string,
  filename: string,
  segmented: boolean
): Promise<SaveDestination> {
  const capability = saveCapability()
  if (capability === "insecure")
    throw new Error("直接写盘需要 HTTPS；本机调试请使用 localhost 地址。")
  if (capability === "unsupported")
    throw new Error("当前浏览器不支持流式保存，请使用最新版 Chrome 或 Edge。")
  const picker = window as PickerWindow
  if (segmented && picker.showDirectoryPicker)
    return {
      type: "directory",
      directory: await picker.showDirectoryPicker({
        mode: "readwrite",
        id: "nvr-recordings",
      }),
    }
  if (picker.showSaveFilePicker)
    return {
      type: "file",
      file: await picker.showSaveFilePicker({
        suggestedName: filename,
        id: "nvr-clips",
        types: [
          {
            description: "保留原始音视频的 MKV 录像",
            accept: { "video/x-matroska": [".mkv"] },
          },
        ],
      }),
    }
  return downloadDestination(id, filename)
}
