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


def guest_stats(warnings: list[str]) -> list[dict]:
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
        guests.append(
            {
                "vmid": item.get("vmid"),
                "type": kind,
                "status": item.get("status", "unknown"),
                "cpu": round(float(item.get("cpu") or 0), 4),
                "maxcpu": int(item.get("maxcpu") or 0),
                "mem": int(item.get("mem") or 0),
                "maxmem": int(item.get("maxmem") or 0),
                "disk": int(item.get("disk") or 0),
                "maxdisk": int(item.get("maxdisk") or 0),
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
        self.executor = ThreadPoolExecutor(max_workers=12)

    def snapshot(self) -> dict:
        warnings: list[str] = []
        probes = run_probes(self.probes, self.executor)
        return {
            "ts": int(time.time()),
            "host": host_stats(self.interface),
            "guests": guest_stats(warnings),
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
