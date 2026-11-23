import exampleInventory from '../../inventory.example.json'
import { parseInventory } from '../lib/inventory'
import type { Inventory, Service, Snapshot, StatsResponse } from '../lib/types'
import { PRIVATE_SERVICE_FIELDS } from '../lib/types'
import { bindings } from './env'

/** Inventory is small and changes rarely. */
const INVENTORY_TTL_MS = 60_000
/** Stats are polled by the browser every 10s; a short cache absorbs bursts. */
const STATS_TTL_MS = 4_000
const STATS_TIMEOUT_MS = 6_000

let inventoryCache: { at: number; value: Inventory; degraded: boolean } | undefined
let statsCache: { at: number; value: StatsResponse } | undefined

export interface InventoryResult {
  inventory: Inventory
  /** True when no real inventory is bound and the example is being served. */
  degraded: boolean
}

export function readInventory(): InventoryResult {
  const now = Date.now()
  if (inventoryCache && now - inventoryCache.at < INVENTORY_TTL_MS) {
    return { inventory: inventoryCache.value, degraded: inventoryCache.degraded }
  }

  const raw = bindings().INVENTORY_JSON?.trim()
  let inventory: Inventory
  let degraded = false

  if (raw) {
    try {
      inventory = parseInventory(JSON.parse(raw))
    } catch (error) {
      // A bad secret must not take the site down; fall back and say so.
      console.error('inventory: falling back to example:', error)
      inventory = parseInventory(exampleInventory)
      degraded = true
    }
  } else {
    inventory = parseInventory(exampleInventory)
    degraded = true
  }

  inventoryCache = { at: now, value: inventory, degraded }
  return { inventory, degraded }
}

/** Removes internal addresses and tunnel details before anything reaches the browser. */
export function publicInventory(inventory: Inventory): Inventory {
  const services = inventory.services.map((service) => {
    const copy: Service = { ...service }
    for (const field of PRIVATE_SERVICE_FIELDS) delete copy[field]
    return copy
  })
  return { ...inventory, services }
}

async function fetchCollector(url: string): Promise<Snapshot> {
  const { CF_ACCESS_CLIENT_ID, CF_ACCESS_CLIENT_SECRET } = bindings()
  const headers: Record<string, string> = { accept: 'application/json' }
  if (CF_ACCESS_CLIENT_ID && CF_ACCESS_CLIENT_SECRET) {
    headers['CF-Access-Client-Id'] = CF_ACCESS_CLIENT_ID
    headers['CF-Access-Client-Secret'] = CF_ACCESS_CLIENT_SECRET
  }

  const response = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(STATS_TIMEOUT_MS),
  })

  if (!response.ok) {
    throw new Error(`collector responded ${response.status}`)
  }

  const body = (await response.json()) as Snapshot
  if (!body || typeof body.ts !== 'number' || !body.host) {
    throw new Error('collector returned an unexpected payload')
  }
  return body
}

export async function readStats(): Promise<StatsResponse> {
  const now = Date.now()
  if (statsCache && now - statsCache.at < STATS_TTL_MS) return statsCache.value

  const url = bindings().STATS_URL?.trim()
  let value: StatsResponse

  if (!url) {
    value = { ok: false, snapshot: null, error: 'No stats collector configured' }
  } else {
    try {
      const snapshot = await fetchCollector(url)
      value = {
        ok: true,
        snapshot,
        age: Math.max(0, Math.round(now / 1000 - snapshot.ts)),
      }
    } catch (error) {
      value = {
        ok: false,
        snapshot: null,
        error: error instanceof Error ? error.message : 'collector unreachable',
      }
    }
  }

  statsCache = { at: now, value }
  return value
}
