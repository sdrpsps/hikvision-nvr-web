import type { NvrConfig } from "./config"
import { digestAuthorization, parseChallenge } from "./digest"
import { AppError } from "./errors"

const MAX_XML_BYTES = 4 * 1024 * 1024
export class IsapiClient {
  constructor(
    private config: NvrConfig,
    private fetcher: typeof fetch = fetch
  ) {}
  async request(
    path: string,
    body?: string,
    signal?: AbortSignal,
    operation?: "PUT"
  ): Promise<string> {
    const channelPath =
      /^\/ISAPI\/ContentMgmt\/InputProxy\/channels\/[1-9]\d{0,8}$/.test(path)
    const playbackCapabilityPath = [
      "/SDK/capabilities",
      "/ISAPI/System/capabilities",
    ].includes(path)
    if (
      (playbackCapabilityPath && (body !== undefined || operation)) ||
      (operation && (!channelPath || body === undefined)) ||
      (channelPath && body !== undefined && operation !== "PUT") ||
      (!channelPath &&
        !playbackCapabilityPath &&
        ![
          "/ISAPI/System/deviceInfo",
          "/ISAPI/ContentMgmt/record/tracks",
          "/ISAPI/ContentMgmt/InputProxy/channels",
          "/ISAPI/ContentMgmt/search",
          "/ISAPI/System/time",
          "/ISAPI/ContentMgmt/download/capabilities",
        ].includes(path))
    ) {
      throw new AppError("INVALID_DEVICE_PATH", 400, "不支持的设备查询。")
    }
    const url = `${this.config.NVR_HTTP_SCHEME}://${this.config.NVR_HOST}:${this.config.NVR_HTTP_PORT}${path}`
    const method = operation ?? (body === undefined ? "GET" : "POST")
    const controller = new AbortController()
    const timeout = setTimeout(
      () => controller.abort(),
      this.config.NVR_TIMEOUT_MS
    )
    const requestSignal = signal
      ? AbortSignal.any([controller.signal, signal])
      : controller.signal
    let authorization: string | undefined
    try {
      // One challenge + at most two authenticated requests (including stale nonce).
      for (let attempt = 0; attempt < 3; attempt++) {
        requestSignal.throwIfAborted()
        const response = await this.fetcher(url, {
          method,
          body,
          redirect: "manual",
          signal: requestSignal,
          headers: {
            Accept: "application/xml",
            ...(body ? { "Content-Type": "application/xml" } : {}),
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
            throw new AppError(
              "NVR_AUTH_FAILED",
              502,
              "设备认证失败，请检查服务端账号与密码。"
            )
          authorization = digestAuthorization(
            parseChallenge(challenge),
            this.config.NVR_USERNAME,
            this.config.NVR_PASSWORD,
            method,
            path
          )
          continue
        }
        if (!response.ok) {
          await response.body?.cancel()
          if (response.status === 403)
            throw new AppError("NVR_FORBIDDEN", 502, "设备账户没有此操作权限。")
          throw new AppError(
            "NVR_HTTP_ERROR",
            502,
            `设备操作失败（HTTP ${response.status}）。`
          )
        }
        const reader = response.body?.getReader()
        if (!reader) return ""
        let bytes = 0
        const chunks: Uint8Array[] = []
        try {
          while (true) {
            const { done, value } = await reader.read()
            if (done) break
            bytes += value.length
            if (bytes > MAX_XML_BYTES)
              throw new AppError(
                "NVR_RESPONSE_LIMIT",
                502,
                "设备响应超过容量限制。"
              )
            chunks.push(value)
          }
        } finally {
          await reader.cancel().catch(() => {})
          reader.releaseLock()
        }
        return Buffer.concat(chunks).toString("utf8")
      }
      throw new AppError("NVR_AUTH_FAILED", 502, "设备认证失败。")
    } catch (error) {
      if (error instanceof AppError) throw error
      if (requestSignal.aborted)
        throw new AppError(
          "NVR_TIMEOUT",
          504,
          "设备查询超时，请检查网络后重试。"
        )
      throw new AppError(
        "NVR_UNREACHABLE",
        502,
        "无法连接设备，请检查服务端网络与设备地址。"
      )
    } finally {
      clearTimeout(timeout)
    }
  }
}
