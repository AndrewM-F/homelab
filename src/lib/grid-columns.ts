import { createSignal, type Accessor } from 'solid-js'

/** Desktop column count for a card grid. Narrow screens fit fewer. */
export type GridColumns = 2 | 3 | 4

/** Each card section remembers its own count. */
export type GridSection = 'machines' | 'containers' | 'services'

export const GRID_SECTIONS: readonly GridSection[] = ['machines', 'containers', 'services']

const DEFAULT: GridColumns = 3
/** Before the counts were per-section there was one shared key. */
const LEGACY_KEY = 'homelab:grid-columns'

const storageKey = (section: GridSection) => `${LEGACY_KEY}:${section}`
const cssVar = (section: GridSection) => `--cols-${section}`

/**
 * Written onto the document element and read by the grid rules as
 * `var(--cols-<section>, 3)`. Putting them there rather than in a component's
 * style prop is what lets the boot script apply stored values before first paint.
 */
const [machines, setMachines] = createSignal<GridColumns>(DEFAULT)
const [containers, setContainers] = createSignal<GridColumns>(DEFAULT)
const [services, setServices] = createSignal<GridColumns>(DEFAULT)

const state: Record<GridSection, [Accessor<GridColumns>, (value: GridColumns) => void]> = {
  machines: [machines, setMachines],
  containers: [containers, setContainers],
  services: [services, setServices],
}

export function gridColumns(section: GridSection): GridColumns {
  return state[section][0]()
}

function parse(value: string | null | undefined): GridColumns | undefined {
  return value === '2' ? 2 : value === '3' ? 3 : value === '4' ? 4 : undefined
}

export type StoredGridColumns = Record<GridSection, GridColumns>

/**
 * One count per section. A value saved under the old shared key seeds every
 * section that has no preference of its own yet, so an existing visit keeps the
 * layout it had.
 */
export function readStoredGridColumns(): StoredGridColumns {
  const stored = {} as StoredGridColumns
  let legacy: GridColumns | undefined
  try {
    legacy = parse(window.localStorage.getItem(LEGACY_KEY))
    for (const section of GRID_SECTIONS) {
      stored[section] = parse(window.localStorage.getItem(storageKey(section))) ?? legacy ?? DEFAULT
    }
  } catch {
    // private mode or storage disabled: fall back to the default everywhere
    for (const section of GRID_SECTIONS) stored[section] = legacy ?? DEFAULT
  }
  return stored
}

/**
 * Runs in <head>, before anything is painted. Without it the stored counts
 * would paint as the default first and then snap, because the server cannot
 * know a per-browser preference.
 */
export const GRID_COLUMNS_BOOT =
  `(function(){try{` +
  `var ok=function(v){return v==='2'||v==='3'||v==='4'?v:'${DEFAULT}'};` +
  `var legacy=localStorage.getItem(${JSON.stringify(LEGACY_KEY)})||'${DEFAULT}';` +
  `[${GRID_SECTIONS.map((section) => JSON.stringify(section)).join(',')}].forEach(function(s){` +
  `document.documentElement.style.setProperty('--cols-'+s,` +
  `ok(localStorage.getItem(${JSON.stringify(LEGACY_KEY)}+':'+s)||legacy))` +
  `});` +
  `}catch(e){}})()`

function paint(section: GridSection, value: GridColumns): void {
  document.documentElement.style.setProperty(cssVar(section), String(value))
}

export function applyStoredGridColumns(stored: StoredGridColumns): void {
  for (const section of GRID_SECTIONS) {
    state[section][1](stored[section])
    paint(section, stored[section])
  }
}

export function setGridColumnsPreference(section: GridSection, value: GridColumns): void {
  state[section][1](value)
  paint(section, value)
  try {
    window.localStorage.setItem(storageKey(section), String(value))
  } catch {
    // private mode or storage disabled: the choice just will not persist
  }
}
