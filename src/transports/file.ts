import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { loadMockDevices } from "../harness/fixtures.js";
import { MockArgbTransport } from "./mock.js";
import type { ArgbDevice, PersistedHarnessState } from "./types.js";

export async function createFileTransport(statePath: string, fallbackDevices?: readonly ArgbDevice[]): Promise<MockArgbTransport> {
  const persisted = await readPersistedState(statePath);
  const fallback = fallbackDevices ?? (await loadMockDevices());
  const devices = persisted ? mergeDevices(persisted.devices, fallback) : fallback;
  const states = persisted?.states;

  return new MockArgbTransport(devices, states, async (state) => {
    await mkdir(dirname(statePath), { recursive: true });
    await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  });
}

function mergeDevices(
  persistedDevices: readonly ArgbDevice[],
  fallbackDevices: readonly ArgbDevice[]
): readonly ArgbDevice[] {
  const devices = new Map(persistedDevices.map((device) => [device.id, device]));

  for (const device of fallbackDevices) {
    if (!devices.has(device.id)) {
      devices.set(device.id, device);
    }
  }

  return [...devices.values()];
}

async function readPersistedState(statePath: string): Promise<PersistedHarnessState | undefined> {
  try {
    const content = await readFile(statePath, "utf8");
    return JSON.parse(content) as PersistedHarnessState;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return undefined;
    }

    throw error;
  }
}
