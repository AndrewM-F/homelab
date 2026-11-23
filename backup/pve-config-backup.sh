#!/bin/bash
# homelab: back up the hypervisor's own configuration.
#
# VM and container definitions live in /etc/pve, which is pmxcfs — not the root
# filesystem — so no vzdump archive contains them. If this host's disk died, the
# guests would be unrecoverable without this file: it holds every VM/CT config,
# storage definition, backup job, user and firewall rule.
#
# Install:
#   install -m 0755 pve-config-backup.sh /usr/local/sbin/
#   install -m 0644 pve-config-backup.* /etc/systemd/system/
#   systemctl daemon-reload && systemctl enable --now pve-config-backup.timer

set -euo pipefail

DEST=${DEST:-/var/lib/vz/dump}
KEEP=${KEEP:-7}
STAMP=$(date +%Y%m%d-%H%M)
OUT="$DEST/pve-config-$STAMP.tar.zst"

# Everything that describes how this hypervisor is built. Guest disks are not
# here on purpose — the weekly vzdump job covers those.
SOURCES=(
  /etc/pve
  /etc/network
  /etc/hosts
  /etc/fstab
  /etc/apt
  /etc/systemd/system
  /etc/sysctl.d
)

mkdir -p "$DEST"
tar --zstd -cf "$OUT.partial" "${SOURCES[@]}" 2>/dev/null
mv "$OUT.partial" "$OUT"
chmod 600 "$OUT"

# keep the newest $KEEP archives
ls -1t "$DEST"/pve-config-*.tar.zst 2>/dev/null | tail -n +$((KEEP + 1)) | xargs -r rm -f

echo "$(date -Is) pve-config: $(basename "$OUT") $(stat -c%s "$OUT") bytes"
