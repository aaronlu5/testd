import { describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useInspectorPanel } from '~/stores/inspector'
import {
  badgeText,
  formatBody,
  formatBytes,
  isNewMessage,
  messageEntity,
  watchLabel,
  watchStatus,
} from '../inspector/inspector-format'

describe('Service Bus Inspector formatting', () => {
  it('caps the badge so it never outgrows the icon', () => {
    expect(badgeText(1)).toBe('1')
    expect(badgeText(99)).toBe('99')
    expect(badgeText(100)).toBe('99+')
    expect(badgeText(12345)).toBe('99+')
  })

  it('labels queues and topic subscriptions', () => {
    expect(watchLabel({ target: 'bus', entity: 'orders' })).toBe('bus / orders')
    expect(watchLabel({ target: 'bus', entity: 'events', subscription: 'inspector' })).toBe(
      'bus / events ▸ inspector',
    )
    expect(messageEntity({ entity: 'events', subscription: 'inspector' })).toBe(
      'events ▸ inspector',
    )
    expect(messageEntity({ entity: 'orders' })).toBe('orders')
  })

  it('indents JSON bodies and leaves text, base64 and empty bodies alone', () => {
    expect(formatBody({ bodyEncoding: 'json', body: { a: 1 } })).toBe('{\n  "a": 1\n}')
    expect(formatBody({ bodyEncoding: 'text', body: 'hello' })).toBe('hello')
    expect(formatBody({ bodyEncoding: 'base64', body: '//4A' })).toBe('//4A')
    expect(formatBody({ bodyEncoding: 'empty', body: null })).toBe('')
  })

  it('flags only messages newer than what was seen when the panel opened', () => {
    expect(isNewMessage(5, 4)).toBe(true)
    expect(isNewMessage(4, 4)).toBe(false)
    expect(isNewMessage(1, 4)).toBe(false)
  })

  it('formats sizes', () => {
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(2048)).toBe('2.0 KiB')
    expect(formatBytes(262144)).toBe('256 KiB')
  })

  it('summarises a watch by its error code, or that it is still waiting, or listening', () => {
    expect(watchStatus({ lastErrorCode: 'AUTH_FORBIDDEN', lastPolledAt: 'x' })).toEqual({
      kind: 'error',
      text: 'AUTH_FORBIDDEN',
    })
    expect(watchStatus({}).kind).toBe('waiting')
    expect(watchStatus({ lastPolledAt: '2026-01-01T00:00:00Z' }).kind).toBe('ok')
  })

  it('lets any part of the UI open and close the panel', () => {
    setActivePinia(createPinia())
    const panel = useInspectorPanel()
    expect(panel.open).toBe(false)
    panel.show()
    expect(panel.open).toBe(true)
    panel.hide()
    expect(panel.open).toBe(false)
  })
})
