export interface RgbColor {
  readonly red: number;
  readonly green: number;
  readonly blue: number;
}

const HEX_COLOR_PATTERN = /^#?(?<hex>[0-9a-fA-F]{6})$/;

export function parseHexColor(input: string): RgbColor {
  const match = HEX_COLOR_PATTERN.exec(input.trim());
  const hex = match?.groups?.hex;

  if (!hex) {
    throw new Error(`Invalid color "${input}". Expected #RRGGBB.`);
  }

  return {
    red: Number.parseInt(hex.slice(0, 2), 16),
    green: Number.parseInt(hex.slice(2, 4), 16),
    blue: Number.parseInt(hex.slice(4, 6), 16)
  };
}

export function formatHexColor(color: RgbColor): string {
  return `#${toHexByte(color.red)}${toHexByte(color.green)}${toHexByte(color.blue)}`;
}

export function assertRgbColor(color: RgbColor): void {
  for (const [channel, value] of Object.entries(color)) {
    if (!Number.isInteger(value) || value < 0 || value > 255) {
      throw new Error(`Invalid ${channel} channel ${value}. Expected 0-255.`);
    }
  }
}

function toHexByte(value: number): string {
  if (!Number.isInteger(value) || value < 0 || value > 255) {
    throw new Error(`Invalid color channel ${value}. Expected 0-255.`);
  }

  return value.toString(16).padStart(2, "0");
}
