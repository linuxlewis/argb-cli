import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { ArgbDevice } from "../transports/types.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export async function loadMockDevices(path = resolve(REPO_ROOT, "harness/devices.mock.json")): Promise<readonly ArgbDevice[]> {
  const content = await readFile(path, "utf8");
  const devices = JSON.parse(content) as ArgbDevice[];

  validateDevices(devices);
  return devices;
}

function validateDevices(devices: readonly ArgbDevice[]): void {
  const seen = new Set<string>();

  for (const device of devices) {
    if (!device.id || seen.has(device.id)) {
      throw new Error(`Invalid or duplicate device id "${device.id}".`);
    }

    if (device.ledCount <= 0 || device.channels <= 0) {
      throw new Error(`Device "${device.id}" must have positive ledCount and channels.`);
    }

    seen.add(device.id);
  }
}
