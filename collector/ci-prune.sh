#!/bin/bash
# Keep the CI caches bounded without ever letting the disk fill, and without
# ever touching a job that is still running.
#
# A budget, not a watermark. The watermark version did nothing below 90% and then
# reclaimed with `docker volume prune -af`, which drops every unused volume at
# once: the cache was either cold, or the disk was nearly full, and never both
# warm and roomy. This keeps the whole disk under a fixed budget at all times and
# evicts the coldest entry first, so the steady state is a warm cache with free
# space left over.
#
# The budget has to be ABOVE what the runner legitimately keeps, or the script
# escalates forever. At 22 GB it was unreachable on this host: /srv/mise alone is
# 13 GB of warm tool cache, the checkouts are 6.5 GB and the OS is 4.8 GB, so the
# floor was 24 GB before a single image or volume. Every one of the 132 runs on
# 2026-11-26 went past "within budget" and reached the Docker prunes. 34 GB on the
# 48 GB disk leaves ~14 GB free for a suite's own scratch and an image pull, and
# is reachable, so the common path is now a log line and an exit.
#
# Order: job temp folders (always), then the checkouts on the builds volume, then
# cold Docker volumes, then images and the build cache, then (only past the hard
# budget) tagged images no container references. The percentage threshold remains
# as the last-resort guard.
#
# Race rules, each learned from a real failure:
#
#   * `docker container prune -f` with no `until` filter deletes the runner's
#     stopped `<job>...-predefined` helper container in the instant the executor
#     starts or removes it, and the job dies with
#     "container is marked for removal and cannot be started" and
#     failure_reason=runner_system_failure. Every such failure on 2026-11-26
#     landed 0.06-0.29 s after this timer fired. A live job's helper container is
#     seconds old, so `--filter until=1h` provably cannot select it, while a
#     truly leaked container from an old job is still collected.
#   * Image and builder pruning race a job's own image pull and leave the
#     containerd content store reporting "parent snapshot does not exist", so they
#     only run when no job container is in flight.
#   * Volume removal only ever touches volumes that no container references, so it
#     cannot touch one that is in use, and stays safe mid-run.
#   * `until=30*24h` is not a duration: Docker rejects it with
#     `invalid seconds "30*24h"` and the tagged-image prune failed on every run,
#     leaving every stale image in place. The value is computed to hours instead.

set -u

FS=/
BUILDS=${BUILDS_DIR:-/srv/builds}
# The whole disk is 48 GB. 34 GB used leaves ~14 GB free: enough for a suite run's
# own scratch, the images a run pulls and the build cache, without letting the
# cache pretend it owns the disk.
TARGET_USED_GB=${TARGET_USED_GB:-34}
# Past this, images and the builder cache go too, still cold-first.
HARD_USED_GB=${HARD_USED_GB:-40}
# Never finish above this, whatever the budget says.
FLOOR_FREE_GB=${FLOOR_FREE_GB:-8}
EMERGENCY=${EMERGENCY:-95}
# A container younger than this belongs to a job that may still be running, so it
# is never a prune candidate. Every job on this host finishes inside ~3 minutes.
CONTAINER_GRACE=${CONTAINER_GRACE:-1h}

# Age floors, so an entry a suite reuses tomorrow is not dropped today just
# because a large checkout happens to be older than it.
STALE_DAYS=${STALE_DAYS:-30}      # tagged images: only this old, and only past the hard budget
CHECKOUT_DAYS=${CHECKOUT_DAYS:-7}
CACHE_DAYS=${CACHE_DAYS:-14}
JOB_TMP_MINUTES=${JOB_TMP_MINUTES:-1440}

DRY=${DRY_RUN:-0}
run() {
  if [ "$DRY" = 1 ]; then echo "  would: $*"; else "$@" 2>&1 | tail -1 | sed 's/^/  /'; fi
}

used_gb() { df -B1G --output=used "$FS" | tail -1 | tr -dc '0-9'; }
free_gb() { df -B1G --output=avail "$FS" | tail -1 | tr -dc '0-9'; }
pct()     { df --output=pcent "$FS" | tail -1 | tr -dc '0-9'; }
jobs()    { docker ps --format '{{.Names}}' 2>/dev/null | grep -cE -- '-build$|-predefined$'; }
over_budget() { [ "$(used_gb)" -gt "$TARGET_USED_GB" ] || [ "$(free_gb)" -lt "$FLOOR_FREE_GB" ]; }

# The only container prune this script is allowed to run. Bare `docker container
# prune` is what killed jobs here; the age filter is what makes this safe, so do
# not "simplify" it back.
prune_containers() {
  run docker container prune -f --filter "until=${CONTAINER_GRACE}"
}

# Images and the builder cache are only pruned when the runner is idle: both race
# a job's image pull.
prune_images_if_idle() {
  local busy
  busy=$(jobs)
  if [ "$busy" -gt 0 ]; then
    echo "  ${busy} job container(s) in flight: images and build cache left alone"
    return 0
  fi
  run docker image prune -f
  run docker builder prune -f
}

# A job that replaces after_script never removes its own temp folder, and base.yml
# names it by job id, so nothing ever reuses it. This is garbage whatever the disk
# says, so it is collected first and unconditionally.
prune_job_temp() {
  [ -d "$BUILDS/.tmp" ] || return 0
  stale=$(find "$BUILDS/.tmp" -mindepth 1 -maxdepth 1 -type d -mmin +"$JOB_TMP_MINUTES" 2>/dev/null)
  [ -n "$stale" ] || return 0
  count=$(echo "$stale" | wc -l)
  if [ "$DRY" = 1 ]; then
    echo "  would: remove ${count} job temp folder(s) under $BUILDS/.tmp"
  else
    echo "$stale" | xargs -r rm -rf
    echo "  job temp folders older than $((JOB_TMP_MINUTES / 60))h removed: ${count}"
  fi
}

# The checkouts on the builds volume. /srv/builds is a real host path, so it
# accumulates where the anonymous volume it replaced did not: one working tree per
# runner token, per project. None of it is a Docker volume, so the loop below
# never sees it. A checkout a job is using has files modified seconds ago, so a
# tree untouched for the whole window is safe to drop; the next job clones it again.
#
# The tree is $BUILDS/<runner token>/<slot>/<group>/<project>, and the number of
# group levels depends on the namespace, so the working tree is found by the .git
# it holds rather than at a fixed depth.
prune_checkouts() {
  [ -d "$BUILDS" ] || return 0
  local removed=0 gitdir d
  for gitdir in $(find "$BUILDS" -mindepth 4 -maxdepth 9 -type d -name .git \
      -not -path "$BUILDS/.tmp/*" 2>/dev/null); do
    d=$(dirname "$gitdir")
    [ -n "$(find "$d" -newermt "-${CHECKOUT_DAYS} days" -print -quit 2>/dev/null)" ] && continue
    run rm -rf "$d"
    removed=$((removed + 1))
    over_budget || break
  done
  # The group folders the removed checkouts leave empty, never the token or slot
  # folders a job may be about to use.
  find "$BUILDS" -mindepth 3 -maxdepth 8 -type d -empty -not -path "$BUILDS/.tmp*" -delete 2>/dev/null || true
  echo "  stale checkouts removed: ${removed}"
}

# Cold Docker volumes, oldest first, re-checking the disk after each one: evicting
# a volume nothing has mounted cannot disturb a running job, and stopping as soon
# as the budget is met keeps the warmest entries.
prune_cold_volumes() {
  local live cold v mp window evicted=0
  live=$(docker ps -a -q 2>/dev/null | xargs -r docker inspect -f '{{range .Mounts}}{{.Name}}{{"\n"}}{{end}}' 2>/dev/null | sort -u)
  cold=$(mktemp)
  for v in $(docker volume ls -q); do
    echo "$live" | grep -qx "$v" && continue
    mp=$(docker volume inspect -f '{{.Mountpoint}}' "$v" 2>/dev/null) || continue
    [ -d "$mp" ] || continue
    # Cache volumes (GitLab's cache: backend) are worth more than a checkout, so
    # they get a longer window before they are even candidates.
    window=$CHECKOUT_DAYS
    case "$v" in *-cache-*) window=$CACHE_DAYS ;; esac
    [ -n "$(find "$mp" -maxdepth 3 -newermt "-${window} days" -print -quit 2>/dev/null)" ] && continue
    echo "$(stat -c %Y "$mp" 2>/dev/null || echo 0) $v" >> "$cold"
  done

  if [ -s "$cold" ]; then
    while over_budget && read -r _ v; do
      run docker volume rm "$v"
      evicted=$((evicted + 1))
    done < <(sort -n "$cold")
  fi
  rm -f "$cold"
  echo "cold volumes evicted: ${evicted} -> used=$(used_gb)G free=$(free_gb)G"
}

echo "used=$(used_gb)G free=$(free_gb)G pct=$(pct)% budget=${TARGET_USED_GB}G hard=${HARD_USED_GB}G running_jobs=$(jobs)"

# 1. Emergency: unattached resources only, so a live job is unaffected. A full
# disk breaks the running job too. Container pruning keeps its age filter even
# here: a container younger than the grace period may be a job that is still
# starting, and deleting it turns a slow job into a failed one.
if [ "$(pct)" -ge "$EMERGENCY" ]; then
  echo "EMERGENCY: dropping every unused volume, image and build cache"
  prune_job_temp
  prune_containers
  run docker volume prune -af
  run docker image prune -af
  run docker builder prune -af
  echo "usage_after=$(used_gb)G pct=$(pct)%"
  exit 0
fi

prune_job_temp

if ! over_budget; then
  echo "within budget: nothing else pruned"
  exit 0
fi

prune_containers
prune_checkouts

if ! over_budget; then
  echo "usage_after=$(used_gb)G pct=$(pct)%"
  exit 0
fi

prune_cold_volumes

if ! over_budget; then
  echo "usage_after=$(used_gb)G pct=$(pct)%"
  exit 0
fi

# 4. Still over: dangling images and the build cache, which a job re-creates, but
# only with nothing in flight.
echo "still over budget: dropping dangling images and the build cache"
prune_images_if_idle

# 5. Past the hard budget, tagged images past the age floor that no container
# references. A tagged image a job still uses is hot cache even when it is weeks
# old, so docker's own `unused + older than` filter is the right one.
if [ "$(used_gb)" -gt "$HARD_USED_GB" ]; then
  echo "over hard budget: dropping unused tagged images older than ${STALE_DAYS}d"
  if [ "$(jobs)" -gt 0 ]; then
    echo "  job container(s) in flight: tagged-image prune left for an idle window"
  else
    run docker image prune -af --filter "until=$((STALE_DAYS * 24))h"
  fi
fi

echo "usage_after=$(used_gb)G pct=$(pct)%"
