// Smoke test: REST API, live stream, MCP over HTTP and MCP over stdio.
// Start the server first (npm start), then: npm test
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { config } from "../src/config.js";

const BASE = process.env.FLEETTRACK_URL || `http://localhost:${config.port}`;
const KEY = process.env.FLEETTRACK_API_KEY || config.apiKey;
const H = { "Content-Type": "application/json", ...(KEY ? { "X-Api-Key": KEY } : {}) };
let failed = 0;
const ok = (c, m) => { console.log((c ? "  ✓ " : "  ✗ ") + m); if (!c) failed++; };

const j = async (m, p, b) => { const r = await fetch(BASE + p, { method: m, headers: H, body: b && JSON.stringify(b) }); return { status: r.status, data: await r.json() }; };

console.log("REST API");
const sum = await j("GET", "/api/summary");
ok(sum.status === 200 && sum.data.vehicles.total > 0, `summary: ${sum.data.vehicles?.total} vehicles, ${sum.data.shipments?.inTransit} in transit`);
const created = await j("POST", "/api/shipments", { customer: "Smoke Test Store", destination: "Pasig", weightKg: 120 });
ok(created.status === 201 && created.data.status === "Pending", `create shipment → ${created.data.id} (${created.data.status})`);
const bad = await j("POST", "/api/shipments", { customer: "X", destination: "Nowhere" });
ok(bad.status === 400, `bad destination rejected: ${bad.data.error}`);
const upd = await j("PATCH", "/api/shipments/" + created.data.id, { status: "Cancelled" });
ok(upd.status === 200 && upd.data.status === "Cancelled", `update shipment → ${upd.data.status}`);
const noKey = await fetch(BASE + "/api/summary");
ok(!KEY || noKey.status === 401, "request without key is refused");

console.log("Live stream");
const ac = new AbortController();
const sr = await fetch(BASE + "/api/stream", { headers: H, signal: ac.signal });
const reader = sr.body.getReader();
const { value } = await reader.read();
ok(new TextDecoder().decode(value).includes("event: snapshot"), "stream sends a snapshot");
ac.abort();

async function mcpCheck(label, transport) {
  const c = new Client({ name: "smoke", version: "1.0.0" });
  await c.connect(transport);
  const tools = (await c.listTools()).tools.map((t) => t.name);
  ok(tools.includes("list_vehicles") && tools.includes("create_shipment"), `${label}: ${tools.length} tools`);
  const r = await c.callTool({ name: "get_vehicle", arguments: { vehicle: "NBX 4821" } });
  const v = JSON.parse(r.content[0].text);
  ok(v.plate === "NBX 4821", `${label}: get_vehicle NBX 4821 → ${v.state}, ${v.speedKmh} km/h`);
  const g = await c.callTool({ name: "find_address", arguments: { query: "SM Megamall" } });
  ok(!g.isError || /turned off|answered|fetch/i.test(g.content[0].text), `${label}: find_address → ${g.isError ? g.content[0].text : JSON.parse(g.content[0].text).length + " result(s)"}`);
  const e = await c.callTool({ name: "get_shipment", arguments: { id: "SHP-0000" } });
  ok(e.isError === true, `${label}: missing shipment returns an error`);
  await c.close();
}
console.log("MCP");
await mcpCheck("HTTP", new StreamableHTTPClientTransport(new URL(BASE + "/mcp"), { requestInit: { headers: KEY ? { "X-Api-Key": KEY } : {} } }));
await mcpCheck("stdio", new StdioClientTransport({ command: process.execPath, args: ["src/mcp-server.js"], env: { ...process.env, FLEETTRACK_URL: BASE, FLEETTRACK_API_KEY: KEY } }));

console.log(failed ? `\n${failed} check(s) failed` : "\nAll checks passed");
process.exit(failed ? 1 : 0);
