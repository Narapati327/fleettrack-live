// Works with most GPS / telematics providers that offer a REST endpoint returning
// the latest position of every vehicle as JSON. Configure field names in .env.
import { getPath } from "../geo.js";

export function createGenericGps(cfg) {
  if (!cfg.url) throw new Error("GPS_API_URL is not set.");
  const [hName, ...rest] = cfg.authHeader.split(":");
  const headers = { Accept: "application/json" };
  if (cfg.key && hName) headers[hName.trim()] = rest.join(":").trim().replace("{key}", cfg.key);

  return {
    name: "generic",
    async poll() {
      const res = await fetch(cfg.url, { headers });
      if (!res.ok) throw new Error(`GPS API answered ${res.status} ${res.statusText}`);
      const body = await res.json();
      const items = getPath(body, cfg.itemsPath);
      if (!Array.isArray(items)) throw new Error(`GPS API: no list found at "${cfg.itemsPath || "(root)"}". Check GPS_ITEMS_PATH.`);
      const f = cfg.fields;
      const num = (v) => (v === undefined || v === null || v === "" ? null : Number(v));
      return items
        .map((it) => {
          const t = getPath(it, f.time);
          const time = t == null ? new Date() : typeof t === "number" ? new Date(t < 1e12 ? t * 1000 : t) : new Date(t);
          const speed = num(getPath(it, f.speed));
          return {
            id: String(getPath(it, f.id) ?? ""),
            lat: num(getPath(it, f.lat)),
            lng: num(getPath(it, f.lng)),
            speed: speed == null ? null : speed * cfg.speedMultiplier,
            heading: num(getPath(it, f.heading)),
            fuel: num(getPath(it, f.fuel)),
            odometer: num(getPath(it, f.odometer)),
            time: isNaN(time) ? new Date().toISOString() : time.toISOString(),
          };
        })
        .filter((p) => p.id && Number.isFinite(p.lat) && Number.isFinite(p.lng));
    },
  };
}
