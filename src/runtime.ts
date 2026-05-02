import { resolve } from "node:path";

import { loadMockDevices } from "./harness/fixtures.js";
import { createFileTransport } from "./transports/file.js";
import { MockArgbTransport } from "./transports/mock.js";
import type { ArgbTransport } from "./transports/types.js";

export interface RuntimeOptions {
  readonly transport: "mock" | "file";
  readonly state?: string;
}

export async function createTransport(options: RuntimeOptions): Promise<ArgbTransport> {
  const devices = await loadMockDevices();

  if (options.transport === "mock") {
    return new MockArgbTransport(devices);
  }

  return createFileTransport(resolve(options.state ?? ".argb-state.json"), devices);
}
