# homelab

A private operations dashboard for a homelab, served from Cloudflare's edge.

Every service gets its own subdomain — `jellyfin.<apex>`, `proxmox.<apex>`,
`vault.<apex>` — reverse-proxied through a Cloudflare Tunnel. Nothing is exposed
on the router, no inbound ports are opened, and every hostname is gated by
Cloudflare Access before a single byte reaches the origin.

The dashboard itself shows live CPU, memory, disk and network per virtual
machine and container, plus a health probe for each service.

```
                          ┌──────────────────────────────┐
   browser ──HTTPS──▶ Cloudflare edge                       │
                          │  ├─ Access policy (your email)│
                          │  ├─ Worker  → apex dashboard  │
                          │  └─ Tunnel  → <slug>.<apex>   │
                          └──────────┬───────────────────┘
                                     │ QUIC (outbound only)
                          ┌──────────▼───────────┐
                          │  cloudflared         │
                          │  (always-on host)    │
                          └──────────┬───────────┘
              ┌──────────────────────┼───────────────────────┐
        ┌─────▼─────┐          ┌─────▼─────┐          ┌──────▼──────┐
        │ hypervisor│          │  NAS / VM │          │ container   │
        │ :8006     │          │  :8096 …  │          │ :3001 …     │
        └─────┬─────┘          └───────────┘          └─────────────┘
              │ pvesh
        ┌─────▼──────────────┐
        │ stats collector    │◀── dashboard fetches /stats over the tunnel
        └────────────────────┘
```

## Stack

- **TanStack Start** (Solid) rendering a Cloudflare Worker — SSR dashboard, live
  data via server functions, no build step on the client.
- **Cloudflare Tunnel** (remotely managed) for ingress; the ingress table lives
  in Cloudflare, not in this repo.
- **A ~400-line stdlib-only Python collector** on the hypervisor: it reads
  `pvesh get /cluster/resources`, `/proc`, and probes each service over the LAN.
- **Cloudflare Access** with one policy for the owner and one for a service
  token, so the Worker can reach the collector without a human session.

## Layout

```
src/
  routes/index.tsx        the dashboard page (machines + services + live stats)
  routes/__root.tsx       document shell, head, global styles
  components/             machine card, service card, meters, icons
  lib/                    shared types, inventory validation, formatters
  server/                 server functions + Worker binding access
collector/
  homelab-collector.py     the collector (runs on the hypervisor)
  homelab-collector.service
scripts/
  sync.ts                 inventory → Worker secret, .dev.vars, collector config
  tunnel.ts               inventory → tunnel ingress + DNS records
inventory.example.json    schema reference with placeholder addresses
```

## Getting started

Requires Bun, a Cloudflare zone, and a host that is always on to run
`cloudflared`.

```bash
bun install
cp inventory.example.json inventory.local.json   # then edit it
bun run sync                                     # writes .dev.vars + collector config
bun run dev                                      # http://localhost:3000
```

The dev server runs inside workerd (via `@cloudflare/vite-plugin`) with the real
Worker bindings, so what you see locally is what deploys.

### 1. Inventory

`inventory.local.json` is the single source of truth and is **never committed**.
`src/lib/inventory.ts` validates it and fails the build with a precise path on
the first mistake.

```jsonc
{
  "site": { "title": "homelab", "apex": "example.com" },
  "machines": [
    { "id": "nas", "name": "nas", "role": "storage", "vmid": 101 }
  ],
  "services": [
    {
      "slug": "jellyfin",            // becomes jellyfin.<apex>
      "name": "Jellyfin",
      "description": "Media server",
      "category": "Media",           // grouping in the UI
      "machine": "nas",              // links the card to a machine
      "origin": "http://10.0.0.21:8096",
      "probeUrl": "http://10.0.0.21:8096/health",
      "originTLS": "skip",           // self-signed origin
      "originName": "nas.internal",  // SNI override
      "originHost": "pi.hole",       // Host header, for origins that validate it
      "path": "/admin/",             // appended to the public URL
      "tags": ["streaming"]
    }
  ]
}
```

A service with `connect` instead of `origin` does not get a tunnel — it gets a
connection page (useful for RDP, SSH, VNC where a browser cannot help).

### 2. Tunnel and DNS

```bash
bun run tunnel plan
COLLECTOR_URL=http://<hypervisor>:9101 bun run tunnel apply --tunnel <tunnel-id>
```

`COLLECTOR_URL` is required for `apply`: the connector host must know how to
reach the collector, and that address is deliberately not hard-coded.

`plan` prints the ingress table. `apply` pushes it to the tunnel and reconciles
one proxied CNAME per hostname. Re-running is safe.

### 3. Collector

```bash
scp collector/homelab-collector.py root@<hypervisor>:/usr/local/sbin/
scp collector/config.json        root@<hypervisor>:/etc/homelab-collector.json
scp collector/homelab-collector.service root@<hypervisor>:/etc/systemd/system/
ssh root@<hypervisor> systemctl enable --now homelab-collector
```

It answers `GET /stats` (resource sample + probes), `GET /health`, and
`GET /connect/<slug>` for non-HTTP services.

### 4. Worker

```bash
bun run build
wrangler deploy            # needs CLOUDFLARE_API_TOKEN
bun run sync --push        # INVENTORY_JSON, STATS_URL and the Access token
```

Routes for the apex and `www` are declared in `wrangler.jsonc`. The generated
deploy config is written to `dist/server/wrangler.json`; do not pass
`--config wrangler.jsonc` to `wrangler deploy`.

### 5. Access

One self-hosted application covering `<apex>` and `*.<apex>`, with two policies:

| Policy | Decision | Include | Why |
| --- | --- | --- | --- |
| owner | allow | your email | humans |
| dashboard → collector | non_identity | service token | the Worker fetches `/stats` without a session |

The service token's client id and secret are Worker secrets. Redeem them only
from the Worker — never ship them to the browser.

## Adding a service

1. Add an entry to `inventory.local.json`.
2. `bun run sync && bun run tunnel apply --tunnel <id>`
3. If the collector changed: re-copy `collector/config.json` and restart it.
4. If the dashboard code changed: `bun run deploy`.

## What is deliberately not here

- **Inventory** — real hostnames, tailnet and LAN addresses, VM ids.
- **Tunnel id and ingress table** — lives in Cloudflare.
- **Access service token, deploy token** — Worker secrets, never in git.
- **`.dev.vars`** — local bindings.

Everything in that list is git-ignored, and `scripts/sync.ts` regenerates the
derivable parts. The example inventory uses `10.0.0.x` placeholders so a fresh
clone renders without leaking anything.

## Notes

- TanStack Start pins `solid-js@^1.9`. The Solid 2 line (`@tanstack/solid-start@2.0.0-rc`)
  is published but its core packages are version-skewed, so it does not build.
  When that lands, this repo is a two-line dependency bump plus `@solidjs/web`
  in the JSX config.
- Native clients (a TV Jellyfin app, for example) cannot complete an interactive
  Access login. Point those at the tailnet address instead, or add a bypass
  policy scoped to a specific hostname.
- Web terminals and admin shells are intentionally not published. If you add
  one, it is protected by Access alone — decide that deliberately.

## Licence

MIT — see `LICENSE`.
