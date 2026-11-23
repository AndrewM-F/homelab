import exampleInventory from '../../inventory.example.json'
import { parseInventory } from '../lib/inventory'
import type { Addresses, Inventory, Service, Snapshot, StatsResponse } from '../lib/types'
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

export async function readInventory(): Promise<InventoryResult> {
  const now = Date.now()
  if (inventoryCache && now - inventoryCache.at < INVENTORY_TTL_MS) {
    return { inventory: inventoryCache.value, degraded: inventoryCache.degraded }
  }

  // KV holds the real inventory; the secret is a local-dev fallback, and the
  // bundled example is the last resort before the dashboard renders empty.
  let raw = (await bindings().INVENTORY?.get('inventory'))?.trim()
  if (!raw) raw = bindings().INVENTORY_JSON?.trim()
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

/** Tailscale hands out 100.64.0.0/10; everything else private is the LAN. */
const TAILNET = /^100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\./
const LAN = /^(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.)/

type Scope = 'tailnet' | 'lan' | 'other'

function scopeOf(host: string): Scope {
  if (TAILNET.test(host)) return 'tailnet'
  if (LAN.test(host)) return 'lan'
  if (host.endsWith('.ts.net')) return 'tailnet'
  return 'other'
}

interface Endpoint {
  host: string
  port?: number
  secure: boolean
}

function endpoint(url: string | undefined): Endpoint | undefined {
  if (!url) return undefined
  try {
    const parsed = new URL(url)
    const port = parsed.port ? Number(parsed.port) : undefined
    return { host: parsed.hostname, port, secure: parsed.protocol === 'https:' }
  } catch {
    return undefined
  }
}

/** `host` alone when the port is the scheme default, so copied values stay short. */
function formatAddress(endpoint: Endpoint): string {
  if (!endpoint.port) return endpoint.host
  const isDefault = endpoint.port === (endpoint.secure ? 443 : 80)
  return isDefault ? endpoint.host : `${endpoint.host}:${endpoint.port}`
}

/**
 * Works out the copyable addresses for a service. `origin` and `probeUrl` are
 * the only values guaranteed to be real endpoints, so they are the source;
 * `addresses` overrides them for services that listen on one path only.
 */
function resolveAddresses(service: Service): Addresses | undefined {
  const resolved: Addresses = { ...service.addresses }

  const origin = endpoint(service.origin)
  const probe = endpoint(service.probeUrl)

  if (!resolved.tailnet && origin && scopeOf(origin.host) === 'tailnet') {
    resolved.tailnet = formatAddress(origin)
  }
  if (!resolved.lan && probe && scopeOf(probe.host) === 'lan') {
    resolved.lan = formatAddress(probe)
  }
  if (!resolved.lan && origin && scopeOf(origin.host) === 'lan') {
    resolved.lan = formatAddress(origin)
  }

  return resolved.tailnet || resolved.lan ? resolved : undefined
}

/**
 * Shapes the payload the browser receives: tunnel plumbing and probe URLs are
 * removed, and replaced with the plain addresses the copy menu offers.
 * This runs behind Cloudflare Access, so the addresses only reach a logged-in
 * owner — nothing here is rendered for an anonymous request.
 */
export function publicInventory(inventory: Inventory): Inventory {
  const services = inventory.services.map((service) => {
    const copy: Service = { ...service, addresses: resolveAddresses(service) }
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
