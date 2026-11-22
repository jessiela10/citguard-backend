// Memeriksa apakah topic dan payload JSON dari ESP32 sesuai format.
// Setiap fungsi mengembalikan { ok: true, value } atau { ok: false, error }.

const MESSAGE_TYPES = ['telemetry', 'event', 'status'];
const EVENT_TYPES = ['rfid', 'door_open', 'door_close', 'panic', 'tamper', 'shock'];

const isNumber = (v) => typeof v === 'number' && Number.isFinite(v);
const isInt = (v) => Number.isInteger(v);

// Topic: citguard/{deviceId}/{type}
function parseTopic(topic) {
  const parts = topic.split('/');
  if (parts.length !== 3 || parts[0] !== 'citguard') {
    return { ok: false, error: `format topic salah: ${topic}` };
  }
  const [, deviceId, type] = parts;
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(deviceId)) {
    return { ok: false, error: `deviceId tidak valid: ${deviceId}` };
  }
  if (!MESSAGE_TYPES.includes(type)) {
    return { ok: false, error: `jenis pesan tidak dikenal: ${type}` };
  }
  return { ok: true, value: { deviceId, type } };
}

function checkCommon(d, deviceId) {
  if (d.id !== deviceId) return `"id" (${d.id}) tidak sama dengan deviceId di topic (${deviceId})`;
  if (!isInt(d.seq) || d.seq < 0) return '"seq" harus bilangan bulat >= 0';
  if (!isInt(d.ts) || d.ts <= 0) return '"ts" harus waktu Unix (detik)';
  if (d.buf !== undefined && d.buf !== 0 && d.buf !== 1) return '"buf" harus 0 atau 1';
  return null;
}

function validateTelemetry(d, deviceId) {
  const err = checkCommon(d, deviceId);
  if (err) return { ok: false, error: err };

  if (!isNumber(d.lat) || d.lat < -90 || d.lat > 90) return { ok: false, error: '"lat" harus -90..90' };
  if (!isNumber(d.lon) || d.lon < -180 || d.lon > 180) return { ok: false, error: '"lon" harus -180..180' };
  if (d.spd !== undefined && (!isNumber(d.spd) || d.spd < 0)) return { ok: false, error: '"spd" harus angka >= 0' };
  if (d.gps !== undefined && !['real', 'sim'].includes(d.gps)) return { ok: false, error: '"gps" harus "real" atau "sim"' };
  if (d.doors !== undefined &&
      (!Array.isArray(d.doors) || !d.doors.every((x) => x === 0 || x === 1))) {
    return { ok: false, error: '"doors" harus array berisi 0/1' };
  }
  if (d.shock !== undefined && d.shock !== 0 && d.shock !== 1) return { ok: false, error: '"shock" harus 0 atau 1' };

  return { ok: true, value: d };
}

function validateEvent(d, deviceId) {
  const err = checkCommon(d, deviceId);
  if (err) return { ok: false, error: err };

  if (!EVENT_TYPES.includes(d.type)) {
    return { ok: false, error: `"type" harus salah satu dari: ${EVENT_TYPES.join(', ')}` };
  }
  if ((d.type === 'door_open' || d.type === 'door_close') && (!isInt(d.door) || d.door < 1)) {
    return { ok: false, error: '"door" wajib diisi (1, 2, 3, ...) untuk door_open/door_close' };
  }
  if (d.type === 'rfid' && (typeof d.uid !== 'string' || !/^[0-9A-Fa-f]{4,32}$/.test(d.uid))) {
    return { ok: false, error: '"uid" wajib berupa teks heksadesimal untuk event rfid' };
  }
  return { ok: true, value: d };
}

function parseStatus(text) {
  let status = text.trim();
  try {
    const d = JSON.parse(status);
    status = d && typeof d === 'object' ? d.status : d;
  } catch {
  }
  if (status !== 'online' && status !== 'offline') {
    return { ok: false, error: 'status harus "online" atau "offline"' };
  }
  return { ok: true, value: { status } };
}

module.exports = { parseTopic, validateTelemetry, validateEvent, parseStatus };
