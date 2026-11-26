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

## Infrastructure

The inventory describes what the dashboard renders; this is where each role
runs. Names stay generic on purpose — addresses and VMIDs live only in
`inventory.local.json`.

| Guest | Kind | Role | Shown under |
| --- | --- | --- | --- |
| hypervisor | host | Proxmox VE, runs the collector | Machines |
| workstation | VM | daily-driver desktop | Machines |
| storage | VM | NAS and media | Machines |
| windows | VM | Windows build target, native runner | Machines |
| laptop | device | macOS build target, native runner | Machines |
| dns | LXC | Pi-hole | LXC Containers |
| tunnel | LXC | Tailscale, the tailnet entry point | LXC Containers |
| uptime | LXC | Uptime Kuma | LXC Containers |
| secrets | LXC | Vaultwarden | LXC Containers |
| gitlab | LXC | GitLab runners: Linux testing and qualification | LXC Containers |
| circleci | LXC | CircleCI runners: Linux release builds | LXC Containers |

Both CI containers are unprivileged, run their own Docker daemon, and hold no
release credentials — the GitLab one tests, the CircleCI one builds and ships.

## Layout

```
src/
  routes/index.tsx        the dashboard page (machines + services + live stats)
  routes/__root.tsx       document shell, head, global styles
  components/             machine card, service card, meters, icons
  lib/                    shared types, inventory validation, formatters
  server/                 server functions + Worker binding access
collector/
  homelab-collector.py    the collector (runs on the hypervisor)
  homelab-collector.service
scripts/
  sync.ts                 inventory → .dev.vars, KV, Worker secrets, collector config
  tunnel.ts               inventory → tunnel ingress + DNS records
inventory.example.json    schema reference with placeholder addresses
```

## Getting started

Requires Bun, a Cloudflare zone, and a host that is always on to run
`cloudflared`.

```bash
bun install
cp inventory.example.json inventory.local.json   # then edit it
bun run sync                                     # writes .dev.vars and collector config
bun run dev                                      # http://localhost:3000
```

`inventory.local.json` is the only file that describes your installation. It
holds the site title and apex domain, the Worker name and KV namespace id, and
the real addresses; everything derived from it is written to git-ignored files.
The tracked repository stays generic.

The dev server runs inside workerd (via `@cloudflare/vite-plugin`) with the real
Worker bindings, so what you see locally is what deploys. `bun run sync` seeds
the local KV simulation with the same inventory the Worker reads, so the dev
dashboard shows the real machines rather than the bundled example. `bun run sync` seeds
the local KV simulation with the same inventory the Worker reads, so the dev
dashboard shows the real machines rather than the bundled example.

### 1. Inventory

`inventory.local.json` is the single source of truth and is **never committed**.
`src/lib/inventory.ts` validates it and fails the build with a precise path on
the first mistake.

`site.apex` is the domain the dashboard and every service subdomain live under.
`deploy` holds the Worker name and the KV namespace that stores the inventory
(create it once with `cf kv namespaces create --title INVENTORY`). The tracked
`cloudflare.config.ts` reads them from this file at deploy time, so no site
detail has to live in git.

```jsonc
{
  "site": { "title": "homelab", "apex": "example.com" },
  "deploy": {
    "worker": "homelab",                  // the Worker `bun run deploy` pushes to
    "kvNamespaceId": "<from cf kv namespaces create --title INVENTORY>"
  },
  "machines": [
    // kind: hypervisor | vm | lxc | device (device = on the network, no agent)
    { "id": "nas", "name": "nas", "role": "storage", "kind": "vm", "vmid": 101 },
    { "id": "laptop", "name": "laptop", "role": "workstation", "kind": "device", "icon": "apple",
      "url": "https://laptop.example.com" }   // optional: makes the card a link
  ],
  "services": [
    {
      "slug": "jellyfin",            // becomes jellyfin.<apex>
      "name": "Jellyfin",
      "description": "Media server",
      "category": "Media",           // grouping in the UI
      "machine": "nas",              // links the card to a machine
      "icon": "jellyfin",            // logo key, see src/lib/logos.ts
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

### Presentation

`kind` decides which section a machine lands in: everything that is not `lxc`
appears under **Machines**, and containers get their own row between machines
and services. Only Proxmox guests report metrics, so a `device` card shows its
role and an explicit "no metrics agent" note rather than a row of fake zeroes.

`icon` picks a logo from `src/lib/logos.ts`. A slug with no mark falls back to a
monogram, which is the honest outcome for software that publishes none. Logos
are vendored from the community [dashboard-icons](https://github.com/homarr-labs/dashboard-icons)
and [selfh.st/icons](https://github.com/selfhst/icons) sets and imported through
Vite, so they are served from the dashboard's own origin and the page makes no
third-party requests. Each mark remains the trademark of its project and is
used only to identify it.

Resources draw as half-circle gauges. Any card's **⋯** menu switches every card
between gauges and the linear meters; the choice is remembered per browser.

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
bun run sync                                   # writes collector/config.json
scp collector/homelab-collector.py root@<hypervisor>:/usr/local/sbin/
scp collector/config.json          root@<hypervisor>:/etc/homelab-collector.json
scp collector/homelab-collector.service root@<hypervisor>:/etc/systemd/system/
ssh root@<hypervisor> systemctl enable --now homelab-collector
```

The collector reads `/etc/homelab-collector.json`; set
`HOMELAB_COLLECTOR_CONFIG` in its unit to keep the config somewhere else.

It answers `GET /stats` (resource sample + probes), `GET /health`, and
`GET /connect/<slug>` for non-HTTP services.

`/stats` is served from the last completed sample: a background thread rebuilds
it every 5 s. The request path never collects, so a slow probe (the guest agent,
an SSH check, a distant host) cannot drag a request past the dashboard's timeout
— which is exactly what used to happen when one probe pointed at
`login.tailscale.com` and took 1.4 s of every call.

#### CPU

The hypervisor's CPU figure is `/proc/stat` busy time: idle, iowait and steal are
subtracted, so a storage stall does not read as CPU work. The grey band is
iowait + steal — time the CPU was idle but the system was waiting, or time a
hypervisor took. Load average is a different measurement and cannot be stacked as
ring time; it stays in the tooltip alongside iowait, steal and Linux pressure
stall information (PSI) for I/O.

#### Where disk numbers come from

Proxmox reports usage for containers but only *provisioned size* for VMs, so the
collector tries four sources and records which one it used (`diskSource`):

| Guest | Source |
| --- | --- |
| container | `pvesh` config for the provisioned size; `df -B1 /` inside the guest for writable free (cached 60s) |
| VM | QEMU guest agent filesystem table, root mount preferred (cached 60s) |
| appliance that cannot run the agent | `df` over SSH, from `machine.diskProbe` |
| machine that is not a guest at all | a probe script on the host, from `machine.remoteStats` |

Every disk figure uses the same rule: the denominator is the size that was
provisioned, and anything that is not writable free space counts as used — the
unformatted slice, ext4 metadata, and the blocks ext4 reserves for root. A 96 GiB
volume that formats to 93.9 GiB therefore reads `used / 96`, not `used / 93.9`.
The hypervisor root LV is measured the same way (provisioned size minus
`f_bavail`) and kept in its disk tooltip, as is the MacBook (device size minus
`df` available).

The hypervisor card's headline disk gauge is the shared LVM thin pool behind
`local-lvm`, not root. The outer arc is data actually written; the grey band is
capacity committed to thin volumes and snapshots but not yet written. The note
shows the committed share, and the tooltip carries the pool name, metadata and
root `/` figures. A pool that reaches 100% committed is the thin-provisioning
warning no guest's own filesystem can show.

Memory works the same way: containers report it, balloooned VMs report it, and a
VM with **PCIe passthrough** cannot balloon at all — the guest's memory has to
stay mapped for DMA, so Proxmox falls back to reporting the QEMU process size and
the VM looks full. Those guests are asked directly through the agent instead
(`qm guest exec`, cached 60 s), which is the only accurate source left.

#### GPUs

A guest's card shows the graphics device its Proxmox configuration gives it. The
collector reads `hostpci*` entries for passthrough and `vga: virtio-gl` (plus any
`rendernode=` in `args`) for a GPU the host renders with, then resolves the PCI
address through `lspci`. Passthrough hides the device from the hypervisor, so a
running Windows guest is asked through the guest agent for its adapter name and
dedicated VRAM (`qm guest exec`, cached 30 s). A virtio-gl guest shows the host
GPU instead, without a VRAM figure: that memory belongs to the host, not the
guest.

The SSH fallback is deliberately narrow. The collector's key is pinned
server-side to a single read-only command, so it can measure and nothing else:

```
# /root/.ssh/authorized_keys on the guest
restrict,command="df -B1 /DATA" ssh-ed25519 AAAA… homelab-collector@<hypervisor>

# inventory.local.json
{ "id": "nas", "vmid": 101, "diskProbe": { "ssh": "user@10.0.0.21", "path": "/DATA" } }
```

`restrict` disables PTYs, agent forwarding and port forwarding, and the forced
command overrides whatever the client asks for. If no source answers, the card
falls back to showing provisioned size and says so.

#### Machines outside Proxmox

A laptop on the tailnet has no hypervisor to ask, so it runs a probe script of
its own — `collector/remote/macos-stats.sh` — which prints `key=value` lines from
`sysctl`, `top`, `vm_stat` and `df`. The collector reaches it through a container
that is on the same network (`remoteStats.jump`), and the key is pinned to that
one script:

```
restrict,command="/Users/<you>/.homelab-stats.sh" ssh-ed25519 AAAA… homelab-collector-mac
```

Samples are cached for 30 s, because `top` needs about a second to measure CPU.

Two keys have to line up, and both failures are silent in the dashboard — the
machine simply stops appearing:

1. The `authorized_keys` entry above must be the public half of
   `/etc/homelab-collector/ssh_probe` on the hypervisor. `ssh-keygen -lf` both
   and compare.
2. With `remoteStats.jump` the SSH client runs **inside** that container
   (`pct exec <jump> -- ssh …`), so the private key must exist there too, not
   only on the hypervisor:

```bash
ssh root@<hypervisor> '
  pct exec <jump> -- install -d -m 0755 /etc/homelab-collector
  pct push <jump> /etc/homelab-collector/ssh_probe /etc/homelab-collector/ssh_probe \
    --perms 600 --user root --group root'
```

That copy lives in the container's rootfs, so it is lost if the container is
rebuilt — re-run the commands after rebuilding the jump container. The collector
now writes one line to its journal when a machine stops or resumes reading:

```bash
journalctl -u homelab-collector | grep 'machine mb-pro'
```

### 4. Worker

Deploys run on Cloudflare, not from a laptop: the `homelab` Worker is connected
to this repository, so a push to `main` builds and ships it. The build runs
`bun run build`; the deploy runs `bun run deploy:prebuilt`, which uploads the
Build Output that build produced. Nothing on a developer machine needs a
deploy token.

For a one-off from a checkout, `cf` does the same thing locally:

```bash
bun run deploy             # cf deploy: build + upload in one step
bun run sync --push        # inventory to KV, STATS_URL and the Access token
```

`cloudflare.config.ts` is tracked and generic: it reads `site.apex`, the Worker
name and the KV namespace id from `inventory.local.json` when that file exists,
and falls back to placeholders so a fresh clone still builds. The CI build has
no inventory file and passes those values as build-time variables instead:

| Variable | Example |
| --- | --- |
| `SITE_APEX` | `example.com` |
| `WORKER_NAME` | `homelab` |
| `INVENTORY_KV_ID` | the namespace id from `deploy.kvNamespaceId` |
| `CLOUDFLARE_ACCOUNT_ID` | the account holding the Worker |

The connection itself is one `cf` call; `script-tag` is the Worker's immutable
tag, not its name:

```bash
cf workers scripts search --name homelab    # → id, which is the tag
cf builds workers create <tag> \
  --git-repository-provider-type github \
  --git-repository-provider-account-id <github-user-id> \
  --git-repository-provider-account-name <github-user> \
  --git-repository-repo-id <github-repo-id> \
  --git-repository-repo-name <repo> \
  --git-repository-branch main \
  --production-settings-build-command "bun run build" \
  --production-settings-deploy-command "bun run deploy:prebuilt" \
  --production-settings-build-token-uuid <build-token-uuid> \
  --production-settings-environment-variables @env.json \
  --previews-enabled false
```

`cf builds workers get <tag>` prints the current settings and
`cf builds tokens list` shows the build tokens a repository may use.

A build token is its own credential: `cf user tokens create` makes the API token
the build deploys with, and `cf builds tokens create` wraps it for the build
system. It needs only these permission groups:

| Permission group | Scope | Why |
| --- | --- | --- |
| Workers Scripts Write, Read | account | upload the Worker and its version |
| Workers KV Storage Read | account | validate the `INVENTORY` binding |
| Zone Read, Workers Routes Write | the site's zone | attach the `triggers` routes |

`--build-token-secret` takes the **value** of the API token it wraps, so capture
that value when creating it — Cloudflare shows it once. Keep the two tokens out
of each other's way: one build token per Worker.

`cf` is the Cloudflare CLI used throughout this repository. Do not add wrangler
commands, scripts or dependencies back:

| Instead of | Use |
| --- | --- |
| `wrangler deploy` | `bun run deploy` (`cf deploy`) |
| `wrangler kv namespace create` | `cf kv namespaces create --title INVENTORY` |
| `wrangler kv key put` | `cf kv keys put --namespace-id <id> --file <path>` |
| `wrangler secret put` | `cf workers secrets bulk-edit` (what `bun run sync --push` uses) |
| `wrangler tail` | `cf observability tail` |

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
4. If the dashboard code changed: push to `main`; Cloudflare builds and deploys it.

## What is deliberately not here

- **Inventory** — real hostnames, tailnet and LAN addresses, VM ids, apex domain.
- **Worker name, routes and KV namespace id** — read from the inventory at deploy time.
- **Tunnel id and ingress table** — lives in Cloudflare.
- **Access service token, deploy token** — Worker secrets, never in git.
- **`.dev.vars`** — generated local bindings.

Everything in that list is git-ignored, and `scripts/sync.ts` regenerates the
derivable parts. The example inventory uses `10.0.0.x` and `100.64.0.x`
placeholders so a fresh clone renders without leaking anything.

### Apps that reject `X-Forwarded-For`

SABnzbd answers `403 External internet access denied` to any request carrying a
public `X-Forwarded-For`. Cloudflare adds that header and cloudflared rewrites it
when connecting to the origin, so a Transform Rule on the zone cannot remove it —
verified by pointing a hostname at a header-dumping listener: the header still
arrived after a `remove` rule in `http_request_late_transform`. SABnzbd's
`host_whitelist` no longer overrides the check either.

`tunnel/sabnzbd-header-strip.nginx.conf` sits in the tunnel container and proxies
the hostname to the app with the header stripped, which is the first hop that is
downstream of both. Anything else that refuses proxied traffic can be added the
same way.

## Backups

Three jobs, all landing in the hypervisor's `local` storage
(`/var/lib/vz/dump`), none of them storing a machine's bulk:

| Job | What | When | Size | Keep |
| --- | --- | --- | --- | --- |
| `vzdump` (Proxmox job) | the guests worth rebuilding | weekly | — | 2 |
| `pve-config-backup.timer` | `/etc/pve`, network, apt, units | daily 03:30 | — | 7 |
| `omarchy-config-backup.timer` | omarchy's config, not its repos | daily 03:45 | — | 7 |

`pve-config` is the one that makes a rebuild possible at all: VM and container
definitions live in pmxcfs, so no `vzdump` archive contains them. Restoring on a
fresh Proxmox is `tar -xf` into `/`.

`omarchy-config` captures `/etc`, dotfiles, `~/.ssh`, and package manifests
(`pacman -Qqe`, AUR list, enabled units, fonts) — enough to rebuild the
workstation. Large project checkouts and caches are excluded as reproducible,
as are application profiles under `~/.config` that are caches in disguise.

The timer runs as a system service, so its target and paths live in
`/etc/homelab-backup.env` (`REMOTE`, and `KEY`/`HOME_DIR` when the service has no
login home); the unit fails loudly if `REMOTE` is missing rather than guessing
an address.

Big or trivially rebuilt guests are deliberately skipped, as is omarchy's bulk
(git repos, toolchains, caches). Keep the backup target on separate storage from
the guests it protects, or it only covers mistakes and bad upgrades, not drive
failure.

## Notes

### Edge-injected nodes and hydration

Cloudflare injects a hidden anchor as the first child of `<body>` on proxied
zones (observed on this setup):

```html
<a href="/cdn-cgi/content?id=…" aria-hidden="true" style="display:none"></a>
```

Solid hydrates by matching nodes positionally, so one unexpected node shifts the
tree and hydration gives up *silently* — the page renders, then ignores every
click, keystroke and menu. `src/client.tsx` removes leading `<body>` elements
that the server did not produce (anything without Solid's `data-hk` marker)
before hydrating. Keep that file if you change frameworks; without it the
dashboard is a static picture behind Cloudflare.


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
