# FleetTrack Live

A live control room for your trucks and shipments.

- **Dashboard** in the browser that updates by itself (no refresh) with Philippine time.
- **Live GPS** from your telematics provider's API, shown on a real map with ETAs.
- **Shipments in Google Sheets**: your team keeps using the sheet; the dashboard reads and writes it.
- **REST API** so other apps can read the fleet or create shipments.
- **MCP server** so Claude can answer "Where is NBX 4821?", "Which deliveries are late?" or "Create a shipment for Santos Grocery to Pasig on TRK-02".

```
 GPS provider API ──┐                      ┌──> Dashboard (browser, live stream)
                    ├──> FleetTrack server ├──> REST API  (/api/...)
 Google Sheet  <────┘   (this project)     └──> MCP       (/mcp  or  stdio for Claude Desktop)
```

---

## 1. Run it on your computer (5 minutes)

You need **Node.js 18 or newer** (https://nodejs.org).

```bash
cd fleettrack-live
npm install
cp .env.example .env        # on Windows: copy .env.example .env
npm start
```

Open http://localhost:8080 and enter the `API_KEY` from `.env`.

It starts with the **GPS simulator** and **local records**, so you'll see moving demo trucks right away. Steps 2 and 3 switch each part to your real data.

Check that everything works (REST API, live stream, MCP over HTTP and stdio):

```bash
npm test        # with the server running in another window
```

---

## 2. Connect your GPS provider

Ask your provider (or check their developer docs) for:

1. The API URL that returns the **latest position of all vehicles**.
2. Your **API key / token** and how it's sent (header name).
3. A **sample response**, so you know the field names.

Then edit `.env`:

```ini
GPS_PROVIDER=generic
GPS_API_URL=https://api.example-gps.com/v1/vehicles/locations
GPS_API_KEY=your-key
GPS_AUTH_HEADER=Authorization: Bearer {key}
GPS_POLL_SECONDS=15
```

Map the fields. If the provider returns:

```json
{ "data": [ { "deviceId": "TRK-01", "location": { "lat": 14.65, "lng": 121.05 }, "speedKph": 42, "fuel": 63, "recordedAt": "2026-10-12T04:30:00Z" } ] }
```

set:

```ini
GPS_ITEMS_PATH=data
GPS_FIELD_ID=deviceId
GPS_FIELD_LAT=location.lat
GPS_FIELD_LNG=location.lng
GPS_FIELD_SPEED=speedKph
GPS_FIELD_FUEL=fuel
GPS_FIELD_TIME=recordedAt
```

Leave a field empty or pointing to a missing name if your provider doesn't send it (fuel, odometer, heading are optional). Times can be ISO text or Unix seconds/milliseconds. If speed is in mph, set `GPS_SPEED_MULTIPLIER=1.609`.

**Important:** the vehicle `ID` in your Vehicles list must match the provider's device/unit ID (`GPS_FIELD_ID`). That's how a GPS dot becomes "NBX 4821, driver Ramon Cruz".

Restart (`npm start`). The top bar shows `GPS: generic`; hover it to see the last update or any error.

> If your provider needs a login step (session token) instead of a fixed key, or uses an unusual format, send the API docs and a sample response and the adapter in `src/providers/gps-generic.js` can be extended for it.

---

## 3. Connect your Google Sheet

1. Create a Google Sheet (or open the one you use for orders).
2. **Extensions → Apps Script**. Delete what's there and paste everything from `google-apps-script/Code.gs`.
3. Change `SECRET` at the top to a long random text. Save.
4. **Deploy → New deployment → type: Web app**
   - Execute as: **Me**
   - Who has access: **Anyone** (the SECRET protects it)
   - Authorize when asked, then copy the **Web app URL**.
5. In `.env`:
   ```ini
   SHIPMENTS_PROVIDER=sheets
   SHEETS_WEBAPP_URL=https://script.google.com/macros/s/....../exec
   SHEETS_SECRET=the-same-secret
   SHEETS_SYNC_SECONDS=30
   ```
6. Restart the server. The script creates three tabs on first use:

| Tab | Columns | Notes |
|---|---|---|
| **Shipments** | ID, Customer, Destination, Dest Lat, Dest Lng, Truck, Weight kg, Status, Due By, Created At, Delivered At, Notes | Status: `Pending`, `In transit`, `Delivered`, `Cancelled`. Truck = vehicle ID. |
| **Vehicles** | ID, Plate, Driver, Phone, Type, Capacity kg, Note | Put `Maintenance` in Note to take a truck out of service. |
| **Places** | Name, Lat, Lng, Depot | Your depot (Depot = yes) and regular delivery points. |

Edits made in the sheet show on the dashboard within `SHEETS_SYNC_SECONDS`. Shipments created or updated on the dashboard, API or Claude are written back to the sheet immediately. You can add your own extra columns; they're kept.

> If you change Code.gs later, use **Deploy → Manage deployments → Edit → New version** so the URL stays the same.

**Excel instead of Sheets?** Upload the workbook to Google Drive and open it with Google Sheets (File → Save as Google Sheets), then follow the steps above. Excel on OneDrive/SharePoint can be added as another provider later through Microsoft Graph.

---

## 4. Use it with Claude (MCP)

The server offers these tools: `fleet_summary`, `list_vehicles`, `get_vehicle`, `list_shipments`, `get_shipment`, `list_alerts`, `list_places`, `find_address`, `create_shipment`, `update_shipment`, `recent_activity`.

### Claude Desktop (on the same computer as the server)

Settings → Developer → Edit Config, and add:

```json
{
  "mcpServers": {
    "fleettrack": {
      "command": "node",
      "args": ["C:/path/to/fleettrack-live/src/mcp-server.js"],
      "env": {
        "FLEETTRACK_URL": "http://localhost:8080",
        "FLEETTRACK_API_KEY": "your API_KEY"
      }
    }
  }
}
```

Restart Claude Desktop. The FleetTrack server must be running (`npm start`).

### Claude Code

```bash
claude mcp add fleettrack --env FLEETTRACK_URL=http://localhost:8080 --env FLEETTRACK_API_KEY=your-key -- node /path/to/fleettrack-live/src/mcp-server.js
```

### claude.ai (web and mobile) as a custom connector

This needs the server on the internet with HTTPS (step 5). Then in claude.ai: **Settings → Connectors → Add custom connector** and use:

```
https://your-server.example.com/mcp/YOUR_API_KEY
```

The key in the URL is what protects it, so treat that URL like a password. (Other MCP clients can call `https://your-server/mcp` with the header `X-Api-Key: YOUR_API_KEY` instead.)

Things to try:
- "Give me a fleet summary."
- "Which shipments will be late today and why?"
- "Where is NAQ 7734 and when will it reach Taguig?"
- "Assign SHP-1043 to TRK-04."
- "Create a shipment: Santos Grocery, Antipolo, 900 kg, due 5pm today, on NBX 4821."

---

## 4b. Weather, address search and Telegram alerts

These are on by default except Telegram. Settings are in `.env` (copy any missing lines from `.env.example`).

**Weather (Open-Meteo, free, no key).** Every 10 minutes the server checks the weather at your places and at every open shipment's destination. You'll see:
- a weather tag on each open shipment (hover it for rain chance and wind),
- weather at the selected truck's destination,
- an alert like "Heavy rain at Pasig: SHP-1048 may be slower",
- ETAs stretched by `WEATHER_ETA_SLOWDOWN_PERCENT` (25% by default) during heavy rain, storms or strong wind.

**Address search (Nominatim / OpenStreetMap, free, no key).**
- Dashboard: **+ New shipment → Destination → Other location…**, type an address, click **Find on map**, and pick the right result.
- Google Sheet: in **Places**, type a Name like `SM Megamall, Mandaluyong` and leave Lat/Lng empty. The server finds it and writes the numbers into the sheet for you.
- API / Claude: a shipment's destination can be any address; it's looked up automatically. Claude also gets a `find_address` tool.
- Put your email in `GEOCODE_CONTACT_EMAIL`. OpenStreetMap asks apps to identify themselves, and the server keeps to their limit of 1 search per second.

**Telegram alerts (free).**
1. In Telegram, search for **@BotFather**, send `/newbot`, choose a name and a username ending in `bot`.
2. Copy the token it gives you into `.env`: `TELEGRAM_BOT_TOKEN=123456:ABC...`
3. Open your new bot in Telegram, press **Start**, and send it `hi`. For a team group: add the bot to the group and send a message there.
4. In VS Code's terminal run `npm.cmd run telegram` (or `npm run telegram`). It prints your chat ID.
5. Put it in `.env`: `TELEGRAM_CHAT_ID=123456789`, then run `npm.cmd run telegram` again to get a test message.
6. Restart the server. You'll get a message when it starts, for new shipments, deliveries, and each new alert (delays, low fuel, offline trucks, heavy rain). Choose which with `TELEGRAM_NOTIFY`.

## 5. Put it online so the whole team can use it

Any host that runs Node.js works: a small VPS (DigitalOcean, Linode, AWS Lightsail), Render, Railway or Fly.io.

- Set the same variables from `.env` in the host's environment settings.
- **Always set a strong `API_KEY`** before going online.
- Use HTTPS (Render, Railway and Fly give it automatically; on a VPS use Caddy or Nginx).
- Docker is included: `docker build -t fleettrack . && docker run -p 8080:8080 --env-file .env fleettrack`

With `SHIPMENTS_PROVIDER=local`, records live in `data/` on the server, so give it a persistent disk. With Google Sheets, nothing important is stored on the server.

---

## REST API

Send `X-Api-Key: YOUR_API_KEY` with every request (or `?key=` for the live stream).

| Method | Path | What it does |
|---|---|---|
| GET | `/api/health` | Server and data-source health (no key needed) |
| GET | `/api/summary` | Counts, on-time rate, 14-day history |
| GET | `/api/vehicles` · `/api/vehicles/{id or plate}` | Live vehicles |
| GET | `/api/shipments?status=Delayed` · `/api/shipments/{id}` | Shipments with live ETA |
| GET | `/api/alerts` · `/api/places` · `/api/events` | Alerts, saved places, activity |
| GET | `/api/geocode?q=address` | Address search (OpenStreetMap) |
| GET | `/api/stream` | Server-Sent Events: a full snapshot on every change |
| POST | `/api/shipments` | Create: `{customer, destination, truck?, weightKg?, dueBy?, notes?}` |
| PATCH | `/api/shipments/{id}` | Update: `{status?, truck?, dueBy?, weightKg?, notes?}` |
| POST | `/api/refresh` | Re-read the sheet and GPS now |
| POST | `/mcp` · `/mcp/{key}` | MCP (Streamable HTTP) |

## How the live numbers are worked out

- **ETA**: straight-line distance × 1.3 (city road factor) ÷ current speed, or `ETA_FALLBACK_KMH` when the truck is stopped or crawling. Good for a dashboard; for turn-by-turn accuracy, a routing API (Google, Mapbox, OSRM) can be added in `src/geo.js`.
- **Delayed**: an in-transit shipment whose ETA is after its Due By.
- **Auto-delivered**: when the assigned truck stops within `AUTO_DELIVER_RADIUS_M` of the destination. Set it to 0 to mark deliveries only by hand.
- **Offline**: no GPS report for `ALERT_OFFLINE_MINUTES`.
- **Alerts**: low fuel, overspeed, offline, overload, delayed, unassigned and overdue shipments. Thresholds are in `.env`.

## Project files

```
src/server.js              web server: dashboard, REST API, live stream, /mcp
src/store.js               live state, ETAs, delays, alerts
src/mcp-tools.js           MCP tool definitions
src/mcp-server.js          stdio MCP server for Claude Desktop / Claude Code
src/providers/gps-*.js     GPS sources (generic REST API, simulator)
src/providers/records-*.js shipment/vehicle/place records (Google Sheets, local JSON)
src/services/weather.js    Open-Meteo weather and risk
src/services/geocode.js    OpenStreetMap address search
src/services/telegram.js   Telegram alerts
src/telegram-setup.js      finds your Telegram chat ID, sends a test
public/index.html          the dashboard
google-apps-script/Code.gs Google Sheets bridge
test/smoke.js              end-to-end check
```
