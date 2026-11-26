#!/bin/bash
# Trim the filesystems inside running LXC containers, from the host.
#
# A container cannot trim its own rootfs. FITRIM needs privileges an unprivileged
# container does not have, so `fstrim` inside one fails with
#
#   fstrim: /: FITRIM ioctl failed: Operation not permitted
#
# and the fstrim.timer shipped in the image is enabled but can never fire. The
# host can do it, because it only needs to enter the container's mount namespace
# first — that is all this script is.
#
# Why it matters: without a trim, blocks the guest frees are never returned to the
# thin pool, and Proxmox reports the volume as full while the guest is not. On
# 2026-11-26 the gitlab container used 32 GB of a 64 GB volume while
# `lvs` showed 99.90% allocated, so the pool was holding ~30 GB of dead blocks.
# One run returned it: 29.9 GiB trimmed, 99.90% -> 53.60%.
#
# Periodic trim is preferred over mounting with `discard=on`: inline discard costs
# a TRIM on every free(), which is exactly the wrong trade on a CI host that does
# `rm -rf` over multi-gigabyte checkouts all day. It also needs no container
# restart, so there is no outage to arrange.

set -u

trimmed=0
skipped=0
while read -r ct; do
  [ -n "$ct" ] || continue
  pid=$(lxc-info -pHn "$ct" 2>/dev/null)
  if [ -z "$pid" ]; then
    echo "  $ct: no init pid, skipped"
    skipped=$((skipped + 1))
    continue
  fi
  # -m: the container's mount namespace, where / is the container's rootfs. The
  # ioctl is issued by this privileged host process, so FITRIM is permitted.
  if out=$(nsenter -t "$pid" -m -- fstrim / 2>&1); then
    echo "  $ct: trimmed"
    trimmed=$((trimmed + 1))
  else
    echo "  $ct: $out"
    skipped=$((skipped + 1))
  fi
done < <(pct list | awk 'NR > 1 && $2 == "running" { print $1 }')

echo "containers trimmed: ${trimmed}, skipped: ${skipped}"
