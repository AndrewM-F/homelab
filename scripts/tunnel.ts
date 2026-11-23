#!/usr/bin/env bun
/**
 * Reconciles the Cloudflare Tunnel and its DNS records with inventory.local.json.
 *
 * Every service that has an `origin` becomes a tunnel hostname:
 *
 *     jellyfin.example.com  ──▶  http://<tailnet-ip>:8097
 *
 * The ingress table lives in Cloudflare (remotely-managed tunnel), so this
 * repository never contains internal addresses. Re-running is safe: the tunnel
 * config is replaced wholesale and DNS records are updated in place.
 *
 *   bun run tunnel plan                  show what would change
 *   bun run tunnel apply --tunnel <id>   push config + DNS
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseInventory } from '../src/lib/inventory'
import type { Service } from '../src/lib/types'

const ROOT = join(import.meta.dir, '..')
const args = process.argv.slice(2)
const mode = args[0] ?? 'plan'
function flag(name: string): string | undefined {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}

const tunnelId = flag('--tunnel') ?? process.env.TUNNEL_ID
const zone = flag('--zone') ?? process.env.CLOUDFLARE_ZONE ?? 'example.com'

function die(message: string): never {
  console.error(`tunnel: ${message}`)
  process.exit(1)
}

if (!existsSync(join(ROOT, 'inventory.local.json'))) {
  die('missing inventory.local.json')
}

const inventory = parseInventory(JSON.parse(readFileSync(join(ROOT, 'inventory.local.json'), 'utf8')))
if (mode !== 'plan' && !tunnelId) {
  die('pass --tunnel <id> (or set TUNNEL_ID)')
}

// --------------------------------------------------------------- ingress

interface IngressEntry {
  hostname?: string
  service: string
  originRequest?: {
    noTLSVerify?: boolean
    originServerName?: string
    httpHostHeader?: string
  }
}

const tunnelServices: Service[] = inventory.services.filter((service) => service.origin)

const ingress: IngressEntry[] = tunnelServices.map((service) => {
  const entry: IngressEntry = { hostname: `${service.slug}.${inventory.site.apex}`, service: service.origin! }
  const origin: IngressEntry['originRequest'] = {}
  if (service.originTLS === 'skip') origin.noTLSVerify = true
  if (service.originName) origin.originServerName = service.originName
  if (service.originHost) origin.httpHostHeader = service.originHost
  if (Object.keys(origin).length > 0) entry.originRequest = origin
  return entry
})

// Hosts served by the collector rather than an inventory service: the connect
// page for non-HTTP machines, and the stats endpoint the dashboard proxies.
const collectorOrigin = process.env.COLLECTOR_URL ?? 'http://127.0.0.1:9101'
const connectService = inventory.services.find((service) => service.connect)
if (connectService) {
  ingress.push({
    hostname: `${connectService.slug}.${inventory.site.apex}`,
    service: collectorOrigin,
  })
}
ingress.push({ hostname: `metrics.${inventory.site.apex}`, service: collectorOrigin })

ingress.push({ service: 'http_status:404' })

// ---------------------------------------------------------------- output

console.log(`${mode === 'plan' ? 'plan' : 'apply'}: ${ingress.length - 1} hostnames on ${inventory.site.apex}`)
for (const entry of ingress) {
  if (!entry.hostname) {
    console.log(`  ${entry.service}`)
    continue
  }
  const notes = [
    entry.originRequest?.noTLSVerify ? 'insecure-origin' : '',
    entry.originRequest?.originServerName ? `sni=${entry.originRequest.originServerName}` : '',
    entry.originRequest?.httpHostHeader ? `host=${entry.originRequest.httpHostHeader}` : '',
  ]
    .filter(Boolean)
    .join(' ')
  console.log(`  ${entry.hostname.padEnd(34)} → ${entry.service}${notes ? `  (${notes})` : ''}`)
}

if (mode === 'plan') {
  console.log('\napply with: bun run tunnel apply --tunnel <tunnel-id>')
  process.exit(0)
}

// ------------------------------------------------------------------- cf

async function cf(argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(['cf', ...argv], { stdout: 'pipe', stderr: 'pipe', env: process.env })
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { code, stdout, stderr }
}

function parseJson<T>(text: string): T | undefined {
  const start = text.indexOf('[') === -1 ? text.indexOf('{') : text.indexOf('[')
  if (start === -1) return undefined
  try {
    return JSON.parse(text.slice(start)) as T
  } catch {
    return undefined
  }
}

// 1. tunnel ingress
const configResult = await cf([
  'tunnels',
  'config',
  'update',
  tunnelId!,
  '--tunnel-config-ingress',
  JSON.stringify(ingress),
])
if (configResult.code !== 0) {
  die(`updating tunnel ingress failed: ${configResult.stderr.trim() || configResult.stdout.trim()}`)
}
console.log(`\n  ingress pushed to tunnel ${tunnelId}`)

// 2. DNS records
const target = `${tunnelId}.cfargotunnel.com`
const listResult = await cf(['dns', 'records', 'list', '--zone', zone])
if (listResult.code !== 0) die(`listing DNS failed: ${listResult.stderr.trim()}`)

interface DnsRecord {
  id: string
  name: string
  type: string
  content: string
  proxied: boolean
}
const records = parseJson<DnsRecord[]>(listResult.stdout) ?? []

let created = 0
let updated = 0
for (const entry of ingress) {
  if (!entry.hostname) continue
  const existing = records.find((record) => record.name === entry.hostname)
  const body = JSON.stringify({ type: 'CNAME', name: entry.hostname, content: target, proxied: true, ttl: 1 })

  if (existing) {
    if (existing.type === 'CNAME' && existing.content === target && existing.proxied) continue
    const result = await cf(['dns', 'records', 'update', existing.id, '--zone', zone, '--body', body])
    if (result.code !== 0) die(`updating ${entry.hostname} failed: ${result.stderr.trim()}`)
    updated++
    console.log(`  updated ${entry.hostname}`)
    continue
  }

  const result = await cf(['dns', 'records', 'create', '--zone', zone, '--body', body])
  if (result.code !== 0) die(`creating ${entry.hostname} failed: ${result.stderr.trim()}`)
  created++
  console.log(`  created ${entry.hostname}`)
}

console.log(`\n  dns: ${created} created, ${updated} updated, target ${target}`)
process.exit(0)
