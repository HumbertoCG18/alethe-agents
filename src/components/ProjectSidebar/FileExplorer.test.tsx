import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { listDirectory, openInFileExplorer } from '../../lib/tauri'
import { FileExplorer } from './FileExplorer'

const dir = (name: string) => ({ name, path: `C:/repo/${name}`, is_dir: true, size: null })

vi.mock('../../lib/tauri', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/tauri')>()),
  listDirectory: vi.fn(async (path: string) => (path === 'C:/repo' ? [dir('src')] : [])),
  gitStatus: vi.fn(async () => {
    throw new Error('not_a_git_repository')
  }),
  openInFileExplorer: vi.fn(async () => {}),
}))

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

const renderExplorer = () => render(<FileExplorer projectId="p1" cwd="C:/repo" />)
const openMenu = () => fireEvent.click(screen.getByRole('button', { name: 'More actions' }))

describe('FileExplorer without a terminal', () => {
  it('lists the folder with no pty or terminal name', async () => {
    renderExplorer()

    expect(await screen.findByText('src')).toBeInTheDocument()
  })

  it('offers refresh, collapse all and reveal in the more-actions menu', async () => {
    renderExplorer()
    await screen.findByText('src')

    openMenu()

    const items = screen.getAllByRole('menuitem').map((item) => item.textContent)
    expect(items).toEqual(['Refresh files', 'Collapse all folders', 'Reveal in File Explorer'])
  })

  it('opening a context menu closes the more-actions menu', async () => {
    renderExplorer()
    openMenu()

    // A keyboard context menu fires no pointerdown, so nothing else closes the first menu.
    fireEvent.contextMenu(await screen.findByText('src'))

    expect(screen.getAllByRole('menu')).toHaveLength(1)
    expect(screen.queryByRole('menuitem', { name: 'Collapse all folders' })).toBeNull()
  })

  it('refresh re-reads the tree', async () => {
    renderExplorer()
    await screen.findByText('src')
    const calls = vi.mocked(listDirectory).mock.calls.length

    openMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Refresh files' }))

    await waitFor(() => expect(vi.mocked(listDirectory).mock.calls.length).toBeGreaterThan(calls))
  })

  it('collapse all closes expanded folders but keeps the root listed', async () => {
    renderExplorer()
    fireEvent.click(await screen.findByText('src'))
    const src = screen.getByText('src').closest('button')!
    await waitFor(() => expect(src.querySelector('svg')).toHaveClass('lucide-chevron-down'))

    openMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Collapse all folders' }))

    await waitFor(() => expect(src.querySelector('svg')).toHaveClass('lucide-chevron-right'))
    expect(screen.getByText('src')).toBeInTheDocument()
  })

  it('reveals the project folder in the system file manager', async () => {
    renderExplorer()
    await screen.findByText('src')

    openMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Reveal in File Explorer' }))

    expect(openInFileExplorer).toHaveBeenCalledWith('C:/repo')
    expect(screen.queryByRole('menu')).toBeNull()
  })
})
