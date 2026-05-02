import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { formatHexColor, parseHexColor } from "../core/color.js";
import { parseBrightness, parseEffect, parseSpeed } from "../core/effects.js";
import { executePlan, parsePlan } from "../harness/plan.js";
import type { AgentPlan, PlanEvent } from "../harness/plan.js";
import type { ArgbDevice, ArgbTransport, DeviceState } from "../transports/types.js";

export interface WebServerOptions {
  readonly host: string;
  readonly port: number;
}

export interface StartedWebServer {
  readonly server: Server;
  readonly url: string;
  close(): Promise<void>;
}

interface Snapshot {
  readonly devices: readonly ArgbDevice[];
  readonly states: readonly DeviceState[];
}

export async function startWebServer(transport: ArgbTransport, options: WebServerOptions): Promise<StartedWebServer> {
  const server = createWebServer(transport);

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  const port = typeof address === "object" && address ? address.port : options.port;
  const host = displayHost(options.host);

  return {
    server,
    url: `http://${host}:${port}`,
    async close() {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }

          resolve();
        });
      });
      await transport.close?.();
    }
  };
}

export function createWebServer(transport: ArgbTransport): Server {
  return createServer(async (request, response) => {
    try {
      await routeRequest(transport, request, response);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sendJson(response, errorStatus(error), { error: message });
    }
  });
}

async function routeRequest(transport: ArgbTransport, request: IncomingMessage, response: ServerResponse): Promise<void> {
  const method = request.method ?? "GET";
  const url = new URL(request.url ?? "/", "http://localhost");
  const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);

  if (method === "GET" && url.pathname === "/") {
    sendText(response, 200, "text/html; charset=utf-8", INDEX_HTML);
    return;
  }

  if (method === "GET" && url.pathname === "/app.js") {
    sendText(response, 200, "text/javascript; charset=utf-8", APP_JS);
    return;
  }

  if (method === "GET" && url.pathname === "/styles.css") {
    sendText(response, 200, "text/css; charset=utf-8", STYLES_CSS);
    return;
  }

  if (method === "GET" && url.pathname === "/api/snapshot") {
    sendJson(response, 200, await getSnapshot(transport));
    return;
  }

  if (method === "POST" && parts[0] === "api" && parts[1] === "devices" && parts[2] && parts[3]) {
    const body = await readJsonBody(request);
    const state = await applyDeviceCommand(transport, parts[2], parts[3], body);
    sendJson(response, 200, { state, snapshot: await getSnapshot(transport) });
    return;
  }

  if (method === "POST" && url.pathname === "/api/plans/run") {
    const plan = parsePlan(await readJsonBody(request));
    const events = await executePlan(transport, plan);
    sendJson(response, 200, { events, snapshot: await getSnapshot(transport) });
    return;
  }

  sendJson(response, 404, { error: "Not found." });
}

async function applyDeviceCommand(
  transport: ArgbTransport,
  deviceId: string,
  action: string,
  body: unknown
): Promise<DeviceState> {
  if (action === "off") {
    return transport.apply({ type: "off", deviceId });
  }

  const input = requireRecord(body);

  if (action === "set") {
    return transport.apply(withOptional({
      type: "set",
      deviceId,
      color: parseHexColor(requireString(input.color, "color"))
    }, {
      brightness: parseBrightness(input.brightness as string | number | undefined)
    }));
  }

  if (action === "effect") {
    return transport.apply(withOptional({
      type: "effect",
      deviceId,
      effect: parseEffect(requireString(input.effect, "effect"))
    }, {
      color: input.color === undefined || input.color === "" ? undefined : parseHexColor(requireString(input.color, "color")),
      brightness: parseBrightness(input.brightness as string | number | undefined),
      speed: parseSpeed(input.speed as string | number | undefined)
    }));
  }

  throw badRequest(`Unsupported device action "${action}".`);
}

async function getSnapshot(transport: ArgbTransport): Promise<Snapshot> {
  const devices = await transport.listDevices();
  const states = await Promise.all(devices.map((device) => transport.getState(device.id)));

  return { devices, states };
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];

  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  if (chunks.length === 0) {
    return {};
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw badRequest("Invalid JSON request body.");
  }
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  sendText(response, status, "application/json; charset=utf-8", `${JSON.stringify(value)}\n`);
}

function sendText(response: ServerResponse, status: number, contentType: string, text: string): void {
  response.writeHead(status, {
    "content-length": Buffer.byteLength(text),
    "content-type": contentType,
    "x-content-type-options": "nosniff"
  });
  response.end(text);
}

function displayHost(host: string): string {
  if (host === "0.0.0.0" || host === "::") {
    return "localhost";
  }

  if (host.includes(":")) {
    return `[${host}]`;
  }

  return host;
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw badRequest("Expected a JSON object.");
  }

  return value as Record<string, unknown>;
}

function requireString(value: unknown, property: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw badRequest(`Invalid ${property}. Expected a non-empty string.`);
  }

  return value;
}

function badRequest(message: string): Error & { readonly statusCode: number } {
  const error = new Error(message) as Error & { statusCode: number };
  error.statusCode = 400;
  return error;
}

function errorStatus(error: unknown): number {
  if (typeof error === "object" && error !== null && "statusCode" in error && error.statusCode === 400) {
    return 400;
  }

  return 500;
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

export function stateToPreviewColor(state: DeviceState): string {
  if (!state.power || state.effect === "off") {
    return "#111827";
  }

  return formatHexColor(state.color);
}

export function planEventSummary(events: readonly PlanEvent[]): readonly string[] {
  return events.map((event) => `${event.index}\t${event.command}\t${event.message}`);
}

export function normalizePlan(input: unknown): AgentPlan {
  return parsePlan(input);
}

const INDEX_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>ARGB Visualizer</title>
    <link rel="stylesheet" href="/styles.css">
  </head>
  <body>
    <main class="shell">
      <header class="topbar">
        <div>
          <h1>ARGB Visualizer</h1>
          <p id="summary">Loading harness state</p>
        </div>
        <button id="refresh" type="button" title="Refresh device state">Refresh</button>
      </header>
      <section class="workspace">
        <aside class="sidebar">
          <div class="section-title">Devices</div>
          <div id="devices" class="device-list"></div>
        </aside>
        <section class="preview-panel">
          <canvas id="preview" width="1120" height="560" aria-label="ARGB hardware preview"></canvas>
        </section>
        <aside class="controls">
          <div class="section-title">Control</div>
          <form id="control-form">
            <label>
              Device
              <select id="device-select"></select>
            </label>
            <label>
              Color
              <input id="color" type="color" value="#00aaff">
            </label>
            <label>
              Brightness
              <input id="brightness" type="range" min="0" max="100" value="100">
              <output id="brightness-value">100</output>
            </label>
            <label>
              Effect
              <select id="effect"></select>
            </label>
            <label>
              Speed
              <input id="speed" type="range" min="1" max="10" value="4">
              <output id="speed-value">4</output>
            </label>
            <div class="button-row">
              <button type="submit">Apply</button>
              <button id="turn-off" type="button" class="secondary">Off</button>
            </div>
          </form>
          <div class="section-title">Plan</div>
          <textarea id="plan-editor" spellcheck="false">{
  "version": 1,
  "steps": [
    { "command": "set", "deviceId": "motherboard-zone", "color": "#00aaff", "brightness": 65 },
    { "command": "effect", "deviceId": "gpu-strip", "effect": "rainbow", "speed": 4 },
    { "command": "set", "deviceId": "case-fans", "color": "#ff5500", "brightness": 50 }
  ]
}</textarea>
          <button id="run-plan" type="button">Run Plan</button>
          <pre id="log"></pre>
        </aside>
      </section>
    </main>
    <script src="/app.js"></script>
  </body>
</html>`;

const STYLES_CSS = `:root {
  color-scheme: dark;
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  background: #111315;
  color: #edf2f7;
}

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  min-width: 320px;
  background: #111315;
}

button,
input,
select,
textarea {
  font: inherit;
}

.shell {
  min-height: 100vh;
  display: flex;
  flex-direction: column;
}

.topbar {
  min-height: 76px;
  padding: 14px 22px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  border-bottom: 1px solid #2a3037;
  background: #181b1f;
}

h1 {
  margin: 0;
  font-size: 22px;
  line-height: 1.2;
  letter-spacing: 0;
}

p {
  margin: 5px 0 0;
  color: #a8b3c2;
}

.workspace {
  flex: 1;
  display: grid;
  grid-template-columns: minmax(210px, 260px) minmax(0, 1fr) minmax(280px, 340px);
  min-height: 0;
}

.sidebar,
.controls {
  padding: 18px;
  overflow: auto;
  border-color: #2a3037;
  border-style: solid;
}

.sidebar {
  border-width: 0 1px 0 0;
}

.controls {
  border-width: 0 0 0 1px;
}

.section-title {
  margin: 0 0 10px;
  color: #a8b3c2;
  font-size: 12px;
  font-weight: 700;
  text-transform: uppercase;
}

.device-list {
  display: grid;
  gap: 8px;
}

.device-card {
  width: 100%;
  padding: 10px;
  text-align: left;
  color: #edf2f7;
  background: #1c2127;
  border: 1px solid #2f3842;
  border-radius: 8px;
  cursor: pointer;
}

.device-card.active {
  border-color: #68d391;
  background: #223028;
}

.device-name {
  display: block;
  font-weight: 700;
  line-height: 1.25;
}

.device-meta {
  display: block;
  margin-top: 3px;
  color: #a8b3c2;
  font-size: 12px;
}

.preview-panel {
  min-width: 0;
  min-height: 0;
  display: flex;
  align-items: stretch;
  justify-content: stretch;
  background: #0d0f11;
}

canvas {
  width: 100%;
  height: 100%;
  display: block;
}

form {
  display: grid;
  gap: 12px;
  margin-bottom: 18px;
}

label {
  display: grid;
  gap: 6px;
  color: #cbd5e0;
  font-size: 13px;
}

input,
select,
textarea {
  width: 100%;
  color: #edf2f7;
  background: #171b20;
  border: 1px solid #35404b;
  border-radius: 6px;
}

input,
select {
  min-height: 36px;
  padding: 6px 8px;
}

input[type="color"] {
  padding: 3px;
}

input[type="range"] {
  padding: 0;
  accent-color: #68d391;
}

output {
  color: #a8b3c2;
  font-size: 12px;
}

button {
  min-height: 36px;
  padding: 7px 12px;
  color: #0d1410;
  background: #68d391;
  border: 1px solid #68d391;
  border-radius: 6px;
  font-weight: 700;
  cursor: pointer;
}

button.secondary {
  color: #edf2f7;
  background: #2a3037;
  border-color: #3d4651;
}

.button-row {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}

textarea {
  min-height: 220px;
  resize: vertical;
  padding: 10px;
  line-height: 1.45;
  font-family: "SFMono-Regular", Consolas, "Liberation Mono", monospace;
  font-size: 12px;
}

pre {
  min-height: 78px;
  max-height: 160px;
  overflow: auto;
  margin: 10px 0 0;
  padding: 10px;
  color: #cbd5e0;
  background: #0d0f11;
  border: 1px solid #2a3037;
  border-radius: 6px;
  white-space: pre-wrap;
}

@media (max-width: 980px) {
  .workspace {
    grid-template-columns: 1fr;
  }

  .sidebar,
  .controls {
    border-width: 0 0 1px;
  }

  .preview-panel {
    min-height: 420px;
    order: -1;
  }
}`;

const APP_JS = `"use strict";

const state = {
  devices: [],
  states: [],
  selectedId: "",
  phase: 0,
  fireSeed: Math.random() * 10000
};

const elements = {
  summary: document.getElementById("summary"),
  devices: document.getElementById("devices"),
  deviceSelect: document.getElementById("device-select"),
  color: document.getElementById("color"),
  brightness: document.getElementById("brightness"),
  brightnessValue: document.getElementById("brightness-value"),
  effect: document.getElementById("effect"),
  speed: document.getElementById("speed"),
  speedValue: document.getElementById("speed-value"),
  form: document.getElementById("control-form"),
  off: document.getElementById("turn-off"),
  refresh: document.getElementById("refresh"),
  runPlan: document.getElementById("run-plan"),
  planEditor: document.getElementById("plan-editor"),
  log: document.getElementById("log"),
  canvas: document.getElementById("preview")
};

const context = elements.canvas.getContext("2d");

elements.refresh.addEventListener("click", () => refresh());
elements.deviceSelect.addEventListener("change", () => selectDevice(elements.deviceSelect.value));
elements.brightness.addEventListener("input", () => {
  elements.brightnessValue.value = elements.brightness.value;
});
elements.speed.addEventListener("input", () => {
  elements.speedValue.value = elements.speed.value;
});
elements.form.addEventListener("submit", async (event) => {
  event.preventDefault();
  await applyControl();
});
elements.off.addEventListener("click", async () => {
  await postJson("/api/devices/" + encodeURIComponent(state.selectedId) + "/off", {});
  await refresh("Turned device off.");
});
elements.runPlan.addEventListener("click", async () => {
  const plan = JSON.parse(elements.planEditor.value);
  const result = await postJson("/api/plans/run", plan);
  setSnapshot(result.snapshot);
  elements.log.textContent = result.events.map((event) => event.index + "\\t" + event.command + "\\t" + event.message).join("\\n");
});

window.addEventListener("resize", resizeCanvas);

refresh();
requestAnimationFrame(tick);

async function refresh(message) {
  const snapshot = await getJson("/api/snapshot");
  setSnapshot(snapshot);
  if (message) {
    elements.log.textContent = message;
  }
}

function setSnapshot(snapshot) {
  state.devices = snapshot.devices;
  state.states = snapshot.states;

  if (!state.selectedId || !state.devices.some((device) => device.id === state.selectedId)) {
    state.selectedId = state.devices[0]?.id ?? "";
  }

  renderDeviceList();
  renderControls();
  elements.summary.textContent = state.devices.length + " device" + (state.devices.length === 1 ? "" : "s") + " in current harness";
}

function renderDeviceList() {
  elements.devices.replaceChildren(...state.devices.map((device) => {
    const current = getDeviceState(device.id);
    const button = document.createElement("button");
    button.type = "button";
    button.className = "device-card" + (device.id === state.selectedId ? " active" : "");
    button.addEventListener("click", () => selectDevice(device.id));
    button.innerHTML = "<span class=\\"device-name\\"></span><span class=\\"device-meta\\"></span>";
    button.querySelector(".device-name").textContent = device.name;
    button.querySelector(".device-meta").textContent = device.ledCount + " LEDs | " + current.effect + " | " + current.brightness + "%";
    return button;
  }));
}

function renderControls() {
  elements.deviceSelect.replaceChildren(...state.devices.map((device) => new Option(device.name, device.id)));
  elements.deviceSelect.value = state.selectedId;

  const selectedDevice = getSelectedDevice();
  const current = getDeviceState(state.selectedId);
  elements.effect.replaceChildren(...selectedDevice.supports.map((effect) => new Option(effect, effect)));
  elements.color.value = rgbToHex(current.color);
  elements.brightness.value = String(current.brightness);
  elements.brightnessValue.value = String(current.brightness);
  elements.effect.value = current.effect;
  elements.speed.value = String(current.speed ?? 4);
  elements.speedValue.value = String(current.speed ?? 4);
}

function selectDevice(deviceId) {
  state.selectedId = deviceId;
  renderDeviceList();
  renderControls();
}

async function applyControl() {
  const effect = elements.effect.value;
  const body = {
    effect,
    color: elements.color.value,
    brightness: Number(elements.brightness.value),
    speed: Number(elements.speed.value)
  };
  const endpoint = effect === "static" ? "set" : "effect";
  const payload = endpoint === "set" ? { color: body.color, brightness: body.brightness } : body;
  await postJson("/api/devices/" + encodeURIComponent(state.selectedId) + "/" + endpoint, payload);
  await refresh("Applied " + effect + " to " + state.selectedId + ".");
}

async function getJson(url) {
  const response = await fetch(url);
  return parseResponse(response);
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  return parseResponse(response);
}

async function parseResponse(response) {
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || response.statusText);
  }

  return data;
}

function tick(timestamp) {
  state.phase = timestamp / 1000;
  draw();
  requestAnimationFrame(tick);
}

function resizeCanvas() {
  const rect = elements.canvas.getBoundingClientRect();
  const ratio = window.devicePixelRatio || 1;
  elements.canvas.width = Math.max(640, Math.floor(rect.width * ratio));
  elements.canvas.height = Math.max(360, Math.floor(rect.height * ratio));
}

function draw() {
  resizeCanvas();
  const width = elements.canvas.width;
  const height = elements.canvas.height;
  context.clearRect(0, 0, width, height);
  context.fillStyle = "#0d0f11";
  context.fillRect(0, 0, width, height);

  if (state.devices.length === 0) {
    return;
  }

  const gap = height / (state.devices.length + 1);
  state.devices.forEach((device, index) => {
    const y = gap * (index + 1);
    const x = width * 0.08;
    const stripWidth = width * 0.84;
    drawDevice(device, getDeviceState(device.id), x, y, stripWidth, device.id === state.selectedId);
  });
}

function drawDevice(device, deviceState, x, y, width, selected) {
  const ledCount = Math.min(device.ledCount, 96);
  const spacing = width / ledCount;
  const radius = Math.max(4, Math.min(12, spacing * 0.34));

  context.fillStyle = selected ? "#223028" : "#181b1f";
  roundRect(context, x - 16, y - 44, width + 32, 88, 8);
  context.fill();

  context.fillStyle = "#edf2f7";
  context.font = Math.max(14, Math.floor(elements.canvas.width / 70)) + "px system-ui";
  context.fillText(device.name, x, y - 22);

  context.fillStyle = "#a8b3c2";
  context.font = Math.max(11, Math.floor(elements.canvas.width / 95)) + "px system-ui";
  context.fillText(device.ledCount + " LEDs | " + deviceState.effect + " | " + deviceState.brightness + "%", x, y + 36);

  for (let index = 0; index < ledCount; index += 1) {
    const color = ledColor(deviceState, index, ledCount);
    const ledX = x + spacing * index + spacing / 2;
    context.beginPath();
    context.arc(ledX, y + 5, radius, 0, Math.PI * 2);
    context.fillStyle = color;
    context.shadowColor = color;
    context.shadowBlur = deviceState.power ? radius * 2.2 : 0;
    context.fill();
  }

  context.shadowBlur = 0;
}

function ledColor(deviceState, index, count) {
  if (!deviceState.power || deviceState.effect === "off") {
    return "#22272f";
  }

  const brightness = deviceState.brightness / 100;
  if (deviceState.effect === "rainbow") {
    const hue = (index / count * 360 + state.phase * 55 * (deviceState.speed ?? 4)) % 360;
    return "hsl(" + hue + " 90% " + (28 + brightness * 42) + "%)";
  }

  if (deviceState.effect === "wave") {
    const pulse = (Math.sin(index / count * Math.PI * 4 - state.phase * (deviceState.speed ?? 4)) + 1) / 2;
    return scaleHex(rgbToHex(deviceState.color), brightness * (0.25 + pulse * 0.75));
  }

  if (deviceState.effect === "fire") {
    const speed = deviceState.speed ?? 3;
    const position = index / Math.max(1, count - 1);
    const drift = state.phase * speed * 0.42;
    const coarse = valueNoise(position * 3.4 - drift, state.fireSeed + 11);
    const detail = valueNoise(position * 11.8 + drift * 1.7, state.fireSeed + 37);
    const sparks = valueNoise(position * 27.0 - drift * 2.6, state.fireSeed + 83);
    const ember = sparks > 0.82 ? (sparks - 0.82) / 0.18 : 0;
    const heat = clamp(coarse * 0.58 + detail * 0.32 + ember * 0.4, 0, 1);
    return fireColor(heat, brightness);
  }

  if (deviceState.effect === "breathing") {
    const pulse = (Math.sin(state.phase * (deviceState.speed ?? 3)) + 1) / 2;
    return scaleHex(rgbToHex(deviceState.color), brightness * (0.25 + pulse * 0.75));
  }

  return scaleHex(rgbToHex(deviceState.color), brightness);
}

function rgbToHex(color) {
  return "#" + [color.red, color.green, color.blue].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function scaleHex(hex, amount) {
  const red = Math.round(parseInt(hex.slice(1, 3), 16) * amount);
  const green = Math.round(parseInt(hex.slice(3, 5), 16) * amount);
  const blue = Math.round(parseInt(hex.slice(5, 7), 16) * amount);
  return "rgb(" + red + " " + green + " " + blue + ")";
}

function fireColor(heat, brightness) {
  const red = 105 + Math.round(150 * Math.pow(heat, 0.75));
  const green = Math.round(10 + 210 * Math.pow(heat, 1.55));
  const blue = Math.round(2 + 28 * Math.max(0, heat - 0.78));
  return "rgb(" + Math.round(red * brightness) + " " + Math.round(green * brightness) + " " + Math.round(blue * brightness) + ")";
}

function valueNoise(x, seed) {
  const left = Math.floor(x);
  const fraction = x - left;
  const eased = fraction * fraction * (3 - 2 * fraction);
  return lerp(hashNoise(left, seed), hashNoise(left + 1, seed), eased);
}

function hashNoise(value, seed) {
  const wave = Math.sin(value * 127.1 + seed * 311.7) * 43758.5453123;
  return wave - Math.floor(wave);
}

function lerp(a, b, amount) {
  return a + (b - a) * amount;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function getSelectedDevice() {
  return state.devices.find((device) => device.id === state.selectedId) ?? state.devices[0];
}

function getDeviceState(deviceId) {
  return state.states.find((entry) => entry.deviceId === deviceId) ?? {
    deviceId,
    power: false,
    brightness: 100,
    color: { red: 255, green: 255, blue: 255 },
    effect: "off"
  };
}

function roundRect(canvasContext, x, y, width, height, radius) {
  canvasContext.beginPath();
  canvasContext.moveTo(x + radius, y);
  canvasContext.arcTo(x + width, y, x + width, y + height, radius);
  canvasContext.arcTo(x + width, y + height, x, y + height, radius);
  canvasContext.arcTo(x, y + height, x, y, radius);
  canvasContext.arcTo(x, y, x + width, y, radius);
  canvasContext.closePath();
}`;
