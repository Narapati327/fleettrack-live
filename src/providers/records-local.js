// Records stored as JSON files in ./data (used when SHIPMENTS_PROVIDER=local).
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "../config.js";
import { SEED_PLACES, SEED_VEHICLES, seedShipments } from "./seed.js";

const DIR = path.join(ROOT, "data");
const file = (name) => path.join(DIR, name + ".json");

function read(name, seed) {
  try {
    return JSON.parse(fs.readFileSync(file(name), "utf8"));
  } catch {
    const data = typeof seed === "function" ? seed() : seed;
    write(name, data);
    return data;
  }
}
function write(name, data) {
  fs.mkdirSync(DIR, { recursive: true });
  const tmp = file(name) + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file(name));
}

export function createLocalRecords() {
  return {
    name: "local",
    async loadAll() {
      return {
        places: read("places", SEED_PLACES),
        vehicles: read("vehicles", SEED_VEHICLES),
        shipments: read("shipments", seedShipments),
      };
    },
    async savePlace(place) {
      const list = read("places", []);
      const i = list.findIndex((p) => p.name === place.name);
      if (i >= 0) list[i] = { ...list[i], lat: place.lat, lng: place.lng }; else list.push(place);
      write("places", list);
      return place;
    },
    async saveShipment(row) {
      const list = read("shipments", []);
      const i = list.findIndex((s) => s.id === row.id);
      if (i >= 0) list[i] = row;
      else list.unshift(row);
      write("shipments", list);
      return row;
    },
  };
}
