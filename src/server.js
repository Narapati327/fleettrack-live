// FleetTrack Live server: dashboard + REST API + live stream (SSE) + MCP endpoint.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { config, ROOT } from "./config.js";
import { createStore } from "./store.js";
import { buildMcpServer } from "./mcp-tools.js";

const store = createStore();
const PUBLIC = path.join(ROOT, "public");
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".json": "application/json" };

function send(res, status, data, headers = {}) {
  const body = typeof data === "string" ? data : JSON.stringify(data);
  res.writeHead(status, { "Content-Type": typeof data === "string" ? "text/plain; charset=utf-8" : "application/json", "Cache-Control": "no-store", ...headers });
  res.end(body);
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
function authorized(req, url, pathKey) {
  if (!config.apiKey) return true;
  const h = req.headers["x-api-key"] || (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  const q = url.searchParams.get("key");
  return [h, q, pathKey].some((k) => k && safeEqual(k, config.apiKey));
}

async function readBody(req, limit = 1e6) {
  let size = 0; const chunks = [];
  for await (const c of req) { size += c.length; if (size > limit) throw Object.assign(new Error("Body too large"), { status: 413 }); chunks.push(c); }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw Object.assign(new Error("Body must be JSON"), { status: 400 }); }
}

function snapshot() {
  return { summary: store.summary(), vehicles: store.vehicles(), shipments: store.shipments().slice(0, 300), alerts: store.alerts(), events: store.events().slice(0, 30), places: store.places() };
}

const sseClients = new Set();
let pending = false;
store.bus.on("change", () => {
  if (pending || !sseClients.size) return;
  pending = true;
  setTimeout(() => { // coalesce bursts of changes into one push
    pending = false;
    const msg = `event: snapshot\ndata: ${JSON.stringify(snapshot())}\n\n`;
    for (const res of sseClients) res.write(msg);
  }, 250);
});
setInterval(() => { for (const res of sseClients) res.write(": ping\n\n"); }, 25000);

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const p = url.pathname;
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Api-Key, Authorization, Mcp-Session-Id, Mcp-Protocol-Version");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
  res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");
  if (req.method === "OPTIONS") return res.writeHead(204).end();

  try {
    // ---------- MCP (Streamable HTTP, stateless) ----------
    const mcpMatch = p.match(/^\/mcp(?:\/([^/]+))?\/?$/);
    if (mcpMatch) {
      if (!authorized(req, url, mcpMatch[1] && decodeURIComponent(mcpMatch[1]))) return send(res, 401, { error: "Missing or wrong API key" });
      if (req.method !== "POST") return send(res, 405, { jsonrpc: "2.0", error: { code: -32000, message: "Use POST" }, id: null }, { Allow: "POST" });
      const body = await readBody(req, 4e6);
      const mcp = buildMcpServer(apiFromStore, config.company);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on("close", () => { transport.close(); mcp.close(); });
      await mcp.connect(transport);
      await transport.handleRequest(req, res, body);
      return;
    }

    // ---------- REST API ----------
    if (p.startsWith("/api/")) {
      if (p === "/api/health") return send(res, 200, { ok: true, sources: store.summary().sources });
      if (!authorized(req, url)) return send(res, 401, { error: "Missing or wrong API key. Send it as the X-Api-Key header." });

      if (p === "/api/stream" && req.method === "GET") {
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive", "X-Accel-Buffering": "no" });
        res.write(`retry: 3000\nevent: snapshot\ndata: ${JSON.stringify(snapshot())}\n\n`);
        sseClients.add(res);
        req.on("close", () => sseClients.delete(res));
        return;
      }
      if (req.method === "GET") {
        if (p === "/api/snapshot") return send(res, 200, snapshot());
        if (p === "/api/summary") return send(res, 200, store.summary());
        if (p === "/api/vehicles") return send(res, 200, store.vehicles());
        if (p === "/api/alerts") return send(res, 200, store.alerts());
        if (p === "/api/places") return send(res, 200, store.places());
        if (p === "/api/events") return send(res, 200, store.events());
        if (p === "/api/geocode") return send(res, 200, await store.geocode(url.searchParams.get("q"), Math.min(10, Number(url.searchParams.get("limit")) || 5)).catch((e) => { throw Object.assign(e, { status: e.status || 400 }); }));
        if (p === "/api/shipments") {
          const st = url.searchParams.get("status");
          return send(res, 200, store.shipments().filter((s) => !st || (st === "open" ? s.status === "Pending" || s.status === "In transit" : s.status === st || s.displayStatus === st)));
        }
        let m;
        if ((m = p.match(/^\/api\/vehicles\/(.+)$/))) { const v = store.vehicle(decodeURIComponent(m[1])); return v ? send(res, 200, v) : send(res, 404, { error: "Vehicle not found" }); }
        if ((m = p.match(/^\/api\/shipments\/(.+)$/))) { const s = store.shipment(decodeURIComponent(m[1])); return s ? send(res, 200, s) : send(res, 404, { error: "Shipment not found" }); }
      }
      if (p === "/api/shipments" && req.method === "POST") return send(res, 201, await store.createShipment(await readBody(req)));
      const pm = p.match(/^\/api\/shipments\/(.+)$/);
      if (pm && req.method === "PATCH") return send(res, 200, await store.updateShipment(decodeURIComponent(pm[1]), await readBody(req)));
      if (p === "/api/refresh" && req.method === "POST") { await store.refresh(); return send(res, 200, { ok: true }); }
      return send(res, 404, { error: "Unknown API route" });
    }

    // ---------- Dashboard (static files) ----------
    if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, "Method not allowed");
    const file = path.normalize(path.join(PUBLIC, p === "/" ? "index.html" : p));
    if (!file.startsWith(PUBLIC)) return send(res, 403, "Forbidden");
    fs.readFile(file, (err, data) => {
      if (err) return send(res, 404, "Not found");
      res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-cache" });
      res.end(data);
    });
  } catch (e) {
    if (!res.headersSent) send(res, e.status || 500, { error: e.status ? e.message : "Server error: " + e.message });
    if (!e.status) console.error(e);
  }
});

const apiFromStore = {
  summary: () => store.summary(), vehicles: () => store.vehicles(), vehicle: (q) => store.vehicle(q),
  shipments: () => store.shipments(), shipment: (id) => store.shipment(id), alerts: () => store.alerts(),
  places: () => store.places(), events: () => store.events(), geocode: (q, l) => store.geocode(q, l),
  createShipment: (a) => store.createShipment(a), updateShipment: (id, p) => store.updateShipment(id, p),
};

await store.start();
server.listen(config.port, () => {
  const s = store.summary().sources;
  console.log(`\n  ${config.company} is live at http://localhost:${config.port}`);
  console.log(`  GPS: ${s.gps}   Records: ${s.records}   API key: ${config.apiKey ? "on" : "OFF (set API_KEY in .env)"}`);
  console.log(`  MCP endpoint: http://localhost:${config.port}/mcp\n`);
});
