import { env } from 'cloudflare:workers'

/**
 * Bindings available to the Worker. Values that are private (the real
 * inventory, the collector URL, the Access service token) are set as Worker
 * secrets and never appear in this repository.
 */
export interface Bindings {
  /** Full inventory document, JSON. Set by `bun run sync`. */
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
