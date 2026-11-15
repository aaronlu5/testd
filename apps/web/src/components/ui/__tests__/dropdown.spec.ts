import { afterEach, describe, expect, it } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import { h } from 'vue'
import UiDropdown from '../UiDropdown.vue'
import UiDropdownItem from '../UiDropdownItem.vue'

let wrapper: VueWrapper | undefined
afterEach(() => wrapper?.unmount())

function mountMenu() {
  wrapper = mount(UiDropdown, {
    props: { label: 'Actions' },
    slots: {
      default: () => [
        h(UiDropdownItem, null, () => 'One'),
        h(UiDropdownItem, null, () => 'Two'),
        h(UiDropdownItem, { disabled: true }, () => 'Three'),
      ],
    },
    attachTo: document.body,
  })
  return wrapper
}

describe('UiDropdown', () => {
  it('exposes menu semantics and toggles aria-expanded', async () => {
    const w = mountMenu()
    const trigger = w.get('button.ui-dropdown__trigger')
    expect(trigger.attributes('aria-haspopup')).toBe('menu')
    expect(trigger.attributes('aria-expanded')).toBe('false')
    await trigger.trigger('click')
    expect(trigger.attributes('aria-expanded')).toBe('true')
    expect(w.get('[role="menu"]').isVisible()).toBe(true)
  })

  it('focuses the first item on open and moves with the arrow keys, skipping disabled items', async () => {
    const w = mountMenu()
    await w.get('button.ui-dropdown__trigger').trigger('click')
    await w.vm.$nextTick()
    const items = w.findAll('[role="menuitem"]')
    expect(document.activeElement).toBe(items[0]!.element)
    await items[0]!.trigger('keydown', { key: 'ArrowDown' })
    expect(document.activeElement).toBe(items[1]!.element)
    await items[1]!.trigger('keydown', { key: 'ArrowDown' })
    expect(document.activeElement).toBe(items[0]!.element)
  })

  it('closes on Escape and returns focus to the trigger', async () => {
    const w = mountMenu()
    const trigger = w.get('button.ui-dropdown__trigger')
    await trigger.trigger('click')
    await w.vm.$nextTick()
    await w.findAll('[role="menuitem"]')[0]!.trigger('keydown', { key: 'Escape' })
    expect(trigger.attributes('aria-expanded')).toBe('false')
    expect(document.activeElement).toBe(trigger.element)
  })

  it('closes after an item is chosen', async () => {
    const w = mountMenu()
    const trigger = w.get('button.ui-dropdown__trigger')
    await trigger.trigger('click')
    await w.findAll('[role="menuitem"]')[1]!.trigger('click')
    expect(trigger.attributes('aria-expanded')).toBe('false')
  })
})
