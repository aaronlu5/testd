import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import UiAlert from '../UiAlert.vue'
import UiButton from '../UiButton.vue'
import UiCheckbox from '../UiCheckbox.vue'
import UiSwitch from '../UiSwitch.vue'
import UiTabs from '../UiTabs.vue'
import UiInput from '../UiInput.vue'

describe('UiButton', () => {
  it('is a real button that does not submit by default', () => {
    const w = mount(UiButton, { slots: { default: 'Save' } })
    expect(w.element.tagName).toBe('BUTTON')
    expect(w.attributes('type')).toBe('button')
  })

  it('is disabled and busy while loading', () => {
    const w = mount(UiButton, { props: { loading: true }, slots: { default: 'Save' } })
    expect(w.attributes('disabled')).toBeDefined()
    expect(w.attributes('aria-busy')).toBe('true')
  })

  it('maps outline-* variants', () => {
    const w = mount(UiButton, { props: { variant: 'outline-danger' } })
    expect(w.classes()).toEqual(expect.arrayContaining(['ui-btn--danger', 'is-outline']))
  })
})

describe('UiAlert', () => {
  it('uses role=alert for danger and role=status for info, and can be dismissed', async () => {
    expect(mount(UiAlert, { props: { variant: 'danger' } }).attributes('role')).toBe('alert')
    const w = mount(UiAlert, { props: { dismissible: true }, slots: { default: 'Heads up' } })
    expect(w.attributes('role')).toBe('status')
    await w.get('button[aria-label="Dismiss"]').trigger('click')
    expect(w.emitted('dismiss')).toHaveLength(1)
    expect(w.find('.ui-alert').exists()).toBe(false)
  })
})

describe('UiCheckbox / UiSwitch', () => {
  it('emits the checked state', async () => {
    const w = mount(UiCheckbox, { props: { modelValue: false }, slots: { default: 'Enable' } })
    await w.get('input').setValue(true)
    expect(w.emitted('update:modelValue')?.[0]).toEqual([true])
  })

  it('exposes switch semantics', () => {
    const w = mount(UiSwitch, { props: { modelValue: true } })
    expect(w.get('input').attributes('role')).toBe('switch')
    expect((w.get('input').element as HTMLInputElement).checked).toBe(true)
  })
})

describe('UiInput', () => {
  it('emits strings, or numbers in number mode', async () => {
    const text = mount(UiInput)
    await text.get('input').setValue('abc')
    expect(text.emitted('update:modelValue')?.[0]).toEqual(['abc'])
    const num = mount(UiInput, { props: { number: true }, attrs: { type: 'number' } })
    await num.get('input').setValue('42')
    expect(num.emitted('update:modelValue')?.[0]).toEqual([42])
  })
})

describe('UiTabs', () => {
  const tabs = [
    { id: 'a', label: 'Alpha' },
    { id: 'b', label: 'Beta' },
    { id: 'c', label: 'Gamma', disabled: true },
  ]

  it('has tab semantics with a roving tabindex', () => {
    const w = mount(UiTabs, { props: { modelValue: 'a', tabs }, slots: { default: 'content' } })
    const list = w.findAll('[role="tab"]')
    expect(list.map((t) => t.attributes('aria-selected'))).toEqual(['true', 'false', 'false'])
    expect(list.map((t) => t.attributes('tabindex'))).toEqual(['0', '-1', '-1'])
    expect(w.get('[role="tabpanel"]').attributes('aria-labelledby')).toBe(list[0]!.attributes('id'))
  })

  it('moves with arrow keys, skipping disabled tabs, and wraps', async () => {
    const w = mount(UiTabs, { props: { modelValue: 'a', tabs } })
    await w.get('[role="tablist"]').trigger('keydown', { key: 'ArrowRight' })
    expect(w.emitted('update:modelValue')?.[0]).toEqual(['b'])
    await w.setProps({ modelValue: 'b' })
    await w.get('[role="tablist"]').trigger('keydown', { key: 'ArrowRight' })
    expect(w.emitted('update:modelValue')?.[1]).toEqual(['a'])
  })
})
