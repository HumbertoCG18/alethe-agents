import * as Dialog from '@radix-ui/react-dialog'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { Modal } from '../modals/Modal'
import { Dropdown } from './Dropdown'

afterEach(cleanup)

describe('Dropdown', () => {
  it('keeps focus in a custom Radix dialog without the shared Modal marker', async () => {
    render(
      <Dialog.Root open>
        <Dialog.Portal>
          <Dialog.Content aria-describedby={undefined}>
            <Dialog.Title>Preferences</Dialog.Title>
            <Dropdown
              value=""
              onChange={vi.fn()}
              ariaLabel="Font"
              searchable
              searchPlaceholder="Search fonts"
              options={[{ value: 'consolas', label: 'Consolas' }]}
            />
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Font' }))
    const search = screen.getByRole('textbox', { name: 'Search fonts' })
    await waitFor(() => expect(search).toHaveFocus())
    expect(screen.getByRole('dialog')).toContainElement(screen.getByRole('listbox'))
  })
  it('keeps search and keyboard focus inside a modal', async () => {
    const change = vi.fn()
    render(
      <Modal open onClose={vi.fn()} title="Settings">
        <Dropdown
          value=""
          onChange={change}
          ariaLabel="Font"
          searchable
          searchPlaceholder="Search fonts"
          options={[
            { value: 'consolas', label: 'Consolas' },
            { value: 'other', label: 'Other font' },
          ]}
        />
      </Modal>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Font' }))
    const search = screen.getByRole('textbox', { name: 'Search fonts' })
    await waitFor(() => expect(search).toHaveFocus())
    fireEvent.change(search, { target: { value: 'Consolas' } })
    fireEvent.keyDown(search, { key: 'ArrowDown' })
    const option = screen.getByRole('option', { name: 'Consolas' })
    expect(option).toHaveFocus()
    fireEvent.click(option)
    expect(change).toHaveBeenCalledWith('consolas')
  })
  it('keeps wheel events inside the option menu', () => {
    const wheel = vi.fn()
    render(
      <div onWheel={wheel}>
        <Dropdown
          value="a"
          onChange={vi.fn()}
          ariaLabel="Fonts"
          options={[{ value: 'a', label: 'Font A' }]}
        />
      </div>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Fonts' }))
    fireEvent.wheel(screen.getByRole('option', { name: 'Font A' }), { deltaY: 120 })
    expect(wheel).not.toHaveBeenCalled()
  })
  it('selects a portal option without dismissing its parent modal', () => {
    const onChange = vi.fn()
    const onClose = vi.fn()

    render(
      <Modal open onClose={onClose} title="Settings">
        <Dropdown
          value="first"
          onChange={onChange}
          ariaLabel="Choice"
          options={[
            { value: 'first', label: 'First' },
            { value: 'second', label: 'Second' },
          ]}
        />
      </Modal>,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Choice' }))
    fireEvent.pointerDown(screen.getByRole('option', { name: 'Second' }))
    fireEvent.click(screen.getByRole('option', { name: 'Second' }))

    expect(onChange).toHaveBeenCalledWith('second')
    expect(onClose).not.toHaveBeenCalled()
  })

  it('closes the dropdown before its parent modal on Escape', () => {
    const onClose = vi.fn()

    render(
      <Modal open onClose={onClose} title="Settings">
        <Dropdown
          value="first"
          onChange={vi.fn()}
          ariaLabel="Choice"
          options={[{ value: 'first', label: 'First' }]}
        />
      </Modal>,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Choice' }))
    fireEvent.keyDown(document, { key: 'Escape' })

    expect(screen.queryByRole('listbox', { name: 'Choice' })).not.toBeInTheDocument()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('filters searchable options and accepts a custom value', () => {
    const onChange = vi.fn()

    render(
      <Dropdown
        value=""
        onChange={onChange}
        ariaLabel="Model"
        placeholder="Select model"
        searchable
        searchPlaceholder="Search models"
        emptyLabel={(query) => `No result for ${query}`}
        allowCustomValue
        customOptionLabel={(value) => `Use ${value}`}
        options={[
          { value: 'alpha', label: 'Alpha', searchText: 'Alpha alpha' },
          { value: 'beta', label: 'Beta', searchText: 'Beta beta' },
        ]}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Model' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Search models' }), {
      target: { value: 'custom-model' },
    })
    fireEvent.click(screen.getByRole('option', { name: 'Use custom-model' }))

    expect(onChange).toHaveBeenCalledWith('custom-model')
  })

  it('selects the first enabled search result with Enter', () => {
    const onChange = vi.fn()

    render(
      <Dropdown
        value=""
        onChange={onChange}
        ariaLabel="Project"
        searchable
        searchPlaceholder="Search projects"
        options={[
          { value: 'blocked', label: 'Blocked', disabled: true },
          { value: 'ready', label: 'Ready' },
        ]}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Project' }))
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Search projects' }), {
      key: 'Enter',
    })

    expect(onChange).toHaveBeenCalledWith('ready')
  })
})
