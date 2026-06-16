#!/usr/bin/env python3
import argparse
import ipaddress
import json
import queue
import socket
import threading
from datetime import datetime, timezone
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
WEB_ROOT = ROOT / "web"
CONFIG_PATH = Path(__file__).resolve().parent / "config.json"
DEFAULT_CONFIG = {
    "udp": {
        "host": "0.0.0.0",
        "port": 8888,
    },
    "http": {
        "host": "127.0.0.1",
        "port": 8765,
    },
}
CLIENTS: set[queue.Queue[dict[str, Any]]] = set()
CLIENTS_LOCK = threading.Lock()
RECENT: list[dict[str, Any]] = []
RECENT_LIMIT = 200
DUMP_LOCK = threading.Lock()
RECORD_ALL = False
RECORDING_LOCK = threading.Lock()
PACKET_COUNT = 0
PACKET_COUNT_LOCK = threading.Lock()


class UdpService:
    def __init__(self, host: str, port: int) -> None:
        self.host = host
        self.port = port
        self.status = "starting"
        self.error = ""
        self._sock: socket.socket | None = None
        self._lock = threading.Lock()
        self._changed = threading.Event()
        self._stopped = threading.Event()

    def config(self) -> dict[str, Any]:
        with self._lock:
            return {
                "host": self.host,
                "port": self.port,
                "status": self.status,
                "error": self.error,
            }

    def update(self, host: str, port: int) -> dict[str, Any]:
        with self._lock:
            self.host = host
            self.port = port
            self.status = "restarting"
            self.error = ""
            if self._sock:
                self._sock.close()
        self._changed.set()
        return self.config()

    def run(self) -> None:
        while not self._stopped.is_set():
            self._changed.clear()
            config = self.config()
            sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            sock.settimeout(0.5)

            try:
                sock.bind((config["host"], config["port"]))
            except OSError as exc:
                with self._lock:
                    self.status = "error"
                    self.error = str(exc)
                    self._sock = None
                print(f"UDP bind failed on {config['host']}:{config['port']}: {exc}", flush=True)
                self._changed.wait(1)
                continue

            with self._lock:
                self._sock = sock
                self.status = "listening"
                self.error = ""
            print(f"UDP listening on {config['host']}:{config['port']}", flush=True)

            while not self._changed.is_set() and not self._stopped.is_set():
                try:
                    data, addr = sock.recvfrom(65535)
                except socket.timeout:
                    continue
                except OSError:
                    break
                event = event_payload(data, addr)
                log_packet_summary(event)
                publish(event)

            sock.close()


UDP_SERVICE: UdpService | None = None


def log_packet_summary(event: dict[str, Any]) -> None:
    global PACKET_COUNT

    with PACKET_COUNT_LOCK:
        PACKET_COUNT += 1
        count = PACKET_COUNT

    if count == 1 or count % 100 == 0:
        print(
            f"[{event['time']}] received {count} packets, latest {event['source']} {event['bytes']}B",
            flush=True,
        )


def load_config() -> dict[str, Any]:
    config = json.loads(json.dumps(DEFAULT_CONFIG))
    if CONFIG_PATH.exists():
        with CONFIG_PATH.open("r", encoding="utf-8") as file:
            loaded = json.load(file)
        for section, values in loaded.items():
            if isinstance(values, dict) and isinstance(config.get(section), dict):
                config[section].update(values)
    return config


def save_config(config: dict[str, Any]) -> None:
    CONFIG_PATH.write_text(json.dumps(config, indent=2) + "\n", encoding="utf-8")


def update_config_file(section: str, values: dict[str, Any]) -> None:
    config = load_config()
    config.setdefault(section, {}).update(values)
    save_config(config)


def local_ipv4_addresses() -> list[str]:
    addresses: set[str] = set()
    hostname = socket.gethostname()

    for name in {hostname, socket.getfqdn(), "localhost"}:
        try:
            infos = socket.getaddrinfo(name, None, socket.AF_INET, socket.SOCK_DGRAM)
        except socket.gaierror:
            continue
        for info in infos:
            address = info[4][0]
            if not ipaddress.ip_address(address).is_loopback:
                addresses.add(address)

    return sorted(addresses)


def route_ipv4_probe() -> str:
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        sock.connect(("8.8.8.8", 80))
        return sock.getsockname()[0]
    except OSError:
        return ""
    finally:
        sock.close()


def network_info() -> dict[str, Any]:
    route_address = route_ipv4_probe()
    addresses = local_ipv4_addresses()
    if route_address and route_address not in addresses and route_address != "127.0.0.1":
        addresses.insert(0, route_address)

    config = UDP_SERVICE.config() if UDP_SERVICE is not None else {"port": 8888}
    port = config.get("port", 8888)
    targets = [f"{address}:{port}" for address in addresses]

    return {
        "hostname": socket.gethostname(),
        "primary": route_address,
        "addresses": addresses,
        "targets": targets,
    }


def recording_state() -> dict[str, Any]:
    with RECORDING_LOCK:
        record_all = RECORD_ALL
    return {"recordAll": record_all, "bufferLimit": RECENT_LIMIT}


def now_iso() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="milliseconds")


def event_payload(data: bytes, addr: tuple[str, int]) -> dict[str, Any]:
    text = data.decode("utf-8", errors="replace")
    return {
        "time": now_iso(),
        "source": f"{addr[0]}:{addr[1]}",
        "bytes": len(data),
        "text": text,
    }


def publish(event: dict[str, Any]) -> None:
    with RECORDING_LOCK:
        record_all = RECORD_ALL

    with DUMP_LOCK:
        if record_all:
            RECENT.append(event)
            if len(RECENT) > RECENT_LIMIT:
                del RECENT[: len(RECENT) - RECENT_LIMIT]
        else:
            RECENT[:] = [event]

    with CLIENTS_LOCK:
        clients = list(CLIENTS)

    for client in clients:
        try:
            client.put_nowait(event)
        except queue.Full:
            with CLIENTS_LOCK:
                CLIENTS.discard(client)


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, directory=str(WEB_ROOT), **kwargs)

    def log_message(self, format: str, *args: Any) -> None:
        return

    def do_GET(self) -> None:
        if self.path == "/events":
            self.stream_events()
            return
        if self.path == "/api/recent":
            with DUMP_LOCK:
                recent = list(RECENT)
            self.send_json(recent)
            return
        if self.path == "/api/config":
            self.send_json(self.current_config())
            return
        if self.path == "/api/network":
            self.send_json(network_info())
            return
        if self.path == "/api/recording":
            self.send_json(recording_state())
            return
        super().do_GET()

    def do_OPTIONS(self) -> None:
        self.send_response(HTTPStatus.NO_CONTENT)
        self.end_headers()

    def do_POST(self) -> None:
        if self.path == "/api/config":
            self.update_config()
            return
        if self.path == "/api/clear":
            with DUMP_LOCK:
                RECENT.clear()
            self.send_json({"ok": True})
            return
        if self.path == "/api/recording":
            self.update_recording()
            return
        self.send_error(HTTPStatus.NOT_FOUND)

    def read_json(self) -> dict[str, Any]:
        length = int(self.headers.get("Content-Length", "0"))
        body = self.rfile.read(length)
        return json.loads(body.decode("utf-8")) if body else {}

    def current_config(self) -> dict[str, Any]:
        if UDP_SERVICE is None:
            return {"host": "", "port": 0, "status": "stopped", "error": ""}
        return UDP_SERVICE.config()

    def update_config(self) -> None:
        if UDP_SERVICE is None:
            self.send_error(HTTPStatus.SERVICE_UNAVAILABLE)
            return

        try:
            payload = self.read_json()
            host = str(payload.get("host", "")).strip() or "0.0.0.0"
            port = int(payload.get("port", 8888))
            if port < 1 or port > 65535:
                raise ValueError("port must be 1-65535")
        except (TypeError, ValueError, json.JSONDecodeError) as exc:
            self.send_json({"error": str(exc)}, HTTPStatus.BAD_REQUEST)
            return

        update_config_file("udp", {"host": host, "port": port})
        self.send_json(UDP_SERVICE.update(host, port))

    def update_recording(self) -> None:
        global RECORD_ALL

        try:
            payload = self.read_json()
            enabled = bool(payload.get("recordAll", False))
        except json.JSONDecodeError as exc:
            self.send_json({"error": str(exc)}, HTTPStatus.BAD_REQUEST)
            return

        with RECORDING_LOCK:
            RECORD_ALL = enabled
        with DUMP_LOCK:
            if not enabled and len(RECENT) > 1:
                RECENT[:] = RECENT[-1:]
        self.send_json(recording_state())

    def end_headers(self) -> None:
        self.send_cors_headers()
        super().end_headers()

    def send_cors_headers(self) -> None:
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Private-Network", "true")

    def send_json(self, payload: Any, status: HTTPStatus = HTTPStatus.OK) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def stream_events(self) -> None:
        client: queue.Queue[dict[str, Any]] = queue.Queue(maxsize=500)
        with CLIENTS_LOCK:
            CLIENTS.add(client)

        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "keep-alive")
        self.end_headers()

        try:
            self.wfile.write(b": connected\n\n")
            self.wfile.flush()
            while True:
                try:
                    event = client.get(timeout=15)
                    body = json.dumps(event, ensure_ascii=False)
                    self.wfile.write(f"data: {body}\n\n".encode("utf-8"))
                except queue.Empty:
                    self.wfile.write(b": keepalive\n\n")
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            pass
        finally:
            with CLIENTS_LOCK:
                CLIENTS.discard(client)


def main() -> None:
    global UDP_SERVICE

    parser = argparse.ArgumentParser(description="Telemetry Viewer local agent.")
    config = load_config()

    parser.add_argument("--udp-host", default=None)
    parser.add_argument("--udp-port", type=int, default=None)
    parser.add_argument("--http-host", default=None)
    parser.add_argument("--http-port", type=int, default=None)
    args = parser.parse_args()

    udp_host = args.udp_host or config["udp"]["host"]
    udp_port = args.udp_port or int(config["udp"]["port"])
    http_host = args.http_host or config["http"]["host"]
    http_port = args.http_port or int(config["http"]["port"])

    UDP_SERVICE = UdpService(udp_host, udp_port)
    thread = threading.Thread(target=UDP_SERVICE.run, daemon=True)
    thread.start()

    server = ThreadingHTTPServer((http_host, http_port), Handler)
    print(f"Local agent on http://{http_host}:{http_port}", flush=True)
    print(f"Local fallback UI on http://{http_host}:{http_port}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping.", flush=True)
        server.shutdown()


if __name__ == "__main__":
    main()
