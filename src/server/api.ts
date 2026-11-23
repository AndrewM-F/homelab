import { createServerFn } from '@tanstack/solid-start'
import { readInventory, readStats, publicInventory } from './data'

/** Everything the dashboard renders. Internal addresses are stripped. */
export const fetchDashboard = createServerFn({ method: 'GET' }).handler(async () => {
  const { inventory, degraded } = readInventory()
  return {
    inventory: publicInventory(inventory),
    degraded,
  }
})

/** Live resource sample, proxied from the collector behind the tunnel. */
export const fetchStats = createServerFn({ method: 'GET' }).handler(async () => {
  return readStats()
})
