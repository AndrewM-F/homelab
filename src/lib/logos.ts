/**
 * App and machine logos.
 *
 * SVGs are vendored under `src/assets/logos/` and imported with `?url`, so Vite
 * fingerprints them, the Worker serves them from the same origin, and nothing
 * is fetched from a third-party CDN at runtime.
 *
 * Source: the community "dashboard-icons" set
 * (https://github.com/homarr-labs/dashboard-icons), which collects official
 * marks for self-hosted software. Each logo remains the trademark of its
 * project and is used here only to identify it.
 *
 * Keys are the `icon` values used in the inventory. A slug with no entry falls
 * back to a monogram, which is the honest outcome for software with no
 * published mark.
 */

import apple from '../assets/logos/apple.svg?url'
import archLinux from '../assets/logos/arch-linux.svg?url'
import bazarr from '../assets/logos/bazarr.svg?url'
import jellyfin from '../assets/logos/jellyfin.svg?url'
import omarchy from '../assets/logos/omarchy.svg?url'
import piHole from '../assets/logos/pi-hole.svg?url'
import prowlarr from '../assets/logos/prowlarr.svg?url'
import proxmox from '../assets/logos/proxmox.svg?url'
import radarr from '../assets/logos/radarr.svg?url'
import romm from '../assets/logos/romm.svg?url'
import sabnzbd from '../assets/logos/sabnzbd.svg?url'
import seerr from '../assets/logos/seerr.svg?url'
import sonarr from '../assets/logos/sonarr.svg?url'
import sunshine from '../assets/logos/sunshine.svg?url'
import tailscale from '../assets/logos/tailscale.svg?url'
import uptimeKuma from '../assets/logos/uptime-kuma.svg?url'
import vaultwarden from '../assets/logos/vaultwarden.svg?url'
import windows11 from '../assets/logos/windows-11.svg?url'
import zimaos from '../assets/logos/zimaos.svg?url'

const LOGOS: Record<string, string> = {
  apple,
  'arch-linux': archLinux,
  bazarr,
  jellyfin,
  omarchy,
  'pi-hole': piHole,
  prowlarr,
  proxmox,
  radarr,
  romm,
  sabnzbd,
  seerr,
  sonarr,
  sunshine,
  tailscale,
  'uptime-kuma': uptimeKuma,
  vaultwarden,
  'windows-11': windows11,
  zimaos,
}

export function logoFor(key: string | undefined): string | undefined {
  return key ? LOGOS[key] : undefined
}

export const LOGO_KEYS = Object.keys(LOGOS)
