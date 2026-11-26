#!/usr/bin/env python3
"""Govern the CI queue from measured CPU utilisation, in the only form GitLab permits.

GitLab has no resource model for runners. `concurrent` and each runner's `limit` are
plain semaphores and tag matching is a hard partition, so nothing in GitLab can say
"24 tiny jobs fit alongside 4 medium+". The one admission control it offers is the
size of the slot pool: a runner takes a job when it polls, and not before. So the
queue we manage is GitLab's own -- shrink `concurrent` and jobs wait there, which is
exactly where they should wait.

Two layers:

  * Per-runner `limit` is NOT the constraint. Each is set to what that tier alone
    could fill, so any single tier can use the whole host when it is the only one
    with work. That is 24/12/6/4 for tiny/small/medium/medium+.
  * `concurrent` is the single governor, and this script moves it.

Why utilisation: the question is "is the compute there and sitting idle". Aggregate
CPU use answers it directly -- usage_usec over wall-clock divided by the cores. Two
signals were rejected on measurement:

  * Summing each job's CPU *quota* overestimates by 4x on some jobs and cannot see the
    difference at all between a job saturating its 2-core cap (188%, 196%) and one that
    is fsync-bound and wants no CPU (0.64%).
  * cgroup `cpu.pressure` measures runnable-task stalls, but a single job that
    over-threads its own quota raises pressure while ten cores sit idle. It is logged
    as context, not steered on.

Band, deliberately asymmetric -- adding slots is cheap and reversible, shedding is what
protects the latency of jobs already running, so it moves down faster than up:

    util < LOW_UTIL   -> add  SLOTS_UP     (spare compute: admit more)
    util > HIGH_UTIL  -> shed SLOTS_DOWN   (saturated: stop admitting)
    in between        -> hold

Measured on this host 2026-11-26: cgroup anon peaked at 5.9 GiB of 24 across 8
concurrent jobs, about 0.73 GiB/job, so CPU is the binding resource, not memory. The
memory check is a backstop for what those samples did not cover -- a leaking job, a
ballooning build -- because an OOM kills the runner and every job on it and there is no
swap. Shedding never kills anything: `concurrent` below the running count just stops
new pickups until the count falls.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import time

CONFIG = os.environ.get("CONFIG", "/etc/gitlab-runner/config.toml")
STATE = os.environ.get("STATE", "/run/ci-admission.state")
MEM_STAT = os.environ.get("MEM_STAT", "/sys/fs/cgroup/memory.stat")
CPU_STAT = os.environ.get("CPU_STAT", "/sys/fs/cgroup/cpu.stat")
CPU_PRESSURE = os.environ.get("CPU_PRESSURE", "/sys/fs/cgroup/cpu.pressure")

CORES = float(os.environ.get("CORES", "12"))
# Enough slots for a tiny-only period to fill every core (12 / 0.5).
MAX_SLOTS = int(os.environ.get("MAX_SLOTS", "24"))
MIN_SLOTS = int(os.environ.get("MIN_SLOTS", "4"))
LOW_UTIL = float(os.environ.get("LOW_UTIL", "55"))
HIGH_UTIL = float(os.environ.get("HIGH_UTIL", "90"))
SLOTS_UP = int(os.environ.get("SLOTS_UP", "2"))
SLOTS_DOWN = int(os.environ.get("SLOTS_DOWN", "2"))
HIGH_ANON_GIB = float(os.environ.get("HIGH_ANON_GIB", "16"))
COOLDOWN_SECONDS = int(os.environ.get("COOLDOWN_SECONDS", "120"))
DRY_RUN = os.environ.get("DRY_RUN", "0") == "1"


def read_first_line(path: str) -> str:
    try:
        return open(path, encoding="utf-8").readline().strip()
    except OSError:
        return ""


def usage_usec() -> int | None:
    for line in read_first_line(CPU_STAT).splitlines() or []:
        if line.startswith("usage_usec "):
            return int(line.split()[1])
    try:
        for line in open(CPU_STAT, encoding="utf-8"):
            if line.startswith("usage_usec "):
                return int(line.split()[1])
    except OSError:
        pass
    return None


def pressure_some_avg60() -> float | None:
    try:
        for line in open(CPU_PRESSURE, encoding="utf-8"):
            if line.startswith("some "):
                for field in line.split():
                    if field.startswith("avg60="):
                        return float(field.split("=", 1)[1])
    except OSError:
        pass
    return None


def anon_gib() -> float:
    try:
        for line in open(MEM_STAT, encoding="utf-8"):
            if line.startswith("anon "):
                return int(line.split()[1]) / 2**30
    except OSError:
        pass
    return 0.0


def running_jobs() -> int:
    try:
        out = subprocess.run(
            ["docker", "ps", "--format", "{{.Names}}"],
            capture_output=True, text=True, timeout=20,
        ).stdout
    except Exception:
        return 0
    return sum(1 for n in out.split() if n.endswith("-build"))


def current_concurrent() -> int:
    for raw in open(CONFIG, encoding="utf-8"):
        if raw.startswith("concurrent = "):
            return int(raw.split("=", 1)[1].strip())
    return 0


def load_state() -> dict:
    try:
        return json.load(open(STATE, encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def save_state(state: dict) -> None:
    try:
        json.dump(state, open(STATE, "w", encoding="utf-8"))
    except OSError:
        pass


def set_concurrent(n: int) -> None:
    if DRY_RUN:
        print(f"  would: set concurrent = {n} and reload")
        return
    text = open(CONFIG, encoding="utf-8").read()
    text = re.sub(r"^concurrent = \d+$", f"concurrent = {n}", text, count=1, flags=re.M)
    open(CONFIG, "w", encoding="utf-8").write(text)
    # SIGHUP re-reads config.toml and rebuilds the workers. Verified on this host that
    # `Configuration loaded ... max_builds=N` follows the new value, and that it does not
    # disturb running jobs.
    subprocess.run(["systemctl", "reload", "gitlab-runner"], check=True, timeout=30)


def main() -> int:
    cur = current_concurrent()
    if cur < 1:
        print(f"cannot read concurrent from {CONFIG}: leaving it alone")
        return 1

    now = time.time()
    used = usage_usec()
    anon = anon_gib()
    psi = pressure_some_avg60()
    jobs = running_jobs()
    state = load_state()

    prev_used, prev_at = state.get("used_usec"), state.get("at")

    if used is None:
        print(f"cannot read {CPU_STAT}: holding at {cur}")
        return 0

    if prev_used is None or prev_at is None or now <= prev_at:
        save_state({"used_usec": used, "at": now, "concurrent": cur})
        print(f"first sample at concurrent={cur}: holding until the next tick")
        return 0

    elapsed = now - prev_at
    util = (used - prev_used) / (elapsed * 1_000_000 * CORES) * 100.0
    util = max(0.0, min(100.0, util))

    target = cur
    if util > HIGH_UTIL:
        target = cur - SLOTS_DOWN
        why = f"util {util:.0f}% > {HIGH_UTIL:.0f}%: saturated, shedding {SLOTS_DOWN}"
    elif util < LOW_UTIL:
        target = cur + SLOTS_UP
        why = f"util {util:.0f}% < {LOW_UTIL:.0f}%: spare compute, adding {SLOTS_UP}"
    else:
        why = f"util {util:.0f}% within band"

    if anon >= HIGH_ANON_GIB:
        target = min(target, cur - SLOTS_DOWN)
        why += f"; anon {anon:.1f}G >= {HIGH_ANON_GIB}G: shedding"

    target = max(MIN_SLOTS, min(MAX_SLOTS, target))
    psi_txt = f"{psi:.0f}%" if psi is not None else "n/a"
    print(
        f"util={util:.0f}% psi={psi_txt} anon={anon:.1f}G jobs={jobs} "
        f"concurrent={cur} -> {target} ({why})"
    )

    cooled = (now - state.get("changed_at", 0)) >= COOLDOWN_SECONDS
    if target != cur and not cooled:
        print(f"  cooldown {COOLDOWN_SECONDS}s not elapsed: holding at {cur}")
        target = cur

    if target != cur and not DRY_RUN:
        set_concurrent(target)
        print(f"  concurrent {cur} -> {target}")

    new_state = {"used_usec": used, "at": now, "concurrent": target}
    if target != cur:
        new_state["changed_at"] = now
    else:
        new_state["changed_at"] = state.get("changed_at", 0)
    save_state(new_state)
    return 0


if __name__ == "__main__":
    sys.exit(main())
