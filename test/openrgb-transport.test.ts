import { createServer, type Server, type Socket } from "node:net";

import { describe, expect, it } from "vitest";

import { OpenRgbTransport } from "../src/transports/openrgb.js";

const PACKET = {
  requestControllerCount: 0,
  requestControllerData: 1,
  requestProtocolVersion: 40,
  setClientName: 50,
  updateLeds: 1050,
  setCustomMode: 1100,
  updateMode: 1101
} as const;

interface RecordedPacket {
  readonly deviceId: number;
  readonly packetId: number;
  readonly payload: Buffer<ArrayBufferLike>;
}

describe("OpenRgbTransport", () => {
  it("lists OpenRGB controllers and applies set, effect, and off commands", async () => {
    const server = await startOpenRgbServer();
    const transport = new OpenRgbTransport({
      host: "127.0.0.1",
      port: server.port,
      timeoutMs: 500
    });

    try {
      await expect(transport.listDevices()).resolves.toEqual([
        {
          id: "openrgb:0",
          name: "Fake Controller",
          vendor: "OpenRGB Test",
          product: "Virtual RGB Device",
          ledCount: 3,
          channels: 1,
          supports: ["static", "rainbow", "off"]
        }
      ]);

      await expect(transport.apply({
        type: "set",
        deviceId: "openrgb:0",
        color: { red: 100, green: 50, blue: 25 },
        brightness: 50
      })).resolves.toMatchObject({
        deviceId: "openrgb:0",
        power: true,
        effect: "static",
        brightness: 50,
        color: { red: 100, green: 50, blue: 25 }
      });

      await expect(transport.apply({
        type: "effect",
        deviceId: "openrgb:0",
        effect: "rainbow",
        speed: 10
      })).resolves.toMatchObject({
        power: true,
        effect: "rainbow",
        speed: 10
      });

      await expect(transport.apply({ type: "off", deviceId: "openrgb:0" })).resolves.toMatchObject({
        power: false,
        effect: "off"
      });

      await waitFor(() => server.packets.filter((packet) => packet.packetId === PACKET.updateLeds).length >= 2);
      const setCustomModePackets = server.packets.filter((packet) => packet.packetId === PACKET.setCustomMode);
      expect(setCustomModePackets).toHaveLength(2);

      const ledUpdates = server.packets.filter((packet) => packet.packetId === PACKET.updateLeds);
      expect(readColors(ledUpdates[0]?.payload)).toEqual([
        { red: 50, green: 25, blue: 13 },
        { red: 50, green: 25, blue: 13 },
        { red: 50, green: 25, blue: 13 }
      ]);
      expect(readColors(ledUpdates[1]?.payload)).toEqual([
        { red: 0, green: 0, blue: 0 },
        { red: 0, green: 0, blue: 0 },
        { red: 0, green: 0, blue: 0 }
      ]);

      const modeUpdates = server.packets.filter((packet) => packet.packetId === PACKET.updateMode);
      expect(modeUpdates).toHaveLength(1);
    } finally {
      await transport.close();
      await server.close();
    }
  });

  it("rejects unsupported OpenRGB native effects", async () => {
    const server = await startOpenRgbServer();
    const transport = new OpenRgbTransport({
      host: "127.0.0.1",
      port: server.port,
      timeoutMs: 500
    });

    try {
      await transport.listDevices();
      await expect(transport.apply({
        type: "effect",
        deviceId: "openrgb:0",
        effect: "wave"
      })).rejects.toThrow(/does not support/);
    } finally {
      await transport.close();
      await server.close();
    }
  });
});

async function startOpenRgbServer(): Promise<{
  readonly port: number;
  readonly packets: readonly RecordedPacket[];
  close(): Promise<void>;
}> {
  const packets: RecordedPacket[] = [];
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    let buffer = Buffer.alloc(0);

    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
      while (buffer.length >= 16) {
        const size = buffer.readUInt32LE(12);
        if (buffer.length < 16 + size) {
          return;
        }

        const packet = {
          deviceId: buffer.readUInt32LE(4),
          packetId: buffer.readUInt32LE(8),
          payload: buffer.subarray(16, 16 + size)
        };
        packets.push(packet);
        handlePacket(socket, packet);
        buffer = buffer.subarray(16 + size);
      }
    });
  });

  await listen(server);
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected TCP server address.");
  }

  return {
    port: address.port,
    packets,
    async close() {
      for (const socket of sockets) {
        socket.destroy();
      }

      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }

          resolve();
        });
      });
    }
  };
}

function handlePacket(socket: Socket, packet: RecordedPacket): void {
  switch (packet.packetId) {
    case PACKET.requestProtocolVersion:
      socket.write(packetBuffer(0, PACKET.requestProtocolVersion, uint32(5)));
      break;
    case PACKET.requestControllerCount:
      socket.write(packetBuffer(0, PACKET.requestControllerCount, uint32(1)));
      break;
    case PACKET.requestControllerData:
      socket.write(packetBuffer(packet.deviceId, PACKET.requestControllerData, fakeControllerData()));
      break;
  }
}

function listen(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

async function waitFor(condition: () => boolean): Promise<void> {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > 500) {
      throw new Error("Timed out waiting for fake OpenRGB server packets.");
    }

    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function packetBuffer(deviceId: number, packetId: number, payload: Buffer<ArrayBufferLike>): Buffer<ArrayBufferLike> {
  const header = Buffer.alloc(16);
  header.write("ORGB", 0, "ascii");
  header.writeUInt32LE(deviceId, 4);
  header.writeUInt32LE(packetId, 8);
  header.writeUInt32LE(payload.length, 12);
  return Buffer.concat([header, payload]);
}

function fakeControllerData(): Buffer<ArrayBufferLike> {
  const modes = Buffer.concat([
    modeBuffer("direct", 0),
    modeBuffer("rainbow", 1)
  ]);
  const zones = Buffer.concat([
    Buffer.concat([
      stringBuffer("Main"),
      uint32(0),
      uint32(3),
      uint32(3),
      uint32(3),
      uint32(0),
      uint16(0),
      uint32(0)
    ])
  ]);
  const leds = Buffer.concat([
    ledBuffer("LED 1", 0),
    ledBuffer("LED 2", 1),
    ledBuffer("LED 3", 2)
  ]);
  const colors = colorList([
    { red: 10, green: 20, blue: 30 },
    { red: 10, green: 20, blue: 30 },
    { red: 10, green: 20, blue: 30 }
  ]);
  const body = Buffer.concat([
    int32(0),
    stringBuffer("Fake Controller"),
    stringBuffer("OpenRGB Test"),
    stringBuffer("Virtual RGB Device"),
    stringBuffer("1.0"),
    stringBuffer("SERIAL"),
    stringBuffer("test-location"),
    uint16(2),
    int32(0),
    modes,
    uint16(1),
    zones,
    uint16(3),
    leds,
    uint16(3),
    colors,
    uint16(0),
    uint32(0)
  ]);

  return Buffer.concat([uint32(body.length + 4), body]);
}

function modeBuffer(name: string, value: number): Buffer<ArrayBufferLike> {
  return Buffer.concat([
    stringBuffer(name),
    int32(value),
    uint32(0),
    uint32(0),
    uint32(100),
    uint32(0),
    uint32(100),
    uint32(0),
    uint32(1),
    uint32(50),
    uint32(100),
    uint32(0),
    uint32(0),
    uint16(0)
  ]);
}

function ledBuffer(name: string, value: number): Buffer<ArrayBufferLike> {
  return Buffer.concat([
    stringBuffer(name),
    uint32(value)
  ]);
}

function readColors(payload: Buffer<ArrayBufferLike> | undefined): readonly { red: number; green: number; blue: number }[] {
  if (!payload) {
    return [];
  }

  const count = payload.readUInt16LE(4);
  return Array.from({ length: count }, (_, index) => {
    const offset = 6 + (index * 4);
    return {
      red: payload.readUInt8(offset),
      green: payload.readUInt8(offset + 1),
      blue: payload.readUInt8(offset + 2)
    };
  });
}

function colorList(colors: readonly { red: number; green: number; blue: number }[]): Buffer<ArrayBufferLike> {
  const buffer = Buffer.alloc(colors.length * 4);
  for (const [index, color] of colors.entries()) {
    const offset = index * 4;
    buffer.writeUInt8(color.red, offset);
    buffer.writeUInt8(color.green, offset + 1);
    buffer.writeUInt8(color.blue, offset + 2);
  }

  return buffer;
}

function stringBuffer(value: string): Buffer<ArrayBufferLike> {
  const text = Buffer.from(value, "utf8");
  const buffer = Buffer.alloc(2 + text.length + 1);
  buffer.writeUInt16LE(text.length + 1, 0);
  text.copy(buffer, 2);
  return buffer;
}

function uint16(value: number): Buffer<ArrayBufferLike> {
  const buffer = Buffer.alloc(2);
  buffer.writeUInt16LE(value);
  return buffer;
}

function uint32(value: number): Buffer<ArrayBufferLike> {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(value);
  return buffer;
}

function int32(value: number): Buffer<ArrayBufferLike> {
  const buffer = Buffer.alloc(4);
  buffer.writeInt32LE(value);
  return buffer;
}
