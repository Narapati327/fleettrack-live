/**
 * FleetTrack ⇄ Google Sheets bridge.
 *
 * Paste this into Extensions → Apps Script in your Google Sheet, set SECRET,
 * then Deploy → New deployment → Web app (Execute as: Me, Who has access: Anyone).
 * Copy the web app URL into SHEETS_WEBAPP_URL in the server's .env file.
 *
 * The script creates three tabs on first use: Shipments, Vehicles, Places.
 * Only requests that send the right SECRET can read or change the sheet.
 */

const SECRET = "CHANGE-ME-to-the-same-value-as-SHEETS_SECRET";

const TABS = {
  Shipments: ["ID", "Customer", "Destination", "Dest Lat", "Dest Lng", "Truck", "Weight kg", "Status", "Due By", "Created At", "Delivered At", "Notes"],
  Vehicles: ["ID", "Plate", "Driver", "Phone", "Type", "Capacity kg", "Note"],
  Places: ["Name", "Lat", "Lng", "Depot"],
};

const EXAMPLES = {
  Vehicles: [
    ["TRK-01", "NBX 4821", "Ramon Cruz", "0917 555 0101", "10-wheeler wing van", 12000, ""],
    ["TRK-02", "NCF 2210", "Joel Ramos", "0917 555 0102", "6-wheeler closed van", 6000, ""],
  ],
  Places: [
    ["Valenzuela DC", 14.7011, 120.983, "yes"],
    ["Quezon City", 14.6488, 121.0509, ""],
    ["Makati", 14.5547, 121.0244, ""],
    ["Pasig", 14.5764, 121.0851, ""],
  ],
};

function doPost(e) {
  try {
    const req = JSON.parse(e.postData.contents || "{}");
    if (!SECRET || SECRET.indexOf("CHANGE-ME") === 0) return out({ ok: false, error: "Set SECRET at the top of Code.gs and redeploy." });
    if (req.secret !== SECRET) return out({ ok: false, error: "Wrong secret" });

    if (req.action === "readAll") {
      const res = { ok: true };
      Object.keys(TABS).forEach(function (name) { res[name] = readTab(name); });
      return out(res);
    }
    if (req.action === "upsert") {
      if (!TABS[req.sheet]) return out({ ok: false, error: "Unknown sheet " + req.sheet });
      upsert(req.sheet, req.key || TABS[req.sheet][0], req.row || {});
      return out({ ok: true });
    }
    return out({ ok: false, error: "Unknown action" });
  } catch (err) {
    return out({ ok: false, error: String(err && err.message || err) });
  }
}

function doGet() {
  return out({ ok: true, message: "FleetTrack bridge is running. The server talks to it with POST requests." });
}

function out(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function sheet(name) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.getRange(1, 1, 1, TABS[name].length).setValues([TABS[name]]).setFontWeight("bold");
    sh.setFrozenRows(1);
    if (EXAMPLES[name]) sh.getRange(2, 1, EXAMPLES[name].length, TABS[name].length).setValues(EXAMPLES[name]);
  }
  return sh;
}

function readTab(name) {
  const sh = sheet(name);
  const values = sh.getDataRange().getValues();
  if (values.length < 2) return [];
  const head = values[0].map(String);
  return values.slice(1)
    .filter(function (r) { return r.some(function (c) { return c !== "" && c !== null; }); })
    .map(function (r) {
      const o = {};
      head.forEach(function (h, i) { o[h] = r[i] instanceof Date ? r[i].toISOString() : r[i]; });
      return o;
    });
}

function upsert(name, key, row) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const sh = sheet(name);
    const values = sh.getDataRange().getValues();
    const head = values[0].map(String);
    const k = head.indexOf(key);
    if (k < 0) throw new Error("Column " + key + " not found in " + name);
    const line = head.map(function (h) { return row[h] === undefined ? "" : row[h]; });
    for (let i = 1; i < values.length; i++) {
      if (String(values[i][k]) === String(row[key])) {
        // Keep values in columns the server doesn't know about (your own extra columns).
        const merged = head.map(function (h, j) { return row[h] === undefined ? values[i][j] : row[h]; });
        sh.getRange(i + 1, 1, 1, head.length).setValues([merged]);
        return;
      }
    }
    sh.appendRow(line);
  } finally {
    lock.releaseLock();
  }
}
