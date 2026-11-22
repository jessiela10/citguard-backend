// Query tulis dan query untuk event engine.
// Nilai selalu dikirim lewat placeholder "?" agar aman dari SQL injection.
const pool = require('./db');

const toDate = (unixSeconds) => new Date(unixSeconds * 1000);

// ---------------------------------------------------------------------
// Perangkat
// ---------------------------------------------------------------------

async function deviceExists(deviceId) {
  const [rows] = await pool.query('SELECT 1 FROM devices WHERE device_id = ?', [deviceId]);
  return rows.length === 1;
}

async function getActiveTripId(deviceId) {
  const [rows] = await pool.query(
    "SELECT trip_id FROM trips WHERE device_id = ? AND status = 'active' LIMIT 1",
    [deviceId]
  );
  return rows[0] ? rows[0].trip_id : null;
}

async function touchLastSeen(deviceId) {
  await pool.query('UPDATE devices SET last_seen = NOW(3) WHERE device_id = ?', [deviceId]);
}

// Ubah status hanya jika memang berubah. Mengembalikan true jika berubah.
async function setOnlineIfOffline(deviceId) {
  const [r] = await pool.query(
    "UPDATE devices SET status = 'online' WHERE device_id = ? AND status = 'offline'",
    [deviceId]
  );
  if (r.affectedRows !== 1) return false;
  await pool.query("INSERT INTO device_status_log (device_id, status) VALUES (?, 'online')", [deviceId]);
  return true;
}

async function setOfflineIfOnline(deviceId) {
  const [r] = await pool.query(
    "UPDATE devices SET status = 'offline' WHERE device_id = ? AND status = 'online'",
    [deviceId]
  );
  if (r.affectedRows !== 1) return false;
  await pool.query("INSERT INTO device_status_log (device_id, status) VALUES (?, 'offline')", [deviceId]);
  return true;
}

// Perangkat berstatus online tetapi sudah lama tidak mengirim data
async function findStaleOnlineDevices(timeoutS) {
  const cutoff = new Date(Date.now() - timeoutS * 1000);
  const [rows] = await pool.query(
    `SELECT device_id FROM devices
      WHERE status = 'online' AND (last_seen IS NULL OR last_seen < ?)`,
    [cutoff]
  );
  return rows.map((r) => r.device_id);
}

// ---------------------------------------------------------------------
// Telemetry & event
// ---------------------------------------------------------------------

// Jika (device_id, seq, device_ts) sudah ada, MariaDB menolak dengan
// ER_DUP_ENTRY, lalu fungsi ini mengembalikan null (data ganda).
async function insertOrSkipDuplicate(sql, params) {
  try {
    const [result] = await pool.query(sql, params);
    return result.insertId;
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return null;
    throw err;
  }
}

function insertTelemetry(d, tripId) {
  return insertOrSkipDuplicate(
    `INSERT INTO telemetry
       (device_id, trip_id, seq, device_ts, lat, lon, speed_kmh, gps_source, doors, shock, buffered, raw)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      d.id, tripId, d.seq, toDate(d.ts),
      d.lat, d.lon, d.spd ?? null, d.gps ?? null,
      d.doors ? JSON.stringify(d.doors) : null,
      d.shock === 1 ? 1 : 0, d.buf === 1 ? 1 : 0,
      JSON.stringify(d),
    ]
  );
}

function insertEvent(d, tripId) {
  return insertOrSkipDuplicate(
    `INSERT INTO events
       (device_id, trip_id, seq, device_ts, type, door, rfid_uid, buffered, raw)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      d.id, tripId, d.seq, toDate(d.ts), d.type,
      d.door ?? null, d.uid ? d.uid.toUpperCase() : null,
      d.buf === 1 ? 1 : 0, JSON.stringify(d),
    ]
  );
}

// ---------------------------------------------------------------------
// Data untuk event engine
// ---------------------------------------------------------------------

async function getTripRoute(tripId) {
  const [trips] = await pool.query('SELECT route_tolerance_m FROM trips WHERE trip_id = ?', [tripId]);
  if (trips.length === 0) return null;
  const [points] = await pool.query(
    'SELECT lat, lon FROM trip_route_points WHERE trip_id = ? ORDER BY point_order',
    [tripId]
  );
  return { tolerance: trips[0].route_tolerance_m, points };
}

// Stop trip beserta lokasi dan status kedatangan
async function getTripStops(tripId) {
  const [rows] = await pool.query(
    `SELECT s.stop_order, s.planned_bags, s.arrived_at, s.departed_at,
            l.location_id, l.name, l.lat, l.lon, l.radius_m
       FROM trip_stops s JOIN locations l ON l.location_id = s.location_id
      WHERE s.trip_id = ? ORDER BY s.stop_order`,
    [tripId]
  );
  return rows;
}

// Mengembalikan true jika berhasil diubah (belum pernah dicatat sebelumnya)
async function setStopArrived(tripId, stopOrder, ts) {
  const [r] = await pool.query(
    'UPDATE trip_stops SET arrived_at = ? WHERE trip_id = ? AND stop_order = ? AND arrived_at IS NULL',
    [ts, tripId, stopOrder]
  );
  return r.affectedRows === 1;
}

async function setStopDeparted(tripId, stopOrder, ts) {
  const [r] = await pool.query(
    `UPDATE trip_stops SET departed_at = ?
      WHERE trip_id = ? AND stop_order = ? AND arrived_at IS NOT NULL AND departed_at IS NULL`,
    [ts, tripId, stopOrder]
  );
  return r.affectedRows === 1;
}

// Kantong kas yang discan RFID dalam rentang waktu tertentu
async function getBagsScanned(tripId, from, to) {
  const [rows] = await pool.query(
    `SELECT DISTINCT b.rfid_uid, b.label
       FROM events e JOIN cash_bags b ON b.rfid_uid = e.rfid_uid
      WHERE e.trip_id = ? AND e.type = 'rfid' AND e.device_ts BETWEEN ? AND ?
      ORDER BY b.label`,
    [tripId, from, to]
  );
  return rows;
}

// Posisi terakhir sebelum waktu ts, maksimal berumur maxAgeS detik
async function getPositionAt(deviceId, ts, maxAgeS) {
  const from = new Date(ts.getTime() - maxAgeS * 1000);
  const [rows] = await pool.query(
    `SELECT lat, lon FROM telemetry
      WHERE device_id = ? AND device_ts BETWEEN ? AND ?
      ORDER BY device_ts DESC, id DESC LIMIT 1`,
    [deviceId, from, ts]
  );
  return rows[0] || null;
}

// Apakah ada scan RFID dari petugas aktif yang ditugaskan di trip ini
// dalam windowS detik sebelum waktu ts
async function hasRecentOfficerScan(tripId, ts, windowS) {
  const from = new Date(ts.getTime() - windowS * 1000);
  const [rows] = await pool.query(
    `SELECT 1
       FROM events e
       JOIN officers o      ON o.rfid_uid = e.rfid_uid AND o.active = TRUE
       JOIN trip_officers t ON t.officer_id = o.officer_id AND t.trip_id = e.trip_id
      WHERE e.trip_id = ? AND e.type = 'rfid' AND e.device_ts BETWEEN ? AND ?
      LIMIT 1`,
    [tripId, from, ts]
  );
  return rows.length === 1;
}

// ---------------------------------------------------------------------
// Alert
// ---------------------------------------------------------------------

async function getAlert(id) {
  const [rows] = await pool.query('SELECT * FROM alerts WHERE id = ?', [id]);
  return rows[0] || null;
}

async function insertAlert(a) {
  const [r] = await pool.query(
    `INSERT INTO alerts (device_id, trip_id, event_id, type, severity, message)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [a.device_id, a.trip_id ?? null, a.event_id ?? null, a.type, a.severity, a.message]
  );
  return getAlert(r.insertId);
}

// Alur status: open -> acknowledged -> resolved (atau langsung open -> resolved)
async function updateAlertStatus(id, status, by) {
  const sql = status === 'acknowledged'
    ? `UPDATE alerts SET status = 'acknowledged', acknowledged_by = ?, acknowledged_at = NOW(3)
        WHERE id = ? AND status = 'open'`
    : `UPDATE alerts SET status = 'resolved',
              acknowledged_by = COALESCE(acknowledged_by, ?),
              acknowledged_at = COALESCE(acknowledged_at, NOW(3))
        WHERE id = ? AND status IN ('open', 'acknowledged')`;

  const [r] = await pool.query(sql, [by, id]);
  const row = await getAlert(id);
  if (!row) return { result: 'not_found' };
  if (r.affectedRows !== 1) return { result: 'invalid_transition', row };
  return { result: 'ok', row };
}

module.exports = {
  deviceExists, getActiveTripId, touchLastSeen,
  setOnlineIfOffline, setOfflineIfOnline, findStaleOnlineDevices,
  insertTelemetry, insertEvent,
  getTripRoute, getTripStops, setStopArrived, setStopDeparted, getBagsScanned,
  getPositionAt, hasRecentOfficerScan,
  insertAlert, updateAlertStatus,
};
