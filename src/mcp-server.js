#!/usr/bin/env node
// Stdio MCP server for Claude Desktop / Claude Code. It talks to a running
// FleetTrack server over its REST API, so both always see the same live data.
//   FLEETTRACK_URL=http://localhost:8080  FLEETTRACK_API_KEY=...  node src/mcp-server.js
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildMcpServer } from "./mcp-tools.js";
import { config } from "./config.js";

const BASE = (process.env.FLEETTRACK_URL || `http://localhost:${config.port}`).replace(/\/$/, "");
const KEY = process.env.FLEETTRACK_API_KEY || config.apiKey;

async function call(method, p, body) {
  let res;
  try {
    res = await fetch(BASE + p, {
      method,
      headers: { "Content-Type": "application/json", ...(KEY ? { "X-Api-Key": KEY } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new Error(`Can't reach FleetTrack at ${BASE}. Is the server running (npm start)?`);
  }
  if (res.status === 404 && method === "GET" && /\/(vehicles|shipments)\//.test(p)) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `FleetTrack answered ${res.status}`);
  return data;
}
const enc = encodeURIComponent;

const api = {
  summary: () => call("GET", "/api/summary"),
  vehicles: () => call("GET", "/api/vehicles"),
  vehicle: (q) => call("GET", "/api/vehicles/" + enc(q)),
  shipments: () => call("GET", "/api/shipments"),
  shipment: (id) => call("GET", "/api/shipments/" + enc(id)),
  alerts: () => call("GET", "/api/alerts"),
  places: () => call("GET", "/api/places"),
  events: () => call("GET", "/api/events"),
  geocode: (q, limit = 5) => call("GET", "/api/geocode?q=" + enc(q) + "&limit=" + limit),
  createShipment: (a) => call("POST", "/api/shipments", a),
  updateShipment: (id, patch) => call("PATCH", "/api/shipments/" + enc(id), patch),
};

const server = buildMcpServer(api, config.company);
await server.connect(new StdioServerTransport());
