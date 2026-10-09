import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { writeClipboardText } from '../lib/tauri'
import { useUiStore } from '../stores/uiStore'
import { InAppNotifications } from './InAppNotifications'

vi.mock('../lib/tauri', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/tauri')>()),
  writeClipboardText: vi.fn(async () => {}),
}))

const BODY = 'first line of a long failure\nsecond line with the actual cause'

beforeEach(() => {
  vi.useFakeTimers()
  useUiStore.setState({ toasts: [], notifications: [] })
  act(() => useUiStore.getState().pushToast({ title: 'Build failed', body: BODY }))
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.clearAllMocks()
})

describe('toast', () => {
  it('expands on click and shows the whole message', () => {
    render(<InAppNotifications />)
    const toggle = screen.getByRole('button', { name: /Build failed/ })
    // A screen reader hears the message, not a generic "expand".
    expect(toggle).toHaveAccessibleName(/Build failed.*first line of a long failure/)
    expect(toggle).toHaveAttribute('aria-expanded', 'false')

    fireEvent.click(toggle)

    expect(screen.getByRole('button', { name: /Build failed/ })).toHaveAttribute(
      'aria-expanded',
      'true',
    )
    expect(screen.getByText(/second line with the actual cause/)).toBeInTheDocument()
  })

  it('stays open past the auto-dismiss time while expanded, and closes with X', () => {
    render(<InAppNotifications />)
    fireEvent.click(screen.getByRole('button', { name: /Build failed/ }))

    act(() => {
      vi.advanceTimersByTime(7000)
    })
    expect(useUiStore.getState().toasts).toHaveLength(1)

    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(useUiStore.getState().toasts).toHaveLength(0)
  })

  it('still auto-dismisses when collapsed', () => {
    render(<InAppNotifications />)
    act(() => {
      vi.advanceTimersByTime(7000)
    })
    expect(useUiStore.getState().toasts).toHaveLength(0)
  })

  it('copies title and body without expanding or dismissing', async () => {
    render(<InAppNotifications />)

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /copy/i }))
    })

    expect(writeClipboardText).toHaveBeenCalledWith(`Build failed\n${BODY}`)
    expect(screen.getByRole('button', { name: /Build failed/ })).toHaveAttribute(
      'aria-expanded',
      'false',
    )
    expect(useUiStore.getState().toasts).toHaveLength(1)
  })
})
