import { describe, expect, it } from "vitest";

import { MockArgbTransport } from "../src/transports/mock.js";
import type { ArgbDevice } from "../src/transports/types.js";
import { startWebServer } from "../src/web/server.js";

const devices: readonly ArgbDevice[] = [
  {
    id: "web-device",
    name: "Web Device",
    vendor: "Harness",
    product: "Mock",
    ledCount: 16,
    channels: 1,
    supports: ["static", "rainbow", "off"]
  }
];

describe("web visualizer server", () => {
  it("serves the browser app and device snapshot", async () => {
    const app = await startWebServer(new MockArgbTransport(devices), { host: "127.0.0.1", port: 0 });

    try {
      const html = await fetchText(`${app.url}/`);
      const snapshot = await fetchJson(`${app.url}/api/snapshot`);

      expect(html).toContain("ARGB Visualizer");
      expect(snapshot).toMatchObject({
        devices: [{ id: "web-device", ledCount: 16 }],
        states: [{ deviceId: "web-device", effect: "off", power: false }]
      });
    } finally {
      await app.close();
    }
  });

  it("applies control commands through the transport API", async () => {
    const app = await startWebServer(new MockArgbTransport(devices), { host: "127.0.0.1", port: 0 });

    try {
      const setResult = await postJson(`${app.url}/api/devices/web-device/set`, {
        color: "#336699",
        brightness: 45
      });
      const effectResult = await postJson(`${app.url}/api/devices/web-device/effect`, {
        effect: "rainbow",
        speed: 5
      });

      expect(setResult).toMatchObject({
        state: { deviceId: "web-device", effect: "static", brightness: 45, power: true }
      });
      expect(effectResult).toMatchObject({
        state: { deviceId: "web-device", effect: "rainbow", speed: 5, power: true }
      });
    } finally {
      await app.close();
    }
  });

  it("runs harness plans and returns updated preview state", async () => {
    const app = await startWebServer(new MockArgbTransport(devices), { host: "127.0.0.1", port: 0 });

    try {
      const result = await postJson<PlanRunResponse>(`${app.url}/api/plans/run`, {
        version: 1,
        steps: [
          { command: "set", deviceId: "web-device", color: "#00aaff", brightness: 70 },
          { command: "assert", deviceId: "web-device", effect: "static", power: true }
        ]
      });

      expect(result.events).toHaveLength(2);
      expect(result.snapshot.states).toMatchObject([{ deviceId: "web-device", brightness: 70, effect: "static" }]);
    } finally {
      await app.close();
    }
  });
});

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url);
  expect(response.ok).toBe(true);
  return response.text();
}

interface PlanRunResponse {
  readonly events: readonly unknown[];
  readonly snapshot: {
    readonly states: readonly unknown[];
  };
}

async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url);
  expect(response.ok).toBe(true);
  return response.json();
}

async function postJson<T = unknown>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  expect(response.ok).toBe(true);
  return response.json() as Promise<T>;
}
