import { describe, expect, it } from "vitest";

import { formatHexColor, parseHexColor } from "../src/core/color.js";
import { parseBrightness, parseEffect, parseSpeed } from "../src/core/effects.js";

describe("color parsing", () => {
  it("parses and formats #RRGGBB colors", () => {
    expect(parseHexColor("#00aaff")).toEqual({ red: 0, green: 170, blue: 255 });
    expect(formatHexColor({ red: 0, green: 170, blue: 255 })).toBe("#00aaff");
  });

  it("rejects invalid colors", () => {
    expect(() => parseHexColor("#0af")).toThrow(/Expected #RRGGBB/);
  });
});

describe("effect parsing", () => {
  it("validates effect, brightness, and speed ranges", () => {
    expect(parseEffect("rainbow")).toBe("rainbow");
    expect(parseBrightness("65")).toBe(65);
    expect(parseSpeed("4")).toBe(4);
    expect(() => parseBrightness("101")).toThrow(/0 to 100/);
    expect(() => parseSpeed("0")).toThrow(/1 to 10/);
  });
});
