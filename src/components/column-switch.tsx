import { For, type JSX } from 'solid-js'
import { Dynamic } from 'solid-js/web'
import { ColumnsFourIcon, ColumnsThreeIcon, ColumnsTwoIcon } from './icons'
import { gridColumns, setGridColumnsPreference, type GridColumns } from '../lib/grid-columns'

interface Option {
  value: GridColumns
  label: string
  icon: (props: { size?: number }) => JSX.Element
}

/** Densest first: the same order the columns appear in on screen. */
const OPTIONS: Option[] = [
  { value: 4, label: '4 columns', icon: ColumnsFourIcon },
  { value: 3, label: '3 columns', icon: ColumnsThreeIcon },
  { value: 2, label: '2 columns', icon: ColumnsTwoIcon },
]

/**
 * One shared preference, shown in every section head. A click in any of them
 * moves the grids everywhere and is remembered for the next visit.
 */
export function ColumnSwitch(): JSX.Element {
  return (
    <div class="column-switch" role="group" aria-label="Columns per row">
      <For each={OPTIONS}>
        {(option) => (
          <button
            type="button"
            aria-pressed={gridColumns() === option.value}
            aria-label={option.label}
            title={option.label}
            onClick={() => setGridColumnsPreference(option.value)}
          >
            <Dynamic component={option.icon} />
          </button>
        )}
      </For>
    </div>
  )
}
