import type { InjectionKey } from 'vue'

export interface DropdownContext {
  close: (returnFocus?: boolean) => void
}

export const DROPDOWN_KEY: InjectionKey<DropdownContext> = Symbol('ui-dropdown')
