const express = require('express');
const cors = require('cors');
const q = require('./query');
const repo = require('./repository');
const audit = require('./audit');
const trips = require('./trips');
const { tripReport } = require('./report');
const { emit } = require('./realtime');

const TRIP_STATUS = ['planned', 'active', 'completed', 'cancelled'];
const ALERT_STATUS = ['open', 'acknowledged', 'resolved'];
const SEVERITY = ['info', 'warning', 'critical'];
const EVENT_TYPES = ['rfid', 'door_open', 'door_close', 'panic', 'tamper', 'shock'];

const wrap = (fn) => (req, res) =>
  fn(req, res).catch((err) => {
    console.error('[API ERROR]', req.method, req.originalUrl, err.message);
    res.status(500).json({ error: 'internal_error' });
  });

function createApp(corsOrigin) {
  const app = express();
  app.use(cors({ origin: corsOrigin }));
  app.use(express.json());

  app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', time: new Date().toISOString() });
  });

  app.get('/api/devices', wrap(async (req, res) => {
    res.json(await q.listDevices());
  }));

  app.get('/api/devices/:deviceId/latest', wrap(async (req, res) => {
    const row = await q.latestTelemetry(req.params.deviceId);
    if (!row) return res.status(404).json({ error: 'not_found' });
    res.json(row);
  }));

  app.get('/api/devices/:deviceId/status-log', wrap(async (req, res) => {
    res.json(await q.deviceStatusLog(req.params.deviceId));
  }));

  // Trip
  app.get('/api/trips', wrap(async (req, res) => {
    const { status } = req.query;
    if (status && !TRIP_STATUS.includes(status)) {
      return res.status(400).json({ error: 'invalid_status', allowed: TRIP_STATUS });
    }
    res.json(await q.listTrips(status));
  }));

  app.get('/api/trips/:tripId', wrap(async (req, res) => {
    const trip = await q.getTrip(req.params.tripId);
    if (!trip) return res.status(404).json({ error: 'not_found' });
    res.json(trip);
  }));

  app.get('/api/trips/:tripId/telemetry', wrap(async (req, res) => {
    res.json(await q.tripTelemetry(req.params.tripId));
  }));

  app.get('/api/trips/:tripId/events', wrap(async (req, res) => {
    res.json(await q.tripEvents(req.params.tripId));
  }));

  // Ubah status trip. Body: { "status": "active" | "completed" | "cancelled" }
  app.patch('/api/trips/:tripId/status', wrap(async (req, res) => {
    const { status } = req.body || {};
    const allowed = ['active', 'completed', 'cancelled'];
    if (!allowed.includes(status)) return res.status(400).json({ error: 'invalid_status', allowed });

    const out = await trips.changeTripStatus(req.params.tripId, status);
    if (out.result === 'not_found') return res.status(404).json({ error: 'not_found' });
    if (out.result === 'invalid_transition') {
      return res.status(409).json({ error: 'invalid_transition', current_status: out.current_status });
    }
    if (out.result === 'conflict') {
      return res.status(409).json({ error: 'device_has_active_trip', active_trip: out.active_trip });
    }
    res.json(out.row);
  }));

  // Laporan audit perjalanan
  app.get('/api/trips/:tripId/report', wrap(async (req, res) => {
    const report = await tripReport(req.params.tripId);
    if (!report) return res.status(404).json({ error: 'not_found' });
    res.json(report);
  }));

  // Event
  app.get('/api/events', wrap(async (req, res) => {
    const { device_id, trip_id, type } = req.query;
    if (type && !EVENT_TYPES.includes(type)) {
      return res.status(400).json({ error: 'invalid_type', allowed: EVENT_TYPES });
    }
    res.json(await q.listEvents({ deviceId: device_id, tripId: trip_id, type }));
  }));

  // Alert
  app.get('/api/alerts', wrap(async (req, res) => {
    const { status, severity } = req.query;
    if (status && !ALERT_STATUS.includes(status)) {
      return res.status(400).json({ error: 'invalid_status', allowed: ALERT_STATUS });
    }
    if (severity && !SEVERITY.includes(severity)) {
      return res.status(400).json({ error: 'invalid_severity', allowed: SEVERITY });
    }
    res.json(await q.listAlerts({ status, severity }));
  }));

  // Ubah status alert. Body: { "status": "acknowledged", "acknowledged_by": "Budi Santoso" }
  app.patch('/api/alerts/:id', wrap(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'invalid_id' });

    const { status, acknowledged_by } = req.body || {};
    if (!['acknowledged', 'resolved'].includes(status)) {
      return res.status(400).json({ error: 'invalid_status', allowed: ['acknowledged', 'resolved'] });
    }
    const by = typeof acknowledged_by === 'string' ? acknowledged_by.trim() : '';
    if (!by || by.length > 100) {
      return res.status(400).json({ error: 'acknowledged_by_required', max_length: 100 });
    }

    const out = await repo.updateAlertStatus(id, status, by);
    if (out.result === 'not_found') return res.status(404).json({ error: 'not_found' });
    if (out.result === 'invalid_transition') {
      return res.status(409).json({ error: 'invalid_transition', current_status: out.row.status });
    }
    await audit.append('alert', id, status, { by });
    emit('alert_update', out.row);
    res.json(out.row);
  }));

  // Jejak audit (hanya baca)
  app.get('/api/audit-log', wrap(async (req, res) => {
    res.json(await audit.list({ entity: req.query.entity, limit: req.query.limit }));
  }));

  app.get('/api/audit-log/verify', wrap(async (req, res) => {
    res.json(await audit.verify());
  }));

  // Rute tidak dikenal
  app.use((req, res) => res.status(404).json({ error: 'not_found' }));

  return app;
}

module.exports = { createApp };
