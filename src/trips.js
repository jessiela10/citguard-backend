const pool = require('./db');
const audit = require('./audit');
const engine = require('./engine');
const { emit } = require('./realtime');

const TRANSITIONS = {
  planned: ['active', 'cancelled'],
  active: ['completed', 'cancelled'],
};

async function changeTripStatus(tripId, status) {
  const [rows] = await pool.query('SELECT trip_id, device_id, status FROM trips WHERE trip_id = ?', [tripId]);
  if (rows.length === 0) return { result: 'not_found' };
  const trip = rows[0];

  if (!(TRANSITIONS[trip.status] || []).includes(status)) {
    return { result: 'invalid_transition', current_status: trip.status };
  }

  if (status === 'active') {
    const [other] = await pool.query(
      "SELECT trip_id FROM trips WHERE device_id = ? AND status = 'active' AND trip_id <> ?",
      [trip.device_id, tripId]
    );
    if (other.length > 0) return { result: 'conflict', active_trip: other[0].trip_id };
    await pool.query(
      "UPDATE trips SET status = 'active', started_at = NOW(3), ended_at = NULL WHERE trip_id = ? AND status = 'planned'",
      [tripId]
    );
  } else {
    // Tutup stop yang masih terbuka (dan cek jumlah kantongnya) sebelum trip ditutup
    if (trip.status === 'active') await engine.closeOpenStop(trip.device_id, tripId);
    await pool.query(
      'UPDATE trips SET status = ?, ended_at = NOW(3) WHERE trip_id = ? AND status = ?',
      [status, tripId, trip.status]
    );
  }

  const [updated] = await pool.query('SELECT * FROM trips WHERE trip_id = ?', [tripId]);
  await audit.append('trip', tripId, status, { from: trip.status, to: status });
  emit('trip_status', updated[0]);
  console.log(`[TRIP] ${tripId}: ${trip.status} -> ${status}`);
  return { result: 'ok', row: updated[0] };
}

module.exports = { changeTripStatus };
