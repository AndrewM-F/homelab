import { createFileRoute } from '@tanstack/solid-router'
import { For, Show, createMemo, createSignal, onCleanup, onMount } from 'solid-js'
import { CubeIcon, GridIcon, LockIcon, RefreshIcon, SearchIcon, ServerIcon } from '../components/icons'
import { MachineCard } from '../components/machine-card'
import { ServiceCard } from '../components/service-card'
import { clock, percent } from '../lib/format'
import { applyStoredResourceView, readStoredResourceView } from '../lib/resource-view'
import type { GuestStat, HostSample, Inventory, Machine, ProbeResult, Service, StatsResponse } from '../lib/types'
import { fetchDashboard, fetchStats } from '../server/api'

const POLL_MS = 10_000

export const Route = createFileRoute('/')({
  loader: async () => {
    const [dashboard, stats] = await Promise.all([fetchDashboard(), fetchStats()])
    return { inventory: dashboard.inventory, degraded: dashboard.degraded, stats }
  },
  component: Dashboard,
})

function kindOf(machine: Machine): NonNullable<Machine['kind']> {
  return machine.kind ?? (machine.vmid === undefined ? 'device' : 'vm')
}

function Dashboard() {
  const data = Route.useLoaderData()
  const inventory = (): Inventory => data().inventory

  const [stats, setStats] = createSignal<StatsResponse>(data().stats)
  const [query, setQuery] = createSignal('')
  const [refreshing, setRefreshing] = createSignal(false)
  let searchRef: HTMLInputElement | undefined

  const snapshot = () => (stats().ok ? stats().snapshot : null)

  const refresh = async () => {
    setRefreshing(true)
    try {
      setStats(await fetchStats())
    } finally {
      setRefreshing(false)
    }
  }

  onMount(() => {
    // Read after mount: doing it during the first render would produce markup
    // the server render cannot match.
    applyStoredResourceView(readStoredResourceView())

    const id = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refresh()
    }, POLL_MS)
    onCleanup(() => window.clearInterval(id))

    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      const typing = target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)
      if (event.key === '/' && !typing) {
        event.preventDefault()
        searchRef?.focus()
      }
      if (event.key === 'Escape' && target === searchRef) {
        setQuery('')
        searchRef?.blur()
      }
    }
    window.addEventListener('keydown', onKey)
    onCleanup(() => window.removeEventListener('keydown', onKey))
  })

  const guestByVmid = createMemo(() => {
    const map = new Map<number, NonNullable<StatsResponse['snapshot']>['guests'][number]>()
    for (const guest of snapshot()?.guests ?? []) map.set(guest.vmid, guest)
    return map
  })

  const probeBySlug = createMemo(() => {
    const map = new Map<string, ProbeResult>()
    for (const probe of snapshot()?.probes ?? []) map.set(probe.slug, probe)
    return map
  })

  /** Non-guest machines report through their own probe, keyed by machine id. */
  const hostById = createMemo(() => {
    const map = new Map<string, HostSample>()
    for (const sample of snapshot()?.hosts ?? []) map.set(sample.id, sample)
    return map
  })

  const machineById = createMemo(() => {
    const map = new Map<string, Machine>()
    for (const machine of inventory().machines) map.set(machine.id, machine)
    return map
  })

  const machineName = createMemo(() => {
    const map = new Map<string, string>()
    for (const machine of inventory().machines) map.set(machine.id, machine.name)
    return map
  })

  const matches = (haystack: (string | undefined)[], needle: string) =>
    haystack.filter(Boolean).join(' ').toLowerCase().includes(needle)

  const filteredMachines = createMemo(() => {
    const needle = query().trim().toLowerCase()
    if (!needle) return inventory().machines
    return inventory().machines.filter((machine) =>
      matches([machine.name, machine.role, machine.tags?.join(' ')], needle),
    )
  })

  /** Bare metal and virtual machines sit together; containers get their own row. */
  const computers = createMemo(() => filteredMachines().filter((m) => kindOf(m) !== 'lxc'))
  const containers = createMemo(() => filteredMachines().filter((m) => kindOf(m) === 'lxc'))

  const filteredGroups = createMemo(() => {
    const needle = query().trim().toLowerCase()
    const groups = new Map<string, Service[]>()
    for (const service of inventory().services) {
      if (needle) {
        const haystack = [
          service.name,
          service.description,
          service.category,
          service.tags?.join(' '),
          machineName().get(service.machine),
          service.slug,
        ]
        if (!matches(haystack, needle)) continue
      }
      const bucket = groups.get(service.category) ?? []
      bucket.push(service)
      groups.set(service.category, bucket)
    }
    return [...groups.entries()].map(([name, services]) => ({ name, services }))
  })

  const runningCount = createMemo(() => {
    const snap = snapshot()
    if (!snap) return null
    return snap.guests.filter((guest) => guest.status === 'running').length
  })

  /** `undefined` for machines with no metrics agent, so the dot stays neutral. */
  const isOnline = (machine: Machine): boolean | undefined => {
    // No sample at all means unknown, not down.
    if (!snapshot()) return undefined
    if (hostById().has(machine.id)) return true
    if (machine.vmid === undefined) return kindOf(machine) === 'hypervisor' ? true : undefined
    const guest = guestByVmid().get(machine.vmid)
    return guest ? guest.status === 'running' : undefined
  }

  /** Devices with no agent cannot report metrics whatever the collector says. */
  const isMeterable = (machine: Machine) =>
    kindOf(machine) === 'hypervisor' || machine.vmid !== undefined || hostById().has(machine.id)

  /** Present a host sample in the shape the card already renders. */
  const toGuest = (sample: HostSample): GuestStat => ({
    vmid: -1,
    type: 'qemu',
    status: 'running',
    cpu: sample.cpu,
    maxcpu: sample.cores,
    mem: sample.mem,
    maxmem: sample.memTotal,
    disk: sample.disk,
    maxdisk: sample.diskTotal,
    diskSource: sample.diskTotal > 0 ? 'guest' : 'allocated',
    diskAllocated: sample.diskTotal,
    // the probe script measures the host directly, so this is guest-reported
    memSource: 'guest',
    uptime: sample.uptime,
  })

  const renderMachine = (machine: Machine) => (
    <MachineCard
      machine={machine}
      guest={
        machine.vmid === undefined
          ? (() => {
              const sample = hostById().get(machine.id)
              return sample ? toGuest(sample) : undefined
            })()
          : guestByVmid().get(machine.vmid)
      }
      host={kindOf(machine) === 'hypervisor' ? snapshot()?.host : undefined}
      disk={kindOf(machine) === 'hypervisor' ? snapshot()?.disks?.[0] : undefined}
      online={isOnline(machine)}
      meterable={isMeterable(machine)}
    />
  )

  return (
    <div class="shell">
      <header class="topbar">
        <div class="brand">
          <span class="brand-mark" aria-hidden="true" />
          <span class="brand-name">{inventory().site.title}</span>
          <span class="brand-sub">{inventory().site.subtitle ?? 'homelab'}</span>
        </div>

        <div class="topbar-tools">
          <label class="search">
            <SearchIcon />
            <input
              ref={searchRef}
              type="search"
              placeholder="filter machines and services"
              value={query()}
              onInput={(event) => setQuery(event.currentTarget.value)}
              aria-label="Filter machines and services"
            />
            <kbd>/</kbd>
          </label>

          <button class="icon-button" onClick={() => void refresh()} title="Refresh now" aria-label="Refresh">
            <span classList={{ spinning: refreshing() }}>
              <RefreshIcon />
            </span>
          </button>
        </div>
      </header>

      <div class="statusline">
        <span class={`chip ${snapshot() ? 'is-live' : 'is-offline'}`}>
          <span class="chip-dot" />
          {snapshot() ? `updated ${clock(snapshot()!.ts)}` : 'stats offline'}
        </span>
        <Show when={snapshot()?.host}>
          {(host) => (
            <span class="chip is-quiet" title="Hypervisor CPU from load average">
              host {percent(host().cpu)}
            </span>
          )}
        </Show>
        <Show when={runningCount() !== null}>
          <span class="chip is-quiet">{runningCount()} guests up</span>
        </Show>
        <span class="chip is-quiet">{inventory().services.length} services</span>
        <span class="chip is-locked">
          <LockIcon />
          cloudflare access
        </span>
      </div>

      <Show when={data().degraded}>
        <div class="banner">
          No inventory is bound to this Worker — showing the example inventory. Run{' '}
          <code>bun run sync</code> to publish the real service list.
        </div>
      </Show>

      <Show when={!stats().ok && stats().error}>
        <div class="banner is-warn">
          Live stats unavailable: {stats().error}. Links below still work.
        </div>
      </Show>

      <main>
        <section class="section">
          <div class="section-head">
            <h2>
              <ServerIcon />
              Machines
            </h2>
            <span class="section-meta">
              {computers().length} of {inventory().machines.filter((m) => kindOf(m) !== 'lxc').length}
            </span>
          </div>
          <div class="machine-grid">
            <For each={computers()}>{renderMachine}</For>
          </div>
        </section>

        <Show when={inventory().machines.some((m) => kindOf(m) === 'lxc')}>
          <section class="section">
            <div class="section-head">
              <h2>
                <CubeIcon />
                LXC Containers
              </h2>
              <span class="section-meta">
                {containers().length} of {inventory().machines.filter((m) => kindOf(m) === 'lxc').length}
              </span>
            </div>
            <div class="machine-grid">
              <For each={containers()}>{renderMachine}</For>
            </div>
          </section>
        </Show>

        <section class="section">
          <div class="section-head">
            <h2>
              <GridIcon />
              Services
            </h2>
            <span class="section-meta">{inventory().services.length} linked</span>
          </div>

          <Show
            when={filteredGroups().length > 0}
            fallback={<p class="empty">Nothing matches “{query()}”.</p>}
          >
            <For each={filteredGroups()}>
              {(group) => (
                <div class="group">
                  <h3 class="group-label">
                    <span>{group.name}</span>
                    <span class="group-count">{group.services.length}</span>
                  </h3>
                  <div class="service-grid">
                    <For each={group.services}>
                      {(service) => (
                        <ServiceCard
                          inventory={inventory()}
                          service={service}
                          machineName={machineName().get(service.machine) ?? service.machine}
                          probe={probeBySlug().get(service.slug)}
                          machineOnline={(() => {
                            const host = machineById().get(service.machine)
                            return host ? isOnline(host) : undefined
                          })()}
                        />
                      )}
                    </For>
                  </div>
                </div>
              )}
            </For>
          </Show>
        </section>
      </main>

      <footer class="footer">
        <span>
          {inventory().site.apex} · targets are reachable through Cloudflare Tunnel and gated
          by Cloudflare Access
        </span>
        <Show when={snapshot()}>
          <span class="footer-meta">
            refreshed {stats().age !== undefined ? `${stats().age}s` : '—'} ago
          </span>
        </Show>
      </footer>
    </div>
  )
}
