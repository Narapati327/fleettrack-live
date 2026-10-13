// Weather from Open-Meteo (https://open-meteo.com) — free, no API key.
// Fetches current conditions plus the next 3 hours for many points in one request.
// If Open-Meteo refuses (e.g. its free limit is used up by other apps on a shared cloud server),
// it falls back to MET Norway (https://api.met.no) — also free, no key.

const WMO = {
  0: "Clear", 1: "Mostly clear", 2: "Partly cloudy", 3: "Cloudy", 45: "Fog", 48: "Fog",
  51: "Light drizzle", 53: "Drizzle", 55: "Heavy drizzle", 56: "Freezing drizzle", 57: "Freezing drizzle",
  61: "Light rain", 63: "Rain", 65: "Heavy rain", 66: "Freezing rain", 67: "Freezing rain",
  71: "Snow", 73: "Snow", 75: "Snow", 77: "Snow", 80: "Rain showers", 81: "Heavy showers", 82: "Violent showers",
  95: "Thunderstorm", 96: "Thunderstorm, hail", 99: "Thunderstorm, hail",
};

// risk: 0 = fine, 1 = watch (wet roads), 2 = high (expect delays)
export function assess(w) {
  const code = w.code ?? 0;
  let risk = 0, reason = "";
  if ([51, 53, 55, 61, 80].includes(code) || w.precipMm >= 0.5 || w.nextRainProb >= 60) { risk = 1; reason = "Wet roads"; }
  if ([63, 65, 81, 82].includes(code) || w.precipMm >= 4) { risk = 2; reason = "Heavy rain"; }
  if (code >= 95) { risk = 2; reason = "Thunderstorm"; }
  if ((w.gustsKmh ?? 0) >= 60) { risk = 2; reason = "Strong winds"; }
  if (risk < 2 && w.nextRainMm >= 6 && w.nextRainProb >= 70) { risk = 2; reason = "Heavy rain expected"; }
  return { risk, reason };
}

const MET_URL = process.env.WEATHER_FALLBACK_URL || "https://api.met.no";
const MET_UA = `FleetTrack/1.0 (${process.env.GEOCODE_CONTACT_EMAIL || "https://github.com/fleettrack"})`;
const metCode = (sym = "") => /thunder/.test(sym) ? 95 : /heavyrain/.test(sym) ? 65 : /lightrain/.test(sym) ? 61 : /rain/.test(sym) ? 63
  : /snow|sleet/.test(sym) ? 71 : /fog/.test(sym) ? 45 : /partlycloudy/.test(sym) ? 2 : /cloudy/.test(sym) ? 3 : /fair/.test(sym) ? 1 : 0;

async function fromMetNorway(p) {
  const res = await fetch(`${MET_URL}/weatherapi/locationforecast/2.0/compact?lat=${p.lat.toFixed(3)}&lon=${p.lng.toFixed(3)}`, { headers: { "User-Agent": MET_UA } });
  if (!res.ok) throw new Error(`MET Norway answered ${res.status}`);
  const ts = ((await res.json()).properties || {}).timeseries || [];
  if (!ts.length) throw new Error("MET Norway returned no forecast");
  const now = ts[0].data || {}, inst = (now.instant || {}).details || {}, n1 = now.next_1_hours || {};
  const code = metCode((n1.summary || {}).symbol_code);
  const nextRainMm = ts.slice(0, 3).reduce((a, t) => a + ((((t.data || {}).next_1_hours || {}).details || {}).precipitation_amount || 0), 0);
  return {
    tempC: inst.air_temperature, precipMm: (n1.details || {}).precipitation_amount ?? 0, code, label: WMO[code] || "—",
    gustsKmh: inst.wind_speed != null ? Math.round(inst.wind_speed * 3.6 * 1.5) : null, // compact feed has mean wind only; gusts ≈ 1.5×
    nextRainProb: nextRainMm >= 0.5 ? 80 : nextRainMm > 0 ? 40 : 0, nextRainMm, time: new Date().toISOString(),
  };
}

export function createWeather({ enabled, baseUrl, refreshMinutes }) {
  const cache = new Map(); // "lat,lng" (2 decimals ≈ 1 km) -> weather
  const key = (lat, lng) => `${lat.toFixed(2)},${lng.toFixed(2)}`;
  const health = { ok: !enabled ? null : false, lastOk: null, error: enabled ? null : "off" };

  async function refresh(points) {
    if (!enabled) return;
    const uniq = [...new Map(points.filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng)).map((p) => [key(p.lat, p.lng), p])).values()];
    if (!uniq.length) { health.ok = true; health.lastOk = new Date().toISOString(); health.error = null; return; }
    let source = "Open-Meteo";
    try {
      for (let i = 0; i < uniq.length; i += 50) {
        const batch = uniq.slice(i, i + 50);
        const qs = new URLSearchParams({
          latitude: batch.map((p) => p.lat.toFixed(4)).join(","),
          longitude: batch.map((p) => p.lng.toFixed(4)).join(","),
          current: "temperature_2m,precipitation,weather_code,wind_gusts_10m",
          hourly: "precipitation_probability,precipitation",
          forecast_hours: "3",
          timezone: "Asia/Manila",
        });
        let body;
        try {
          const res = await fetch(`${baseUrl}/v1/forecast?${qs}`);
          if (!res.ok) throw new Error(`Open-Meteo answered ${res.status}`);
          body = await res.json();
        } catch (e) {
          console.error("[weather]", e.message, "- using MET Norway instead");
          source = "MET Norway";
          for (const p of batch) {
            const w = await fromMetNorway(p);
            Object.assign(w, assess(w));
            cache.set(key(p.lat, p.lng), w);
            await new Promise((r) => setTimeout(r, 200));
          }
          continue;
        }
        if (!Array.isArray(body)) body = [body]; // a single location returns one object
        body.forEach((r, j) => {
          const p = batch[j]; if (!p || !r || !r.current) return;
          const c = r.current, h = r.hourly || {};
          const probs = (h.precipitation_probability || []).filter((x) => x != null);
          const rain = (h.precipitation || []).filter((x) => x != null);
          const w = {
            tempC: c.temperature_2m, precipMm: c.precipitation ?? 0, code: c.weather_code, label: WMO[c.weather_code] || "—",
            gustsKmh: c.wind_gusts_10m, nextRainProb: probs.length ? Math.max(...probs) : 0, nextRainMm: rain.reduce((a, b) => a + b, 0),
            time: new Date().toISOString(),
          };
          Object.assign(w, assess(w));
          cache.set(key(p.lat, p.lng), w);
        });
      }
      health.ok = true; health.lastOk = new Date().toISOString(); health.error = null; health.source = source;
    } catch (e) {
      health.ok = false; health.error = e.message;
      console.error("[weather]", e.message);
    }
  }

  return {
    enabled,
    health,
    refreshMs: Math.max(5, refreshMinutes) * 60000,
    refresh,
    at: (lat, lng) => (Number.isFinite(lat) && Number.isFinite(lng) ? cache.get(key(lat, lng)) || null : null),
  };
}