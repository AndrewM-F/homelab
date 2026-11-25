import { Show, type JSX } from 'solid-js'
import { bytes, duration, percent } from '../lib/format'
import { resourceView, toggleResourceView } from '../lib/resource-view'
import type { GpuStat, GuestStat, HostStat, Machine } from '../lib/types'
import { CardMenu, type MenuItem } from './card-menu'
import { Gauge } from './gauge'
import { DiskIcon, GpuIcon } from './icons'
import { Logo } from './logo'
import { Inline, Meter } from './meter'

interface Props {
  machine: Machine
  guest?: GuestStat
  host?: HostStat
  /** `undefined` means unknown — a device with no metrics agent, or no sample yet. */
  online?: boolean
  /** Whether this machine *can* report metrics, independent of the current sample. */
  meterable: boolean
}

export function MachineCard(props: Props): JSX.Element {
  const sampled = () => Boolean(props.guest || props.host)
  const metered = () => props.meterable

  const cpu = () => (props.guest ? props.guest.cpu : (props.host?.cpu ?? 0))
  const memUsed = () => (props.guest ? props.guest.mem : (props.host?.memUsed ?? 0))
  const memTotal = () => (props.guest ? props.guest.maxmem : (props.host?.memTotal ?? 0))
  // The hypervisor's disk gauge is the shared thin pool, not the root LV: the
  // root is a small OS volume while every guest draws from the pool. Guests
  // keep their own filesystem figures; a host without a thin pool falls back to
  // root, which is the provisioned volume rather than the raw `df` sample.
  const pool = () => props.host?.pool
  const usingPool = () => (pool()?.total ?? 0) > 0
  const rootUsed = () => props.host?.disk ?? 0
  const rootTotal = () => props.host?.diskTotal ?? 0
  const rootFraction = () => (rootTotal() > 0 ? rootUsed() / rootTotal() : 0)
  const diskUsed = () =>
    usingPool() ? (pool()?.used ?? 0) : props.guest ? props.guest.disk : (props.host?.disk ?? 0)
  const diskTotal = () =>
    usingPool()
      ? (pool()?.total ?? 0)
      : props.guest
        ? props.guest.maxdisk
        : (props.host?.diskTotal ?? 0)
  const diskAllocated = () =>
    usingPool()
      ? (pool()?.total ?? 0)
      : props.guest
        ? props.guest.diskAllocated
        : (props.host?.diskTotal ?? 0)
  const uptime = () => (props.guest ? props.guest.uptime : (props.host?.uptime ?? 0))
  const cores = () => props.guest?.maxcpu ?? props.host?.cores ?? 0
  const coreLabel = () => `${cores()} core${cores() === 1 ? '' : 's'}`

  const memFraction = () => (memTotal() > 0 ? memUsed() / memTotal() : 0)
  // `mem` is already real use (cache excluded) and `memCache` is the extra resident
  // page cache, so the two add up to what the hypervisor is actually holding.
  const memCache = () => Math.max(0, props.guest?.memCache ?? props.host?.memCache ?? 0)
  const memRealFraction = () => (memTotal() > 0 ? Math.min(1, memUsed() / memTotal()) : 0)
  const memCacheFraction = () => (memTotal() > 0 ? Math.min(1 - memRealFraction(), memCache() / memTotal()) : 0)
  const memResident = () => memUsed() + memCache()
  const memCacheLabel = () => (memCache() > 0 ? `${bytes(memCache())} cache` : undefined)
  const diskFraction = () => (diskTotal() > 0 ? diskUsed() / diskTotal() : 0)
  // Containers report rootfs usage; VMs only report it when the guest agent
  // answers, so `diskSource` says which of the two numbers this is.
  const diskKnown = () =>
    usingPool() ? true : props.guest ? props.guest.diskSource === 'guest' : diskTotal() > 0
  // The pool's grey band is the capacity committed to thin volumes but not yet
  // written. It is the storage analogue of memory's reclaimable cache band.
  const poolCommittedFraction = () => {
    const p = pool()
    return p && p.total > 0 ? Math.min(1, p.committed / p.total) : 0
  }
  const poolInnerFraction = () => {
    const p = pool()
    if (!p || p.total <= 0) return 0
    const unwritten = Math.max(0, p.committed - p.used)
    return Math.min(1 - diskFraction(), unwritten / p.total)
  }

  const status = () => (props.online === undefined ? 'unknown' : props.online ? 'up' : 'down')
  const guestBadge = () =>
    props.machine.kind === 'lxc' ? 'ct' : props.machine.kind === 'vm' ? 'vm' : 'guest'

  const diskNote = () => {
    if (!sampled()) return undefined
    return diskKnown()
      ? `${bytes(diskUsed())} / ${bytes(diskTotal())}`
      : `${bytes(diskAllocated())} alloc`
  }

  const diskGaugeNote = () => {
    if (!sampled()) return undefined
    return usingPool() ? `${percent(poolCommittedFraction())} committed` : diskNote()
  }

  const cpuTitle = () =>
    props.host
      ? `cpu ${percent(cpu())} · ${coreLabel()} · load average, includes I/O wait`
      : undefined

  const poolTitle = () => {
    const p = pool()
    if (!p) return undefined
    const meta = p.metaTotal && p.metaTotal > 0 ? ` · meta ${percent((p.metaUsed ?? 0) / p.metaTotal)}` : ''
    const root =
      rootTotal() > 0
        ? ` · root / ${bytes(rootUsed())} / ${bytes(rootTotal())} (${percent(rootFraction())})`
        : ''
    return `thin pool ${p.name} · ${bytes(p.used)} / ${bytes(p.total)} used · ${percent(poolCommittedFraction())} committed${meta}${root}`
  }

  const gpuTitle = (gpu: GpuStat) => {
    const mode =
      gpu.mode === 'virtualized'
        ? 'rendering this VM on the host (virtio-gl)'
        : 'passed through to this VM'
    const mem =
      gpu.memTotal && gpu.memUsed != null
        ? ` · ${bytes(gpu.memUsed)} of ${bytes(gpu.memTotal)} dedicated VRAM in use`
        : ''
    const address = gpu.address ? ` · PCI ${gpu.address}` : ''
    return `${gpu.name} — ${mode}${address}${mem}`
  }

  // The footer has one line at every column width, so the chip uses a compact
  // label and "2.4 MB / 16 GB" becomes "2.4/16 GB". The title keeps the detail.
  const gpuLabel = (name: string) =>
    name.replace(/^Intel\s+Arc\b/i, 'Arc').replace(/\s+Graphics$/i, '')

  const gpuMemory = (gpu: GpuStat) => {
    if (!gpu.memTotal) return undefined
    const total = bytes(gpu.memTotal, 0)
    return gpu.memUsed == null ? total : `${bytes(gpu.memUsed).split(' ')[0]}/${total}`
  }

  // A mount path such as /media/Media becomes "Media" in the footer; the full
  // path stays in the tooltip.
  const diskLabel = (label: string) => {
    const parts = label.split(/[\\/]/).filter(Boolean)
    return parts[parts.length - 1] ?? label
  }

  const menuItems = (): MenuItem[] => {
    const items: MenuItem[] = []
    if (props.machine.url) items.push({ label: 'Open', href: props.machine.url })
    if (props.machine.addresses?.tailnet) {
      items.push({ label: 'Tailnet', value: props.machine.addresses.tailnet })
    }
    if (props.machine.addresses?.lan) {
      items.push({ label: 'LAN', value: props.machine.addresses.lan })
    }
    if (props.machine.url) items.push({ label: 'URL', value: props.machine.url })
    items.push({
      label: resourceView() === 'gauge' ? 'Show bar meters' : 'Show gauges',
      onSelect: toggleResourceView,
    })
    return items
  }

  const body = (
    <>
      <header class="machine-head">
        <div class="machine-title">
          <Logo icon={props.machine.icon} name={props.machine.name} />
          <div class="machine-title-text">
            <div class="machine-name-row">
              <h3>{props.machine.name}</h3>
              <Show when={props.machine.vmid !== undefined}>
                <span class="machine-id">
                  {guestBadge()} {props.machine.vmid}
                </span>
              </Show>
              <span class={`dot ${status()}`} />
            </div>
            <span class="machine-role">{props.machine.role ?? 'guest'}</span>
          </div>
        </div>
      </header>

      <Show
        when={metered()}
        fallback={
          <p class="machine-unmetered">
            No metrics agent — this host is not a Proxmox guest, so only its
            network presence is known.
          </p>
        }
      >
        <Show
          when={resourceView() === 'gauge'}
          fallback={
            <div class="meter-stack">
              <Meter
                label="cpu"
                value={sampled() ? cpu() : 0}
                display={sampled() ? percent(cpu()) : '—'}
                note={sampled() ? coreLabel() : 'no data'}
              />
              <Meter
                label="mem"
                value={sampled() ? memFraction() : 0}
                display={sampled() ? bytes(memUsed()) : '—'}
                note={
                  sampled()
                    ? props.guest?.memSource === 'resident'
                      ? 'resident, no balloon'
                      : `/ ${bytes(memTotal())}`
                    : undefined
                }
              />
              <Meter
                label={usingPool() ? 'pool' : 'disk'}
                value={sampled() && diskKnown() ? diskFraction() : 0}
                display={sampled() && diskKnown() ? bytes(diskUsed()) : '—'}
                note={
                  sampled() && diskKnown()
                    ? usingPool()
                      ? `/ ${bytes(diskTotal())} · ${percent(poolCommittedFraction())} committed`
                      : `/ ${bytes(diskTotal())}`
                    : sampled()
                      ? `${bytes(diskAllocated())} allocated`
                      : undefined
                }
              />
            </div>
          }
        >
          <div class="gauges">
            <Gauge
              value={sampled() ? cpu() : 0}
              center={sampled() ? percent(cpu()) : '—'}
              label="cpu"
              note={sampled() ? coreLabel() : 'no data'}
              title={cpuTitle()}
            />
            <Gauge
              value={sampled() ? memRealFraction() : 0}
              inner={sampled() ? memCacheFraction() : 0}
              center={sampled() ? percent(memRealFraction()) : '—'}
              label="mem"
              note={
                sampled()
                  ? props.guest?.memSource === 'resident'
                    ? `resident · ${bytes(memTotal())}`
                    : `${bytes(memUsed())} / ${bytes(memTotal())}`
                  : undefined
              }
            />
            <Gauge
              value={sampled() && diskKnown() ? diskFraction() : 0}
              inner={usingPool() && sampled() ? poolInnerFraction() : 0}
              center={sampled() && diskKnown() ? percent(diskFraction()) : '—'}
              label={usingPool() ? 'pool' : 'disk'}
              note={diskGaugeNote()}
              title={usingPool() ? poolTitle() : undefined}
            />
          </div>
        </Show>

        <footer class="machine-foot">
          <Inline
            items={[
              {
                label: 'up',
                value: props.online === false ? 'stopped' : sampled() ? duration(uptime()) : '—',
              },
              ...(props.machine.tags?.length
                ? [{ label: '', value: props.machine.tags.join(' · '), class: 'machine-tags' }]
                : []),
            ]}
          />
          <Show when={props.guest?.gpu || props.guest?.diskExtra}>
            <div class="foot-tags">
              <Show when={props.guest?.gpu}>
                {(gpu) => (
                  <span class="foot-tag" title={gpuTitle(gpu())}>
                    <GpuIcon />
                    <span class="foot-tag-name">{gpuLabel(gpu().name)}</span>
                    <Show when={gpuMemory(gpu())}>
                      {(mem) => <span class="foot-tag-mem">{mem()}</span>}
                    </Show>
                  </span>
                )}
              </Show>
              <Show when={props.guest?.diskExtra}>
                {(disk) => (
                  <span
                    class="foot-tag"
                    title={`${disk().label} · ${bytes(disk().used)} of ${bytes(disk().total)} used`}
                  >
                    <DiskIcon />
                    <span class="foot-tag-name">{diskLabel(disk().label)}</span>
                    <span class="foot-tag-mem">{bytes(disk().total)}</span>
                  </span>
                )}
              </Show>
            </div>
          </Show>
        </footer>
      </Show>
    </>
  )

  return (
    <div class="card" classList={{ 'is-down': props.online === false }}>
      <Show when={props.machine.url} fallback={<div class="machine">{body}</div>}>
        <a
          class="machine"
          href={props.machine.url}
          target="_blank"
          rel="noreferrer noopener"
          title={props.machine.url}
          aria-label={`${props.machine.name} — ${props.machine.url}`}
        >
          {body}
        </a>
      </Show>
      <CardMenu items={menuItems()} label={`${props.machine.name} options`} />
    </div>
  )
}
