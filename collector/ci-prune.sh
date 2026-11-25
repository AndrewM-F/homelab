#!/bin/bash
# Keep the CI caches bounded without ever letting the disk fill.
#
# Order matters: the emergency reclaim runs first, even while a job is live. A
# full disk breaks the running job too, and pruning only *unused* volumes cannot
# touch what that job has mounted. Above the high-water mark, cold volumes are
# dropped even while a pipeline is running for the same reason; images and build
# cache still wait for idle, and everything waits below the trigger.
set -u

FS=/
HIGH_WATER=90     # start evicting cold entries above this
LOW_WATER=75      # stop once back under this
EMERGENCY=95      # drop every unused volume, image and cache, jobs or not
STALE_DAYS=30     # tagged images: only this old, and only past the trigger
CHECKOUT_DAYS=7
CACHE_DAYS=14     # unused project cache volumes (GitLab's own cache: backend)

usage() { df --output=pcent "$FS" | tail -1 | tr -dc '0-9'; }
jobs()  { docker ps --format '{{.Names}}' 2>/dev/null | grep -cE -- '-build$|-predefined$'; }

used=$(usage)
busy=$(jobs)
echo "usage=${used}% trigger=${HIGH_WATER}% emergency=${EMERGENCY}% running_jobs=${busy}"

# 1. Emergency: only unattached resources go, so a live job is unaffected.
if [ "$used" -ge "$EMERGENCY" ]; then
  echo "EMERGENCY: dropping unused volumes, images and build cache"
  docker container prune -f >/dev/null 2>&1
  docker volume prune -af 2>&1 | tail -1
  docker image prune -af 2>&1 | tail -1
  docker builder prune -af >/dev/null 2>&1
  echo "usage_after=$(usage)%"
  exit 0
fi

# 2. High water with a live pipeline: cold cache volumes are the bulk of the
# usage and are not attached to any job, so drop them before the disk fills.
# Images and build cache stay warm — the emergency threshold handles those.
if [ "$busy" -gt 0 ] && [ "$used" -ge "$HIGH_WATER" ]; then
  echo "high water with jobs running: dropping unused volumes"
  docker container prune -f >/dev/null 2>&1
  docker volume prune -af 2>&1 | tail -1
  echo "usage_after=$(usage)%"
  exit 0
fi

# 3. A running pipeline owns its caches; nothing cold is worth evicting yet.
if [ "$busy" -gt 0 ]; then
  echo "jobs running: not pruning"
  exit 0
fi

if [ "$used" -lt "$HIGH_WATER" ]; then
  echo "below trigger: nothing pruned"
  exit 0
fi

docker container prune -f >/dev/null 2>&1

# Dangling only: a tagged image a job still references (the CI image, a browser
# image) is hot cache even when it is weeks old.
echo "pruning dangling images"
docker image prune -f 2>&1 | tail -1
docker builder prune -f >/dev/null 2>&1

echo "pruning tagged images older than ${STALE_DAYS}d"
docker image prune -af --filter "until=${STALE_DAYS}*24h" 2>&1 | tail -1

live=$(docker ps -a -q 2>/dev/null | xargs -r docker inspect -f '{{range .Mounts}}{{.Name}}{{"\n"}}{{end}}' 2>/dev/null | sort -u)
removed=0
for v in $(docker volume ls -q); do
  echo "$live" | grep -qx "$v" && continue
  mp=$(docker volume inspect -f '{{.Mountpoint}}' "$v" 2>/dev/null) || continue
  [ -d "$mp" ] || continue
  # Cache volumes (GitLab's cache: backend) are worth more than checkouts, so
  # they get a longer window; everything else ages out faster.
  window=$CHECKOUT_DAYS
  case "$v" in *-cache-*) window=$CACHE_DAYS ;; esac
  [ -n "$(find "$mp" -maxdepth 3 -newermt "-${window} days" -print -quit 2>/dev/null)" ] && continue
  docker volume rm "$v" >/dev/null 2>&1 && removed=$((removed+1))
done
echo "idle checkout volumes removed: ${removed}"

if [ "$(usage)" -gt "$LOW_WATER" ]; then
  echo "still above ${LOW_WATER}%: dropping unused volumes"
  docker volume prune -af >/dev/null 2>&1
fi

echo "usage_after=$(usage)%"
