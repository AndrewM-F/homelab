#!/usr/bin/env python3
"""
homelab stats collector.

Runs on the Proxmox host and answers three things over plain HTTP:

  GET /health          -> {"ok": true}
  GET /stats           -> host + guest resource sample, service probes
  GET /connect/<slug>  -> a small page for services that are not HTTP

It is never exposed directly to the internet: the Cloudflare Tunnel publishes
it on one hostname, and Cloudflare Access sits in front of that hostname.

Config: /etc/homelab-collector.json (override with HOMELAB_COLLECTOR_CONFIG)

    {
      "listen": {"host": "0.0.0.0", "port": 9101},
      "interface": "vmbr0",
      "disks": ["/"],
      "ups": {"name": "cyberpower"},
      "probes": [{"slug": "media", "url": "http://10.0.0.21:8096/"}],
      "connect": [{"slug": "windows", "name": "Windows", "protocol": "rdp",
                   "address": "windows.example.com:3389",
                   "command": "cloudflared access rdp --hostname ..."}]
    }
"""

from __future__ import annotations

import html
import json
import os
import shutil
import socket
import ssl
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

CONFIG_PATH = os.environ.get("HOMELAB_COLLECTOR_CONFIG", "/etc/homelab-collector.json")
SAMPLE_SECONDS = 5.0
SAMPLE_INTERVAL_SECONDS = 5.0
PROBE_TIMEOUT = 3.5
PVESH_TIMEOUT = 8.0
AGENT_TIMEOUT = 6.0
# Filesystem usage moves slowly and the agent call is not free, so it is cached
# far longer than the resource sample itself.
AGENT_TTL = 60.0
SSH_TIMEOUT = 6.0
# Key whose authorized_keys entry is pinned to a single read-only command, for
# appliances that cannot run the guest agent (see README).
SSH_IDENTITY = "/etc/homelab-collector/ssh_probe"

_agent_cache: dict[int, tuple[float, tuple[int, int, str] | None]] = {}
# A big non-root volume inside the guest (a media array, a NAS share) is worth
# showing, but it is not the machine's own disk, so it rides along separately.
_disk_extra: dict[int, tuple[int, int, str]] = {}
_ssh_cache: dict[int, tuple[float, tuple[int, int, str] | None]] = {}
# Machines that are not Proxmox guests report through their own probe script.
MACHINE_TTL = 30.0
_machine_cache: dict[str, tuple[float, dict | None]] = {}
# Last reported problem per machine, so the journal records a change, not a poll.
_machine_state: dict[str, str | None] = {}

# ---------------------------------------------------------------- sampling

_net_lock = threading.Lock()
_net_sample = {"ts": 0.0, "rx": 0, "tx": 0, "rx_rate": 0.0, "tx_rate": 0.0}


def read(path: str) -> str:
    with open(path, "r", encoding="utf-8") as fh:
        return fh.read()


def default_interface() -> str:
    """Interface carrying the default route, falling back to the first physical one."""
    try:
        for line in read("/proc/net/route").splitlines()[1:]:
            fields = line.split()
            if len(fields) > 2 and fields[1] == "00000000" and int(fields[3], 16) & 0x2:
                return fields[0]
    except OSError:
        pass
    return "eth0"


def read_net(interface: str) -> tuple[int, int]:
    try:
        for line in read("/proc/net/dev").splitlines():
            name, sep, rest = line.partition(":")
            if not sep or name.strip() != interface:
                continue
            fields = rest.split()
            return int(fields[0]), int(fields[8])
    except (OSError, IndexError, ValueError):
        pass
    return 0, 0


def sample_network(interface: str) -> None:
    previous = None
    while True:
        rx, tx = read_net(interface)
        now = time.time()
        with _net_lock:
            if previous is not None:
                elapsed = max(now - previous[0], 0.001)
                _net_sample.update(
                    ts=now,
                    rx=rx,
                    tx=tx,
                    rx_rate=max(0.0, (rx - previous[1]) / elapsed),
                    tx_rate=max(0.0, (tx - previous[2]) / elapsed),
                )
        previous = (now, rx, tx)
        time.sleep(SAMPLE_SECONDS)


def network() -> dict:
    with _net_lock:
        return dict(_net_sample)


def memory() -> tuple[int, int, int, int, int]:
    info: dict[str, int] = {}
    for line in read("/proc/meminfo").splitlines():
        key, _, rest = line.partition(":")
        try:
            info[key] = int(rest.strip().split()[0]) * 1024
        except (IndexError, ValueError):
            continue
    total = info.get("MemTotal", 0)
    available = info.get("MemAvailable", info.get("MemFree", 0))
    cache = info.get("Cached", 0) + info.get("Buffers", 0) + info.get("SReclaimable", 0)
    swap_total = info.get("SwapTotal", 0)
    swap_free = info.get("SwapFree", 0)
    used = total - available
    return used, total, swap_total - swap_free, swap_total, min(cache, max(0, total - used))


def uptime() -> int:
    try:
        return int(float(read("/proc/uptime").split()[0]))
    except (OSError, IndexError, ValueError):
        return 0


_installed_memory_cache: int | None = None


def installed_memory(fallback: int) -> int:
    """
    RAM physically installed, in bytes.

    MemTotal excludes what firmware and the kernel reserve, so a 96 GiB machine
    reports 93 GiB and its card implies memory that was never there. The installed
    figure is read once from SMBIOS and the reserved part is counted as used.
    """
    global _installed_memory_cache
    if _installed_memory_cache:
        return _installed_memory_cache
    total = 0
    tool = shutil.which("dmidecode")
    if tool:
        try:
            out = subprocess.run(
                [tool, "-t", "17"], capture_output=True, text=True, timeout=15, check=False
            )
            for line in out.stdout.splitlines():
                line = line.strip()
                if not line.startswith("Size:"):
                    continue
                parts = line.split(":", 1)[1].split()
                if len(parts) < 2 or not parts[0].isdigit():
                    continue
                size, unit = int(parts[0]), parts[1].upper()
                if unit.startswith("GB"):
                    total += size * 1024**3
                elif unit.startswith("MB"):
                    total += size * 1024**2
        except Exception:  # noqa: BLE001 - a machine without SMBIOS is fine
            total = 0
    _installed_memory_cache = total if total >= fallback else fallback
    return _installed_memory_cache


def host_stats(interface: str) -> dict:
    cores = os.cpu_count() or 1
    try:
        load = os.getloadavg()
    except OSError:
        load = (0.0, 0.0, 0.0)
    used, total, swap_used, swap_total, cache = memory()
    # Measure against the installed DIMMs, not MemTotal: the kernel and firmware
    # reservations are real memory the host cannot hand out.
    installed = installed_memory(total)
    if installed > total:
        used = max(0, installed - max(0, total - used))
        total = installed
    net = network()
    return {
        "name": os.uname().nodename,
        "cores": cores,
        "load": [round(load[0], 2), round(load[1], 2), round(load[2], 2)],
        "cpu": round(min(1.0, load[0] / cores), 4),
        "memUsed": used,
        "memTotal": total,
        "memCache": cache,
        "swapUsed": swap_used,
        "swapTotal": swap_total,
        "uptime": uptime(),
        "net": {
            "rx": int(net["rx"]),
            "tx": int(net["tx"]),
            "rxRate": round(net["rx_rate"], 2),
            "txRate": round(net["tx_rate"], 2),
        },
    }


def agent_disk(vmid: int, node: str) -> tuple[int, int, str] | None:
    """
    Real filesystem usage inside a VM, via the QEMU guest agent.

    Proxmox reports only provisioned size for VMs, so without this the dashboard
    can show what a disk is allowed to grow to but not what is on it.
    """
    now = time.time()
    cached = _agent_cache.get(vmid)
    if cached and now - cached[0] < AGENT_TTL:
        return cached[1]

    found: tuple[int, int, str] | None = None
    pvesh = shutil.which("pvesh")
    if pvesh:
        try:
            out = subprocess.run(
                [pvesh, "get", f"/nodes/{node}/qemu/{vmid}/agent/get-fsinfo", "--output-format", "json"],
                capture_output=True,
                text=True,
                timeout=AGENT_TIMEOUT,
                check=False,
            )
            if out.returncode == 0:
                payload = json.loads(out.stdout or "{}")
                entries = payload.get("result", payload) if isinstance(payload, dict) else payload
                root_mounts = ("/", "C:\\", "C:/")
                root = None
                root_saturated = False
                largest = None
                for entry in entries or []:
                    total = int(entry.get("total-bytes") or 0)
                    used = int(entry.get("used-bytes") or 0)
                    if total <= 0:
                        continue
                    mount = str(entry.get("mountpoint", ""))
                    if mount in root_mounts:
                        # A read-only system image reports itself 100% full: that is
                        # the image's size, not pressure (ZimaOS root is exactly this).
                        if used >= total:
                            root_saturated = True
                        else:
                            root = (used, total, mount)
                        continue
                    # Other mounts can be a media array or a NAS share that has nothing
                    # to do with this machine's own disk, so they are never preferred.
                    if largest is None or total > largest[1]:
                        largest = (used, total, mount)

                if root is not None:
                    found = root
                    # Only when it dwarfs the system disk, so a normal /home or
                    # /var partition does not get promoted.
                    if largest is not None and largest[1] >= root[1] * 4:
                        _disk_extra[vmid] = largest
                    else:
                        _disk_extra.pop(vmid, None)
                elif root_saturated:
                    # Leave the headline to Proxmox's provisioned size rather than
                    # reporting somebody else's volume as this machine's disk, but
                    # keep the biggest local volume for the card's footer.
                    found = None
                    if largest is not None:
                        _disk_extra[vmid] = largest
                else:
                    found = largest
        except Exception:  # noqa: BLE001 - a missing agent is expected, not fatal
            found = None

    _agent_cache[vmid] = (now, found)
    return found


def ssh_disk(vmid: int, probe: dict) -> tuple[int, int, str] | None:
    """
    Filesystem usage for a guest that cannot run the agent, read over SSH.

    The remote key is restricted server-side to one command (`df -B1 <path>`),
    so this cannot do anything else even if the collector is compromised.
    """
    now = time.time()
    cached = _ssh_cache.get(vmid)
    if cached and now - cached[0] < AGENT_TTL:
        return cached[1]

    found: tuple[int, int, str] | None = None
    target = probe.get("ssh")
    path = probe.get("path") or "/"
    if target:
        try:
            out = subprocess.run(
                [
                    "ssh",
                    "-i",
                    SSH_IDENTITY,
                    "-o",
                    "BatchMode=yes",
                    "-o",
                    "StrictHostKeyChecking=accept-new",
                    "-o",
                    f"ConnectTimeout={int(SSH_TIMEOUT)}",
                    target,
                    "df",
                    "-B1",
                    path,
                ],
                capture_output=True,
                text=True,
                timeout=SSH_TIMEOUT + 4,
                check=False,
            )
            if out.returncode == 0:
                rows = [line for line in out.stdout.splitlines() if line.strip()]
                if len(rows) >= 2:
                    fields = rows[-1].split()
                    if len(fields) >= 3:
                        total = int(fields[1])
                        used = int(fields[2])
                        if total > 0:
                            found = (used, total, path)
        except Exception:  # noqa: BLE001 - an unreachable probe is not fatal
            found = None

    _ssh_cache[vmid] = (now, found)
    return found


def machine_note(machine_id: str, problem: str | None) -> None:
    """Journal a machine that stops or resumes reading, only when that changes."""
    previous = _machine_state.get(machine_id)
    if problem == previous:
        return
    _machine_state[machine_id] = problem
    if problem:
        print(f"collector: machine {machine_id}: {problem}", file=sys.stderr, flush=True)
    elif previous:
        print(f"collector: machine {machine_id}: reading again", file=sys.stderr, flush=True)


def machine_stat(entry: dict) -> dict | None:
    """
    Resource sample for a machine that is not a Proxmox guest.

    Runs a probe script on the host (pinned server-side to a single command) and
    parses its `key=value` output. Cached like the other slow lookups.
    """
    machine_id = entry.get("id")
    now = time.time()
    cached = _machine_cache.get(machine_id)
    if cached and now - cached[0] < MACHINE_TTL:
        return cached[1]

    found: dict | None = None
    problem: str | None = None
    ssh = entry.get("ssh")
    identity = entry.get("identity")
    if ssh and identity:
        remote = [
            "ssh",
            "-T",
            "-i",
            identity,
            "-o",
            "BatchMode=yes",
            "-o",
            "StrictHostKeyChecking=accept-new",
            "-o",
            f"ConnectTimeout={int(SSH_TIMEOUT)}",
            ssh,
        ]
        command = remote
        jump = entry.get("jump")
        if jump is not None:
            # Reach a tailnet-only host from the container that is on the tailnet.
            command = ["pct", "exec", str(jump), "--"] + remote
        try:
            out = subprocess.run(
                command, capture_output=True, text=True, timeout=SSH_TIMEOUT + 10, check=False
            )
            if out.returncode == 0:
                values: dict[str, float] = {}
                for line in out.stdout.splitlines():
                    key, sep, raw = line.partition("=")
                    if not sep:
                        continue
                    try:
                        values[key.strip()] = float(raw.strip())
                    except ValueError:
                        continue
                total = values.get("mem_total", 0)
                if total > 0:
                    found = {
                        "id": machine_id,
                        "cores": int(values.get("cores", 0)),
                        "cpu": round(min(1.0, values.get("cpu_percent", 0.0) / 100.0), 4),
                        "mem": int(values.get("mem_used", 0)),
                        "memTotal": int(total),
                        "disk": int(values.get("disk_used", 0)),
                        "diskTotal": int(values.get("disk_total", 0)),
                        "uptime": int(values.get("uptime", 0)),
                    }
                else:
                    problem = "probe script printed no mem_total"
            else:
                detail = next((line.strip() for line in out.stderr.splitlines() if line.strip()), "")
                problem = f"ssh exited {out.returncode}" + (f": {detail}" if detail else "")
        except Exception as error:  # noqa: BLE001 - an unreachable machine is not fatal
            problem = f"{type(error).__name__}: {error}"
    else:
        problem = "needs both ssh and identity in the collector config"

    machine_note(machine_id, problem)
    _machine_cache[machine_id] = (now, found)
    return found


_balloon_cache: dict[int, tuple[float, bool]] = {}
_mem_cache: dict[int, tuple[float, tuple[int, int] | None]] = {}


def memory_is_guest_reported(vmid: int, node: str) -> bool:
    """
    True when the running VM actually reports its own memory usage.

    Without an *active* balloon device Proxmox reports the QEMU process's
    resident set, which climbs to the full allocation as the guest touches pages
    — a Windows VM then looks 100% full while the guest itself is barely a
    quarter used. Configuring a balloon is not enough: the device only exists
    after the VM restarts, so ask the running machine.
    """
    now = time.time()
    cached = _balloon_cache.get(vmid)
    if cached and now - cached[0] < AGENT_TTL:
        return cached[1]

    active = False
    pvesh = shutil.which("pvesh")
    if pvesh:
        try:
            out = subprocess.run(
                [pvesh, "get", f"/nodes/{node}/qemu/{vmid}/status/current", "--output-format", "json"],
                capture_output=True,
                text=True,
                timeout=AGENT_TIMEOUT,
                check=False,
            )
            if out.returncode == 0:
                active = bool(json.loads(out.stdout or "{}").get("ballooninfo"))
        except Exception:  # noqa: BLE001
            active = False

    _balloon_cache[vmid] = (now, active)
    return active


def guest_ostype(vmid: int) -> str:
    try:
        with open(f"/etc/pve/qemu-server/{vmid}.conf", "r", encoding="utf-8") as handle:
            for line in handle:
                if line.startswith("ostype:"):
                    return line.split(":", 1)[1].strip()
    except OSError:
        pass
    return ""


def lxc_memory(vmid: int) -> tuple[int, int]:
    """
    (resident, reclaimable) bytes for a running container, from its own cgroup.

    pvesh reports one figure and its meaning shifts with the container, so both
    numbers are read here instead: `memory.current` is everything the cgroup
    holds, `inactive_file` is the page cache the kernel would drop first.
    """
    current = 0
    inactive = 0
    try:
        with open(f"/sys/fs/cgroup/lxc/{vmid}/memory.current", "r", encoding="utf-8") as handle:
            current = int(handle.read().strip())
    except (OSError, ValueError):
        pass
    try:
        with open(f"/sys/fs/cgroup/lxc/{vmid}/memory.stat", "r", encoding="utf-8") as handle:
            for line in handle:
                key, _, value = line.partition(" ")
                if key == "inactive_file":
                    inactive = int(value.strip())
                    break
    except (OSError, ValueError):
        pass
    return current, inactive


def lxc_inactive_file(vmid: int) -> int:
    """
    Reclaimable page cache of a running container, in bytes.

    A container's cgroup counts its page cache as usage, so a busy runner reads
    full while most of it would be handed back the moment anything asked. The
    inactive half of the file cache is the part the kernel drops first.
    """
    try:
        with open(f"/sys/fs/cgroup/lxc/{vmid}/memory.stat", "r", encoding="utf-8") as handle:
            for line in handle:
                key, _, value = line.partition(" ")
                if key == "inactive_file":
                    return int(value.strip())
    except (OSError, ValueError):
        pass
    return 0


def agent_memory(vmid: int) -> tuple[int, int, int] | None:
    """
    Real memory use from the QEMU guest agent, for VMs that cannot balloon.

    Ballooning is incompatible with PCIe passthrough (the guest's memory has to
    stay mapped for DMA), so a passthrough VM reports its process size instead.
    The agent can still answer the question directly, which is what this does.
    """
    now = time.time()
    cached = _mem_cache.get(vmid)
    if cached and now - cached[0] < AGENT_TTL:
        return cached[1]

    result: tuple[int, int, int] | None = None
    qm = shutil.which("qm")
    if qm:
        if guest_ostype(vmid).startswith("win"):
            command = [
                "powershell",
                "-NoProfile",
                "-Command",
                "$o=Get-CimInstance Win32_OperatingSystem;"
                "$m=Get-CimInstance Win32_PerfRawData_PerfOS_Memory;"
                " $t=[int64]$o.TotalVisibleMemorySize*1024;"
                " $a=[int64]$m.AvailableMBytes*1MB;"
                # FreePhysicalMemory already counts the standby list, so the cache
                # figure has to come from the standby lists themselves.
                " $c=[int64]$m.StandbyCacheNormalPriorityBytes+[int64]$m.StandbyCacheReserveBytes+[int64]$m.StandbyCacheCoreBytes;"
                " 'total={0} used={1} cache={2}' -f $t, ($t-$a), ([Math]::Min($c, $a))",
            ]
        else:
            command = [
                "sh",
                "-c",
                # used = MemTotal - MemAvailable (page cache excluded); cache = the
                # reclaimable part still resident, so a guest full of cache reads cheap.
                "awk '/MemTotal/{t=$2}/MemFree/{f=$2}/MemAvailable/{a=$2}END{print \"total=\" t*1024 \" used=\" (t-a)*1024 \" cache=\" (a-f)*1024}' /proc/meminfo",
            ]
        try:
            out = subprocess.run(
                [qm, "guest", "exec", str(vmid), "--"] + command,
                capture_output=True,
                text=True,
                timeout=AGENT_TIMEOUT + 6,
                check=False,
            )
            if out.returncode == 0:
                payload = json.loads(out.stdout or "{}")
                data = str(payload.get("out-data") or "")
                values = dict(
                    part.split("=", 1) for part in data.split() if "=" in part
                )
                total = int(values.get("total", 0))
                used = int(values.get("used", 0))
                cache = int(values.get("cache", 0))
                if total > 0:
                    result = (used, total, cache)
        except Exception:  # noqa: BLE001 - a guest without an agent is expected
            result = None

    _mem_cache[vmid] = (now, result)
    return result


def qemu_disk_total(total: int, allocated: int, item: dict) -> int:
    """The VM's provisioned disk size, which is what its card is measured against."""
    return max(total, allocated, int(item.get("maxdisk") or 0))


def qemu_disk_used(used: int, total: int, allocated: int, item: dict) -> int:
    """
    Used = provisioned - what the guest can actually still write.

    A guest that formats only part of its disk would otherwise look emptier than
    it is: the unformatted slice is not free space, it is gone.
    """
    provisioned = qemu_disk_total(total, allocated, item)
    free = max(0, total - used)
    return max(0, provisioned - free)


def guest_stats(warnings: list[str], disk_probes: dict[int, dict]) -> list[dict]:
    """Live CPU/memory/disk for every VM and container, from the cluster API."""
    pvesh = shutil.which("pvesh")
    if not pvesh:
        warnings.append("pvesh not found on this host")
        return []
    try:
        out = subprocess.run(
            [pvesh, "get", "/cluster/resources", "--type", "vm", "--output-format", "json"],
            capture_output=True,
            text=True,
            timeout=PVESH_TIMEOUT,
            check=False,
        )
    except subprocess.TimeoutExpired:
        warnings.append("pvesh timed out")
        return []

    if out.returncode != 0:
        warnings.append(f"pvesh exited {out.returncode}: {out.stderr.strip()[:200]}")
        return []

    try:
        resources = json.loads(out.stdout or "[]")
    except json.JSONDecodeError as error:
        warnings.append(f"pvesh returned invalid JSON: {error}")
        return []

    guests = []
    for item in resources:
        kind = item.get("type")
        if kind not in ("qemu", "lxc"):
            continue

        vmid = int(item.get("vmid") or 0)
        used = int(item.get("disk") or 0)
        allocated = int(item.get("maxdisk") or 0)
        total = allocated
        # Containers report real usage; VMs report zero unless the agent answers.
        source = "guest" if used > 0 else "allocated"

        if kind == "qemu" and item.get("status") == "running":
            node = item.get("node") or os.uname().nodename
            measured = agent_disk(vmid, node)
            if not measured and vmid in disk_probes:
                measured = ssh_disk(vmid, disk_probes[vmid])
            if measured:
                used, total, _mount = measured
                source = "guest"

        mem_used = int(item.get("mem") or 0)
        mem_total = int(item.get("maxmem") or 0)
        # A stopped guest has no memory to report; its zeros are accurate.
        mem_source = (
            "guest"
            if kind == "lxc"
            or item.get("status") != "running"
            or memory_is_guest_reported(vmid, item.get("node") or os.uname().nodename)
            else "resident"
        )
        # Splitting resident memory into "really used" and "page cache" needs the
        # guest's own MemAvailable, which neither pvesh nor the balloon reports.
        mem_cache = 0
        provisioned_mem = int(item.get("maxmem") or 0)
        if kind == "lxc" and item.get("status") == "running":
            current, inactive = lxc_memory(vmid)
            if current > 0:
                mem_cache = min(inactive, current)
                mem_used = current - mem_cache
        elif kind != "lxc" and item.get("status") == "running":
            measured_mem = agent_memory(vmid)
            if measured_mem:
                agent_used, agent_total, agent_cache = measured_mem
                # An agent inside a containerised appliance can answer with that
                # container's memory, which reads smaller than the VM itself. A
                # total far below the configured size is that, not a resize.
                if mem_total > 0 and agent_total < mem_total * 0.6:
                    warnings.append(
                        f"{item.get('name') or vmid}: guest agent reported {agent_total} bytes "
                        f"against a {mem_total} byte VM; keeping the Proxmox figures"
                    )
                else:
                    mem_used, mem_total, mem_cache = agent_used, agent_total, agent_cache
                    mem_source = "guest"
                    # Measure against the memory the VM was given, and count the part
                    # firmware and the kernel keep for themselves as used: it is not
                    # memory the guest can hand back (Windows: 24 configured, 23.9
                    # visible).
                    provisioned = int(item.get("maxmem") or 0)
                    if provisioned > mem_total:
                        gap = provisioned - mem_total
                        mem_total = provisioned
                        mem_used = min(mem_total - min(mem_cache, mem_total), mem_used + gap)

        guests.append(
            {
                "vmid": vmid,
                "type": kind,
                "status": item.get("status", "unknown"),
                "cpu": round(float(item.get("cpu") or 0), 4),
                "maxcpu": int(item.get("maxcpu") or 0),
                "mem": min(mem_used, mem_total),
                "maxmem": mem_total,
                "memCache": mem_cache,
                # Report against what was provisioned, and count the slice the guest
                # never formats (ZimaOS leaves ~12 GiB of its 32 GiB to the OS image
                # and overlay) as used, so the free figure on the card is the free
                # space that actually exists.
                # Same rule for containers: measure against the provisioned rootfs
                # and treat everything that is not writable free space as used, so
                # a 40 GiB container reads 40 GiB rather than the filesystem's
                # slightly smaller size.
                "disk": qemu_disk_used(used, total, allocated, item),
                "maxdisk": qemu_disk_total(total, allocated, item),
                "diskAllocated": allocated,
                "diskSource": source,
                **(
                    {
                        "diskExtra": {
                            "label": _disk_extra[vmid][2],
                            "used": _disk_extra[vmid][0],
                            "total": _disk_extra[vmid][1],
                        }
                    }
                    if vmid in _disk_extra
                    else {}
                ),
                "memSource": mem_source,
                "uptime": int(item.get("uptime") or 0),
                "name": item.get("name"),
            }
        )
    guests.sort(key=lambda guest: guest["vmid"] or 0)
    return guests


def disk_stats(mounts: list[str]) -> list[dict]:
    disks = []
    for mount in mounts:
        try:
            stat = os.statvfs(mount)
        except OSError:
            continue
        total = stat.f_frsize * stat.f_blocks
        available = stat.f_frsize * stat.f_bavail
        disks.append({"name": mount, "used": total - available, "total": total})
    return disks


def ups_stats(name: str) -> dict | None:
    """Read the local NUT daemon. `None` when NUT is absent or not answering.

    `upsc` prints one `key: value` per line; only the handful a card can show
    without a second call are kept, and the status word is expanded into flags
    so the UI never has to parse "OB LB" itself.
    """
    if not shutil.which("upsc"):
        return None
    try:
        result = subprocess.run(
            ["upsc", name], capture_output=True, text=True, timeout=3, check=False
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if result.returncode != 0:
        return None

    values: dict[str, str] = {}
    for line in result.stdout.splitlines():
        key, _, value = line.partition(":")
        if key.strip():
            values[key.strip()] = value.strip()
    if "ups.status" not in values:
        return None

    def number(key: str) -> float | None:
        try:
            return float(values[key])
        except (KeyError, ValueError):
            return None

    status = values["ups.status"]
    flags = set(status.split())
    return {
        "name": name,
        "status": status,
        "onBattery": "OB" in flags,
        "lowBattery": "LB" in flags,
        "model": values.get("device.model") or values.get("ups.model"),
        "manufacturer": values.get("device.mfr") or values.get("ups.mfr"),
        "charge": number("battery.charge"),
        "load": number("ups.load"),
        "runtime": number("battery.runtime"),
        "voltage": number("input.voltage"),
    }


# ------------------------------------------------------------------ probes

_ssl = ssl.create_default_context()
_ssl.check_hostname = False
_ssl.verify_mode = ssl.CERT_NONE


def probe(entry: dict) -> dict:
    url = entry.get("url")
    if not url:
        return {"slug": entry.get("slug"), "up": None, "error": "no url"}
    started = time.monotonic()
    request = urllib.request.Request(url, method="GET", headers={"User-Agent": "homelab-collector/1"})
    try:
        with urllib.request.urlopen(request, timeout=PROBE_TIMEOUT, context=_ssl) as response:
            elapsed = int((time.monotonic() - started) * 1000)
            return {"slug": entry["slug"], "up": response.status < 500, "status": response.status, "ms": elapsed}
    except urllib.error.HTTPError as error:
        elapsed = int((time.monotonic() - started) * 1000)
        # 401/403 mean the service is alive and asking for credentials.
        return {"slug": entry["slug"], "up": error.code < 500, "status": error.code, "ms": elapsed}
    except Exception as error:  # noqa: BLE001 - any failure means "not answering"
        return {"slug": entry["slug"], "up": False, "error": type(error).__name__}


def probe_exec(entry: dict) -> dict:
    """Run a check inside the guest, for services only reachable from there."""
    vmid = entry.get("vmid")
    command = entry.get("command")
    if vmid is None or not command:
        return {"slug": entry.get("slug"), "up": None, "error": "incomplete exec probe"}
    pct = shutil.which("pct")
    if not pct:
        return {"slug": entry.get("slug"), "up": None, "error": "pct not found"}

    started = time.monotonic()
    try:
        out = subprocess.run(
            [pct, "exec", str(vmid), "--", "sh", "-c", command],
            capture_output=True,
            text=True,
            timeout=PROBE_TIMEOUT + 3,
            check=False,
        )
        elapsed = int((time.monotonic() - started) * 1000)
        return {"slug": entry["slug"], "up": out.returncode == 0, "status": out.returncode, "ms": elapsed}
    except Exception as error:  # noqa: BLE001
        return {"slug": entry.get("slug"), "up": False, "error": type(error).__name__}


def probe_tcp(entry: dict) -> dict:
    """Plain connect test for services with no HTTP surface."""
    host = entry.get("host")
    port = entry.get("port")
    if not host or not port:
        return {"slug": entry.get("slug"), "up": None, "error": "incomplete tcp probe"}

    started = time.monotonic()
    try:
        with socket.create_connection((host, int(port)), timeout=PROBE_TIMEOUT):
            elapsed = int((time.monotonic() - started) * 1000)
            return {"slug": entry["slug"], "up": True, "ms": elapsed}
    except OSError as error:
        return {"slug": entry.get("slug"), "up": False, "error": type(error).__name__}


def run_probes(entries: list[dict], executor: ThreadPoolExecutor) -> list[dict]:
    if not entries:
        return []
    return list(executor.map(probe, entries))


# ------------------------------------------------------------------- state


class State:
    def __init__(self, config: dict):
        self.config = config
        self.site_title = (config.get("site") or {}).get("title") or "homelab"
        self.interface = config.get("interface") or default_interface()
        self.disks = config.get("disks") or ["/"]
        # NUT device name to sample; absent means UPS reporting is off.
        self.ups = (config.get("ups") or {}).get("name")
        self.probes = config.get("probes") or []
        self.probe_exec = config.get("probe_exec") or []
        self.tcp_probes = config.get("tcp_probes") or []
        self.machine_stats = config.get("machine_stats") or []
        self.connect = {item["slug"]: item for item in config.get("connect") or [] if item.get("slug")}
        # Served at "/" so a bare hostname opens something useful.
        self.root_connect = config.get("root_connect")
        self.disk_probes = {
            int(item["vmid"]): item for item in config.get("disk_probes") or [] if item.get("vmid") is not None
        }
        self.executor = ThreadPoolExecutor(max_workers=12)
        self._lock = threading.Lock()
        self._snapshot: dict | None = None
        self._building = False

    def current(self) -> dict | None:
        """The last completed sample. Requests never wait for collection."""
        with self._lock:
            return self._snapshot

    def refresh(self) -> None:
        """Build a sample off the request path and publish it."""
        if self._building:
            return
        self._building = True
        try:
            built = self.collect()
            with self._lock:
                self._snapshot = built
        finally:
            self._building = False

    def sampler_loop(self, interval: float) -> None:
        while True:
            try:
                self.refresh()
            except Exception as error:  # noqa: BLE001 - never let the thread die
                print(f"collector: sample failed: {error}", file=sys.stderr, flush=True)
            time.sleep(interval)

    def collect(self) -> dict:
        warnings: list[str] = []
        probes = run_probes(self.probes, self.executor)
        if self.probe_exec:
            probes += list(self.executor.map(probe_exec, self.probe_exec))
        if self.tcp_probes:
            probes += list(self.executor.map(probe_tcp, self.tcp_probes))
        snapshot = {
            "ts": int(time.time()),
            "host": host_stats(self.interface),
            "guests": guest_stats(warnings, self.disk_probes),
            "hosts": [sample for sample in (machine_stat(entry) for entry in self.machine_stats) if sample],
            "probes": probes,
            "disks": disk_stats(self.disks),
            "warnings": warnings,
        }
        # Present only when a NUT device is configured: null then means "asked
        # and got no answer", which is a state worth showing, while a missing
        # key means the dashboard has no UPS at all.
        if self.ups:
            snapshot["ups"] = ups_stats(self.ups)
        return snapshot


# ------------------------------------------------------------------ server


CONNECT_PAGE = """<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>{name} · connect</title>
<style>
  :root {{ color-scheme: dark; }}
  body {{ margin:0; min-height:100vh; display:grid; place-items:center;
         background:#0a0c0e; color:#e6edf3;
         font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Inter,system-ui,sans-serif; }}
  main {{ width:min(560px,90vw); }}
  .eyebrow {{ font-family:ui-monospace,monospace; font-size:11px; letter-spacing:.14em;
              text-transform:uppercase; color:#5a6772; }}
  h1 {{ margin:6px 0 4px; font-size:22px; letter-spacing:-.01em; }}
  p {{ color:#8b98a4; font-size:13.5px; line-height:1.55; }}
  pre {{ margin:16px 0 0; padding:14px 16px; background:#101418; border:1px solid #1c2329;
         border-radius:10px; overflow-x:auto; font-family:ui-monospace,monospace;
         font-size:12.5px; color:#e6edf3; }}
  code {{ color:#5eead4; }}
  .addr {{ margin-top:14px; font-family:ui-monospace,monospace; font-size:12px; color:#8b98a4; }}
  .tag {{ display:inline-block; margin-bottom:18px; padding:3px 9px; border:1px solid #28323a;
          border-radius:999px; font-family:ui-monospace,monospace; font-size:10.5px; color:#5a6772; }}
</style></head>
<body><main>
  <div class="eyebrow">{site} · connect</div>
  <h1>{name}</h1>
  <p>{description}</p>
  <div class="tag">{protocol} over cloudflare access</div>
  <div class="addr">target {address}</div>
  <pre>{command}</pre>
</main></body></html>
"""


class Handler(BaseHTTPRequestHandler):
    state: State
    server_version = "homelab-collector/1"

    def log_message(self, fmt: str, *args) -> None:  # keep the journal quiet
        return

    def send_json(self, payload: dict, status: int = 200) -> None:
        body = json.dumps(payload, separators=(",", ":")).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("cache-control", "no-store")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def send_connect(self, entry: dict, slug: str) -> None:
        page = CONNECT_PAGE.format(
            site=html.escape(self.state.site_title),
            name=html.escape(entry.get("name", slug)),
            description=html.escape(entry.get("description", "Connect with the client below.")),
            protocol=html.escape(entry.get("protocol", "tcp")),
            address=html.escape(entry.get("address", "")),
            command=html.escape(entry.get("command", "")),
        ).encode()
        self.send_response(200)
        self.send_header("content-type", "text/html; charset=utf-8")
        self.send_header("cache-control", "no-store")
        self.send_header("content-length", str(len(page)))
        self.end_headers()
        self.wfile.write(page)

    def do_GET(self) -> None:  # noqa: N802 - required by BaseHTTPRequestHandler
        path = self.path.split("?")[0].rstrip("/") or "/"

        if path == "/health":
            self.send_json({"ok": True})
            return

        if path == "/stats":
            try:
                sample = self.state.current()
                if sample is None:
                    # Nothing sampled yet (fresh start): build once, then serve.
                    self.state.refresh()
                    sample = self.state.current()
                self.send_json(sample or {"error": "no sample available"}, status=200 if sample else 503)
            except Exception as error:  # noqa: BLE001
                self.send_json({"error": f"{type(error).__name__}: {error}"}, status=500)
            return

        if path == "/":
            # One hostname per connect page (ubuntu.<apex>, mac.<apex>, …), so
            # pick by Host rather than always serving the default.
            host = (self.headers.get("Host") or "").split(":")[0].lower()
            slug = host.split(".")[0]
            if slug in self.state.connect:
                self.send_connect(self.state.connect[slug], slug)
                return
            if self.state.root_connect and self.state.root_connect in self.state.connect:
                entry = self.state.connect[self.state.root_connect]
                self.send_connect(entry, self.state.root_connect)
                return

        if path.startswith("/connect/"):
            slug = path.removeprefix("/connect/")
            entry = self.state.connect.get(slug)
            if not entry:
                self.send_json({"error": "unknown service", "slug": slug}, status=404)
                return
            self.send_connect(entry, slug)
            return

        self.send_json({"error": "not found"}, status=404)


def load_config() -> dict:
    try:
        return json.loads(read(CONFIG_PATH))
    except FileNotFoundError:
        print(f"collector: {CONFIG_PATH} missing, starting with an empty config", file=sys.stderr)
        return {}
    except json.JSONDecodeError as error:
        raise SystemExit(f"collector: {CONFIG_PATH} is not valid JSON: {error}")


def main() -> None:
    config = load_config()
    state = State(config)
    listen = config.get("listen") or {}
    host = listen.get("host", "0.0.0.0")
    port = int(listen.get("port", 9101))

    threading.Thread(target=sample_network, args=(state.interface,), daemon=True).start()
    # Collect on a fixed cadence so /stats answers from cache and a slow probe
    # cannot drag a request past the dashboard's timeout.
    threading.Thread(target=state.sampler_loop, args=(SAMPLE_INTERVAL_SECONDS,), daemon=True).start()

    Handler.state = state
    server = ThreadingHTTPServer((host, port), Handler)
    print(f"collector: listening on {host}:{port}, interface {state.interface}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
