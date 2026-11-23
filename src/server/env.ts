import { env } from 'cloudflare:workers'

/**
 * Bindings available to the Worker. Values that are private (the real
 * inventory, the collector URL, the Access service token) are set as Worker
 * secrets and never appear in this repository.
 */
export interface Bindings {
  /** Inventory document, JSON, read from KV. Written by `bun run sync --push`. */
  INVENTORY?: KVNamespace
  /** Fallback binding for local dev, where KV is empty. */
  INVENTORY_JSON?: string
  /** Collector base URL reachable through the Cloudflare Tunnel. */
  STATS_URL?: string
  /** Access service token authorised for the collector hostname. */
  CF_ACCESS_CLIENT_ID?: string
  CF_ACCESS_CLIENT_SECRET?: string
}

export function bindings(): Bindings {
  return env as unknown as Bindings
}
