export class AppError extends Error {
  constructor(
    public code: string,
    public status: 400 | 401 | 403 | 404 | 429 | 502 | 503 | 504,
    message: string
  ) {
    super(message)
  }
}
export const invalidXml = () =>
  new AppError(
    "NVR_INVALID_XML",
    502,
    "设备响应结构无效，请检查固件与接口响应。"
  )
