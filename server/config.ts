import { z } from "zod"
import { AppError } from "./errors"

const hostSchema = z
  .string()
  .min(1)
  .refine((value) => {
    if (/[\s/@?#\\]/.test(value)) return false
    try {
      const url = new URL(`http://${value}`)
      return url.hostname === value && !url.port && url.pathname === "/"
    } catch {
      return false
    }
  })
const configSchema = z.object({
  NVR_HOST: hostSchema,
  NVR_HTTP_PORT: z.coerce.number().int().min(1).max(65535).default(80),
  NVR_HTTP_SCHEME: z.enum(["http", "https"]).default("http"),
  NVR_RTSP_PORT: z.coerce.number().int().min(1).max(65535).default(554),
  NVR_USERNAME: z
    .string()
    .min(1)
    .max(256)
    .regex(/^[^\r\n]+$/),
  NVR_PASSWORD: z
    .string()
    .min(1)
    .max(1024)
    .regex(/^[^\r\n]+$/),
  NVR_TIME_ZONE: z
    .string()
    .default("Asia/Shanghai")
    .refine((value) => {
      try {
        new Intl.DateTimeFormat("en", { timeZone: value })
        return true
      } catch {
        return false
      }
    }),
  NVR_TIMEOUT_MS: z.coerce.number().int().min(100).max(60000).default(8000),
})
export type NvrConfig = z.infer<typeof configSchema>
export function readNvrConfig(
  env: Record<string, string | undefined> = process.env
): NvrConfig {
  const result = configSchema.safeParse(env)
  if (!result.success)
    throw new AppError(
      "NVR_NOT_CONFIGURED",
      503,
      "请在服务端 .env 中配置设备连接参数。"
    )
  return result.data
}
