import { Show, type JSX } from 'solid-js'
import { bytes, duration, percent, rate } from '../lib/format'
import { resourceView, toggleResourceView } from '../lib/resource-view'
import type { DiskStat, GuestStat, HostStat, Machine } from '../lib/types'
import { CardMenu, type MenuItem } from './card-menu'
import { Gauge } from './gauge'
import { DownloadIcon, UploadIcon } from './icons'
import { Logo } from './logo'
import { Inline, Meter } from './meter'

interface Props {
  machine: Machine
  guest?: GuestStat
  host?: HostStat
  disk?: DiskStat
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
  const diskUsed = () => (props.guest ? props.guest.disk : (props.disk?.used ?? 0))
  const diskTotal = () => (props.guest ? props.guest.maxdisk : (props.disk?.total ?? 0))
  const diskAllocated = () => (props.guest ? props.guest.diskAllocated : (props.disk?.total ?? 0))
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
  const diskKnown = () => (props.guest ? props.guest.diskSource === 'guest' : diskTotal() > 0)

  const status = () => (props.online === undefined ? 'unknown' : props.online ? 'up' : 'down')
  const guestBadge = () =>
    props.machine.kind === 'lxc' ? 'ct' : props.machine.kind === 'vm' ? 'vm' : 'guest'

  const diskNote = () => {
    if (!sampled()) return undefined
    return diskKnown()
      ? `${bytes(diskUsed())} / ${bytes(diskTotal())}`
      : `${bytes(diskAllocated())} alloc`
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
                label="disk"
                value={sampled() && diskKnown() ? diskFraction() : 0}
                display={sampled() && diskKnown() ? bytes(diskUsed()) : '—'}
                note={
                  sampled() && diskKnown()
                    ? `/ ${bytes(diskTotal())}`
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
              center={sampled() && diskKnown() ? percent(diskFraction()) : '—'}
              label="disk"
              note={diskNote()}
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
              ...(props.machine.tags?.length ? [{ label: '', value: props.machine.tags.join(' · ') }] : []),
            ]}
          />
          <Show when={props.host}>
            {(host) => (
              <div class="net">
                <span class="net-item" title={`received ${bytes(host().net.rx)}`}>
                  <DownloadIcon />
                  {rate(host().net.rxRate)}
                </span>
                <span class="net-item" title={`sent ${bytes(host().net.tx)}`}>
                  <UploadIcon />
                  {rate(host().net.txRate)}
                </span>
              </div>
            )}
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
