import { nextTick, onBeforeUnmount, watch, type Ref } from 'vue'

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

/** Visible, focusable descendants of an element, in DOM order. */
export function focusableWithin(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => !el.hasAttribute('hidden') && el.getAttribute('aria-hidden') !== 'true',
  )
}

/**
 * Traps Tab focus inside `container` while `active` is true, moves focus in on open and
 * restores it to the previously focused element on close. Escape calls `onEscape`.
 */
export function useFocusTrap(
  container: Ref<HTMLElement | null>,
  active: Ref<boolean>,
  onEscape?: () => void,
) {
  let previous: HTMLElement | null = null

  function onKeydown(event: KeyboardEvent) {
    const root = container.value
    if (!root) return
    if (event.key === 'Escape') {
      event.stopPropagation()
      onEscape?.()
      return
    }
    if (event.key !== 'Tab') return
    const items = focusableWithin(root)
    if (items.length === 0) {
      event.preventDefault()
      root.focus()
      return
    }
    const first = items[0]!
    const last = items[items.length - 1]!
    const current = document.activeElement
    if (event.shiftKey && (current === first || current === root)) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && current === last) {
      event.preventDefault()
      first.focus()
    }
  }

  watch(
    active,
    async (isActive) => {
      if (isActive) {
        previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
        await nextTick()
        const root = container.value
        if (!root) return
        root.addEventListener('keydown', onKeydown)
        const target =
          root.querySelector<HTMLElement>('[data-autofocus]') ?? focusableWithin(root)[0]
        ;(target ?? root).focus()
      } else {
        container.value?.removeEventListener('keydown', onKeydown)
        previous?.focus?.()
        previous = null
      }
    },
    { immediate: true, flush: 'post' },
  )

  onBeforeUnmount(() => {
    container.value?.removeEventListener('keydown', onKeydown)
  })
}

let lockCount = 0
/** Reference-counted body scroll lock for overlays. */
export function lockScroll(lock: boolean) {
  lockCount = Math.max(0, lockCount + (lock ? 1 : -1))
  document.body.style.overflow = lockCount > 0 ? 'hidden' : ''
}
