#!/bin/sh
# homelab stats probe: prints key=value lines, no sudo required.
set -e
echo "cores=$(sysctl -n hw.ncpu)"
echo "mem_total=$(sysctl -n hw.memsize)"
echo "uptime=$(($(date +%s) - $(sysctl -n kern.boottime | sed -E 's/^{ sec = ([0-9]+).*/\1/')))"
set -- $(sysctl -n vm.loadavg | tr -d '{}')
echo "load1=$1"

# CPU: top samples for ~1s; that is fine at a 30s refresh
top -l 1 -n 0 | sed -nE 's/^CPU usage: ([0-9.]+)% user, ([0-9.]+)% sys,.*/\1 \2/p' | awk '{printf "cpu_percent=%.1f\n", $1+$2}'

# Memory: Activity Monitor's "used" = active (minus purgeable) + wired + compressor
vm_stat | awk '
  /page size of/ { for (i=1;i<=NF;i++) if ($i=="bytes)") { gsub(/[^0-9]/,"",$(i-1)); ps=$(i-1) } }
  /^Pages active/       { gsub(/\./,"",$3); act=$3 }
  /^Pages purgeable/    { gsub(/\./,"",$3); pur=$3 }
  /^Pages wired down/   { gsub(/\./,"",$4); wir=$4 }
  /^Pages occupied by compressor/ { gsub(/\./,"",$5); cmp=$5 }
  END { if (ps=="") ps=16384; printf "mem_used=%d\n", (act-pur+wir+cmp)*ps }'

# Disk: df's "used" excludes the sealed system snapshot and anything else sharing
# the APFS container, so measure used as total minus available instead: what the
# card then shows is the space that is genuinely still writable.
df -k /System/Volumes/Data | awk 'NR==2 {printf "disk_total=%d\ndisk_used=%d\n", $2*1024, ($2-$4)*1024}'
