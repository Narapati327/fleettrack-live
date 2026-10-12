// Example records used on first run (local mode) and by the simulator.
// Replace them with your own in data/*.json or in your Google Sheet.

export const SEED_PLACES = [
  { name: "Valenzuela DC", lat: 14.7011, lng: 120.983, depot: true },
  { name: "Quezon City", lat: 14.6488, lng: 121.0509 },
  { name: "Antipolo", lat: 14.5873, lng: 121.176 },
  { name: "Pasig", lat: 14.5764, lng: 121.0851 },
  { name: "Manila", lat: 14.5995, lng: 120.9842 },
  { name: "Makati", lat: 14.5547, lng: 121.0244 },
  { name: "Taguig", lat: 14.5176, lng: 121.0509 },
  { name: "Parañaque", lat: 14.4793, lng: 121.0198 },
  { name: "Bacoor", lat: 14.4624, lng: 120.9645 },
  { name: "Caloocan", lat: 14.6507, lng: 120.9676 },
];

export const SEED_VEHICLES = [
  { id: "TRK-01", plate: "NBX 4821", driver: "Ramon Cruz", phone: "0917 555 0101", type: "10-wheeler wing van", capacityKg: 12000, note: "" },
  { id: "TRK-02", plate: "NCF 2210", driver: "Joel Ramos", phone: "0917 555 0102", type: "6-wheeler closed van", capacityKg: 6000, note: "" },
  { id: "TRK-03", plate: "NAQ 7734", driver: "Mark Villanueva", phone: "0917 555 0103", type: "Reefer truck", capacityKg: 5000, note: "" },
  { id: "TRK-04", plate: "NDE 1198", driver: "Ana Bautista", phone: "0917 555 0104", type: "4-wheeler L300", capacityKg: 1500, note: "" },
  { id: "TRK-05", plate: "NBL 5562", driver: "Paolo Garcia", phone: "0917 555 0105", type: "10-wheeler wing van", capacityKg: 12000, note: "" },
  { id: "TRK-06", plate: "NCA 3087", driver: "Rico Mendoza", phone: "0917 555 0106", type: "6-wheeler dropside", capacityKg: 6000, note: "Maintenance" },
];

export function seedShipments() {
  const now = Date.now();
  const iso = (msAgo) => new Date(now - msAgo).toISOString();
  const later = (min) => new Date(now + min * 60000).toISOString();
  const H = 3600000, D = 86400000;
  const rows = [
    ["SHP-1048", "Santos Grocery", "Antipolo", "TRK-01", 1200, "In transit", later(180)],
    ["SHP-1047", "Mabuhay Mart", "Parañaque", "TRK-02", 860, "In transit", later(160)],
    ["SHP-1046", "FreshCo Foods", "Taguig", "TRK-03", 1450, "In transit", later(15)],
    ["SHP-1045", "Lucky 7 Store", "Bacoor", "TRK-04", 420, "Pending", later(240)],
    ["SHP-1044", "Golden Rice Depot", "Makati", "TRK-05", 1680, "In transit", later(150)],
    ["SHP-1043", "Dela Cruz Sari-sari", "Caloocan", "", 310, "Pending", later(300)],
  ].map(([id, customer, destination, truck, weightKg, status, dueBy]) => {
    const p = SEED_PLACES.find((x) => x.name === destination);
    return { id, customer, destination, destLat: p.lat, destLng: p.lng, truck, weightKg, status, dueBy, createdAt: iso(2 * H), deliveredAt: "", notes: "" };
  });
  // Some delivered history for the last 14 days so the chart has data.
  let n = 1000;
  for (let d = 13; d >= 0; d--) {
    const count = d === 0 ? 3 : 4 + ((d * 7) % 5);
    for (let k = 0; k < count; k++) {
      const p = SEED_PLACES[1 + ((d + k) % (SEED_PLACES.length - 1))];
      const due = now - d * D - (k + 2) * H;
      const late = (d + k) % 6 === 0;
      rows.push({
        id: "SHP-" + n++, customer: ["Metro Pharmacy", "Ilaw Hardware", "Bayan Bakery", "Sunrise Mart", "Aling Nena Store"][k % 5],
        destination: p.name, destLat: p.lat, destLng: p.lng, truck: SEED_VEHICLES[k % 5].id, weightKg: 300 + ((k * 211) % 1400),
        status: "Delivered", dueBy: new Date(due).toISOString(), createdAt: new Date(due - 5 * H).toISOString(),
        deliveredAt: new Date(due + (late ? 50 : -25) * 60000).toISOString(), notes: "",
      });
    }
  }
  return rows;
}
