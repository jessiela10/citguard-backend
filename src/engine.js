const repo = require('./repository');
const geo = require('./geo');
const audit = require('./audit');
const config = require('./config');
const { emit } = require('./realtime');

const DEPART_MARGIN_M = 10;

const deviationState = new Map();

async function raise(alert) {
  const row = await repo.insertAlert(alert);
  await audit.append('alert', row.id, 'create', {
    device_id: row.device_id, trip_id: row.trip_id, event_id: row.event_id,
    type: row.type, severity: row.severity, message: row.message,
  });
  emit('alert', row);
  console.log(`[ALERT] ${row.severity.toUpperCase()} ${row.type} ${row.device_id}: ${row.message}`);
  return row;
}

const delayedNote = (d) => (d.buf === 1 ? ' [data tertunda dari buffer]' : '');

// ---------------------------------------------------------------------
// Status online/offline
// ---------------------------------------------------------------------

async function deviceSeen(deviceId) {
  const cameOnline = await repo.setOnlineIfOffline(deviceId);
  await repo.touchLastSeen(deviceId);
  if (cameOnline) {
    await audit.append('device', deviceId, 'online', {});
    emit('device_status', { device_id: deviceId, status: 'online', received_at: new Date().toISOString() });
    console.log(`[STATUS] ${deviceId} -> online`);
  }
}

async function markOffline(deviceId, reason) {
  const wentOffline = await repo.setOfflineIfOnline(deviceId);
  if (!wentOffline) return; // sudah offline, jangan buat alert ganda

  await audit.append('device', deviceId, 'offline', { reason });
  emit('device_status', { device_id: deviceId, status: 'offline', received_at: new Date().toISOString() });
  console.log(`[STATUS] ${deviceId} -> offline (${reason})`);

  await raise({
    device_id: deviceId,
    trip_id: await repo.getActiveTripId(deviceId),
    type: 'device_offline',
    severity: 'warning',
    message: `Perangkat offline: ${reason}`,
  });
}

function startWatchdog() {
  let running = false;
  setInterval(async () => {
    if (running) return;
    running = true;
    try {
      const stale = await repo.findStaleOnlineDevices(config.offlineTimeoutS);
      for (const deviceId of stale) {
        await markOffline(deviceId, `tidak ada data selama ${config.offlineTimeoutS} detik`);
      }
    } catch (err) {
      console.error('[WATCHDOG] Error:', err.message);
    } finally {
      running = false;
    }
  }, config.watchdogIntervalS * 1000);
  console.log(`[ENGINE] Watchdog offline aktif (batas ${config.offlineTimeoutS} detik)`);
}

// ---------------------------------------------------------------------
// Kedatangan dan keberangkatan di lokasi tujuan + cek jumlah kantong
// ---------------------------------------------------------------------

async function departStop(deviceId, tripId, stop, ts) {
  if (!(await repo.setStopDeparted(tripId, stop.stop_order, ts))) return;

  await audit.append('trip_stop', `${tripId}#${stop.stop_order}`, 'departed', { location: stop.name, at: ts });
  emit('trip_stop', { trip_id: tripId, stop_order: stop.stop_order, location: stop.name, status: 'departed', at: ts.toISOString() });
  console.log(`[STOP] ${deviceId} meninggalkan ${stop.name}`);

  const bags = await repo.getBagsScanned(tripId, stop.arrived_at, ts);
  if (bags.length === stop.planned_bags) {
    console.log(`[INFO] Serah-terima di ${stop.name} sesuai (${bags.length} kantong)`);
    return;
  }
  await raise({
    device_id: deviceId,
    trip_id: tripId,
    type: 'bag_mismatch',
    severity: 'warning',
    message: `${stop.name}: ${bags.length} dari ${stop.planned_bags} kantong discan saat serah-terima`,
  });
}

async function updateStops(d, tripId) {
  const ts = new Date(d.ts * 1000);
  const stops = await repo.getTripStops(tripId);
  const dist = (s) => geo.haversine(d.lat, d.lon, s.lat, s.lon);

  const open = stops.find((s) => s.arrived_at && !s.departed_at);
  if (open) {
    if (dist(open) > open.radius_m + DEPART_MARGIN_M) await departStop(d.id, tripId, open, ts);
    return;
  }

  const here = stops.find((s) => !s.arrived_at && dist(s) <= s.radius_m);
  if (here && (await repo.setStopArrived(tripId, here.stop_order, ts))) {
    await audit.append('trip_stop', `${tripId}#${here.stop_order}`, 'arrived', { location: here.name, at: ts });
    emit('trip_stop', { trip_id: tripId, stop_order: here.stop_order, location: here.name, status: 'arrived', at: ts.toISOString() });
    console.log(`[STOP] ${d.id} tiba di ${here.name} (stop ${here.stop_order})`);
  }
}

async function closeOpenStop(deviceId, tripId) {
  const stops = await repo.getTripStops(tripId);
  const open = stops.find((s) => s.arrived_at && !s.departed_at);
  if (open) await departStop(deviceId, tripId, open, new Date());
}

// ---------------------------------------------------------------------
// Deviasi rute
// ---------------------------------------------------------------------

async function checkDeviation(d, tripId) {
  const route = await repo.getTripRoute(tripId);
  if (!route || route.points.length === 0) return;

  const dist = geo.distanceToRoute({ lat: d.lat, lon: d.lon }, route.points);
  const key = `${d.id}:${tripId}`;
  const state = deviationState.get(key) || { outCount: 0, alerted: false };

  if (dist > route.tolerance) {
    state.outCount += 1;
    if (!state.alerted && state.outCount >= config.deviationConsecutive) {
      state.alerted = true;
      await raise({
        device_id: d.id,
        trip_id: tripId,
        type: 'route_deviation',
        severity: 'warning',
        message: `Kendaraan keluar rute sejauh ${Math.round(dist)} m (toleransi ${route.tolerance} m)${delayedNote(d)}`,
      });
    }
  } else {
    if (state.alerted) console.log(`[INFO] ${d.id} kembali ke rute (${Math.round(dist)} m)`);
    state.outCount = 0;
    state.alerted = false;
  }
  deviationState.set(key, state);
}

async function onTelemetry(d, tripId) {
  if (!tripId) return;
  await updateStops(d, tripId);
  await checkDeviation(d, tripId);
}

// ---------------------------------------------------------------------
// Pintu kompartemen sah / tidak sah
// ---------------------------------------------------------------------

async function checkDoorOpen(d, tripId, eventId) {
  const ts = new Date(d.ts * 1000);
  const reasons = [];
  let place = null;

  if (!tripId) {
    reasons.push('tanpa trip aktif');
  } else {
    const pos = await repo.getPositionAt(d.id, ts, config.positionMaxAgeS);
    if (!pos) {
      reasons.push('saat posisi kendaraan tidak diketahui');
    } else {
      const stops = await repo.getTripStops(tripId);
      place = stops.find((s) => geo.haversine(pos.lat, pos.lon, s.lat, s.lon) <= s.radius_m) || null;
      if (!place) reasons.push('di luar geofence lokasi tujuan');
    }

    if (!(await repo.hasRecentOfficerScan(tripId, ts, config.rfidWindowS))) {
      reasons.push(`tanpa scan RFID petugas dalam ${Math.round(config.rfidWindowS / 60)} menit terakhir`);
    }
  }

  if (reasons.length === 0) {
    console.log(`[INFO] Pintu ${d.door} dibuka SAH di ${place.name}`);
    return;
  }

  await raise({
    device_id: d.id,
    trip_id: tripId,
    event_id: eventId,
    type: 'unauthorized_door',
    severity: 'critical',
    message: `Pintu ${d.door} dibuka ${reasons.join(', ')}${delayedNote(d)}`,
  });
}

// ---------------------------------------------------------------------
// Event dari perangkat
// ---------------------------------------------------------------------

async function onEvent(d, tripId, eventId) {
  // Semua event dicatat di jejak audit
  await audit.append('event', eventId, d.type, {
    device_id: d.id, trip_id: tripId, seq: d.seq, ts: d.ts,
    door: d.door ?? null, rfid_uid: d.uid ? d.uid.toUpperCase() : null, buffered: d.buf === 1,
  });

  const base = { device_id: d.id, trip_id: tripId, event_id: eventId };
  switch (d.type) {
    case 'door_open':
      return checkDoorOpen(d, tripId, eventId);
    case 'panic':
      return raise({ ...base, type: 'panic', severity: 'critical', message: `Tombol panik ditekan${delayedNote(d)}` });
    case 'tamper':
      return raise({ ...base, type: 'tamper', severity: 'critical', message: `Casing perangkat dibuka (tamper)${delayedNote(d)}` });
    case 'shock':
      return raise({ ...base, type: 'shock', severity: 'warning', message: `Benturan terdeteksi${delayedNote(d)}` });
    default:
      return; // rfid dan door_close cukup dicatat
  }
}

module.exports = { deviceSeen, markOffline, startWatchdog, onTelemetry, onEvent, closeOpenStop };
