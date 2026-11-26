#!/bin/bash
# Keep the CI caches bounded without ever letting the disk fill, and without
# ever disturbing a job that is still running.
#
# A budget, not a watermark. The watermark version did nothing below 90% and then
# reclaimed with `docker volume prune -af`, which drops every unused volume at
# once: the cache was either cold, or the disk was nearly full, and never both
# warm and roomy. This keeps the whole disk under a fixed budget at all times and
# evicts the coldest entry first, so the steady state is a warm cache with free
# space left over.
#
# The budget has to be ABOVE what the runner legitimately keeps, or the script
# escalates forever and the Docker prunes run on every tick. That is not a
# theoretical concern: at TARGET 22 on a 48 GB disk, 132 of the 132 runs in a day
# went past "within budget", because /srv/mise alone is 13 GB of warm tool cache,
# the checkouts are 6.5 GB and the OS is 4.8 GB -- 24 GB before a single image.
# The numbers below are measured from this host's own journal (730 samples over
# 24 h, 2026-11-25/26):
#
#   warm steady state        33-35 GB
#   observed peak            40 GB   (85% of the then-48 GB disk)
#   samples above 38 GB      2.3%    -> TARGET 38 acts on about one tick in forty
#   samples above 34 GB      29%     -> TARGET 34 would act on one tick in three
#
# 38 is therefore the smallest budget that lets the common path be "one log line
# and an exit". The disk is 64 GB, so 38 GB leaves ~25 GB free: room for a suite's
# own scratch, an image pull, and a newly provisioned runner pool (~5 GB of fresh
# checkouts, which is what the single +9 GB one-minute jump on 2026-11-26 00:00
# turned out to be -- not image pulls).
#
# Order: job temp folders (always), then the checkouts on the builds volume, then
# cold Docker volumes, then images and the build cache, then (only past the hard
# budget) tagged images no container references. The percentage threshold remains
# as the last-resort guard.
#
# One invariant makes this safe to reason about:
#
#   No Docker write is ever issued while a job container exists.
#
# Every line below that deletes something either checks that invariant, or only
# touches an entry that provably cannot be in use. Each rule cost a real failure:
#
#   * `docker container prune -f` with no age filter deletes the runner's stopped
#     `<job>...-predefined` helper container in the instant the executor starts or
#     removes it, and the job dies with "container is marked for removal and
#     cannot be started" / failure_reason=runner_system_failure. Every one of the
#     8 such failures on 2026-11-26 landed 0.06-0.29 s after this timer fired. Now
#     it runs only with no job container in flight, and carries `until=1h` anyway
#     so that a mis-counted job still cannot be selected.
#   * Image and builder pruning race a job's own pull and leave the containerd
#     content store reporting "parent snapshot does not exist" (3 occurrences).
#     Idle-only.
#   * A `.git` nested inside another working tree is a fixture repo committed in
#     the tree, not a checkout. Treating it as one deleted part of a live job.
#   * Job temp folders were aged on the folder's own mtime, which a job writing
#     deeper never updates. Age on the newest content instead.
#   * `until=30*24h` is not a duration: Docker rejected it with
#     `invalid seconds "30*24h"` on every single run, so every stale image stayed.
#     The value is computed to hours instead.

set -u

FS=/
BUILDS=${BUILDS_DIR:-/srv/builds}
# Start reclaiming above this, and stop as soon as we are back under it.
TARGET_USED_GB=${TARGET_USED_GB:-38}
# Past this, tagged images and the build cache go too, still cold-first.
HARD_USED_GB=${HARD_USED_GB:-48}
# Never finish below this much free, whatever the budget says.
FLOOR_FREE_GB=${FLOOR_FREE_GB:-8}
EMERGENCY=${EMERGENCY:-90}
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

used_gb()  { df -B1G --output=used "$FS" | tail -1 | tr -dc '0-9'; }
free_gb()  { df -B1G --output=avail "$FS" | tail -1 | tr -dc '0-9'; }
total_gb() { df -B1G --output=size "$FS" | tail -1 | tr -dc '0-9'; }
pct()      { df --output=pcent "$FS" | tail -1 | tr -dc '0-9'; }
jobs()     { docker ps --format '{{.Names}}' 2>/dev/null | grep -cE -- '-build$|-predefined$'; }
over_budget() { [ "$(used_gb)" -gt "$TARGET_USED_GB" ] || [ "$(free_gb)" -lt "$FLOOR_FREE_GB" ]; }
# Keep reclaiming while the disk is above <limit> GB used.
above() { [ "$(used_gb)" -gt "$1" ]; }

# The only container prune this script is allowed to run, and only when the box
# is otherwise idle. Both halves matter: the idle check keeps it away from a job
# that is mid-phase, the age filter keeps it away from a job we failed to count.
# Do not "simplify" either one back.
prune_containers() {
  local busy
  busy=$(jobs)
  if [ "$busy" -gt 0 ]; then
    echo "  ${busy} job container(s) in flight: containers left alone"
    return 0
  fi
  run docker container prune -f --filter "until=${CONTAINER_GRACE}"
}

# Images and the builder cache race a job's image pull, so they only move when the
# runner is idle.
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
  local stale=() d
  for d in "$BUILDS/.tmp"/*/; do
    [ -d "$d" ] || continue
    # Age on the newest content, never on the folder's own mtime: a job writing
    # into a subdirectory leaves the top-level mtime untouched and old.
    [ -n "$(find "$d" -newermt "-${JOB_TMP_MINUTES} minutes" -print -quit 2>/dev/null)" ] && continue
    stale+=("$d")
  done
  [ "${#stale[@]}" -gt 0 ] || return 0
  if [ "$DRY" = 1 ]; then
    echo "  would: remove ${#stale[@]} job temp folder(s) under $BUILDS/.tmp"
  else
    rm -rf "${stale[@]}"
    echo "  job temp folders idle ${JOB_TMP_MINUTES}m+: ${#stale[@]}"
  fi
}

# A checkout root is the working tree the runner clones. A .git deeper inside one
# (a fixture repo committed in the tree) is not: its files are older than the
# outer tree it lives in, so it would look stale and be deleted out of a live job.
is_checkout_root() {
  local parent
  parent=$(dirname "$1")
  while [ "$parent" != "$BUILDS" ] && [ "$parent" != "/" ] && [ -n "$parent" ]; do
    [ -e "$parent/.git" ] && return 1
    parent=$(dirname "$parent")
  done
  return 0
}

# The checkouts on the builds volume. /srv/builds is a real host path, so it
# accumulates where the anonymous volume it replaced did not: one working tree per
# runner token, per project. None of it is a Docker volume, so the volume loop
# below never sees it. A checkout a job is using has files modified seconds ago,
# so a tree untouched for the whole window is safe to drop; the next job clones it.
#
# The tree is $BUILDS/<runner token>/<slot>/<group>/<project>, and the number of
# group levels depends on the namespace, so the working tree is found by the .git
# it holds rather than at a fixed depth.
#   $1 = keep going until used <= this many GB (default: the budget)
prune_checkouts() {
  [ -d "$BUILDS" ] || return 0
  local limit=${1:-$TARGET_USED_GB}
  local removed=0 gitdir d
  if above "$limit"; then
    for gitdir in $(find "$BUILDS" -mindepth 4 -maxdepth 9 -type d -name .git \
        -not -path "$BUILDS/.tmp/*" 2>/dev/null); do
      d=$(dirname "$gitdir")
      is_checkout_root "$d" || continue
      [ -n "$(find "$d" -newermt "-${CHECKOUT_DAYS} days" -print -quit 2>/dev/null)" ] && continue
      run rm -rf "$d"
      removed=$((removed + 1))
      above "$limit" || break
    done
    # The group folders the removed checkouts leave empty, never the token or slot
    # folders a job may be about to use.
    if [ "$removed" -gt 0 ] && [ "$DRY" != 1 ]; then
      find "$BUILDS" -mindepth 3 -maxdepth 8 -type d -empty -not -path "$BUILDS/.tmp*" -delete 2>/dev/null || true
    fi
  fi
  echo "  stale checkouts removed: ${removed}"
}

# Cold Docker volumes, oldest first, re-checking the disk after each one: evicting
# a volume nothing has mounted cannot disturb a running job, and stopping as soon
# as the budget is met keeps the warmest entries.
#   $1 = keep going until used <= this many GB (default: the budget)
prune_cold_volumes() {
  local limit=${1:-$TARGET_USED_GB}
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
    while above "$limit" && read -r _ v; do
      run docker volume rm "$v"
      evicted=$((evicted + 1))
    done < <(sort -n "$cold")
  fi
  rm -f "$cold"
  echo "cold volumes evicted: ${evicted} -> used=$(used_gb)G free=$(free_gb)G"
}

echo "used=$(used_gb)G free=$(free_gb)G of $(total_gb)G pct=$(pct)% budget=${TARGET_USED_GB}G hard=${HARD_USED_GB}G running_jobs=$(jobs)"

# 1. Emergency: reclaim as much as possible, but take the entries that cannot be
# in use first, and only fall back to images and the build cache if that was not
# enough. Reclaiming to the floor rather than to the budget, so one emergency buys
# real headroom instead of firing again on the next tick.
if [ "$(pct)" -ge "$EMERGENCY" ]; then
  emergency_stop=$(( $(total_gb) - 2 * FLOOR_FREE_GB ))
  echo "EMERGENCY at $(pct)%: reclaiming to ${emergency_stop}G from unattached entries only"
  prune_job_temp
  prune_containers
  run docker volume prune -af
  prune_checkouts "$emergency_stop"
  if above "$emergency_stop"; then
    echo "EMERGENCY: still at $(used_gb)G, dropping every unused image and the build cache"
    run docker image prune -af
    run docker builder prune -af
  fi
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
