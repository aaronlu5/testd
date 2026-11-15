import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import CodeEditor from '~/components/platform/CodeEditor.vue'

describe('Code editor', () => {
  it('keeps the Ace layout classes when the invalid state changes', async () => {
    const wrapper = mount(CodeEditor, { props: { modelValue: '{}', id: 'body' } })
    expect(wrapper.find('.ace_editor').exists()).toBe(true)
    await wrapper.setProps({ invalid: true })
    expect(wrapper.find('.ace_editor').exists()).toBe(true)
    expect(wrapper.classes()).toContain('is-invalid')
    wrapper.unmount()
  })

  it('exposes the id on the editing element', () => {
    const wrapper = mount(CodeEditor, { props: { modelValue: '', id: 'body' } })
    expect(wrapper.find('textarea#body').exists()).toBe(true)
    wrapper.unmount()
  })
})
