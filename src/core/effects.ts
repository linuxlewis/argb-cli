export const ARGB_EFFECTS = ["static", "breathing", "rainbow", "wave", "fire", "off"] as const;

export type ArgbEffect = (typeof ARGB_EFFECTS)[number];

export function parseEffect(input: string): ArgbEffect {
  if (ARGB_EFFECTS.includes(input as ArgbEffect)) {
    return input as ArgbEffect;
  }

  throw new Error(`Unsupported effect "${input}". Expected one of: ${ARGB_EFFECTS.join(", ")}.`);
}

export function parseBrightness(input: string | number | undefined): number | undefined {
  if (input === undefined) {
    return undefined;
  }

  const value = typeof input === "number" ? input : Number.parseInt(input, 10);
  if (!Number.isInteger(value) || value < 0 || value > 100) {
    throw new Error(`Invalid brightness "${input}". Expected an integer from 0 to 100.`);
  }

  return value;
}

export function parseSpeed(input: string | number | undefined): number | undefined {
  if (input === undefined) {
    return undefined;
  }

  const value = typeof input === "number" ? input : Number.parseInt(input, 10);
  if (!Number.isInteger(value) || value < 1 || value > 10) {
    throw new Error(`Invalid speed "${input}". Expected an integer from 1 to 10.`);
  }

  return value;
}
