import { Show, type JSX } from 'solid-js'
import { bytes, duration, percent, rate } from '../lib/format'
import type { DiskStat, GuestStat, HostStat, Machine } from '../lib/types'
import { DownloadIcon, UploadIcon } from './icons'
import { Inline, Meter } from './meter'

interface Props {
  machine: Machine
  guest?: GuestStat
  host?: HostStat
  disk?: DiskStat
  online: boolean
}

export function MachineCard(props: Props): JSX.Element {
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

  return (
    <article class="machine" classList={{ 'is-down': !props.online }}>
      <header class="machine-head">
        <div class="machine-title">
          <span class="dot" classList={{ up: props.online, down: !props.online }} />
          <h3>{props.machine.name}</h3>
          <Show when={props.machine.vmid !== undefined}>
            <span class="machine-id">ct {props.machine.vmid}</span>
          </Show>
        </div>
        <span class="machine-role">{props.machine.role ?? 'guest'}</span>
      </header>

      <div class="meter-stack">
        <Meter label="cpu" value={cpu()} display={percent(cpu())} note={coreLabel()} />
        <Meter label="mem" value={memFraction()} display={bytes(memUsed())} note={`/ ${bytes(memTotal())}`} />
        <Meter
          label="disk"
          value={diskKnown() ? diskFraction() : 0}
          display={diskKnown() ? bytes(diskUsed()) : '—'}
          note={diskKnown() ? `/ ${bytes(diskTotal())}` : `${bytes(diskTotal())} allocated`}
        />
      </div>

      <footer class="machine-foot">
        <Inline
          items={[
            { label: 'up', value: props.online ? duration(uptime()) : 'stopped' },
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
    </article>
  )
}
