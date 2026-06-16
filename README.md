# Network Ingress Viz

Browser-based arrival check and visualization tool for network telemetry entering a local machine.

The current local agent listens for UDP datagrams and exposes them to the browser in realtime.
The browser UI can show and change the UDP listen IP/port, show LAN send-target addresses, clear/copy the dump, autoscroll incoming text, and switch between raw and JSON views.
When JSON mode receives Captury pose data, the latest `joints.*.position` frame is rendered as a simple 3D skeleton.

The project direction is to keep the browser UI portable, including GitHub Pages hosting, while each host runs a small local agent for UDP/WS ingress.

## Run

```bash
python3 server.py
```

Open:

```text
http://127.0.0.1:8080
```

Startup defaults:

- UDP bind: `0.0.0.0:8888`
- Web UI: `127.0.0.1:8080`

The UDP bind address and port can also be changed from the browser while the server is running.
By default the UI follows only the latest received packet. Enable `Record all` when you explicitly want a running session log.

## Send a test packet

From another terminal:

```bash
printf 'hello udp\n' | nc -u -w1 127.0.0.1 8888
```

The same datagram is printed as a short server-terminal summary and pushed to the browser.

## Options

```bash
python3 server.py --udp-host 0.0.0.0 --udp-port 8888 --http-host 127.0.0.1 --http-port 8080
```
