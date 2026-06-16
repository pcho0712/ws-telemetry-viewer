# Telemetry Viewer

Browser telemetry arrival checker and visualizer.

The web UI is static and can be hosted on GitHub Pages. A small local agent runs on each host that needs to receive UDP telemetry, then exposes localhost HTTP/SSE APIs for the browser UI.

```text
Telemetry source / Captury
  -> UDP host-ip:port
Local Agent
  -> http://localhost:8765
GitHub Pages or local browser UI
```

## Layout

```text
agent/
  server.py       Local UDP receiver and browser API
  config.json     Persistent agent settings
web/
  index.html      GitHub Pages UI
  app.js
  styles.css
  vendor/
```

## Run Local Agent

```bash
python3 agent/server.py
```

Defaults are stored in `agent/config.json`:

```json
{
  "udp": {
    "host": "0.0.0.0",
    "port": 8888
  },
  "http": {
    "host": "127.0.0.1",
    "port": 8765
  }
}
```

The browser can change the UDP listen host/port. Changes are saved back to `agent/config.json` and applied immediately by rebinding the UDP socket.

## Open UI

Local fallback UI:

```text
http://localhost:8765
```

GitHub Pages UI uses the same `web/` files and connects to:

```text
http://localhost:8765
```

If needed, change the Local Agent URL in the UI.

## Send Test UDP

From the same host:

```bash
printf 'hello udp\n' | nc -u -w1 127.0.0.1 8888
```

From another LAN host, send to the `Send UDP to` address shown in the UI.

## GitHub Pages

This repository includes a GitHub Actions workflow that deploys `web/` to GitHub Pages.

Repository setup:

1. Push this repo to GitHub.
2. In GitHub, open `Settings -> Pages`.
3. Set `Build and deployment` source to `GitHub Actions`.
4. Push to `main`.

## Notes

- Browser-only pages cannot listen for UDP directly.
- UDP receive is handled by the local agent.
- Windows hosts may need a Windows Defender Firewall rule allowing inbound UDP on the configured port.
- The default UI follows only the latest packet. Enable `Record all` only when you want a running session log.
- JSON mode parses the latest payload and renders Captury `joints.*.position` data as a simple 3D skeleton.
