import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Minimal .env loader (no extra dependency). Real environment variables win.
const envFile = path.join(ROOT, ".env");
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m || line.trim().startsWith("#")) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}

const e = (k, d = "") => (process.env[k] ?? d).toString().trim();
const n = (k, d) => {
  const v = Number(process.env[k]);
  return Number.isFinite(v) && process.env[k] !== "" ? v : d;
};

export const config = {
  port: n("PORT", 8080),
  apiKey: e("API_KEY"),
  company: e("COMPANY_NAME", "FleetTrack"),
  gps: {
    provider: e("GPS_PROVIDER", "simulator"),
    pollSeconds: Math.max(5, n("GPS_POLL_SECONDS", 15)),
    url: e("GPS_API_URL"),
    key: e("GPS_API_KEY"),
    authHeader: e("GPS_AUTH_HEADER", "Authorization: Bearer {key}"),
    itemsPath: e("GPS_ITEMS_PATH"),
    fields: {
      id: e("GPS_FIELD_ID", "id"),
      lat: e("GPS_FIELD_LAT", "latitude"),
      lng: e("GPS_FIELD_LNG", "longitude"),
      speed: e("GPS_FIELD_SPEED", "speed"),
      heading: e("GPS_FIELD_HEADING", "heading"),
      fuel: e("GPS_FIELD_FUEL", "fuelPercent"),
      odometer: e("GPS_FIELD_ODOMETER", "odometerKm"),
      time: e("GPS_FIELD_TIME", "time"),
    },
    speedMultiplier: n("GPS_SPEED_MULTIPLIER", 1),
  },
  shipments: {
    provider: e("SHIPMENTS_PROVIDER", "local"),
    sheetsUrl: e("SHEETS_WEBAPP_URL"),
    sheetsSecret: e("SHEETS_SECRET"),
    syncSeconds: Math.max(10, n("SHEETS_SYNC_SECONDS", 30)),
  },
  alerts: {
    lowFuel: n("ALERT_LOW_FUEL", 20),
    overspeed: n("ALERT_OVERSPEED_KMH", 80),
    offlineMinutes: n("ALERT_OFFLINE_MINUTES", 10),
  },
  etaFallbackKmh: n("ETA_FALLBACK_KMH", 25),
  autoDeliverRadiusM: n("AUTO_DELIVER_RADIUS_M", 200),
  weather: {
    enabled: !/^(0|false|no|off)$/i.test(e("WEATHER_ENABLED", "true")),
    baseUrl: e("WEATHER_API_URL", "https://api.open-meteo.com"),
    refreshMinutes: n("WEATHER_REFRESH_MINUTES", 10),
    slowdownPercent: n("WEATHER_ETA_SLOWDOWN_PERCENT", 25),
  },
  geocode: {
    enabled: !/^(0|false|no|off)$/i.test(e("GEOCODE_ENABLED", "true")),
    baseUrl: e("GEOCODE_API_URL", "https://nominatim.openstreetmap.org"),
    countryCodes: e("GEOCODE_COUNTRY", "ph"),
    userAgent: e("GEOCODE_USER_AGENT", "FleetTrack/1.0 (" + (e("GEOCODE_CONTACT_EMAIL") || "logistics dashboard") + ")"),
  },
  telegram: {
    token: e("TELEGRAM_BOT_TOKEN"),
    chatId: e("TELEGRAM_CHAT_ID"),
    baseUrl: e("TELEGRAM_API_URL", "https://api.telegram.org"),
    notify: e("TELEGRAM_NOTIFY", "created,delivered,alerts"),
  },
};
