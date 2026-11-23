/**
 * Shapes shared by the server (Worker), the browser and the collector.
 * Anything marked `secret` is stripped before the browser ever sees it.
 */

export type GuestType = 'qemu' | 'lxc'

/**
 * How a machine is presented and where its numbers come from:
 * `hypervisor` is the Proxmox host, `vm` and `lxc` are its guests (live stats
 * via pvesh), `device` is anything else on the network with no agent.
 */
export type MachineKind = 'hypervisor' | 'vm' | 'lxc' | 'device'

/**
 * Where a host or service can be reached off the public internet.
 * `tailnet` is a Tailscale address, `lan` an address on the home network.
 * Values are `host` for machines and `host[:port]` for services.
 */
export interface Addresses {
  tailnet?: string
  lan?: string
}

export interface Machine {
  /** Stable id; referenced by `Service.machine`. */
  id: string
  name: string
  role?: string
  kind?: MachineKind
  /** Proxmox guest id. Absent for the hypervisor and for bare devices. */
  vmid?: number
  /** Logo key from `src/lib/logos.ts`. Falls back to a monogram. */
  icon?: string
  /** Direct addresses for the copy menu. Host only, no port. */
  addresses?: Addresses
  /** Public URL for this machine's own UI; makes the card a link. */
  url?: string
  tags?: string[]
}

export type ConnectProtocol = 'rdp' | 'ssh' | 'vnc' | 'smb'

export interface Service {
  /** Subdomain label: `<slug>.<apex>`. */
  slug: string
  name: string
  description?: string
  /** UI grouping, e.g. "Media", "Infrastructure". */
  category: string
  /** `Machine.id` this service runs on. */
  machine: string
  /** Logo key from `src/lib/logos.ts`. Falls back to a monogram. */
  icon?: string
  /** Upstream the tunnel proxies to. Never sent to the browser. */
  origin?: string
  /** `skip` sets cloudflared's `noTLSVerify` for self-signed origins. */
  originTLS?: 'verify' | 'skip'
  /** SNI override for origins behind a hostname-aware proxy. */
  originName?: string
  /** Host header to send to the origin when it validates one (e.g. Pi-hole). */
  originHost?: string
  /** Optional health probe run by the collector from the LAN. */
  probeUrl?: string
  /** Path appended to the public URL in the UI. */
  path?: string
  /**
   * Explicit `host[:port]` overrides for the copy menu. Normally derived from
   * `origin` and `probeUrl`; set this when a service only listens on one path
   * (for example a container bound to the tailnet interface alone).
   */
  addresses?: Addresses
  /** Non-HTTP services get a connect page instead of a tunnel. */
  connect?: {
    protocol: ConnectProtocol
    address: string
    command?: string
  }
  tags?: string[]
}

export interface Inventory {
  site: {
    title: string
    subtitle?: string
    apex: string
  }
  machines: Machine[]
  services: Service[]
}

/** Service fields that never leave the Worker. */
export const PRIVATE_SERVICE_FIELDS = [
  'origin',
  'originTLS',
  'originName',
  'originHost',
  'probeUrl',
] as const

export interface GuestStat {
  vmid: number
  type: GuestType
  status: string
  /** Fraction of one core-pair, 0..1 as reported by Proxmox. */
  cpu: number
  maxcpu: number
  mem: number
  maxmem: number
  disk: number
  maxdisk: number
  /**
   * Where `disk`/`maxdisk` came from. `guest` is real filesystem usage, read
   * from a container's rootfs or a VM's guest agent; `allocated` means the VM
   * answered no agent and only its provisioned size is known.
   */
  diskSource: 'guest' | 'allocated'
  /** Provisioned size, always known even when usage is not. */
  diskAllocated: number
  uptime: number
}

export interface HostStat {
  name: string
  cores: number
  load: [number, number, number]
  /** Utilisation 0..1 derived from load average over cores. */
  cpu: number
  memUsed: number
  memTotal: number
  swapUsed: number
  swapTotal: number
  uptime: number
  net: {
    rx: number
    tx: number
    /** Bytes per second over the collector's sample window. */
    rxRate: number
    txRate: number
  }
}

export interface ProbeResult {
  slug: string
  /** `null` when the service could not be probed from the collector host. */
  up: boolean | null
  status?: number
  ms?: number
  error?: string
}

export interface DiskStat {
  name: string
  used: number
  total: number
}

export interface Snapshot {
  /** Unix seconds when the collector produced this sample. */
  ts: number
  host: HostStat
  guests: GuestStat[]
  probes: ProbeResult[]
  disks: DiskStat[]
  /** Set when the collector answered but reported its own trouble. */
  warnings: string[]
}

export interface StatsResponse {
  ok: boolean
  snapshot: Snapshot | null
  /** Why `snapshot` is null, when it is. */
  error?: string
  /** Wall-clock age of the proxied sample, seconds. */
  age?: number
}
