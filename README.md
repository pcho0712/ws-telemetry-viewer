# Telemetry Viewer

Local telemetry arrival checker and visualizer.

Run one local process per host. The process receives UDP telemetry, serves the browser UI, and streams the latest packet to that UI.

```text
Telemetry source / Captury
  -> UDP host-ip:port
Local Telemetry Viewer
  -> http://127.0.0.1:8765
```

## Layout

```text
agent/
  server.py       UDP receiver and local web server
  config.json     Persistent listen settings
web/
  index.html
  app.js
  styles.css
  vendor/
```

## Run

```bash
python3 agent/server.py
```

Open:

```text
http://127.0.0.1:8765
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

## Send Test UDP

From the same host:

```bash
printf 'hello udp\n' | nc -u -w1 127.0.0.1 8888
```

From another LAN host, send to the `Send UDP to` address shown in the UI.

## Notes

- Browser-only pages cannot listen for UDP directly, so this app intentionally runs locally.
- Windows hosts may need a Windows Defender Firewall rule allowing inbound UDP on the configured port.
- The default UI follows only the latest packet. Enable `Record all` only when you want a running session log.
- `View: JSON` parses the latest payload and shows a `path / value` table.
- `View: 3D` renders Captury `joints.*.position` data as a simple 3D skeleton.
