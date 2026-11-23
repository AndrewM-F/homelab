import { Show, type JSX } from 'solid-js'
import { bytes, duration, percent, rate } from '../lib/format'
import type { DiskStat, GuestStat, HostStat, Machine } from '../lib/types'
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
  const metered = () => props.meterable

  const sampled = () => Boolean(props.guest || props.host)
  const cpu = () => (props.guest ? props.guest.cpu : (props.host?.cpu ?? 0))
  const memUsed = () => (props.guest ? props.guest.mem : (props.host?.memUsed ?? 0))
  const memTotal = () => (props.guest ? props.guest.maxmem : (props.host?.memTotal ?? 0))
  const diskUsed = () => (props.guest ? props.guest.disk : (props.disk?.used ?? 0))
  const diskTotal = () => (props.guest ? props.guest.maxdisk : (props.disk?.total ?? 0))
  const uptime = () => (props.guest ? props.guest.uptime : (props.host?.uptime ?? 0))
  const cores = () => props.guest?.maxcpu ?? props.host?.cores ?? 0
  const coreLabel = () => `${cores()} core${cores() === 1 ? '' : 's'}`

  const memFraction = () => (memTotal() > 0 ? memUsed() / memTotal() : 0)
  const diskFraction = () => (diskTotal() > 0 ? diskUsed() / diskTotal() : 0)
  // Proxmox reports allocated size but no usage for VMs; containers report both.
  const diskKnown = () => (props.guest ? props.guest.disk > 0 : diskTotal() > 0)

  const status = () => (props.online === undefined ? 'unknown' : props.online ? 'up' : 'down')
  const guestBadge = () =>
    props.machine.kind === 'lxc' ? 'ct' : props.machine.kind === 'vm' ? 'vm' : 'guest'

  return (
    <article class="machine" classList={{ 'is-down': props.online === false }}>
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
        <div class="meter-stack">
          <Meter
            label="cpu"
            value={sampled() ? cpu() : 0}
            display={sampled() ? percent(cpu()) : '—'}
            note={sampled() ? coreLabel() : 'no sample'}
          />
          <Meter
            label="mem"
            value={sampled() ? memFraction() : 0}
            display={sampled() ? bytes(memUsed()) : '—'}
            note={sampled() ? `/ ${bytes(memTotal())}` : undefined}
          />
          <Meter
            label="disk"
            value={sampled() && diskKnown() ? diskFraction() : 0}
            display={sampled() && diskKnown() ? bytes(diskUsed()) : '—'}
            note={
              sampled() && diskKnown()
                ? `/ ${bytes(diskTotal())}`
                : sampled()
                  ? `${bytes(diskTotal())} allocated`
                  : undefined
            }
          />
        </div>

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
    </article>
  )
}
