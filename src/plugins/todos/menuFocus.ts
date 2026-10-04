import { type KeyboardEvent, useRef } from 'react'

/**
 * Keyboard and focus for a row's small menu. Escape inside the row closes it and puts the focus
 * back on its trigger; so does choosing an item, whose button would otherwise take the focus away
 * as it goes. Once the item's action settles, a focus left nowhere goes back to the trigger, or to
 * `fallback()` when the trigger went with it.
 */
export function useMenuFocus(
  open: boolean,
  close: () => void,
  fallback?: () => HTMLElement | null | undefined,
) {
  const trigger = useRef<HTMLButtonElement>(null)
  const refocus = () => trigger.current?.focus()
  return {
    trigger,
    refocus,
    onKeyDown: (event: KeyboardEvent) => {
      if (!open || event.key !== 'Escape') return
      event.stopPropagation()
      close()
      refocus()
    },
    choose: (action: () => unknown) => () => {
      close()
      refocus()
      void Promise.resolve(action()).finally(() => {
        const active = document.activeElement
        if (active && active !== document.body) return
        ;(trigger.current ?? fallback?.())?.focus()
      })
    },
  }
}
