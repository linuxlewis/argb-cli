#!/usr/bin/env node
import { resolve } from "node:path";
import { Command } from "commander";

import { parseHexColor } from "./core/color.js";
import { parseBrightness, parseEffect, parseSpeed } from "./core/effects.js";
import { executePlan, loadPlan } from "./harness/plan.js";
import { createTransport } from "./runtime.js";
import type { ArgbTransport, DeviceState } from "./transports/types.js";

interface GlobalOptions {
  readonly transport: "mock" | "file";
  readonly state?: string;
}

interface JsonOption {
  readonly json?: boolean;
}

const program = new Command();

program
  .name("argb")
  .description("Control ARGB devices through a harness-friendly TypeScript CLI.")
  .version("0.1.0")
  .option("--transport <transport>", "transport to use: mock or file", "mock")
  .option("--state <path>", "state file for --transport file");

program
  .command("list")
  .description("List available ARGB devices.")
  .option("--json", "print JSON")
  .action(withTransport(async (transport, options: JsonOption) => {
    const devices = await transport.listDevices();
    print(options.json, devices, devices.map((device) => `${device.id}\t${device.name}\t${device.ledCount} LEDs`).join("\n"));
  }));

program
  .command("show")
  .description("Show current state for an ARGB device.")
  .argument("<device-id>")
  .option("--json", "print JSON")
  .action(withTransport(async (transport, deviceId: string, options: JsonOption) => {
    const state = await transport.getState(deviceId);
    print(options.json, state, formatState(state));
  }));

program
  .command("set")
  .description("Set a device to a static color.")
  .argument("<device-id>")
  .requiredOption("--color <hex>", "hex color, for example #00aaff")
  .option("--brightness <0-100>", "brightness percentage")
  .option("--json", "print JSON")
  .action(withTransport(async (transport, deviceId: string, options: JsonOption & { color: string; brightness?: string }) => {
    const state = await transport.apply(withOptional({
      type: "set",
      deviceId,
      color: parseHexColor(options.color)
    }, {
      brightness: parseBrightness(options.brightness)
    }));
    print(options.json, state, formatState(state));
  }));

program
  .command("effect")
  .description("Apply an effect to a device.")
  .argument("<device-id>")
  .requiredOption("--name <effect>", "effect name")
  .option("--color <hex>", "optional effect color")
  .option("--brightness <0-100>", "brightness percentage")
  .option("--speed <1-10>", "effect speed")
  .option("--json", "print JSON")
  .action(withTransport(async (
    transport,
    deviceId: string,
    options: JsonOption & { name: string; color?: string; brightness?: string; speed?: string }
  ) => {
    const state = await transport.apply(withOptional({
      type: "effect",
      deviceId,
      effect: parseEffect(options.name)
    }, {
      color: options.color ? parseHexColor(options.color) : undefined,
      brightness: parseBrightness(options.brightness),
      speed: parseSpeed(options.speed)
    }));
    print(options.json, state, formatState(state));
  }));

program
  .command("off")
  .description("Turn a device off.")
  .argument("<device-id>")
  .option("--json", "print JSON")
  .action(withTransport(async (transport, deviceId: string, options: JsonOption) => {
    const state = await transport.apply({ type: "off", deviceId });
    print(options.json, state, formatState(state));
  }));

program
  .command("run-plan")
  .description("Run an agent harness plan.")
  .argument("<plan-path>")
  .option("--json", "print JSON")
  .action(withTransport(async (transport, planPath: string, options: JsonOption) => {
    const plan = await loadPlan(resolve(planPath));
    const events = await executePlan(transport, plan);
    print(options.json, events, events.map((event) => `${event.index}\t${event.command}\t${event.message}`).join("\n"));
  }));

program
  .command("doctor")
  .description("Check CLI and harness readiness.")
  .option("--json", "print JSON")
  .action(withTransport(async (transport, options: JsonOption) => {
    const devices = await transport.listDevices();
    const report = {
      ok: devices.length > 0,
      transport: getGlobalOptions().transport,
      devices: devices.length
    };
    print(options.json, report, `ok=${report.ok}\ntransport=${report.transport}\ndevices=${report.devices}`);
  }));

try {
  await program.parseAsync();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
}

function withTransport<T extends readonly unknown[]>(
  action: (transport: ArgbTransport, ...args: T) => Promise<void>
): (...args: T) => Promise<void> {
  return async (...args: T) => {
    const transport = await createTransport(getGlobalOptions());
    try {
      await action(transport, ...args);
    } finally {
      await transport.close?.();
    }
  };
}

function getGlobalOptions(): GlobalOptions {
  const options = program.opts<GlobalOptions>();
  if (options.transport !== "mock" && options.transport !== "file") {
    throw new Error(`Unsupported transport "${options.transport}". Expected mock or file.`);
  }

  return options;
}

function print(json: boolean | undefined, value: unknown, text: string): void {
  if (json) {
    console.log(JSON.stringify(value, null, 2));
    return;
  }

  console.log(text);
}

function formatState(state: DeviceState): string {
  return [
    `device=${state.deviceId}`,
    `power=${state.power}`,
    `effect=${state.effect}`,
    `color=#${state.color.red.toString(16).padStart(2, "0")}${state.color.green.toString(16).padStart(2, "0")}${state.color.blue.toString(16).padStart(2, "0")}`,
    `brightness=${state.brightness}`,
    state.speed ? `speed=${state.speed}` : undefined
  ].filter(Boolean).join("\n");
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
