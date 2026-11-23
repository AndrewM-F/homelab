import { createSignal } from 'solid-js'

/** How resource usage is drawn on machine and container cards. */
export type ResourceView = 'gauge' | 'bar'

const STORAGE_KEY = 'homelab:resource-view'

/**
 * Starts on gauges for every render, including the server pass. The stored
 * preference is applied after mount, because reading localStorage during the
 * first render would produce markup the server cannot match.
 */
const [resourceView, setResourceView] = createSignal<ResourceView>('gauge')

export { resourceView }

export function readStoredResourceView(): ResourceView {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === 'bar' ? 'bar' : 'gauge'
  } catch {
    return 'gauge'
  }
}

export function toggleResourceView(): void {
  const next: ResourceView = resourceView() === 'gauge' ? 'bar' : 'gauge'
  setResourceView(next)
  try {
    window.localStorage.setItem(STORAGE_KEY, next)
  } catch {
    // private mode or storage disabled: the choice just will not persist
  }
}

export function applyStoredResourceView(view: ResourceView): void {
  setResourceView(view)
}
