import { createHash, randomBytes } from "node:crypto"
import { AppError } from "./errors"

export type Challenge = {
  realm: string
  nonce: string
  algorithm: string
  qop?: string
  opaque?: string
}
export function parseChallenge(header: string | null): Challenge {
  if (!header || !/^Digest\s/i.test(header))
    throw new AppError(
      "NVR_AUTH_UNSUPPORTED",
      502,
      "设备未提供受支持的 Digest 认证。"
    )
  const values: Record<string, string> = {}
  for (const match of header
    .slice(7)
    .matchAll(/(\w+)\s*=\s*(?:"((?:\\.|[^"\\])*)"|([^,\s]+))/g)) {
    values[match[1].toLowerCase()] = (match[2] ?? match[3]).replace(
      /\\(.)/g,
      "$1"
    )
  }
  const algorithm = (values.algorithm ?? "MD5").toUpperCase()
  const qop = values.qop?.split(",").map((x) => x.trim().toLowerCase())
  if (
    !values.realm ||
    !values.nonce ||
    !["MD5", "MD5-SESS", "SHA-256", "SHA-256-SESS"].includes(algorithm) ||
    (qop && !qop.includes("auth"))
  ) {
    throw new AppError(
      "NVR_AUTH_UNSUPPORTED",
      502,
      "设备 Digest 算法或参数不受支持。"
    )
  }
  return {
    realm: values.realm,
    nonce: values.nonce,
    algorithm,
    qop: qop ? "auth" : undefined,
    opaque: values.opaque,
  }
}
export function digestAuthorization(
  challenge: Challenge,
  username: string,
  password: string,
  method: string,
  uri: string,
  cnonce = randomBytes(16).toString("hex"),
  count = 1
) {
  const { realm, nonce, algorithm, qop, opaque } = challenge
  const hash = (value: string) =>
    createHash(algorithm.startsWith("SHA-256") ? "sha256" : "md5")
      .update(value)
      .digest("hex")
  let ha1 = hash(`${username}:${realm}:${password}`)
  if (algorithm.endsWith("-SESS")) ha1 = hash(`${ha1}:${nonce}:${cnonce}`)
  const nc = count.toString(16).padStart(8, "0")
  const ha2 = hash(`${method}:${uri}`)
  const response = hash(
    qop
      ? `${ha1}:${nonce}:${nc}:${cnonce}:${qop}:${ha2}`
      : `${ha1}:${nonce}:${ha2}`
  )
  const quote = (value: string) =>
    `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`
  const fields = [
    `username=${quote(username)}`,
    `realm=${quote(realm)}`,
    `nonce=${quote(nonce)}`,
    `uri=${quote(uri)}`,
    `response=${quote(response)}`,
    `algorithm=${algorithm}`,
  ]
  if (opaque) fields.push(`opaque=${quote(opaque)}`)
  if (qop) fields.push(`qop=${qop}`, `nc=${nc}`)
  if (qop || algorithm.endsWith("-SESS")) fields.push(`cnonce=${quote(cnonce)}`)
  return `Digest ${fields.join(", ")}`
}
