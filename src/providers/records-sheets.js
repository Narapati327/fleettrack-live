// Records stored in a Google Sheet, reached through the Apps Script web app in google-apps-script/Code.gs.
// The sheet needs three tabs: Shipments, Vehicles, Places (Code.gs creates them on first run).

const SHIP_COLS = {
  "ID": "id", "Customer": "customer", "Destination": "destination", "Dest Lat": "destLat", "Dest Lng": "destLng",
  "Truck": "truck", "Weight kg": "weightKg", "Status": "status", "Due By": "dueBy", "Created At": "createdAt",
  "Delivered At": "deliveredAt", "Notes": "notes",
};
const VEH_COLS = { "ID": "id", "Plate": "plate", "Driver": "driver", "Phone": "phone", "Type": "type", "Capacity kg": "capacityKg", "Note": "note" };
const PLACE_COLS = { "Name": "name", "Lat": "lat", "Lng": "lng", "Depot": "depot" };

const NUM = new Set(["destLat", "destLng", "weightKg", "capacityKg", "lat", "lng"]);
const DATE = new Set(["dueBy", "createdAt", "deliveredAt"]);

function fromRow(row, cols) {
  const o = {};
  for (const [h, k] of Object.entries(cols)) {
    let v = row[h];
    if (v === undefined || v === null) v = "";
    if (NUM.has(k)) v = v === "" ? null : Number(v);
    else if (k === "depot") v = /^(y|yes|true|1)$/i.test(String(v).trim());
    else if (DATE.has(k)) v = v ? new Date(v).toISOString() : "";
    else v = String(v).trim();
    o[k] = v;
  }
  return o;
}
function toRow(obj, cols) {
  const r = {};
  for (const [h, k] of Object.entries(cols)) r[h] = obj[k] ?? "";
  return r;
}


// Reads the Places tab forgivingly: header spelling/case, "Latitude"/"Longitude",
// both numbers pasted into one cell ("14.58, 121.17"), comma decimals, swapped columns.
function parsePlaces(rows) {
  const places = [], warnings = [], pending = [];
  const norm = (h) => String(h).toLowerCase().replace(/[^a-z]/g, "");
  const pick = (row, names) => {
    for (const [h, v] of Object.entries(row)) if (names.includes(norm(h)) && v !== "" && v != null) return v;
    return "";
  };
  const num = (v) => {
    if (typeof v === "number") return v;
    const t = String(v).trim().replace(/[°NnEe]/g, "");
    if (!t) return NaN;
    return Number(/^-?\d+,\d+$/.test(t) ? t.replace(",", ".") : t);
  };
  rows.forEach((row, i) => {
    const name = String(pick(row, ["name", "place", "location"])).trim();
    let latRaw = pick(row, ["lat", "latitude"]);
    let lngRaw = pick(row, ["lng", "long", "lon", "longitude"]);
    if (!name && latRaw === "" && lngRaw === "") return; // empty row
    if (name && latRaw === "" && lngRaw === "") { // no numbers yet: the server looks the name up on the map
      pending.push({ name, depot: /^(y|yes|true|1|depot)$/i.test(String(pick(row, ["depot", "isdepot", "type"])).trim()) });
      return;
    }
    if (lngRaw === "" && /,/.test(String(latRaw)) && String(latRaw).split(",").length === 2) {
      [latRaw, lngRaw] = String(latRaw).split(",");
    }
    let lat = num(latRaw), lng = num(lngRaw);
    if (Math.abs(lat) > 90 && Math.abs(lng) <= 90) [lat, lng] = [lng, lat];
    const depot = /^(y|yes|true|1|depot)$/i.test(String(pick(row, ["depot", "isdepot", "type"])).trim());
    if (!name) { warnings.push(`Places row ${i + 2}: no Name`); return; }
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
      warnings.push(`Places row ${i + 2} (${name}): Lat/Lng not readable ("${latRaw}", "${lngRaw}")`);
      return;
    }
    places.push({ name, lat, lng, depot });
  });
  return { places, warnings, pending };
}

export function createSheetsRecords({ url, secret }) {
  if (!url || url.includes("XXXX")) throw new Error("SHEETS_WEBAPP_URL is not set. See README, step 3.");
  if (!secret) throw new Error("SHEETS_SECRET is not set. It must match SECRET in Code.gs.");

  async function call(body) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" }, // avoids a CORS preflight on Apps Script
      body: JSON.stringify({ secret, ...body }),
      redirect: "follow",
    });
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { throw new Error("Google Sheet did not return JSON. Check the web app is deployed with access 'Anyone'. Got: " + text.slice(0, 120)); }
    if (!data.ok) throw new Error("Google Sheet error: " + data.error);
    return data;
  }

  return {
    name: "sheets",
    async loadAll() {
      const d = await call({ action: "readAll" });
      return {
        shipments: (d.Shipments || []).map((r) => fromRow(r, SHIP_COLS)).filter((s) => s.id),
        vehicles: (d.Vehicles || []).map((r) => fromRow(r, VEH_COLS)).filter((v) => v.id),
        ...parsePlaces(d.Places || []),
      };
    },
    async savePlace(p) {
      await call({ action: "upsert", sheet: "Places", key: "Name", row: { "Name": p.name, "Lat": p.lat, "Lng": p.lng } });
      return p;
    },
    async saveShipment(s) {
      await call({ action: "upsert", sheet: "Shipments", key: "ID", row: toRow(s, SHIP_COLS) });
      return s;
    },
  };
}
