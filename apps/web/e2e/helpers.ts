import type { Locator, Page } from '@playwright/test'

/**
 * Replaces the whole content of a code editor (Ace). Playwright's fill() only inserts at the
 * cursor in Ace's hidden textarea, so select everything first and then type over it.
 */
export async function replaceEditorText(page: Page, field: Locator, text: string): Promise<void> {
  await field.focus()
  await page.keyboard.press('Control+A')
  await page.keyboard.insertText(text)
}
