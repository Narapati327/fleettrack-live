// Address search with Nominatim / OpenStreetMap — free, no API key.
// Usage policy: identify the app with a User-Agent and send at most 1 request per second.
// https://operations.osmfoundation.org/policies/nominatim/

export function createGeocoder({ enabled, baseUrl, countryCodes, userAgent }) {
  const cache = new Map();
  let chain = Promise.resolve();
  let last = 0;
  const health = { ok: null, lastOk: null, error: enabled ? null : "off" };

  // Serialize requests and keep them ≥ 1.1 s apart.
  function throttled(fn) {
    const run = chain.then(async () => {
      const wait = last + 1100 - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      last = Date.now();
      return fn();
    });
    chain = run.catch(() => {});
    return run;
  }

  async function search(query, limit = 5) {
    const q = String(query || "").trim();
    if (!enabled) throw new Error("Address search is turned off (GEOCODE_ENABLED=false).");
    if (q.length < 3) throw new Error("Type at least 3 characters of the address.");
    const k = q.toLowerCase() + "|" + limit;
    if (cache.has(k)) return cache.get(k);
    return throttled(async () => {
      const qs = new URLSearchParams({ format: "jsonv2", q, limit: String(limit), addressdetails: "0" });
      if (countryCodes) qs.set("countrycodes", countryCodes);
      try {
        const res = await fetch(`${baseUrl}/search?${qs}`, { headers: { "User-Agent": userAgent, "Accept-Language": "en" } });
        if (!res.ok) throw new Error(`Address search answered ${res.status}`);
        const list = (await res.json()).map((r) => ({
          name: r.name || String(r.display_name || "").split(",")[0],
          address: r.display_name,
          lat: Number(r.lat),
          lng: Number(r.lon),
        })).filter((r) => Number.isFinite(r.lat) && Number.isFinite(r.lng));
        cache.set(k, list);
        health.ok = true; health.lastOk = new Date().toISOString(); health.error = null;
        return list;
      } catch (e) {
        health.ok = false; health.error = e.message;
        throw e;
      }
    });
  }

  return { enabled, health, search };
}
