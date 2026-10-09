import { SquareTerminal } from 'lucide-react'
import { useEffect, useState } from 'react'

import { useT, useTDynamic } from '../../lib/i18n'
import { discoverShells, type ShellOption } from '../../lib/tauri/terminalSettings'
import { shellKindLabel } from '../../lib/terminalPreferences'
import { RowSelect, type RowSelectOption } from './RowSelect'

/** A plain shell tab's shell, among the installed ones; '' keeps the default from Preferences. */
export function ShellSelect({
  value,
  onChange,
}: {
  value: string
  onChange: (shell: string) => void
}) {
  const t = useT()
  const tDynamic = useTDynamic()
  const [shells, setShells] = useState<ShellOption[]>([])
  useEffect(() => {
    let active = true
    // Without the list the default stays available, so a failed discovery needs no message here.
    discoverShells()
      .then((items) => {
        if (active) setShells(items)
      })
      .catch(() => undefined)
    return () => {
      active = false
    }
  }, [])
  const options: RowSelectOption[] = [
    { value: '', title: t('prefs.defaultShell') },
    ...shells.map((shell) => ({
      value: shell.id,
      title: shellKindLabel(shell.kind, tDynamic),
      description: shell.id,
    })),
  ]
  const selected = options.find((option) => option.value === value) ?? options[0]
  return (
    <RowSelect
      field="shell"
      ariaLabel={t('prefs.shell')}
      value={selected.value}
      options={options}
      onChange={onChange}
      icon={<SquareTerminal size={15} />}
      title={selected.title}
      side={selected.description}
    />
  )
}
