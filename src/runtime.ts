import { resolve } from "node:path";

import { loadMockDevices } from "./harness/fixtures.js";
import { createFileTransport } from "./transports/file.js";
import { MockArgbTransport } from "./transports/mock.js";
import { OpenRgbTransport } from "./transports/openrgb.js";
import type { ArgbTransport } from "./transports/types.js";

export interface RuntimeOptions {
  readonly transport: "mock" | "file" | "openrgb";
  readonly state?: string;
  readonly openrgbHost?: string;
  readonly openrgbPort?: number;
  readonly openrgbName?: string;
}

export async function createTransport(options: RuntimeOptions): Promise<ArgbTransport> {
  if (options.transport === "openrgb") {
    return new OpenRgbTransport(withOptional({}, {
      host: options.openrgbHost,
      port: options.openrgbPort,
      name: options.openrgbName
    }));
  }

  const devices = await loadMockDevices();

  if (options.transport === "mock") {
    return new MockArgbTransport(devices);
  }

  return createFileTransport(resolve(options.state ?? ".argb-state.json"), devices);
}

type DefinedOptional<T extends object> = {
  [K in keyof T]?: Exclude<T[K], undefined>;
};

function withOptional<T extends object, U extends object>(required: T, optional: U): T & DefinedOptional<U> {
  const entries = Object.entries(optional).filter(([, value]) => value !== undefined);
  return {
    ...required,
    ...Object.fromEntries(entries)
  } as T & DefinedOptional<U>;
}
