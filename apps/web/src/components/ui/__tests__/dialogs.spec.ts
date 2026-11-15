import { afterEach, describe, expect, it } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import UiModal from '../UiModal.vue'
import UiDrawer from '../UiDrawer.vue'

let wrapper: VueWrapper | undefined
afterEach(() => {
  wrapper?.unmount()
  document.body.innerHTML = ''
})

const flush = async () => {
  await Promise.resolve()
  await new Promise((r) => setTimeout(r, 0))
}

describe.each([
  ['UiModal', UiModal],
  ['UiDrawer', UiDrawer],
])('%s', (_name, Component) => {
  function open() {
    wrapper = mount(Component, {
      props: { modelValue: true, title: 'Settings' },
      slots: { default: '<button id="first">First</button><button id="last">Last</button>' },
      attachTo: document.body,
    })
    return wrapper
  }

  it('renders an accessible modal dialog named by its title', async () => {
    open()
    await flush()
    const dialog = document.body.querySelector('[role="dialog"]')!
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    const labelledBy = dialog.getAttribute('aria-labelledby')!
    expect(document.getElementById(labelledBy)?.textContent).toContain('Settings')
  })

  it('moves focus inside and wraps Tab at the end', async () => {
    open()
    await flush()
    const dialog = document.body.querySelector<HTMLElement>('[role="dialog"]')!
    expect(dialog.contains(document.activeElement)).toBe(true)
    const buttons = dialog.querySelectorAll<HTMLElement>('button')
    const last = buttons[buttons.length - 1]!
    last.focus()
    last.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }),
    )
    expect(dialog.contains(document.activeElement)).toBe(true)
    expect(document.activeElement).not.toBe(last)
  })

  it('asks to close on Escape and on the close button', async () => {
    const w = open()
    await flush()
    const dialog = document.body.querySelector<HTMLElement>('[role="dialog"]')!
    dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(w.emitted('update:modelValue')?.[0]).toEqual([false])
    document.body.querySelector<HTMLElement>('[aria-label="Close"]')!.click()
    expect(w.emitted('update:modelValue')?.length).toBe(2)
  })
})
