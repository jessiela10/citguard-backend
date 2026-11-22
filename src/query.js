// Query baca untuk REST API. Nilai selalu lewat placeholder "?".
const pool = require('./db');

// MariaDB menyimpan kolom JSON sebagai teks, jadi diubah menjadi array/objek di sini.
function parseJsonColumn(value) {
  if (value === null || value === undefined) return null;
  return typeof value === 'string' ? JSON.parse(value) : value;
}

function mapTelemetry(r) {
  return {
    id: r.id,
    device_id: r.device_id,
    trip_id: r.trip_id,
    seq: Number(r.seq),
    device_ts: r.device_ts,
    received_at: r.received_at,
    lat: r.lat,
    lon: r.lon,
    speed_kmh: r.speed_kmh,
    gps_source: r.gps_source,
    doors: parseJsonColumn(r.doors),
    shock: !!r.shock,
    buffered: !!r.buffered,
  };
}

function mapEvent(r) {
  return {
    id: r.id,
    device_id: r.device_id,
    trip_id: r.trip_id,
    seq: Number(r.seq),
    device_ts: r.device_ts,
    received_at: r.received_at,
    type: r.type,
    door: r.door,
    rfid_uid: r.rfid_uid,
    buffered: !!r.buffered,
  };
}

async function listDevices() {
  const [rows] = await pool.query(
    'SELECT device_id, name, vehicle_plate, status, last_seen FROM devices ORDER BY device_id'
  );
  return rows;
}

async function latestTelemetry(deviceId) {
  const [rows] = await pool.query(
    'SELECT * FROM telemetry WHERE device_id = ? ORDER BY device_ts DESC, id DESC LIMIT 1',
    [deviceId]
  );
  return rows[0] ? mapTelemetry(rows[0]) : null;
}

async function deviceStatusLog(deviceId) {
  const [rows] = await pool.query(
    'SELECT id, device_id, status, received_at FROM device_status_log WHERE device_id = ? ORDER BY received_at DESC LIMIT 100',
    [deviceId]
  );
  return rows;
}

async function listTrips(status) {
  const [rows] = status
    ? await pool.query('SELECT * FROM trips WHERE status = ? ORDER BY created_at DESC', [status])
    : await pool.query('SELECT * FROM trips ORDER BY created_at DESC');
  return rows;
}

// Trip lengkap: data trip, petugas, stop, dan titik rute
async function getTrip(tripId) {
  const [trips] = await pool.query('SELECT * FROM trips WHERE trip_id = ?', [tripId]);
  if (trips.length === 0) return null;

  const [officers] = await pool.query(
    `SELECT o.officer_id, o.name, o.role
       FROM trip_officers t JOIN officers o ON o.officer_id = t.officer_id
      WHERE t.trip_id = ?`,
    [tripId]
  );
  const [stops] = await pool.query(
    `SELECT s.stop_order, s.planned_bags, s.arrived_at, s.departed_at,
            l.location_id, l.name, l.type, l.lat, l.lon, l.radius_m
       FROM trip_stops s JOIN locations l ON l.location_id = s.location_id
      WHERE s.trip_id = ? ORDER BY s.stop_order`,
    [tripId]
  );
  const [route] = await pool.query(
    'SELECT point_order, lat, lon FROM trip_route_points WHERE trip_id = ? ORDER BY point_order',
    [tripId]
  );

  return { ...trips[0], officers, stops, route_points: route };
}

async function tripTelemetry(tripId) {
  const [rows] = await pool.query(
    'SELECT * FROM telemetry WHERE trip_id = ? ORDER BY device_ts ASC, id ASC',
    [tripId]
  );
  return rows.map(mapTelemetry);
}

async function tripEvents(tripId) {
  const [rows] = await pool.query(
    'SELECT * FROM events WHERE trip_id = ? ORDER BY device_ts ASC, id ASC',
    [tripId]
  );
  return rows.map(mapEvent);
}

async function listEvents({ deviceId, tripId, type }) {
  const where = [];
  const params = [];
  if (deviceId) { where.push('device_id = ?'); params.push(deviceId); }
  if (tripId) { where.push('trip_id = ?'); params.push(tripId); }
  if (type) { where.push('type = ?'); params.push(type); }

  const sql = `SELECT * FROM events ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
               ORDER BY device_ts DESC, id DESC LIMIT 500`;
  const [rows] = await pool.query(sql, params);
  return rows.map(mapEvent);
}

async function listAlerts({ status, severity }) {
  const where = [];
  const params = [];
  if (status) { where.push('status = ?'); params.push(status); }
  if (severity) { where.push('severity = ?'); params.push(severity); }

  const sql = `SELECT * FROM alerts ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
               ORDER BY created_at DESC LIMIT 500`;
  const [rows] = await pool.query(sql, params);
  return rows;
}

module.exports = {
  listDevices, latestTelemetry, deviceStatusLog,
  listTrips, getTrip, tripTelemetry, tripEvents,
  listEvents, listAlerts,
};
