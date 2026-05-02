import type { RgbColor } from "../core/color.js";
import type { ArgbEffect } from "../core/effects.js";

export interface ArgbDevice {
  readonly id: string;
  readonly name: string;
  readonly vendor: string;
  readonly product: string;
  readonly ledCount: number;
  readonly channels: number;
  readonly supports: readonly ArgbEffect[];
}

export interface DeviceState {
  readonly deviceId: string;
  readonly power: boolean;
  readonly brightness: number;
  readonly color: RgbColor;
  readonly effect: ArgbEffect;
  readonly speed?: number;
}

export type ArgbCommand =
  | {
      readonly type: "set";
      readonly deviceId: string;
      readonly color: RgbColor;
      readonly brightness?: number;
    }
  | {
      readonly type: "effect";
      readonly deviceId: string;
      readonly effect: ArgbEffect;
      readonly color?: RgbColor;
      readonly brightness?: number;
      readonly speed?: number;
    }
  | {
      readonly type: "off";
      readonly deviceId: string;
    };

export interface ArgbTransport {
  listDevices(): Promise<readonly ArgbDevice[]>;
  getState(deviceId: string): Promise<DeviceState>;
  apply(command: ArgbCommand): Promise<DeviceState>;
  close?(): Promise<void>;
}

export interface PersistedHarnessState {
  readonly devices: readonly ArgbDevice[];
  readonly states: readonly DeviceState[];
}
