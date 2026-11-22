// Mengolah satu pesan MQTT: validasi, simpan, kirim ke dashboard, lalu cek aturan.
const v = require('./validator');
const repo = require('./repository');
const engine = require('./engine');
const { emit } = require('./realtime');

async function handleMessage(topic, message) {
  const text = message.toString();

  // 1. Baca topic -> deviceId dan jenis pesan
  const t = v.parseTopic(topic);
  if (!t.ok) return console.warn(`[TOLAK] ${t.error}`);
  const { deviceId, type } = t.value;

  // 2. Perangkat harus terdaftar di tabel devices
  if (!(await repo.deviceExists(deviceId))) {
    return console.warn(`[TOLAK] perangkat ${deviceId} belum terdaftar di tabel devices`);
  }

  // 3. Pesan status (online/offline, termasuk Last Will dari broker)
  if (type === 'status') {
    const s = v.parseStatus(text);
    if (!s.ok) return console.warn(`[TOLAK] ${topic}: ${s.error}`);
    if (s.value.status === 'online') return engine.deviceSeen(deviceId);
    return engine.markOffline(deviceId, 'koneksi MQTT terputus');
  }

  // 4. Telemetry dan event harus JSON
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return console.warn(`[TOLAK] ${topic}: payload bukan JSON valid -> ${text}`);
  }

  const result = type === 'telemetry'
    ? v.validateTelemetry(data, deviceId)
    : v.validateEvent(data, deviceId);
  if (!result.ok) return console.warn(`[TOLAK] ${topic}: ${result.error}`);

  // 5. Simpan dan kaitkan dengan trip yang sedang aktif
  await engine.deviceSeen(deviceId);
  const tripId = await repo.getActiveTripId(deviceId);
  const timestamp = new Date(data.ts * 1000).toISOString();

  if (type === 'telemetry') {
    const id = await repo.insertTelemetry(data, tripId);
    if (id === null) {
      return console.log(`[GANDA] telemetry ${deviceId} seq=${data.seq} sudah ada, dilewati`);
    }
    emit('telemetry', {
      id,
      device_id: deviceId,
      trip_id: tripId,
      seq: data.seq,
      device_ts: timestamp,
      lat: data.lat,
      lon: data.lon,
      speed_kmh: data.spd ?? null,
      gps_source: data.gps ?? null,
      doors: data.doors ?? null,
      shock: data.shock === 1,
      buffered: data.buf === 1,
    });
    console.log(`[SIMPAN] telemetry #${id} ${deviceId} trip=${tripId ?? '-'} seq=${data.seq} lat=${data.lat} lon=${data.lon}`);
    return engine.onTelemetry(data, tripId);
  }

  const id = await repo.insertEvent(data, tripId);
  if (id === null) {
    return console.log(`[GANDA] event ${deviceId} seq=${data.seq} sudah ada, dilewati`);
  }
  emit('event', {
    id,
    device_id: deviceId,
    trip_id: tripId,
    seq: data.seq,
    device_ts: timestamp,
    type: data.type,
    door: data.door ?? null,
    rfid_uid: data.uid ? data.uid.toUpperCase() : null,
    buffered: data.buf === 1,
  });
  console.log(`[SIMPAN] event #${id} ${deviceId} trip=${tripId ?? '-'} seq=${data.seq} type=${data.type}`);
  return engine.onEvent(data, tripId, id);
}

module.exports = { handleMessage };