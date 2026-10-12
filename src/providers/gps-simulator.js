// Fake GPS feed for testing: trucks drive toward the destination of their
// in-transit shipment, then back to the depot. Time runs faster than real life.
import { distanceKm } from "../geo.js";

const SPEED_UP = 6; // simulated minutes per real minute

export function createSimulatorGps() {
  const state = new Map();
  let last = Date.now();

  return {
    name: "simulator",
    async poll({ vehicles, shipments, places }) {
      const now = Date.now();
      const hours = ((now - last) / 3600000) * SPEED_UP;
      last = now;
      const depot = places.find((p) => p.depot) || places[0] || { lat: 14.6, lng: 121 };
      const out = [];
      vehicles.forEach((v, i) => {
        let s = state.get(v.id);
        if (!s) {
          s = { lat: depot.lat + (i - 2) * 0.004, lng: depot.lng + (i % 3) * 0.004, speed: 0, heading: 0, fuel: 35 + ((i * 23) % 60), odometer: 48000 + i * 9100, frozenAt: null };
          state.set(v.id, s);
        }
        if (/maint/i.test(v.note || "")) {
          // Parked and not reporting, so the dashboard shows it as offline after a while.
          if (!s.frozenAt) s.frozenAt = new Date(now - 12 * 60000).toISOString();
          out.push({ id: v.id, lat: s.lat, lng: s.lng, speed: 0, heading: s.heading, fuel: s.fuel, odometer: s.odometer, time: s.frozenAt });
          return;
        }
        const job = shipments.find((x) => x.truck === v.id && x.status === "In transit" && x.destLat != null);
        const target = job ? { lat: job.destLat, lng: job.destLng } : depot;
        const d = distanceKm(s, target);
        if (d > 0.05) {
          const jam = (i * 7 + Math.floor(now / 90000)) % 9 === 0; // occasional traffic
          const want = jam ? 8 + Math.random() * 10 : 30 + Math.random() * 35;
          s.speed += (want - s.speed) * 0.5;
          const step = Math.min(d, s.speed * hours);
          const f = step / d;
          const nlat = s.lat + (target.lat - s.lat) * f;
          const nlng = s.lng + (target.lng - s.lng) * f;
          s.heading = (Math.atan2(nlng - s.lng, nlat - s.lat) * 180) / Math.PI;
          s.lat = nlat; s.lng = nlng;
          s.odometer += step;
          s.fuel = Math.max(4, s.fuel - step * 0.12);
        } else {
          s.speed = 0;
          if (!job && s.fuel < 25) s.fuel = 96; // refuel at depot
        }
        out.push({ id: v.id, lat: +s.lat.toFixed(6), lng: +s.lng.toFixed(6), speed: Math.round(s.speed), heading: Math.round(s.heading), fuel: Math.round(s.fuel), odometer: Math.round(s.odometer), time: new Date(now).toISOString() });
      });
      return out;
    },
  };
}
