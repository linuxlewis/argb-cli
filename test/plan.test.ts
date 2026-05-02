import { describe, expect, it } from "vitest";

import { executePlan, parsePlan } from "../src/harness/plan.js";
import { MockArgbTransport } from "../src/transports/mock.js";
import type { ArgbDevice } from "../src/transports/types.js";

const devices: readonly ArgbDevice[] = [
  {
    id: "plan-device",
    name: "Plan Device",
    vendor: "Harness",
    product: "Mock",
    ledCount: 18,
    channels: 1,
    supports: ["static", "breathing", "off"]
  }
];

describe("agent plan harness", () => {
  it("executes fixture-like plans and assertion steps", async () => {
    const plan = parsePlan({
      version: 1,
      steps: [
        { command: "set", deviceId: "plan-device", color: "#336699", brightness: 40 },
        { command: "assert", deviceId: "plan-device", color: "#336699", brightness: 40, effect: "static", power: true },
        { command: "off", deviceId: "plan-device" },
        { command: "assert", deviceId: "plan-device", effect: "off", power: false }
      ]
    });

    const events = await executePlan(new MockArgbTransport(devices), plan);

    expect(events).toHaveLength(4);
    expect(events.at(-1)).toMatchObject({ command: "assert" });
  });

  it("rejects invalid plan shape", () => {
    expect(() => parsePlan({ version: 2, steps: [] })).toThrow(/Invalid plan/);
    expect(() => parsePlan({ version: 1, steps: [{ command: "wait", ms: -1 }] })).toThrow(/Invalid wait/);
  });
});
