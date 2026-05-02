import { describe, expect, it } from "vitest";

import { MockArgbTransport } from "../src/transports/mock.js";
import type { ArgbDevice } from "../src/transports/types.js";

const devices: readonly ArgbDevice[] = [
  {
    id: "test-device",
    name: "Test Device",
    vendor: "Harness",
    product: "Mock",
    ledCount: 12,
    channels: 1,
    supports: ["static", "rainbow", "off"]
  }
];

describe("MockArgbTransport", () => {
  it("updates device state with set, effect, and off commands", async () => {
    const transport = new MockArgbTransport(devices);

    await expect(transport.listDevices()).resolves.toHaveLength(1);
    await expect(transport.apply({
      type: "set",
      deviceId: "test-device",
      color: { red: 255, green: 85, blue: 0 },
      brightness: 75
    })).resolves.toMatchObject({
      power: true,
      effect: "static",
      brightness: 75
    });

    await expect(transport.apply({
      type: "effect",
      deviceId: "test-device",
      effect: "rainbow",
      speed: 3
    })).resolves.toMatchObject({
      power: true,
      effect: "rainbow",
      speed: 3
    });

    await expect(transport.apply({ type: "off", deviceId: "test-device" })).resolves.toMatchObject({
      power: false,
      effect: "off"
    });
  });

  it("rejects unsupported effects", async () => {
    const transport = new MockArgbTransport(devices);

    await expect(transport.apply({
      type: "effect",
      deviceId: "test-device",
      effect: "wave"
    })).rejects.toThrow(/does not support/);
  });
});
