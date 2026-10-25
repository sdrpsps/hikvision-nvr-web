"use client"

import { useEffect, useId, useRef } from "react"
import { toast } from "sonner"

// Reuse one notification per view, including repeated failures with the same
// message. The timestamp distinguishes a new failed request from a rerender.
export function useQueryErrorToast(
  {
    error,
    errorUpdatedAt,
    isFetching,
  }: { error: Error | null; errorUpdatedAt: number; isFetching: boolean },
  title: string
) {
  const id = useId()
  const notified = useRef<{ error: Error; updatedAt: number } | undefined>(
    undefined
  )
  useEffect(() => {
    if (!error) {
      toast.dismiss(id)
      return
    }
    if (
      isFetching ||
      (notified.current?.error === error &&
        notified.current.updatedAt === errorUpdatedAt)
    )
      return
    notified.current = { error, updatedAt: errorUpdatedAt }
    toast.error(title, { id, description: error.message, duration: 8000 })
  }, [error, errorUpdatedAt, isFetching, title, id])

  useEffect(
    () => () => {
      // StrictMode replays effects for a mount that may already have a cached
      // error. Let that replay restore the same notification after cleanup.
      notified.current = undefined
      toast.dismiss(id)
    },
    [id]
  )
}
