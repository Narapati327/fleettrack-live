// Central live state: merges GPS positions with vehicle and shipment records,
// computes ETAs, delays and alerts, and notifies listeners on every change.
import { EventEmitter } from "node:events";
import { config } from "./config.js";
import { distanceKm, etaMinutes } from "./geo.js";
import { createLocalRecords } from "./providers/records-local.js";
import { createSheetsRecords } from "./providers/records-sheets.js";
import { createSimulatorGps } from "./providers/gps-simulator.js";
import { createGenericGps } from "./providers/gps-generic.js";
import { createWeather } from "./services/weather.js";
import { createGeocoder } from "./services/geocode.js";
import { createTelegram } from "./services/telegram.js";

export const STATUSES = ["Pending", "In transit", "Delivered", "Cancelled"];

export function createStore() {
  const bus = new EventEmitter();
  bus.setMaxListeners(200);
  const records = config.shipments.provider === "sheets"
    ? createSheetsRecords({ url: config.shipments.sheetsUrl, secret: config.shipments.sheetsSecret })
    : createLocalRecords();
  const gps = config.gps.provider === "generic" ? createGenericGps(config.gps) : createSimulatorGps();
  const pollMs = (gps.name === "simulator" ? 3 : config.gps.pollSeconds) * 1000;
  const weather = createWeather(config.weather);
  const geocoder = createGeocoder(config.geocode);
  const tg = createTelegram(config.telegram);
  const TZ = "Asia/Manila";
  const clock = (iso) => new Date(iso || Date.now()).toLocaleTimeString("en-PH", { timeZone: TZ, hour: "numeric", minute: "2-digit" });

  let places = [], vehicles = [], shipments = [];
  const positions = new Map(); // vehicleId -> latest position
  const trails = new Map();    // vehicleId -> last 40 points
  const events = [];           // activity log
  const health = { gps: { ok: false, lastOk: null, error: null }, records: { ok: false, lastOk: null, error: null } };
  let version = 0;
  let lastWarn = "";
  let pendingPlaces = [];
  const geoTried = new Set();
  let alertKeys = null; // for Telegram: alerts already announced
  let ready = false;

  const log = (text, kind = "info") => {
    events.unshift({ at: new Date().toISOString(), text, kind });
    events.length = Math.min(events.length, 100);
  };
  const changed = () => { version++; bus.emit("change", version); };

  async function syncRecords() {
    try {
      const d = await records.loadAll();
      const okPlace = (p) => p && p.name && Number.isFinite(p.lat) && Number.isFinite(p.lng);
      places = d.places.filter(okPlace); vehicles = d.vehicles; shipments = d.shipments;
      pendingPlaces = (d.pending || []).concat(d.places.filter((p) => p && p.name && !okPlace(p)));
      geocodePendingPlaces();
      const w = (d.warnings || []).join(" | ");
      if (w && w !== lastWarn) { log("Sheet problem: " + w, "warning"); console.warn("[records]", w); }
      lastWarn = w;
      health.records = { ok: true, lastOk: new Date().toISOString(), error: null, warnings: d.warnings || [] };
      changed();
      announceAlerts();
    } catch (e) {
      health.records = { ...health.records, ok: false, error: e.message };
      console.error("[records]", e.message);
      changed();
    }
  }

  async function pollGps() {
    try {
      const pts = await gps.poll({ vehicles, shipments, places });
      for (const p of pts) {
        const prev = positions.get(p.id);
        positions.set(p.id, p);
        const t = trails.get(p.id) || [];
        if (!prev || prev.lat !== p.lat || prev.lng !== p.lng) {
          t.push([p.lat, p.lng]);
          if (t.length > 40) t.shift();
          trails.set(p.id, t);
        }
      }
      health.gps = { ok: true, lastOk: new Date().toISOString(), error: null };
      await autoDeliver();
      changed();
      announceAlerts();
    } catch (e) {
      health.gps = { ...health.gps, ok: false, error: e.message };
      console.error("[gps]", e.message);
      changed();
    }
  }

  // Places typed in the sheet without Lat/Lng: look them up by name and write the numbers back.
  async function geocodePendingPlaces() {
    if (!geocoder.enabled) return;
    const todo = pendingPlaces.filter((p) => !geoTried.has(p.name.toLowerCase())).slice(0, 3);
    for (const p of todo) {
      geoTried.add(p.name.toLowerCase());
      try {
        const [hit] = await geocoder.search(p.name, 1);
        if (!hit) { log(`Couldn't find "${p.name}" on the map. Add Lat/Lng in Places or write a fuller address as the Name.`, "warning"); continue; }
        const place = { name: p.name, lat: +hit.lat.toFixed(6), lng: +hit.lng.toFixed(6), depot: !!p.depot };
        if (records.savePlace) await records.savePlace(place);
        if (!places.some((x) => x.name === place.name)) places.push(place);
        pendingPlaces = pendingPlaces.filter((x) => x.name !== p.name);
        log(`Found map location for ${p.name} (${hit.address || "OpenStreetMap"})`, "system");
        changed();
      } catch (e) {
        geoTried.delete(p.name.toLowerCase());
        console.error("[geocode]", e.message);
        break;
      }
    }
  }

  async function refreshWeather() {
        const depot = places.find((p) => p.depot);
    const raw = (depot ? [{ lat: depot.lat, lng: depot.lng }] : [])
      .concat(shipments.filter((s) => (s.status === "Pending" || s.status === "In transit") && s.destLat != null).map((s) => ({ lat: s.destLat, lng: s.destLng })));
    const seen = new Set();
    const pts = raw.filter((p) => { const k = `${p.lat.toFixed(2)},${p.lng.toFixed(2)}`; if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 40);
    await weather.refresh(pts);
    changed();
    announceAlerts();
  }

  function announceAlerts() {
    if (!ready || !tg.wants("alerts")) return;
    const active = alerts().filter((a) => a.level !== "info");
    const keyOf = (a) => [a.type, a.vehicle || "", a.shipment || "", a.place || ""].join("|");
    if (alertKeys === null) {
      alertKeys = new Set(active.map(keyOf));
      tg.send(`🚚 ${config.company} control room is online (${clock()}). ${active.length ? active.length + " active alert(s):\n" + active.slice(0, 8).map((a) => "• " + a.text).join("\n") : "No active alerts."}`);
      return;
    }
    const now = new Set(active.map(keyOf));
    for (const a of active) if (!alertKeys.has(keyOf(a))) tg.send(`${a.level === "critical" ? "🔴" : "🟠"} ${a.text}`);
    alertKeys = now;
  }

  async function autoDeliver() {
    if (!config.autoDeliverRadiusM) return;
    for (const s of shipments) {
      if (s.status !== "In transit" || !s.truck || s.destLat == null) continue;
      const p = positions.get(s.truck);
      if (!p) continue;
      const d = distanceKm(p, { lat: s.destLat, lng: s.destLng });
      if (d != null && d * 1000 <= config.autoDeliverRadiusM && (p.speed ?? 0) < 5) {
        await updateShipment(s.id, { status: "Delivered" }, "auto");
      }
    }
  }

  // ---------- views ----------
  function vehicleView(v) {
    const p = positions.get(v.id);
    const ageMin = p ? (Date.now() - new Date(p.time)) / 60000 : Infinity;
    const offline = ageMin > config.alerts.offlineMinutes;
    const job = shipments.find((s) => s.truck === v.id && s.status === "In transit");
    let state = "idle";
    if (/maint/i.test(v.note || "")) state = "maintenance";
    else if (offline) state = "offline";
    else if (job) state = (p?.speed ?? 0) > 3 ? "on route" : "stopped";
    else if ((p?.speed ?? 0) > 3) state = "moving";
    const destWeather = job ? weather.at(job.destLat, job.destLng) : null;
    let eta = job && p && job.destLat != null ? etaMinutes(p, { lat: job.destLat, lng: job.destLng }, p.speed, config.etaFallbackKmh) : null;
    if (eta != null && destWeather && destWeather.risk >= 2) eta = Math.round(eta * (1 + config.weather.slowdownPercent / 100));
    const load = shipments.filter((s) => s.truck === v.id && (s.status === "In transit" || s.status === "Pending")).reduce((a, s) => a + (Number(s.weightKg) || 0), 0);
    return {
      ...v,
      state,
      position: p ? { lat: p.lat, lng: p.lng, heading: p.heading, time: p.time } : null,
      speedKmh: p?.speed ?? null,
      fuelPercent: p?.fuel ?? null,
      odometerKm: p?.odometer ?? null,
      lastSeenMinutes: Number.isFinite(ageMin) ? Math.round(ageMin) : null,
      currentShipment: job ? job.id : null,
      destination: job ? job.destination : null,
      etaMinutes: eta,
      destinationWeather: destWeather,
      loadKg: load,
      loadPercent: v.capacityKg ? Math.min(100, Math.round((load / v.capacityKg) * 100)) : null,
      trail: trails.get(v.id) || [],
    };
  }

  function shipmentView(s) {
    const v = vehicles.find((x) => x.id === s.truck);
    const p = positions.get(s.truck);
    let eta = null, etaAt = null;
    const open = s.status === "Pending" || s.status === "In transit";
    const w = open ? weather.at(s.destLat, s.destLng) : null;
    const weatherSlowdown = !!(w && w.risk >= 2);
    if (s.status === "In transit" && p && s.destLat != null) {
      eta = etaMinutes(p, { lat: s.destLat, lng: s.destLng }, p.speed, config.etaFallbackKmh);
      if (weatherSlowdown) eta = Math.round(eta * (1 + config.weather.slowdownPercent / 100));
      etaAt = new Date(Date.now() + eta * 60000).toISOString();
    }
    let late = false;
    if (s.dueBy) {
      const due = new Date(s.dueBy).getTime();
      if (s.status === "Delivered") late = s.deliveredAt && new Date(s.deliveredAt).getTime() > due;
      else if (s.status !== "Cancelled") late = (etaAt ? new Date(etaAt).getTime() : Date.now()) > due;
    }
    const display = s.status === "In transit" && late ? "Delayed" : s.status;
    return { ...s, plate: v ? v.plate : null, driver: v ? v.driver : null, etaMinutes: eta, etaAt, late: !!late, displayStatus: display, weather: w, weatherSlowdown };
  }

  function alerts() {
    const a = [];
    for (const v of vehicles.map(vehicleView)) {
      if (v.state === "maintenance") { a.push({ level: "info", type: "maintenance", vehicle: v.id, text: `${v.plate} is in maintenance` }); continue; }
      if (v.state === "offline") a.push({ level: "warning", type: "offline", vehicle: v.id, text: `${v.plate} has not reported for ${v.lastSeenMinutes ?? "?"} min` });
      if (v.fuelPercent != null && v.fuelPercent < config.alerts.lowFuel) a.push({ level: "critical", type: "low_fuel", vehicle: v.id, text: `${v.plate} fuel at ${Math.round(v.fuelPercent)}%` });
      if (v.speedKmh != null && v.speedKmh > config.alerts.overspeed) a.push({ level: "warning", type: "overspeed", vehicle: v.id, text: `${v.plate} at ${Math.round(v.speedKmh)} km/h` });
      if (v.loadPercent != null && v.loadPercent > 100) a.push({ level: "warning", type: "overload", vehicle: v.id, text: `${v.plate} is overloaded` });
    }
    for (const s of shipments.map(shipmentView)) {
      if (s.displayStatus === "Delayed") a.push({ level: "critical", type: "delayed", shipment: s.id, text: `${s.id} for ${s.customer} will miss its due time` });
      if (s.status === "Pending" && !s.truck) a.push({ level: "info", type: "unassigned", shipment: s.id, text: `${s.id} has no truck assigned` });
      if (s.status === "Pending" && s.late) a.push({ level: "warning", type: "overdue_pending", shipment: s.id, text: `${s.id} is past due and not dispatched` });
    }
    const byPlace = new Map();
    for (const s of shipments) {
      if (s.status !== "Pending" && s.status !== "In transit") continue;
      const w = weather.at(s.destLat, s.destLng);
      if (!w || w.risk < 1) continue;
      const k = s.destination;
      if (!byPlace.has(k)) byPlace.set(k, { w, ids: [] });
      byPlace.get(k).ids.push(s.id);
    }
    for (const [place, { w, ids }] of byPlace) {
      const list = ids.slice(0, 3).join(", ") + (ids.length > 3 ? ` +${ids.length - 3}` : "");
      a.push(w.risk >= 2
        ? { level: "warning", type: "weather", place, text: `${w.reason} at ${place} (${w.label}, ${Math.round(w.tempC)}°C): ${list} may be slower` }
        : { level: "info", type: "weather", place, text: `${w.reason} at ${place} (${w.label}): drive carefully` });
    }
    const rank = { critical: 0, warning: 1, info: 2 };
    return a.sort((x, y) => rank[x.level] - rank[y.level]);
  }

  function summary() {
    const sv = shipments.map(shipmentView);
    const vv = vehicles.map(vehicleView);
    const today = new Date().toDateString();
    const delivered = sv.filter((s) => s.status === "Delivered");
    const days = [];
    for (let i = 13; i >= 0; i--) {
      const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - i);
      const k = d.toDateString();
      const list = delivered.filter((s) => s.deliveredAt && new Date(s.deliveredAt).toDateString() === k);
      days.push({ date: d.toISOString().slice(0, 10), delivered: list.length, late: list.filter((s) => s.late).length });
    }
    const last14 = days.reduce((a, d) => a + d.delivered, 0);
    const late14 = days.reduce((a, d) => a + d.late, 0);
    return {
      company: config.company,
      time: new Date().toISOString(),
      vehicles: { total: vv.length, onRoute: vv.filter((v) => v.state === "on route" || v.state === "stopped").length, idle: vv.filter((v) => v.state === "idle").length, offline: vv.filter((v) => v.state === "offline").length, maintenance: vv.filter((v) => v.state === "maintenance").length },
      shipments: {
        inTransit: sv.filter((s) => s.status === "In transit").length,
        delayed: sv.filter((s) => s.displayStatus === "Delayed").length,
        pending: sv.filter((s) => s.status === "Pending").length,
        deliveredToday: delivered.filter((s) => new Date(s.deliveredAt).toDateString() === today).length,
      },
      onTimeRate14d: last14 ? Math.round(((last14 - late14) / last14) * 100) : null,
      daily: days,
      sources: { gps: gps.name, records: records.name, health: { ...health, weather: weather.health, geocode: geocoder.health, telegram: tg.health }, telegram: tg.enabled, weather: weather.enabled },
    };
  }

  // ---------- writes ----------
  function nextId() {
    const max = shipments.reduce((m, s) => Math.max(m, parseInt(String(s.id).replace(/\D/g, ""), 10) || 0), 1000);
    return "SHP-" + (max + 1);
  }

  async function createShipment(input) {
    const customer = String(input.customer || "").trim();
    if (!customer) throw httpError(400, "customer is required");
    let { destination, destLat, destLng } = input;
    const place = places.find((p) => p.name.toLowerCase() === String(destination || "").toLowerCase());
    if (place) { destination = place.name; destLat ??= place.lat; destLng ??= place.lng; }
    if (!destination) throw httpError(400, "destination is required");
    if ((destLat == null || destLng == null) && geocoder.enabled) {
      const [hit] = await geocoder.search(destination, 1).catch(() => []);
      if (hit) { destLat = hit.lat; destLng = hit.lng; }
    }
    if (destLat == null || destLng == null) throw httpError(400, `Couldn't find "${destination}". Use a saved place, a fuller address, or send destLat and destLng.`);
    const truck = input.truck ? findVehicle(input.truck)?.id : "";
    if (input.truck && !truck) throw httpError(400, `No vehicle matches "${input.truck}"`);
    const weightKg = Number(input.weightKg) || 0;
    if (weightKg < 0) throw httpError(400, "weightKg cannot be negative");
    const s = {
      id: nextId(), customer, destination, destLat: Number(destLat), destLng: Number(destLng), truck: truck || "",
      weightKg, status: input.status && STATUSES.includes(input.status) ? input.status : truck ? "In transit" : "Pending",
      dueBy: toIso(input.dueBy), createdAt: new Date().toISOString(), deliveredAt: "",
      notes: String(input.notes || ""),
    };
    await records.saveShipment(s);
    shipments.unshift(s);
    log(`New shipment ${s.id} for ${s.customer} to ${s.destination}${truck ? " on " + findVehicle(truck).plate : ""}`, "create");
    if (tg.wants("created")) tg.send(`🆕 ${s.id} for ${s.customer} → ${s.destination}${truck ? "\nTruck: " + findVehicle(truck).plate : "\nNo truck yet"}${s.weightKg ? "\nWeight: " + s.weightKg + " kg" : ""}${s.dueBy ? "\nDue: " + new Date(s.dueBy).toLocaleString("en-PH", { timeZone: TZ, month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : ""}`);
    changed();
    return shipmentView(s);
  }

  async function updateShipment(id, patch, by = "user") {
    const s = shipments.find((x) => x.id.toLowerCase() === String(id).toLowerCase());
    if (!s) throw httpError(404, `Shipment ${id} not found`);
    const next = { ...s };
    if (patch.status !== undefined) {
      if (!STATUSES.includes(patch.status)) throw httpError(400, `status must be one of: ${STATUSES.join(", ")}`);
      next.status = patch.status;
      if (patch.status === "Delivered" && !next.deliveredAt) next.deliveredAt = new Date().toISOString();
      if (patch.status !== "Delivered") next.deliveredAt = "";
    }
    if (patch.truck !== undefined) {
      if (patch.truck === "" || patch.truck === null) next.truck = "";
      else { const v = findVehicle(patch.truck); if (!v) throw httpError(400, `No vehicle matches "${patch.truck}"`); next.truck = v.id; }
      if (next.truck && next.status === "Pending" && patch.status === undefined) next.status = "In transit";
    }
    if (patch.dueBy !== undefined) next.dueBy = toIso(patch.dueBy);
    if (patch.notes !== undefined) next.notes = String(patch.notes);
    if (patch.weightKg !== undefined) next.weightKg = Number(patch.weightKg) || 0;
    await records.saveShipment(next);
    Object.assign(s, next);
    const v = vehicles.find((x) => x.id === s.truck);
    if (patch.status === "Delivered" && tg.wants("delivered")) tg.send(`📦 ${s.id} delivered to ${s.customer} (${s.destination})${v ? " by " + v.plate : ""} at ${clock(s.deliveredAt)}${by === "auto" ? " (auto-detected by GPS)" : ""}`);
    if (patch.status) log(`${s.id} ${by === "auto" ? "auto-marked" : "marked"} ${s.status}${v ? " (" + v.plate + ")" : ""}`, s.status === "Delivered" ? "delivered" : "update");
    else log(`${s.id} updated`, "update");
    changed();
    return shipmentView(s);
  }

  function findVehicle(q) {
    const k = String(q).toLowerCase().replace(/\s+/g, "");
    return vehicles.find((v) => v.id.toLowerCase() === k || v.plate.toLowerCase().replace(/\s+/g, "") === k);
  }

  return {
    bus,
    get version() { return version; },
    async start() {
      await syncRecords();
      log(`Connected · GPS: ${gps.name}, records: ${records.name}`, "system");
      await pollGps();
      setInterval(pollGps, pollMs);
      if (weather.enabled) { refreshWeather(); setInterval(refreshWeather, weather.refreshMs); }
      ready = true;
      announceAlerts();
      setInterval(syncRecords, (records.name === "sheets" ? config.shipments.syncSeconds : 60) * 1000);
    },
    places: () => places,
    vehicles: () => vehicles.map(vehicleView),
    vehicle: (q) => { const v = findVehicle(q); return v ? vehicleView(v) : null; },
    shipments: () => shipments.map(shipmentView),
    shipment: (id) => { const s = shipments.find((x) => x.id.toLowerCase() === String(id).toLowerCase()); return s ? shipmentView(s) : null; },
    alerts,
    summary,
    events: () => events,
    createShipment,
    updateShipment,
    refresh: async () => { await syncRecords(); await pollGps(); if (weather.enabled) await refreshWeather(); },
    geocode: (q, limit) => geocoder.search(q, limit),
    weatherAt: (lat, lng) => weather.at(lat, lng),
  };
}

function toIso(v) {
  if (!v) return "";
  const d = new Date(v);
  if (isNaN(d)) throw httpError(400, `"${v}" is not a valid date. Use a format like 2026-10-12T15:30:00+08:00`);
  return d.toISOString();
}

export function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}
