import { readFile } from "node:fs/promises";

import { formatHexColor, parseHexColor } from "../core/color.js";
import { parseBrightness, parseEffect, parseSpeed } from "../core/effects.js";
import type { ArgbEffect } from "../core/effects.js";
import type { ArgbCommand, ArgbTransport, DeviceState } from "../transports/types.js";

export interface AgentPlan {
  readonly version: 1;
  readonly steps: readonly PlanStep[];
}

export type PlanStep =
  | {
      readonly command: "set";
      readonly deviceId: string;
      readonly color: string;
      readonly brightness?: number;
    }
  | {
      readonly command: "effect";
      readonly deviceId: string;
      readonly effect: ArgbEffect;
      readonly color?: string;
      readonly brightness?: number;
      readonly speed?: number;
    }
  | {
      readonly command: "off";
      readonly deviceId: string;
    }
  | {
      readonly command: "wait";
      readonly ms: number;
    }
  | {
      readonly command: "assert";
      readonly deviceId: string;
      readonly power?: boolean;
      readonly color?: string;
      readonly brightness?: number;
      readonly effect?: ArgbEffect;
    };

export interface PlanEvent {
  readonly index: number;
  readonly command: PlanStep["command"];
  readonly state?: DeviceState;
  readonly message: string;
}

export async function loadPlan(path: string): Promise<AgentPlan> {
  const content = await readFile(path, "utf8");
  return parsePlan(JSON.parse(content));
}

export function parsePlan(input: unknown): AgentPlan {
  if (!isRecord(input) || input.version !== 1 || !Array.isArray(input.steps)) {
    throw new Error("Invalid plan. Expected { version: 1, steps: [...] }.");
  }

  return {
    version: 1,
    steps: input.steps.map(parseStep)
  };
}

export async function executePlan(transport: ArgbTransport, plan: AgentPlan): Promise<readonly PlanEvent[]> {
  const events: PlanEvent[] = [];

  for (const [index, step] of plan.steps.entries()) {
    switch (step.command) {
      case "set": {
        const state = await transport.apply(toCommand(step));
        events.push({ index, command: step.command, state, message: `Set ${step.deviceId} to ${formatHexColor(state.color)}.` });
        break;
      }
      case "effect": {
        const state = await transport.apply(toCommand(step));
        events.push({ index, command: step.command, state, message: `Applied ${state.effect} to ${step.deviceId}.` });
        break;
      }
      case "off": {
        const state = await transport.apply({ type: "off", deviceId: step.deviceId });
        events.push({ index, command: step.command, state, message: `Turned ${step.deviceId} off.` });
        break;
      }
      case "wait":
        await delay(step.ms);
        events.push({ index, command: step.command, message: `Waited ${step.ms}ms.` });
        break;
      case "assert": {
        const state = await transport.getState(step.deviceId);
        assertState(step, state);
        events.push({ index, command: step.command, state, message: `Asserted ${step.deviceId}.` });
        break;
      }
    }
  }

  return events;
}

function parseStep(input: unknown, index: number): PlanStep {
  if (!isRecord(input) || typeof input.command !== "string") {
    throw new Error(`Invalid plan step at index ${index}.`);
  }

  switch (input.command) {
    case "set":
      return withOptional({
        command: "set",
        deviceId: requireString(input.deviceId, index, "deviceId"),
        color: requireString(input.color, index, "color")
      }, {
        brightness: parseBrightness(input.brightness as number | undefined)
      });
    case "effect":
      return withOptional({
        command: "effect",
        deviceId: requireString(input.deviceId, index, "deviceId"),
        effect: parseEffect(requireString(input.effect, index, "effect"))
      }, {
        color: optionalString(input.color, index, "color"),
        brightness: parseBrightness(input.brightness as number | undefined),
        speed: parseSpeed(input.speed as number | undefined)
      });
    case "off":
      return {
        command: "off",
        deviceId: requireString(input.deviceId, index, "deviceId")
      };
    case "wait": {
      const ms = input.ms;
      if (typeof ms !== "number" || !Number.isInteger(ms) || ms < 0 || ms > 60_000) {
        throw new Error(`Invalid wait ms at step ${index}. Expected 0-60000.`);
      }

      return {
        command: "wait",
        ms
      };
    }
    case "assert":
      return withOptional({
        command: "assert",
        deviceId: requireString(input.deviceId, index, "deviceId")
      }, {
        power: optionalBoolean(input.power, index, "power"),
        color: optionalString(input.color, index, "color"),
        brightness: parseBrightness(input.brightness as number | undefined),
        effect: input.effect === undefined ? undefined : parseEffect(requireString(input.effect, index, "effect"))
      });
    default:
      throw new Error(`Unsupported plan command "${input.command}" at step ${index}.`);
  }
}

function toCommand(step: Extract<PlanStep, { command: "set" | "effect" }>): ArgbCommand {
  if (step.command === "set") {
    return withOptional({
      type: "set",
      deviceId: step.deviceId,
      color: parseHexColor(step.color)
    }, {
      brightness: step.brightness
    });
  }

  return withOptional({
    type: "effect",
    deviceId: step.deviceId,
    effect: step.effect
  }, {
    color: step.color ? parseHexColor(step.color) : undefined,
    brightness: step.brightness,
    speed: step.speed
  });
}

function assertState(step: Extract<PlanStep, { command: "assert" }>, state: DeviceState): void {
  if (step.power !== undefined && state.power !== step.power) {
    throw new Error(`Assertion failed for ${step.deviceId}: power expected ${step.power}, got ${state.power}.`);
  }

  if (step.color && formatHexColor(state.color) !== step.color.toLowerCase()) {
    throw new Error(`Assertion failed for ${step.deviceId}: color expected ${step.color}, got ${formatHexColor(state.color)}.`);
  }

  if (step.brightness !== undefined && state.brightness !== step.brightness) {
    throw new Error(`Assertion failed for ${step.deviceId}: brightness expected ${step.brightness}, got ${state.brightness}.`);
  }

  if (step.effect && state.effect !== step.effect) {
    throw new Error(`Assertion failed for ${step.deviceId}: effect expected ${step.effect}, got ${state.effect}.`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function requireString(value: unknown, index: number, property: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Invalid ${property} at step ${index}. Expected a non-empty string.`);
  }

  return value;
}

function optionalString(value: unknown, index: number, property: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  return requireString(value, index, property);
}

function optionalBoolean(value: unknown, index: number, property: string): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "boolean") {
    throw new Error(`Invalid ${property} at step ${index}. Expected a boolean.`);
  }

  return value;
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
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
