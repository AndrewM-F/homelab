#!/usr/bin/env python3
"""
homelab stats collector.

Runs on the Proxmox host and answers three things over plain HTTP:

  GET /health          -> {"ok": true}
  GET /stats           -> host + guest resource sample, service probes
  GET /connect/<slug>  -> a small page for services that are not HTTP

It is never exposed directly to the internet: the Cloudflare Tunnel publishes
it on one hostname, and Cloudflare Access sits in front of that hostname.

Config: /etc/homelab-collector.json

    {
      "listen": {"host": "0.0.0.0", "port": 9101},
      "interface": "vmbr0",
      "disks": ["/"],
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
_ssh_cache: dict[int, tuple[float, tuple[int, int, str] | None]] = {}

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


def memory() -> tuple[int, int, int, int]:
    info: dict[str, int] = {}
    for line in read("/proc/meminfo").splitlines():
        key, _, rest = line.partition(":")
        try:
            info[key] = int(rest.strip().split()[0]) * 1024
        except (IndexError, ValueError):
            continue
    total = info.get("MemTotal", 0)
    available = info.get("MemAvailable", info.get("MemFree", 0))
    swap_total = info.get("SwapTotal", 0)
    swap_free = info.get("SwapFree", 0)
    return total - available, total, swap_total - swap_free, swap_total


def uptime() -> int:
    try:
        return int(float(read("/proc/uptime").split()[0]))
    except (OSError, IndexError, ValueError):
        return 0


def host_stats(interface: str) -> dict:
    cores = os.cpu_count() or 1
    try:
        load = os.getloadavg()
    except OSError:
        load = (0.0, 0.0, 0.0)
    used, total, swap_used, swap_total = memory()
    net = network()
    return {
        "name": os.uname().nodename,
        "cores": cores,
        "load": [round(load[0], 2), round(load[1], 2), round(load[2], 2)],
        "cpu": round(min(1.0, load[0] / cores), 4),
        "memUsed": used,
        "memTotal": total,
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
                for entry in entries or []:
                    total = int(entry.get("total-bytes") or 0)
                    if total <= 0:
                        continue
                    mount = str(entry.get("mountpoint", ""))
                    used = int(entry.get("used-bytes") or 0)
                    # Prefer the root filesystem; otherwise the largest one, which
                    # skips Windows' recovery and EFI partitions.
                    if mount in ("/", "C:\\", "C:/"):
                        found = (used, total, mount)
                        break
                    if found is None or total > found[1]:
                        found = (used, total, mount)
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

        guests.append(
            {
                "vmid": vmid,
                "type": kind,
                "status": item.get("status", "unknown"),
                "cpu": round(float(item.get("cpu") or 0), 4),
                "maxcpu": int(item.get("maxcpu") or 0),
                "mem": int(item.get("mem") or 0),
                "maxmem": int(item.get("maxmem") or 0),
                "disk": used,
                "maxdisk": total,
                "diskAllocated": allocated,
                "diskSource": source,
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


def run_probes(entries: list[dict], executor: ThreadPoolExecutor) -> list[dict]:
    if not entries:
        return []
    return list(executor.map(probe, entries))


# ------------------------------------------------------------------- state


class State:
    def __init__(self, config: dict):
        self.config = config
        self.interface = config.get("interface") or default_interface()
        self.disks = config.get("disks") or ["/"]
        self.probes = config.get("probes") or []
        self.connect = {item["slug"]: item for item in config.get("connect") or [] if item.get("slug")}
        # Served at "/" so a bare hostname opens something useful.
        self.root_connect = config.get("root_connect")
        self.disk_probes = {
            int(item["vmid"]): item for item in config.get("disk_probes") or [] if item.get("vmid") is not None
        }
        self.executor = ThreadPoolExecutor(max_workers=12)

    def snapshot(self) -> dict:
        warnings: list[str] = []
        probes = run_probes(self.probes, self.executor)
        return {
            "ts": int(time.time()),
            "host": host_stats(self.interface),
            "guests": guest_stats(warnings, self.disk_probes),
            "probes": probes,
            "disks": disk_stats(self.disks),
            "warnings": warnings,
        }


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
  <div class="eyebrow">homelab · connect</div>
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
                self.send_json(self.state.snapshot())
            except Exception as error:  # noqa: BLE001
                self.send_json({"error": f"{type(error).__name__}: {error}"}, status=500)
            return

        if path == "/" and self.state.root_connect:
            entry = self.state.connect.get(self.state.root_connect)
            if entry:
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

    Handler.state = state
    server = ThreadingHTTPServer((host, port), Handler)
    print(f"collector: listening on {host}:{port}, interface {state.interface}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
