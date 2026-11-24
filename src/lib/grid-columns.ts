import { createSignal } from 'solid-js'

/** Desktop column count for the card grids. Narrow screens fit fewer. */
export type GridColumns = 2 | 3 | 4

export const GRID_COLUMNS_KEY = 'homelab:grid-columns'

const DEFAULT: GridColumns = 3

/**
 * Written straight onto the document element, and read by the grid rules as
 * `var(--cols, 3)`. Putting it there rather than in a component's style prop is
 * what lets the boot script below apply the stored value before the first paint.
 */
const cssVar = '--cols'

const [gridColumns, setGridColumns] = createSignal<GridColumns>(DEFAULT)

export { gridColumns }

function parse(value: string | null): GridColumns {
  return value === '2' ? 2 : value === '4' ? 4 : 3
}

/**
 * Runs in <head>, before anything is painted. Without it a stored choice would
 * paint the three-column default first and then snap, because the server cannot
 * know a per-browser preference.
 */
export const GRID_COLUMNS_BOOT =
  `(function(){try{var v=localStorage.getItem(${JSON.stringify(GRID_COLUMNS_KEY)});` +
  `if(v==='2'||v==='3'||v==='4')document.documentElement.style.setProperty('${cssVar}',v)}catch(e){}})()`

export function readStoredGridColumns(): GridColumns {
  try {
    return parse(window.localStorage.getItem(GRID_COLUMNS_KEY))
  } catch {
    return DEFAULT
  }
}

function paint(value: GridColumns): void {
  document.documentElement.style.setProperty(cssVar, String(value))
}

export function applyStoredGridColumns(value: GridColumns): void {
  setGridColumns(value)
  paint(value)
}

export function setGridColumnsPreference(value: GridColumns): void {
  setGridColumns(value)
  paint(value)
  try {
    window.localStorage.setItem(GRID_COLUMNS_KEY, String(value))
  } catch {
    // private mode or storage disabled: the choice just will not persist
  }
}
