import { For, type JSX } from 'solid-js'
import { Dynamic } from 'solid-js/web'
import { ColumnsFourIcon, ColumnsThreeIcon, ColumnsTwoIcon } from './icons'
import { gridColumns, setGridColumnsPreference, type GridColumns, type GridSection } from '../lib/grid-columns'

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

const SECTION_LABEL: Record<GridSection, string> = {
  machines: 'Machine',
  containers: 'Container',
  services: 'Service',
}

/**
 * Column count for one section's grid. Each section keeps its own, so machines
 * can be three wide while services are four.
 */
export function ColumnSwitch(props: { section: GridSection }): JSX.Element {
  return (
    <div class="column-switch" role="group" aria-label={`${SECTION_LABEL[props.section]} columns`}>
      <For each={OPTIONS}>
        {(option) => (
          <button
            type="button"
            aria-pressed={gridColumns(props.section) === option.value}
            aria-label={option.label}
            title={option.label}
            onClick={() => setGridColumnsPreference(props.section, option.value)}
          >
            <Dynamic component={option.icon} />
          </button>
        )}
      </For>
    </div>
  )
}
