import { expect, type Page } from "@playwright/test"

export async function selectOption(page: Page, label: string, option: string) {
  await page.getByRole("combobox", { name: label, exact: true }).click()
  await page.getByRole("option", { name: option, exact: true }).click()
}

export async function selectDate(page: Page, value: string) {
  const trigger = page.getByRole("button", { name: "设备日期", exact: true })
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
