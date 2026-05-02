import { Socket } from "node:net";

import { assertRgbColor, type RgbColor } from "../core/color.js";
import { ARGB_EFFECTS, type ArgbEffect } from "../core/effects.js";
import type { ArgbCommand, ArgbDevice, ArgbTransport, DeviceState } from "./types.js";

const OPENRGB_PROTOCOL_VERSION = 5;
const HEADER_SIZE = 16;
const DEFAULT_COLOR: RgbColor = { red: 255, green: 255, blue: 255 };
type AnyBuffer = Buffer<ArrayBufferLike>;

const PACKET = {
  requestControllerCount: 0,
  requestControllerData: 1,
  requestProtocolVersion: 40,
  setClientName: 50,
  updateLeds: 1050,
  setCustomMode: 1100,
  updateMode: 1101
} as const;

const EFFECT_ALIASES: Record<ArgbEffect, readonly string[]> = {
  static: ["static", "direct", "fixed"],
  breathing: ["breathing", "breath"],
  rainbow: ["rainbow", "spectrum cycle"],
  wave: ["wave"],
  fire: ["fire"],
  off: []
};

export interface OpenRgbTransportOptions {
  readonly host?: string;
  readonly port?: number;
  readonly name?: string;
  readonly timeoutMs?: number;
}

interface OpenRgbPacket {
  readonly deviceId: number;
  readonly packetId: number;
  readonly payload: AnyBuffer;
}

interface PendingRead {
  readonly deviceId: number;
  readonly packetId: number;
  readonly resolve: (packet: OpenRgbPacket) => void;
  readonly reject: (error: Error) => void;
  readonly timeout: NodeJS.Timeout;
}

interface OpenRgbLed {
  readonly name: string;
  readonly value: number;
}

interface OpenRgbZone {
  readonly name: string;
  readonly id: number;
  readonly ledsCount: number;
}

interface OpenRgbMode {
  readonly id: number;
  readonly name: string;
  readonly value: number;
  readonly flags: number;
  readonly speedMin: number;
  readonly speedMax: number;
  readonly brightnessMin?: number;
  readonly brightnessMax?: number;
  readonly colorMin: number;
  readonly colorMax: number;
  readonly speed: number;
  readonly brightness?: number;
  readonly direction: number;
  readonly colorMode: number;
  readonly colors: readonly RgbColor[];
}

interface OpenRgbController {
  readonly index: number;
  readonly type: number;
  readonly name: string;
  readonly vendor: string;
  readonly description: string;
  readonly version: string;
  readonly serial: string;
  readonly location: string;
  readonly activeMode: number;
  readonly modes: readonly OpenRgbMode[];
  readonly zones: readonly OpenRgbZone[];
  readonly leds: readonly OpenRgbLed[];
  readonly colors: readonly RgbColor[];
}

export class OpenRgbTransport implements ArgbTransport {
  readonly #client: OpenRgbClient;
  readonly #controllers = new Map<string, OpenRgbController>();
  readonly #states = new Map<string, DeviceState>();

  constructor(options: OpenRgbTransportOptions = {}) {
    this.#client = new OpenRgbClient(options);
  }

  async listDevices(): Promise<readonly ArgbDevice[]> {
    const controllers = await this.#refreshControllers();
    return controllers.map(toArgbDevice);
  }

  async getState(deviceId: string): Promise<DeviceState> {
    const controller = await this.#requireController(deviceId);
    const cached = this.#states.get(deviceId);
    if (cached) {
      return cached;
    }

    const state = toDeviceState(controller);
    this.#states.set(deviceId, state);
    return state;
  }

  async apply(command: ArgbCommand): Promise<DeviceState> {
    const controller = await this.#requireController(command.deviceId);
    const current = await this.getState(command.deviceId);
    let next: DeviceState;

    switch (command.type) {
      case "set": {
        assertRgbColor(command.color);
        const brightness = command.brightness ?? current.brightness;
        await this.#client.setCustomMode(controller.index);
        await this.#client.updateLeds(controller.index, fillColors(controller, scaleColor(command.color, brightness)));
        next = {
          deviceId: command.deviceId,
          power: true,
          brightness,
          color: command.color,
          effect: "static"
        };
        break;
      }
      case "effect": {
        if (command.effect === "off") {
          next = await this.#turnOff(controller, current);
          break;
        }

        if (command.effect === "static") {
          const color = command.color ?? current.color;
          assertRgbColor(color);
          const brightness = command.brightness ?? current.brightness;
          await this.#client.setCustomMode(controller.index);
          await this.#client.updateLeds(controller.index, fillColors(controller, scaleColor(color, brightness)));
          next = {
            deviceId: command.deviceId,
            power: true,
            brightness,
            color,
            effect: "static",
            ...(command.speed ? { speed: command.speed } : {})
          };
          break;
        }

        const mode = findMode(controller, command.effect);
        if (!mode) {
          throw new Error(`Device "${command.deviceId}" does not support effect "${command.effect}".`);
        }

        if (command.color) {
          assertRgbColor(command.color);
        }

        const brightness = command.brightness ?? current.brightness;
        await this.#client.updateMode(controller.index, withModeOverrides(mode, withDefined({
          brightness
        }, {
          color: command.color,
          speed: command.speed
        })));
        next = {
          deviceId: command.deviceId,
          power: true,
          brightness,
          color: command.color ?? current.color,
          effect: command.effect,
          ...(command.speed ?? current.speed ? { speed: command.speed ?? current.speed } : {})
        };
        break;
      }
      case "off":
        next = await this.#turnOff(controller, current);
        break;
    }

    this.#states.set(command.deviceId, next);
    return next;
  }

  async close(): Promise<void> {
    await this.#client.close();
  }

  async #turnOff(controller: OpenRgbController, current: DeviceState): Promise<DeviceState> {
    await this.#client.setCustomMode(controller.index);
    await this.#client.updateLeds(controller.index, fillColors(controller, { red: 0, green: 0, blue: 0 }));
    return {
      ...current,
      power: false,
      effect: "off"
    };
  }

  async #requireController(deviceId: string): Promise<OpenRgbController> {
    const cached = this.#controllers.get(deviceId);
    if (cached) {
      return cached;
    }

    await this.#refreshControllers();
    const controller = this.#controllers.get(deviceId);
    if (!controller) {
      throw new Error(`Unknown ARGB device "${deviceId}".`);
    }

    return controller;
  }

  async #refreshControllers(): Promise<readonly OpenRgbController[]> {
    await this.#client.connect();
    const count = await this.#client.getControllerCount();
    const controllers: OpenRgbController[] = [];
    this.#controllers.clear();

    for (let index = 0; index < count; index += 1) {
      const controller = await this.#client.getControllerData(index);
      controllers.push(controller);
      this.#controllers.set(toDeviceId(controller), controller);
    }

    return controllers;
  }
}

class OpenRgbClient {
  readonly #host: string;
  readonly #port: number;
  readonly #name: string;
  readonly #timeoutMs: number;
  #socket: Socket | undefined;
  #connected = false;
  #protocolVersion = OPENRGB_PROTOCOL_VERSION;
  #buffer = Buffer.alloc(0);
  readonly #pending: PendingRead[] = [];

  constructor(options: OpenRgbTransportOptions) {
    this.#host = options.host ?? "127.0.0.1";
    this.#port = options.port ?? 6742;
    this.#name = options.name ?? "argb-cli";
    this.#timeoutMs = options.timeoutMs ?? 1000;
  }

  async connect(): Promise<void> {
    if (this.#connected) {
      return;
    }

    this.#socket = new Socket();
    this.#socket.on("data", (chunk) => this.#handleData(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    this.#socket.on("close", () => {
      this.#connected = false;
    });
    this.#socket.on("error", (error) => {
      this.#rejectPending(error instanceof Error ? error : new Error(String(error)));
    });

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`Timed out connecting to OpenRGB SDK at ${this.#host}:${this.#port}.`));
        this.#socket?.destroy();
      }, this.#timeoutMs);

      this.#socket?.once("connect", () => {
        clearTimeout(timeout);
        this.#connected = true;
        resolve();
      });

      this.#socket?.once("error", (error) => {
        clearTimeout(timeout);
        reject(new Error(`Unable to connect to OpenRGB SDK at ${this.#host}:${this.#port}: ${error.message}`));
      });

      this.#socket?.connect(this.#port, this.#host);
    });

    this.#protocolVersion = await this.getProtocolVersion();
    await this.send(PACKET.setClientName, Buffer.from(`${this.#name}\0`, "utf8"));
  }

  async getProtocolVersion(): Promise<number> {
    const payload = Buffer.alloc(4);
    payload.writeUInt32LE(OPENRGB_PROTOCOL_VERSION);
    const response = this.read(PACKET.requestProtocolVersion, 0);
    await this.send(PACKET.requestProtocolVersion, payload);
    const packet = await response;
    const serverVersion = packet.payload.length >= 4 ? packet.payload.readUInt32LE(0) : 0;
    return Math.min(serverVersion, OPENRGB_PROTOCOL_VERSION);
  }

  async getControllerCount(): Promise<number> {
    const response = this.read(PACKET.requestControllerCount, 0);
    await this.send(PACKET.requestControllerCount);
    const packet = await response;
    return packet.payload.readUInt32LE(0);
  }

  async getControllerData(index: number): Promise<OpenRgbController> {
    const payload = Buffer.alloc(4);
    payload.writeUInt32LE(this.#protocolVersion);
    const response = this.read(PACKET.requestControllerData, index);
    await this.send(PACKET.requestControllerData, payload, index);
    const packet = await response;
    return parseController(packet.payload, index, this.#protocolVersion);
  }

  async setCustomMode(index: number): Promise<void> {
    await this.send(PACKET.setCustomMode, Buffer.alloc(0), index);
  }

  async updateLeds(index: number, colors: readonly RgbColor[]): Promise<void> {
    await this.send(PACKET.updateLeds, packColorVector(colors), index);
  }

  async updateMode(index: number, mode: OpenRgbMode): Promise<void> {
    await this.send(PACKET.updateMode, packMode(mode, this.#protocolVersion), index);
  }

  async close(): Promise<void> {
    this.#rejectPending(new Error("OpenRGB SDK connection closed."));
    await new Promise<void>((resolve) => {
      if (!this.#socket || this.#socket.destroyed) {
        resolve();
        return;
      }

      this.#socket.once("close", () => resolve());
      this.#socket.end();
    });
  }

  async send(packetId: number, payload: AnyBuffer = Buffer.alloc(0), deviceId = 0): Promise<void> {
    if (!this.#socket || !this.#connected) {
      throw new Error("OpenRGB SDK is not connected.");
    }

    const header = Buffer.alloc(HEADER_SIZE);
    header.write("ORGB", 0, "ascii");
    header.writeUInt32LE(deviceId, 4);
    header.writeUInt32LE(packetId, 8);
    header.writeUInt32LE(payload.length, 12);
    const socket = this.#socket;
    await new Promise<void>((resolve, reject) => {
      socket.write(Buffer.concat([header, payload]), (error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });
  }

  read(packetId: number, deviceId: number): Promise<OpenRgbPacket> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        const index = this.#pending.findIndex((pending) => pending.deviceId === deviceId && pending.packetId === packetId);
        if (index >= 0) {
          this.#pending.splice(index, 1);
        }
        reject(new Error(`Timed out waiting for OpenRGB SDK packet ${packetId}.`));
      }, this.#timeoutMs);
      this.#pending.push({ deviceId, packetId, resolve, reject, timeout });
    });
  }

  #handleData(chunk: AnyBuffer): void {
    this.#buffer = Buffer.concat([this.#buffer, chunk]);

    while (this.#buffer.length >= HEADER_SIZE) {
      if (this.#buffer.subarray(0, 4).toString("ascii") !== "ORGB") {
        this.#rejectPending(new Error("Invalid OpenRGB SDK packet magic."));
        this.#buffer = Buffer.alloc(0);
        return;
      }

      const deviceId = this.#buffer.readUInt32LE(4);
      const packetId = this.#buffer.readUInt32LE(8);
      const payloadSize = this.#buffer.readUInt32LE(12);
      const packetSize = HEADER_SIZE + payloadSize;
      if (this.#buffer.length < packetSize) {
        return;
      }

      const payload = this.#buffer.subarray(HEADER_SIZE, packetSize);
      this.#buffer = this.#buffer.subarray(packetSize);
      this.#resolvePacket({ deviceId, packetId, payload });
    }
  }

  #resolvePacket(packet: OpenRgbPacket): void {
    const index = this.#pending.findIndex((pending) => (
      pending.deviceId === packet.deviceId && pending.packetId === packet.packetId
    ));
    if (index < 0) {
      return;
    }

    const pending = this.#pending.splice(index, 1)[0];
    if (!pending) {
      return;
    }

    clearTimeout(pending.timeout);
    pending.resolve(packet);
  }

  #rejectPending(error: Error): void {
    for (const pending of this.#pending.splice(0)) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
  }
}

function parseController(buffer: AnyBuffer, index: number, protocolVersion: number): OpenRgbController {
  const reader = new BufferReader(buffer);
  reader.uint32(); // serialized controller data size
  const type = reader.int32();
  const name = reader.string();
  const vendor = protocolVersion >= 1 ? reader.string() : "OpenRGB";
  const description = reader.string();
  const version = reader.string();
  const serial = reader.string();
  const location = reader.string();
  const modeCount = reader.uint16();
  const activeMode = reader.int32();
  const modes = readModes(reader, modeCount, protocolVersion);
  const zoneCount = reader.uint16();
  const zones = readZones(reader, zoneCount, protocolVersion);
  const ledCount = reader.uint16();
  const leds = readLeds(reader, ledCount);
  const colorCount = reader.uint16();
  const colors = readColors(reader, colorCount);

  if (protocolVersion >= 5 && reader.remaining > 0) {
    const alternateLedCount = reader.uint16();
    for (let ledIndex = 0; ledIndex < alternateLedCount; ledIndex += 1) {
      reader.string();
    }
    reader.uint32(); // controller flags
  }

  return {
    index,
    type,
    name,
    vendor,
    description,
    version,
    serial,
    location,
    activeMode,
    modes,
    zones,
    leds,
    colors
  };
}

function readModes(reader: BufferReader, count: number, protocolVersion: number): readonly OpenRgbMode[] {
  const modes: OpenRgbMode[] = [];

  for (let id = 0; id < count; id += 1) {
    const name = reader.string();
    const value = reader.int32();
    const flags = reader.uint32();
    const speedMin = reader.uint32();
    const speedMax = reader.uint32();
    const brightnessMin = protocolVersion >= 3 ? reader.uint32() : undefined;
    const brightnessMax = protocolVersion >= 3 ? reader.uint32() : undefined;
    const colorMin = reader.uint32();
    const colorMax = reader.uint32();
    const speed = reader.uint32();
    const brightness = protocolVersion >= 3 ? reader.uint32() : undefined;
    const direction = reader.uint32();
    const colorMode = reader.uint32();
    const colorCount = reader.uint16();
    const colors = readColors(reader, colorCount);

    modes.push(withDefined({
      id,
      name,
      value,
      flags,
      speedMin,
      speedMax,
      colorMin,
      colorMax,
      speed,
      direction,
      colorMode,
      colors
    }, {
      brightnessMin,
      brightnessMax,
      brightness
    }));
  }

  return modes;
}

function readZones(reader: BufferReader, count: number, protocolVersion: number): readonly OpenRgbZone[] {
  const zones: OpenRgbZone[] = [];

  for (let id = 0; id < count; id += 1) {
    const name = reader.string();
    reader.uint32(); // zone type
    reader.uint32(); // leds min
    reader.uint32(); // leds max
    const ledsCount = reader.uint32();
    const matrixSize = reader.uint32();
    if (matrixSize > 0) {
      const height = reader.uint32();
      const width = reader.uint32();
      for (let cell = 0; cell < height * width; cell += 1) {
        reader.uint32();
      }
    }

    if (protocolVersion >= 4) {
      const segmentCount = reader.uint16();
      for (let segmentIndex = 0; segmentIndex < segmentCount; segmentIndex += 1) {
        reader.string();
        reader.uint32();
        reader.uint32();
        reader.uint32();
      }
    }

    if (protocolVersion >= 5) {
      reader.uint32(); // zone flags
    }

    zones.push({ id, name, ledsCount });
  }

  return zones;
}

function readLeds(reader: BufferReader, count: number): readonly OpenRgbLed[] {
  const leds: OpenRgbLed[] = [];

  for (let id = 0; id < count; id += 1) {
    leds.push({
      name: reader.string(),
      value: reader.uint32()
    });
  }

  return leds;
}

function readColors(reader: BufferReader, count: number): readonly RgbColor[] {
  const colors: RgbColor[] = [];

  for (let colorIndex = 0; colorIndex < count; colorIndex += 1) {
    colors.push(reader.color());
  }

  return colors;
}

function packMode(mode: OpenRgbMode, protocolVersion: number): AnyBuffer {
  const modeHeader = Buffer.alloc(protocolVersion >= 3 ? 48 : 36);
  let offset = 0;
  offset = modeHeader.writeUInt32LE(mode.value, offset);
  offset = modeHeader.writeUInt32LE(mode.flags, offset);
  offset = modeHeader.writeUInt32LE(mode.speedMin, offset);
  offset = modeHeader.writeUInt32LE(mode.speedMax, offset);
  if (protocolVersion >= 3) {
    offset = modeHeader.writeUInt32LE(mode.brightnessMin ?? 0, offset);
    offset = modeHeader.writeUInt32LE(mode.brightnessMax ?? 0, offset);
  }
  offset = modeHeader.writeUInt32LE(mode.colorMin, offset);
  offset = modeHeader.writeUInt32LE(mode.colorMax, offset);
  offset = modeHeader.writeUInt32LE(mode.speed, offset);
  if (protocolVersion >= 3) {
    offset = modeHeader.writeUInt32LE(mode.brightness ?? 0, offset);
  }
  offset = modeHeader.writeUInt32LE(mode.direction, offset);
  modeHeader.writeUInt32LE(mode.colorMode, offset);

  const body = Buffer.concat([
    uint32(mode.id),
    packString(mode.name),
    modeHeader,
    packModeColorList(mode.colors)
  ]);

  return Buffer.concat([uint32(body.length + 4), body]);
}

function packColorVector(colors: readonly RgbColor[]): AnyBuffer {
  const body = Buffer.alloc(2 + (colors.length * 4));
  body.writeUInt16LE(colors.length, 0);
  writeColors(body, colors, 2);
  return Buffer.concat([uint32(body.length + 4), body]);
}

function packModeColorList(colors: readonly RgbColor[]): AnyBuffer {
  const body = Buffer.alloc(2 + (colors.length * 4));
  body.writeUInt16LE(colors.length, 0);
  writeColors(body, colors, 2);
  return body;
}

function packString(value: string): AnyBuffer {
  const text = Buffer.from(value, "utf8");
  const buffer = Buffer.alloc(2 + text.length + 1);
  buffer.writeUInt16LE(text.length + 1, 0);
  text.copy(buffer, 2);
  return buffer;
}

function writeColors(buffer: AnyBuffer, colors: readonly RgbColor[], start: number): void {
  for (const [index, color] of colors.entries()) {
    const offset = start + (index * 4);
    buffer.writeUInt8(color.red, offset);
    buffer.writeUInt8(color.green, offset + 1);
    buffer.writeUInt8(color.blue, offset + 2);
    buffer.writeUInt8(0, offset + 3);
  }
}

function uint32(value: number): AnyBuffer {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(value);
  return buffer;
}

function toArgbDevice(controller: OpenRgbController): ArgbDevice {
  return {
    id: toDeviceId(controller),
    name: controller.name,
    vendor: controller.vendor || "OpenRGB",
    product: controller.description || controller.version || "OpenRGB Controller",
    ledCount: ledCount(controller),
    channels: Math.max(controller.zones.length, 1),
    supports: supportedEffects(controller)
  };
}

function toDeviceState(controller: OpenRgbController): DeviceState {
  const color = controller.colors[0] ?? DEFAULT_COLOR;
  const mode = controller.modes[controller.activeMode];
  const effect = mode ? effectForMode(mode) : "static";

  return {
    deviceId: toDeviceId(controller),
    power: color.red > 0 || color.green > 0 || color.blue > 0 || effect !== "off",
    brightness: 100,
    color,
    effect,
    ...(mode?.speed ? { speed: normalizeModeValue(mode.speed, mode.speedMin, mode.speedMax, 1, 10) } : {})
  };
}

function toDeviceId(controller: OpenRgbController): string {
  return `openrgb:${controller.index}`;
}

function ledCount(controller: OpenRgbController): number {
  return Math.max(controller.colors.length, controller.leds.length, ...controller.zones.map((zone) => zone.ledsCount), 1);
}

function fillColors(controller: OpenRgbController, color: RgbColor): readonly RgbColor[] {
  return Array.from({ length: ledCount(controller) }, () => color);
}

function supportedEffects(controller: OpenRgbController): readonly ArgbEffect[] {
  return ARGB_EFFECTS.filter((effect) => effect === "static" || effect === "off" || Boolean(findMode(controller, effect)));
}

function findMode(controller: OpenRgbController, effect: ArgbEffect): OpenRgbMode | undefined {
  const aliases = EFFECT_ALIASES[effect];
  return controller.modes.find((mode) => aliases.some((alias) => mode.name.toLowerCase() === alias));
}

function effectForMode(mode: OpenRgbMode): ArgbEffect {
  const normalized = mode.name.toLowerCase();
  for (const effect of ARGB_EFFECTS) {
    if (EFFECT_ALIASES[effect].some((alias) => alias === normalized)) {
      return effect;
    }
  }

  return "static";
}

function scaleColor(color: RgbColor, brightness: number): RgbColor {
  const scale = brightness / 100;
  return {
    red: Math.round(color.red * scale),
    green: Math.round(color.green * scale),
    blue: Math.round(color.blue * scale)
  };
}

function withModeOverrides(
  mode: OpenRgbMode,
  overrides: { readonly color?: RgbColor; readonly brightness: number; readonly speed?: number }
): OpenRgbMode {
  const nextSpeed = overrides.speed === undefined
    ? mode.speed
    : denormalizeModeValue(overrides.speed, 1, 10, mode.speedMin, mode.speedMax);
  const nextBrightness = mode.brightness === undefined
    ? undefined
    : denormalizeModeValue(overrides.brightness, 0, 100, mode.brightnessMin ?? 0, mode.brightnessMax ?? 100);
  const colors = overrides.color
    ? Array.from({ length: Math.max(mode.colorMin, 1) }, () => overrides.color as RgbColor)
    : mode.colors;

  return withDefined({
    ...mode,
    speed: nextSpeed,
    colors
  }, {
    brightness: nextBrightness
  });
}

function normalizeModeValue(value: number, sourceMin: number, sourceMax: number, targetMin: number, targetMax: number): number {
  if (sourceMax <= sourceMin) {
    return targetMin;
  }

  const ratio = (value - sourceMin) / (sourceMax - sourceMin);
  return Math.round(targetMin + (ratio * (targetMax - targetMin)));
}

function denormalizeModeValue(value: number, sourceMin: number, sourceMax: number, targetMin: number, targetMax: number): number {
  if (targetMax <= targetMin) {
    return targetMin;
  }

  const ratio = (value - sourceMin) / (sourceMax - sourceMin);
  return Math.round(targetMin + (ratio * (targetMax - targetMin)));
}

function withDefined<T extends object, U extends object>(required: T, optional: U): T & {
  [K in keyof U]?: Exclude<U[K], undefined>;
} {
  return {
    ...required,
    ...Object.fromEntries(Object.entries(optional).filter(([, value]) => value !== undefined))
  } as T & { [K in keyof U]?: Exclude<U[K], undefined> };
}

class BufferReader {
  readonly #buffer: Buffer;
  #offset = 0;

  constructor(buffer: AnyBuffer) {
    this.#buffer = buffer;
  }

  get remaining(): number {
    return this.#buffer.length - this.#offset;
  }

  uint16(): number {
    const value = this.#buffer.readUInt16LE(this.#offset);
    this.#offset += 2;
    return value;
  }

  uint32(): number {
    const value = this.#buffer.readUInt32LE(this.#offset);
    this.#offset += 4;
    return value;
  }

  int32(): number {
    const value = this.#buffer.readInt32LE(this.#offset);
    this.#offset += 4;
    return value;
  }

  string(): string {
    const length = this.uint16();
    if (length === 0) {
      return "";
    }

    const start = this.#offset;
    this.#offset += length;
    return this.#buffer.subarray(start, start + length - 1).toString("utf8");
  }

  color(): RgbColor {
    const color = {
      red: this.#buffer.readUInt8(this.#offset),
      green: this.#buffer.readUInt8(this.#offset + 1),
      blue: this.#buffer.readUInt8(this.#offset + 2)
    };
    this.#offset += 4;
    return color;
  }
}
