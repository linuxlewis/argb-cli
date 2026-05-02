import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { loadMockDevices } from "../harness/fixtures.js";
import { MockArgbTransport } from "./mock.js";
import type { ArgbDevice, PersistedHarnessState } from "./types.js";

export async function createFileTransport(statePath: string, fallbackDevices?: readonly ArgbDevice[]): Promise<MockArgbTransport> {
  const persisted = await readPersistedState(statePath);
  const devices = persisted?.devices ?? fallbackDevices ?? (await loadMockDevices());
  const states = persisted?.states;

  return new MockArgbTransport(devices, states, async (state) => {
    await mkdir(dirname(statePath), { recursive: true });
    await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  });
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
