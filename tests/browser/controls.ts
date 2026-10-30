import { expect, type Page } from "@playwright/test"

export async function selectOption(page: Page, label: string, option: string) {
  await page.getByRole("combobox", { name: label, exact: true }).click()
  await page.getByRole("option", { name: option, exact: true }).click()
}

export async function selectRecordingTime(
  page: Page,
  label: string,
  value: string
) {
  const time = value.slice(-8)
  const trigger = page.getByRole("button", { name: label, exact: true })
  if ((await trigger.textContent())?.trim() === time) return
  await trigger.click()
  for (const [index, unit] of ["时", "分", "秒"].entries()) {
    const control = page.getByRole("spinbutton", {
      name: `${label}${unit}`,
      exact: true,
    })
    const selected = Number(time.split(":")[index])
    if (Number(await control.getAttribute("aria-valuenow")) === selected)
      continue
    await control.focus()
    if (Number(await control.getAttribute("aria-valuemax")) === selected) {
      await control.press("End")
    } else {
      await control.press("Home")
      await expect(control).toHaveAttribute(
        "aria-valuenow",
        (await control.getAttribute("aria-valuemin")) ?? "0"
      )
      if (selected > 0)
        await control.pressSequentially(String(selected).padStart(2, "0"), {
          delay: 100,
        })
    }
    await expect(control).toHaveAttribute("aria-valuenow", String(selected))
  }
  await page.getByRole("button", { name: "完成时间选择", exact: true }).click()
  await expect(trigger).toHaveText(time)
}

export async function selectDate(page: Page, value: string) {
  const trigger = page.getByRole("button", { name: "日期", exact: true })
  if ((await trigger.textContent())?.includes(value)) return
  await trigger.click()
  const [year, month, day] = value.split("-").map(Number)
  const years = page.getByRole("combobox", { name: "选择年份", exact: true })
  const months = page.getByRole("combobox", { name: "选择月份", exact: true })
  if (!(await years.textContent())?.includes(String(year)))
    await selectOption(page, "选择年份", String(year))
  if (!(await months.textContent())?.includes(`${month}月`))
    await selectOption(page, "选择月份", `${month}月`)
  await page
    .getByRole("button", { name: new RegExp(`${year}年${month}月${day}日`) })
    .click()
  await expect(trigger).toContainText(value)
}
