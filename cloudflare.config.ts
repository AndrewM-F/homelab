import { readFileSync } from 'node:fs'
import { bindings, defineConfig, triggers } from 'cf/config'

/**
 * Deploy configuration, kept generic in git.
 *
 * A checkout reads the real values from `inventory.local.json`, which is never
 * committed. CI has no inventory file, so it passes the same few values as
 * build-time environment variables. Both paths are optional: a fresh clone
 * still builds against the placeholders below.
 */
function fromLocalInventory(): Record<string, string | undefined> {
  try {
    const inventory = JSON.parse(
      readFileSync(new URL('./inventory.local.json', import.meta.url), 'utf8'),
    ) as { site?: { apex?: string }; deploy?: Record<string, string | undefined> }
    return {
      apex: inventory.site?.apex,
      worker: inventory.deploy?.worker,
      accountId: inventory.deploy?.accountId,
      kvNamespaceId: inventory.deploy?.kvNamespaceId,
    }
  } catch {
    return {}
  }
}

const local = fromLocalInventory()

const apex = process.env.SITE_APEX ?? local.apex ?? 'example.com'
const workerName = process.env.WORKER_NAME ?? local.worker ?? 'homelab'
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID ?? local.accountId
const kvNamespaceId = process.env.INVENTORY_KV_ID ?? local.kvNamespaceId ?? '<kv-namespace-id>'

export default defineConfig({
  ...(accountId ? { accountId } : {}),
  worker: {
    name: workerName,
    compatibilityDate: '2025-11-01',
    compatibilityFlags: ['nodejs_compat'],
    entrypoint: '@tanstack/solid-start/server-entry',
    observability: { enabled: true, headSamplingRate: 1 },
    triggers: [
      triggers.fetch({ pattern: `${apex}/*`, zone: apex }),
      triggers.fetch({ pattern: `www.${apex}/*`, zone: apex }),
    ],
    env: {
      INVENTORY: bindings.kv({ id: kvNamespaceId }),
      // Declared so local dev reads them from .dev.vars. Each one must already
      // exist as a Worker secret: a declaration is enforced at deploy time.
      STATS_URL: bindings.secret(),
      CF_ACCESS_CLIENT_ID: bindings.secret(),
      CF_ACCESS_CLIENT_SECRET: bindings.secret(),
    },
  },
})
