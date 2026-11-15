import type { InspectedMessage, InspectedMessageSummary, InspectorWatch } from '~/api/types'

/** Mirrors the server's body cap (the browser imports contract types only, never values). */
export const INSPECTOR_MAX_BODY_BYTES = 256 * 1024

/** Badge text: nothing for zero, and a ceiling so the badge never outgrows the icon. */
export const badgeText = (count: number): string => (count > 99 ? '99+' : String(count))

/** `target / entity` or `target / topic ▸ subscription`. */
export const watchLabel = (
  watch: Pick<InspectorWatch, 'target' | 'entity' | 'subscription'>,
): string =>
  `${watch.target} / ${watch.entity}${watch.subscription ? ` ▸ ${watch.subscription}` : ''}`

export const messageEntity = (
  message: Pick<InspectedMessageSummary, 'entity' | 'subscription'>,
): string => `${message.entity}${message.subscription ? ` ▸ ${message.subscription}` : ''}`

/** The body as shown in the detail view: indented JSON, or the text as received. */
export const formatBody = (message: Pick<InspectedMessage, 'body' | 'bodyEncoding'>): string => {
  if (message.bodyEncoding === 'empty') return ''
  if (message.bodyEncoding === 'json') return JSON.stringify(message.body, null, 2)
  return typeof message.body === 'string' ? message.body : JSON.stringify(message.body)
}

/** Is a message newer than what was already seen when the panel was opened? */
export const isNewMessage = (seq: number, highlightAfter: number): boolean => seq > highlightAfter

export const formatBytes = (bytes: number): string =>
  bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(bytes < 10_240 ? 1 : 0)} KiB`

/** Status line for a watch: the last error code, "waiting" before the first peek, or the time. */
export const watchStatus = (
  watch: Pick<InspectorWatch, 'lastErrorCode' | 'lastPolledAt'>,
): { kind: 'error' | 'waiting' | 'ok'; text: string } => {
  if (watch.lastErrorCode) return { kind: 'error', text: watch.lastErrorCode }
  if (!watch.lastPolledAt) return { kind: 'waiting', text: 'Waiting for first check' }
  return { kind: 'ok', text: 'Listening' }
}
