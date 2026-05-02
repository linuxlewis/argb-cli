# argb-cli

TypeScript CLI for discovering, inspecting, and controlling ARGB devices. The project starts with a deterministic mock/file harness so agents and contributors can build command workflows before real hardware transports are added.

## Quick Start

```bash
npm install
npm run verify
npm run dev -- list
npm run dev -- set motherboard-zone --color '#00aaff' --brightness 65
npm run dev -- run-plan harness/plans/boot-glow.json
npm run web
```

## CLI Shape

```bash
argb list [--json]
argb show <device-id> [--json]
argb set <device-id> --color <hex> [--brightness <0-100>] [--json]
argb effect <device-id> --name <static|breathing|rainbow|wave|fire|off> [--color <hex>] [--brightness <0-100>] [--speed <1-10>] [--json]
argb off <device-id> [--json]
argb run-plan <plan.json> [--json]
argb doctor [--json]
argb web [--host <host>] [--port <port>]
```

By default the CLI uses the in-memory mock transport. Use `--transport file --state .argb-state.json` to persist simulated device state between commands:

```bash
npm run dev -- --transport file --state .argb-state.json set motherboard-zone --color '#ff5500'
npm run dev -- --transport file --state .argb-state.json show motherboard-zone
```

## Web Visualizer

Start the local web interface to preview configured mock/file-harness devices:

```bash
npm run web
```

The visualizer listens on `0.0.0.0:4173` by default so it can be reached from another machine on the same network, subject to your OS firewall. Open `http://localhost:4173` locally or `http://<host-ip>:4173` remotely. It uses the same transport options as the CLI. Use the file transport to keep simulated state between CLI and browser sessions:

```bash
npm run dev -- --transport file --state .argb-state.json web
```

The browser UI can apply colors/effects directly and can run harness plan JSON. For a CPU-ring fire preview, apply the included Eye of Sauron plan before starting the file-backed web server:

```bash
npm run dev -- --transport file --state .argb-state.json run-plan harness/plans/eye-of-sauron.json
npm run dev -- --transport file --state .argb-state.json web
```

The web server is implemented with Node's cross-platform HTTP and path APIs, so it does not depend on Unix-only shell features. It runs on Windows and Linux anywhere the project engine requirement, Node.js 22 or newer, is available.

## Agent Harness

The harness is intentionally fixture-driven:

- `harness/devices.mock.json` defines predictable ARGB devices.
- `harness/plans/*.json` defines command plans an agent can execute and verify.
- `harness/plans/eye-of-sauron.json` demonstrates the preview-only `fire` effect on a CPU fan RGB ring.
- `npm run verify` is the main quality gate: typecheck, tests, and production build.

Plans use this shape:

```json
{
  "version": 1,
  "steps": [
    { "command": "set", "deviceId": "motherboard-zone", "color": "#00aaff", "brightness": 65 },
    { "command": "effect", "deviceId": "gpu-strip", "effect": "rainbow", "speed": 4 },
    { "command": "assert", "deviceId": "gpu-strip", "effect": "rainbow" }
  ]
}
```

## Hardware Transport Roadmap

Real ARGB hardware differs by vendor and bus. The transport boundary in `src/transports/types.ts` is where USB HID, serial, OpenRGB, or vendor SDK integrations should attach. Keep hardware-specific code behind that interface so command parsing, plans, and tests remain deterministic.
