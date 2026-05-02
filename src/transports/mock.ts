import { assertRgbColor } from "../core/color.js";
import type { ArgbCommand, ArgbDevice, ArgbTransport, DeviceState, PersistedHarnessState } from "./types.js";

const DEFAULT_COLOR = { red: 255, green: 255, blue: 255 };

export class MockArgbTransport implements ArgbTransport {
  readonly #devices: Map<string, ArgbDevice>;
  readonly #states: Map<string, DeviceState>;
  readonly #onChange: ((state: PersistedHarnessState) => Promise<void>) | undefined;

  constructor(
    devices: readonly ArgbDevice[],
    states?: readonly DeviceState[],
    onChange?: (state: PersistedHarnessState) => Promise<void>
  ) {
    this.#devices = new Map(devices.map((device) => [device.id, device]));
    this.#states = new Map(
      devices.map((device) => [
        device.id,
        states?.find((state) => state.deviceId === device.id) ?? {
          deviceId: device.id,
          power: false,
          brightness: 100,
          color: DEFAULT_COLOR,
          effect: "off"
        }
      ])
    );
    this.#onChange = onChange;
  }

  async listDevices(): Promise<readonly ArgbDevice[]> {
    return [...this.#devices.values()];
  }

  async getState(deviceId: string): Promise<DeviceState> {
    return this.#requireState(deviceId);
  }

  async apply(command: ArgbCommand): Promise<DeviceState> {
    const device = this.#requireDevice(command.deviceId);
    const current = this.#requireState(command.deviceId);
    let next: DeviceState;

    switch (command.type) {
      case "set":
        assertRgbColor(command.color);
        next = {
          ...current,
          power: true,
          color: command.color,
          brightness: command.brightness ?? current.brightness,
          effect: "static"
        };
        break;
      case "effect":
        if (!device.supports.includes(command.effect)) {
          throw new Error(`Device "${device.id}" does not support effect "${command.effect}".`);
        }

        if (command.color) {
          assertRgbColor(command.color);
        }

        next = {
          ...current,
          power: command.effect !== "off",
          color: command.color ?? current.color,
          brightness: command.brightness ?? current.brightness,
          effect: command.effect,
          ...(command.speed ?? current.speed ? { speed: command.speed ?? current.speed } : {})
        };
        break;
      case "off":
        next = {
          ...current,
          power: false,
          effect: "off"
        };
        break;
    }

    this.#states.set(command.deviceId, next);
    await this.#persist();
    return next;
  }

  snapshot(): PersistedHarnessState {
    return {
      devices: [...this.#devices.values()],
      states: [...this.#states.values()]
    };
  }

  #requireDevice(deviceId: string): ArgbDevice {
    const device = this.#devices.get(deviceId);
    if (!device) {
      throw new Error(`Unknown ARGB device "${deviceId}".`);
    }

    return device;
  }

  #requireState(deviceId: string): DeviceState {
    this.#requireDevice(deviceId);
    const state = this.#states.get(deviceId);
    if (!state) {
      throw new Error(`Missing state for ARGB device "${deviceId}".`);
    }

    return state;
  }

  async #persist(): Promise<void> {
    await this.#onChange?.(this.snapshot());
  }
}
