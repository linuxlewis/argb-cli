# argb-cli

TypeScript CLI for discovering, inspecting, and controlling ARGB devices. The project starts with a deterministic mock/file harness so agents and contributors can build command workflows before real hardware transports are added.

## Quick Start

```bash
npm install
npm run verify
npm run dev -- list
npm run dev -- set motherboard-zone --color '#00aaff' --brightness 65
npm run dev -- run-plan harness/plans/boot-glow.json
```

## CLI Shape

```bash
argb list [--json]
argb show <device-id> [--json]
argb set <device-id> --color <hex> [--brightness <0-100>] [--json]
argb effect <device-id> --name <static|breathing|rainbow|wave|off> [--color <hex>] [--brightness <0-100>] [--speed <1-10>] [--json]
argb off <device-id> [--json]
argb run-plan <plan.json> [--json]
argb doctor [--json]
```

By default the CLI uses the in-memory mock transport. Use `--transport file --state .argb-state.json` to persist simulated device state between commands:

```bash
npm run dev -- --transport file --state .argb-state.json set motherboard-zone --color '#ff5500'
npm run dev -- --transport file --state .argb-state.json show motherboard-zone
```

## Agent Harness

The harness is intentionally fixture-driven:

- `harness/devices.mock.json` defines predictable ARGB devices.
- `harness/plans/*.json` defines command plans an agent can execute and verify.
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
