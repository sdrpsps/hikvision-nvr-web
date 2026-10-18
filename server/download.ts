import { XMLBuilder } from "fast-xml-parser"
import type { NvrConfig } from "./config"
import { digestAuthorization, parseChallenge } from "./digest"
import { AppError } from "./errors"
import { validatePlaybackUri } from "./recordings"

// Credentials and the original playback URI never leave this server-side request.
export async function openRecordingDownload(
  uri: string,
  config: NvrConfig,
  signal: AbortSignal,
  fetcher: typeof fetch = fetch
): Promise<Response> {
  validatePlaybackUri(uri, config)
  const path = "/ISAPI/ContentMgmt/download"
  const body = new XMLBuilder({ ignoreAttributes: false }).build({
    downloadRequest: {
      "@_version": "1.0",
      "@_xmlns": "http://www.isapi.org/ver20/XMLSchema",
      playbackURI: uri,
    },
  }) as string
  const url = `${config.NVR_HTTP_SCHEME}://${config.NVR_HOST}:${config.NVR_HTTP_PORT}${path}`
  let authorization: string | undefined
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      const response = await fetcher(url, {
        method: "POST",
        body,
        redirect: "manual",
        signal,
        headers: {
          "Content-Type": "application/xml",
          Accept: "application/octet-stream",
          ...(authorization ? { Authorization: authorization } : {}),
        },
      })
      if (response.status === 401) {
        const challenge = response.headers.get("www-authenticate")
        await response.body?.cancel()
        if (
          attempt === 2 ||
          (attempt === 1 && !/stale\s*=\s*"?true/i.test(challenge ?? ""))
        )
          throw new AppError("NVR_AUTH_FAILED", 502, "设备录像下载认证失败。")
        authorization = digestAuthorization(
          parseChallenge(challenge),
          config.NVR_USERNAME,
          config.NVR_PASSWORD,
          "POST",
          path
        )
        continue
      }
      if (
        !response.ok ||
        !response.body ||
        /xml|json|text\//i.test(response.headers.get("content-type") ?? "")
      ) {
        await response.body?.cancel()
        if (response.status === 403)
          throw new AppError("NVR_FORBIDDEN", 502, "设备账户没有录像下载权限。")
        throw new AppError(
          "NVR_DOWNLOAD_FAILED",
          502,
          "设备未返回可用的录像数据。"
        )
      }
      return response
    }
    throw new AppError("NVR_AUTH_FAILED", 502, "设备录像下载认证失败。")
  } catch (error) {
    if (error instanceof AppError) throw error
    if (signal.aborted)
      throw new AppError("MEDIA_CANCELLED", 503, "录像请求已取消或超时。")
    throw new AppError(
      "NVR_UNREACHABLE",
      502,
      "无法读取设备录像，请检查网络后重试。"
    )
  }
}
