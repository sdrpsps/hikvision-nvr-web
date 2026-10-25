import type { LocalWritable } from "./types"

export function portWriter(port: MessagePort): LocalWritable {
  let sequence = 0
  let allowance = 0
  let failure: Error | undefined
  let waiter: (() => void) | undefined
  let closed = false
  const acknowledged = new Set<number>()
  port.onmessage = (event) => {
    if (event.data.type === "pull") allowance++
    if (event.data.type === "ack") acknowledged.add(event.data.sequence)
    if (event.data.type === "closed") closed = true
    if (event.data.type === "cancel")
      failure = new Error("下载已取消或磁盘无法继续写入。")
    waiter?.()
    waiter = undefined
  }
  port.start()
  port.postMessage({ type: "writer-ready" })
  async function wait(predicate: () => boolean) {
    const deadline = Date.now() + 45000
    while (!predicate()) {
      if (failure) throw failure
      if (Date.now() > deadline)
        throw new Error("等待浏览器写入磁盘超时，保存已中断。")
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(resolve, 1000)
        waiter = () => {
          clearTimeout(timeout)
          resolve()
        }
      })
    }
    if (failure) throw failure
  }
  return {
    async write(bytes) {
      if (!(bytes instanceof Uint8Array))
        throw new Error("当前保存方式不支持定位写入。")
      await wait(() => allowance > 0)
      allowance--
      const id = ++sequence
      const copy = bytes.slice().buffer
      port.postMessage({ type: "chunk", sequence: id, bytes: copy }, [copy])
      await wait(() => acknowledged.has(id))
      acknowledged.delete(id)
    },
    async close() {
      port.postMessage({ type: "close" })
      await wait(() => closed)
      port.close()
    },
    async abort() {
      port.postMessage({ type: "error" })
      port.close()
    },
  }
}
