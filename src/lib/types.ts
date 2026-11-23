/**
 * Shapes shared by the server (Worker), the browser and the collector.
 * Anything marked `secret` is stripped before the browser ever sees it.
 */

export type GuestType = 'qemu' | 'lxc'

export interface Machine {
  /** Stable id; referenced by `Service.machine`. */
  id: string
  name: string
  role?: string
  /** Proxmox guest id. Absent for the hypervisor itself. */
  vmid?: number
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
