import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createFileTransport } from "../src/transports/file.js";
import type { ArgbDevice, PersistedHarnessState } from "../src/transports/types.js";

const oldDevice: ArgbDevice = {
  id: "old-device",
  name: "Old Device",
  vendor: "Harness",
  product: "Mock",
  ledCount: 8,
  channels: 1,
  supports: ["static", "off"]
};

const newDevice: ArgbDevice = {
  id: "new-device",
  name: "New Device",
  vendor: "Harness",
  product: "Mock",
  ledCount: 12,
  channels: 1,
  supports: ["static", "fire", "off"]
};

describe("createFileTransport", () => {
  it("adds new fallback devices to existing persisted harness state", async () => {
    const directory = await mkdtemp(join(tmpdir(), "argb-cli-"));
    const statePath = join(directory, "state.json");

    try {
      const state: PersistedHarnessState = {
        devices: [oldDevice],
        states: [
          {
            deviceId: "old-device",
            power: true,
            brightness: 50,
            color: { red: 255, green: 0, blue: 0 },
            effect: "static"
          }
        ]
      };

      await writeFile(statePath, `${JSON.stringify(state)}\n`, "utf8");
      const transport = await createFileTransport(statePath, [oldDevice, newDevice]);

      await expect(transport.listDevices()).resolves.toEqual([oldDevice, newDevice]);
      await expect(transport.getState("new-device")).resolves.toMatchObject({
        deviceId: "new-device",
        power: false,
        effect: "off"
      });
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
});
