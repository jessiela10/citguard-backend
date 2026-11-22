// Laporan audit satu perjalanan.
const pool = require('./db');
const q = require('./query');
const geo = require('./geo');
const audit = require('./audit');

const seconds = (a, b) => (a && b ? Math.round((new Date(b) - new Date(a)) / 1000) : null);

async function tripReport(tripId) {
  const trip = await q.getTrip(tripId);
  if (!trip) return null;

  // Data yang dihitung hanya dalam periode trip berjalan
  const from = trip.started_at || trip.created_at;
  const to = trip.ended_at || new Date();

  // Jarak tempuh dan data tertunda
  const [tel] = await pool.query(
    `SELECT lat, lon, device_ts, received_at, buffered FROM telemetry
      WHERE trip_id = ? AND device_ts BETWEEN ? AND ? ORDER BY device_ts, id`,
    [tripId, from, to]
  );
  let distance = 0;
  for (let i = 1; i < tel.length; i++) {
    distance += geo.haversine(tel[i - 1].lat, tel[i - 1].lon, tel[i].lat, tel[i].lon);
  }
  const buffered = tel.filter((t) => t.buffered);
  const maxDelay = buffered.reduce((m, t) => Math.max(m, seconds(t.device_ts, t.received_at)), 0);

  // Serah-terima per stop
  const stops = [];
  for (const s of trip.stops) {
    let bags = [];
    if (s.arrived_at) {
      const [rows] = await pool.query(
        `SELECT DISTINCT b.rfid_uid, b.label
           FROM events e JOIN cash_bags b ON b.rfid_uid = e.rfid_uid
          WHERE e.trip_id = ? AND e.type = 'rfid' AND e.device_ts BETWEEN ? AND ?
          ORDER BY b.label`,
        [tripId, s.arrived_at, s.departed_at || to]
      );
      bags = rows;
    }
    let bagStatus = 'tidak_dikunjungi';
    if (s.arrived_at) {
      if (bags.length === s.planned_bags) bagStatus = 'sesuai';
      else bagStatus = bags.length < s.planned_bags ? 'kurang' : 'lebih';
    }
    stops.push({
      stop_order: s.stop_order,
      location: s.name,
      type: s.type,
      planned_bags: s.planned_bags,
      scanned_bags: bags,
      bag_status: bagStatus,
      arrived_at: s.arrived_at,
      departed_at: s.departed_at,
      duration_s: seconds(s.arrived_at, s.departed_at),
    });
  }

  // Jumlah event per jenis
  const [evRows] = await pool.query(
    `SELECT type, COUNT(*) AS total FROM events
      WHERE trip_id = ? AND device_ts BETWEEN ? AND ? GROUP BY type`,
    [tripId, from, to]
  );
  const eventCounts = Object.fromEntries(evRows.map((r) => [r.type, Number(r.total)]));

  // Semua alert selama trip
  const [alerts] = await pool.query(
    'SELECT * FROM alerts WHERE trip_id = ? AND created_at BETWEEN ? AND ? ORDER BY created_at',
    [tripId, from, to]
  );

  // Periode offline: pasangan status offline -> online berikutnya
  const [log] = await pool.query(
    `SELECT status, received_at FROM device_status_log
      WHERE device_id = ? AND received_at BETWEEN ? AND ? ORDER BY received_at, id`,
    [trip.device_id, from, to]
  );
  const offline = [];
  for (const row of log) {
    if (row.status === 'offline') offline.push({ from: row.received_at, to: null, duration_s: null });
    const last = offline[offline.length - 1];
    if (row.status === 'online' && last && !last.to) {
      last.to = row.received_at;
      last.duration_s = seconds(last.from, last.to);
    }
  }

  return {
    trip: {
      trip_id: trip.trip_id,
      device_id: trip.device_id,
      status: trip.status,
      started_at: trip.started_at,
      ended_at: trip.ended_at,
      duration_s: seconds(from, trip.ended_at),
      route_tolerance_m: trip.route_tolerance_m,
    },
    officers: trip.officers,
    summary: {
      distance_m: Math.round(distance),
      telemetry_count: tel.length,
      buffered_count: buffered.length,
      max_buffer_delay_s: maxDelay,
      stops_visited: stops.filter((s) => s.arrived_at).length,
      stops_planned: stops.length,
      alerts_total: alerts.length,
      alerts_critical: alerts.filter((a) => a.severity === 'critical').length,
      offline_periods: offline.length,
    },
    stops,
    event_counts: eventCounts,
    alerts,
    offline_periods: offline,
    audit_chain: await audit.verify(),
    generated_at: new Date().toISOString(),
  };
}

module.exports = { tripReport };
