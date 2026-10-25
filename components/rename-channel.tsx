"use client"

import { useId, useState } from "react"
import { PencilIcon } from "lucide-react"
import { toast } from "sonner"
import { useRenameChannel } from "@/hooks/use-api"
import { channelNameSchema, type Channel } from "@/shared/contracts"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Field,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"

export function RenameChannel({ channel }: { channel: Channel }) {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState(channel.name)
  const [invalid, setInvalid] = useState(false)
  const mutation = useRenameChannel()
  const id = useId()
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (mutation.isPending) return
        setOpen(next)
        if (next) {
          setName(channel.name)
          setInvalid(false)
          mutation.reset()
        }
      }}
    >
      <DialogTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`修改通道 ${channel.id} 名称`}
            title="修改通道名称"
          />
        }
      >
        <PencilIcon />
      </DialogTrigger>
      <DialogContent showCloseButton={!mutation.isPending}>
        <form
          className="flex flex-col gap-4"
          onSubmit={async (event) => {
            event.preventDefault()
            if (mutation.isPending) return
            const parsed = channelNameSchema.safeParse(name)
            if (!parsed.success) {
              setInvalid(true)
              return
            }
            try {
              await mutation.mutateAsync({ id: channel.id, name: parsed.data })
              setOpen(false)
              toast.success("通道名称已保存")
            } catch (error) {
              toast.error("修改通道名称失败", {
                description:
                  error instanceof Error ? error.message : "请刷新后重试。",
              })
            }
          }}
        >
          <DialogHeader>
            <DialogTitle>修改通道名称</DialogTitle>
            <DialogDescription>
              保存到录像机，通道 {channel.id} 的名称将同步更新。
            </DialogDescription>
          </DialogHeader>
          <FieldGroup>
            <Field data-invalid={invalid}>
              <FieldLabel htmlFor={id}>通道名称</FieldLabel>
              <Input
                id={id}
                value={name}
                disabled={mutation.isPending}
                maxLength={32}
                aria-invalid={invalid}
                aria-describedby={invalid ? `${id}-error` : undefined}
                onChange={(event) => {
                  setName(event.target.value)
                  setInvalid(false)
                }}
              />
              {invalid && (
                <FieldError id={`${id}-error`}>
                  请输入 1–32 个 UTF-8 字节，不能包含控制字符（中文通常每字 3
                  字节）。
                </FieldError>
              )}
            </Field>
          </FieldGroup>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={mutation.isPending}
              onClick={() => setOpen(false)}
            >
              取消
            </Button>
            <Button
              type="submit"
              disabled={mutation.isPending || name.trim() === channel.name}
            >
              {mutation.isPending ? "正在保存…" : "保存"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
