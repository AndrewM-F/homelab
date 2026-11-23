import type { Inventory, Machine, Service } from './types'

class ShapeError extends Error {}

function fail(path: string, expected: string, got: unknown): never {
  const seen = got === null ? 'null' : Array.isArray(got) ? 'array' : typeof got
  throw new ShapeError(`inventory: ${path} must be ${expected} (got ${seen})`)
}

function asString(value: unknown, path: string, optional = false): string | undefined {
  if (value === undefined || value === null) {
    if (optional) return undefined
    fail(path, 'a non-empty string', value)
  }
  if (typeof value !== 'string' || value.trim() === '') fail(path, 'a non-empty string', value)
  return value.trim()
}

function asStringArray(value: unknown, path: string): string[] | undefined {
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value)) fail(path, 'an array of strings', value)
  return value.map((item, i) => asString(item, `${path}[${i}]`)!)
}

function asNumber(value: unknown, path: string, optional = false): number | undefined {
  if (value === undefined || value === null) {
    if (optional) return undefined
    fail(path, 'a number', value)
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(path, 'a number', value)
  return value
}

const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/
const RESERVED = new Set(['www', 'api', 'metrics', 'admin', 'mail', 'ftp', 'ns1', 'ns2'])

const KINDS = new Set(['hypervisor', 'vm', 'lxc', 'device'])

function parseKind(value: unknown, vmid: unknown, path: string): Machine['kind'] {
  if (value === undefined || value === null) return vmid === undefined ? 'device' : 'vm'
  const kind = asString(value, path)!
  if (!KINDS.has(kind)) fail(path, 'hypervisor, vm, lxc or device', kind)
  return kind as Machine['kind']
}

function parseMachine(raw: unknown, index: number): Machine {
  const path = `machines[${index}]`
  if (typeof raw !== 'object' || raw === null) fail(path, 'an object', raw)
  const m = raw as Record<string, unknown>
  return {
    id: asString(m.id, `${path}.id`)!,
    name: asString(m.name, `${path}.name`)!,
    role: asString(m.role, `${path}.role`, true),
    kind: parseKind(m.kind, m.vmid, `${path}.kind`),
    vmid: asNumber(m.vmid, `${path}.vmid`, true),
    icon: asString(m.icon, `${path}.icon`, true),
    tags: asStringArray(m.tags, `${path}.tags`),
  }
}

function parseService(raw: unknown, index: number): Service {
  const path = `services[${index}]`
  if (typeof raw !== 'object' || raw === null) fail(path, 'an object', raw)
  const s = raw as Record<string, unknown>

  const slug = asString(s.slug, `${path}.slug`)!
  if (!SLUG.test(slug)) fail(`${path}.slug`, 'a lowercase DNS label', slug)
  if (RESERVED.has(slug)) fail(`${path}.slug`, 'a slug outside the reserved set', slug)

  const originTLS = asString(s.originTLS, `${path}.originTLS`, true)
  if (originTLS && originTLS !== 'verify' && originTLS !== 'skip') {
    fail(`${path}.originTLS`, '"verify" or "skip"', originTLS)
  }

  let connect: Service['connect']
  if (s.connect !== undefined && s.connect !== null) {
    if (typeof s.connect !== 'object') fail(`${path}.connect`, 'an object', s.connect)
    const c = s.connect as Record<string, unknown>
    const protocol = asString(c.protocol, `${path}.connect.protocol`)!
    if (!['rdp', 'ssh', 'vnc', 'smb'].includes(protocol)) {
      fail(`${path}.connect.protocol`, 'rdp, ssh, vnc or smb', protocol)
    }
    connect = {
      protocol: protocol as NonNullable<Service['connect']>['protocol'],
      address: asString(c.address, `${path}.connect.address`)!,
      command: asString(c.command, `${path}.connect.command`, true),
    }
  }

  return {
    slug,
    name: asString(s.name, `${path}.name`)!,
    description: asString(s.description, `${path}.description`, true),
    category: asString(s.category, `${path}.category`)!,
    machine: asString(s.machine, `${path}.machine`)!,
    icon: asString(s.icon, `${path}.icon`, true),
    origin: asString(s.origin, `${path}.origin`, true),
    originTLS: originTLS as Service['originTLS'],
    originName: asString(s.originName, `${path}.originName`, true),
    originHost: asString(s.originHost, `${path}.originHost`, true),
    probeUrl: asString(s.probeUrl, `${path}.probeUrl`, true),
    path: asString(s.path, `${path}.path`, true),
    connect,
    tags: asStringArray(s.tags, `${path}.tags`),
  }
}

/**
 * Validates an inventory document. Throws with a precise path on the first
 * problem so a bad `sync` fails loudly instead of shipping a broken dashboard.
 */
export function parseInventory(raw: unknown): Inventory {
  if (typeof raw !== 'object' || raw === null) fail('root', 'an object', raw)
  const doc = raw as Record<string, unknown>

  if (typeof doc.site !== 'object' || doc.site === null) fail('site', 'an object', doc.site)
  const site = doc.site as Record<string, unknown>
  const apex = asString(site.apex, 'site.apex')!
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(apex)) fail('site.apex', 'a apex domain', apex)

  if (!Array.isArray(doc.machines) || doc.machines.length === 0) {
    fail('machines', 'a non-empty array', doc.machines)
  }
  const machines = doc.machines.map(parseMachine)

  const machineIds = new Set<string>()
  for (const machine of machines) {
    if (machineIds.has(machine.id)) fail('machines', `unique ids (duplicate "${machine.id}")`, machine.id)
    machineIds.add(machine.id)
  }

  if (!Array.isArray(doc.services)) fail('services', 'an array', doc.services)
  const services = doc.services.map(parseService)

  const slugs = new Set<string>()
  for (const service of services) {
    if (slugs.has(service.slug)) fail('services', `unique slugs (duplicate "${service.slug}")`, service.slug)
    slugs.add(service.slug)
    if (!machineIds.has(service.machine)) {
      fail(`services[${service.slug}].machine`, `a known machine id (got "${service.machine}")`, service.machine)
    }
    if (!service.origin && !service.connect) {
      fail(`services[${service.slug}]`, 'an origin or a connect block', service)
    }
  }

  return {
    site: {
      title: asString(site.title, 'site.title')!,
      subtitle: asString(site.subtitle, 'site.subtitle', true),
      apex,
    },
    machines,
    services,
  }
}

/** Public URL for a service on the apex domain. */
export function publicUrl(inventory: Inventory, service: Service): string {
  const path = service.path ?? ''
  return `https://${service.slug}.${inventory.site.apex}${path}`
}
