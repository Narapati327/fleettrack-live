// MCP tool definitions shared by the HTTP endpoint (/mcp) and the stdio server (mcp-server.js).
// `api` is any object with the methods used below: the live store, or a REST client.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const STATUS = ["Pending", "In transit", "Delivered", "Cancelled"];

const json = (data) => ({ content: [{ type: "text", text: JSON.stringify(data, null, 2) }] });
const fail = (e) => ({ isError: true, content: [{ type: "text", text: e.message || String(e) }] });
const wrap = (fn) => async (args) => { try { return json(await fn(args || {})); } catch (e) { return fail(e); } };

const slimVehicle = ({ trail, ...v }) => v;

export function buildMcpServer(api, company = "FleetTrack") {
  const server = new McpServer(
    { name: "fleettrack", version: "1.0.0" },
    { instructions: `Live data for ${company}'s trucks and shipments in Metro Manila. Times are ISO 8601 (UTC); convert to Asia/Manila (UTC+8) when talking to people. Vehicles can be referred to by ID (TRK-01) or plate (NBX 4821).` }
  );

  server.registerTool("fleet_summary", {
    title: "Fleet summary",
    description: "Current counts of trucks on the road, idle, offline and in maintenance; shipments in transit, delayed, pending and delivered today; 14-day on-time rate and daily delivery history; data-source health.",
    inputSchema: {},
    annotations: { readOnlyHint: true },
  }, wrap(() => api.summary()));

  server.registerTool("list_vehicles", {
    title: "List vehicles",
    description: "All trucks with live position, speed (km/h), fuel %, state (on route, stopped, idle, offline, maintenance), current shipment, destination and ETA in minutes.",
    inputSchema: { state: z.enum(["on route", "stopped", "idle", "moving", "offline", "maintenance"]).optional().describe("Only return trucks in this state") },
    annotations: { readOnlyHint: true },
  }, wrap(async ({ state }) => (await api.vehicles()).filter((v) => !state || v.state === state).map(slimVehicle)));

  server.registerTool("get_vehicle", {
    title: "Get vehicle",
    description: "Live details for one truck, including its recent GPS trail.",
    inputSchema: { vehicle: z.string().describe("Vehicle ID like TRK-01 or plate like NBX 4821") },
    annotations: { readOnlyHint: true },
  }, wrap(async ({ vehicle }) => {
    const v = await api.vehicle(vehicle);
    if (!v) throw new Error(`No vehicle matches "${vehicle}"`);
    return v;
  }));

  server.registerTool("list_shipments", {
    title: "List shipments",
    description: "Shipments with customer, destination, assigned truck, weight, status, due time, live ETA, weather at the destination and whether they are late. displayStatus is 'Delayed' for in-transit shipments expected to miss their due time.",
    inputSchema: {
      status: z.enum(["Pending", "In transit", "Delayed", "Delivered", "Cancelled", "open"]).optional().describe("Filter by status. 'open' = Pending or In transit. 'Delayed' = in transit and late."),
      search: z.string().optional().describe("Match customer name, shipment ID or destination"),
      limit: z.number().int().min(1).max(200).optional().describe("Max rows, newest first (default 50)"),
    },
    annotations: { readOnlyHint: true },
  }, wrap(async ({ status, search, limit = 50 }) => {
    const q = (search || "").toLowerCase();
    return (await api.shipments())
      .filter((s) => !status || (status === "open" ? s.status === "Pending" || s.status === "In transit" : status === "Delayed" ? s.displayStatus === "Delayed" : s.status === status))
      .filter((s) => !q || [s.id, s.customer, s.destination].some((x) => String(x).toLowerCase().includes(q)))
      .slice(0, limit);
  }));

  server.registerTool("get_shipment", {
    title: "Get shipment",
    description: "One shipment by ID, with live ETA and the assigned truck.",
    inputSchema: { id: z.string().describe("Shipment ID like SHP-1048") },
    annotations: { readOnlyHint: true },
  }, wrap(async ({ id }) => {
    const s = await api.shipment(id);
    if (!s) throw new Error(`Shipment ${id} not found`);
    return s;
  }));

  server.registerTool("list_alerts", {
    title: "List alerts",
    description: "Active problems: delayed shipments, bad weather at destinations, low fuel, overspeeding, offline trucks, unassigned or overdue shipments. Sorted critical first.",
    inputSchema: {},
    annotations: { readOnlyHint: true },
  }, wrap(() => api.alerts()));

  server.registerTool("list_places", {
    title: "List places",
    description: "Saved delivery locations (name, lat, lng) and the depot. Use these names as the destination when creating shipments.",
    inputSchema: {},
    annotations: { readOnlyHint: true },
  }, wrap(() => api.places()));

  server.registerTool("find_address", {
    title: "Find address",
    description: "Look up an address or place name on OpenStreetMap and return matching locations with lat/lng. Use before create_shipment when the destination is not a saved place.",
    inputSchema: { query: z.string().min(3).describe("Address or place, e.g. 'SM Megamall, Mandaluyong'"), limit: z.number().int().min(1).max(10).optional() },
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, wrap(({ query, limit }) => api.geocode(query, limit || 5)));

  server.registerTool("create_shipment", {
    title: "Create shipment",
    description: "Create a new shipment. If a truck is given it starts as 'In transit', otherwise 'Pending'. Destination can be a saved place name, any address (it is looked up on the map), or pass destLat and destLng.",
    inputSchema: {
      customer: z.string().min(1),
      destination: z.string().min(1).describe("Saved place name, or a label when destLat/destLng are given"),
      destLat: z.number().optional(),
      destLng: z.number().optional(),
      truck: z.string().optional().describe("Vehicle ID or plate"),
      weightKg: z.number().min(0).optional(),
      dueBy: z.string().optional().describe("Due time, ISO 8601, e.g. 2026-10-12T17:00:00+08:00"),
      notes: z.string().optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
  }, wrap((a) => api.createShipment(a)));

  server.registerTool("update_shipment", {
    title: "Update shipment",
    description: "Change a shipment's status, truck, due time, weight or notes. Setting status to Delivered records the delivery time.",
    inputSchema: {
      id: z.string(),
      status: z.enum(STATUS).optional(),
      truck: z.string().optional().describe("Vehicle ID or plate; empty string to unassign"),
      dueBy: z.string().optional(),
      weightKg: z.number().min(0).optional(),
      notes: z.string().optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  }, wrap(({ id, ...patch }) => api.updateShipment(id, patch)));

  server.registerTool("recent_activity", {
    title: "Recent activity",
    description: "The latest fleet events: deliveries, new shipments, status changes, connection messages.",
    inputSchema: { limit: z.number().int().min(1).max(100).optional() },
    annotations: { readOnlyHint: true },
  }, wrap(async ({ limit = 20 }) => (await api.events()).slice(0, limit)));

  return server;
}
