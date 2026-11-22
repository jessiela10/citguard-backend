// Meniru ESP32: mengirim beberapa pesan uji ke broker MQTT.
// Jalankan: npm run test-publish
const mqtt = require('mqtt');
const config = require('../src/config');

const DEVICE = 'CIT-001';
const now = Math.floor(Date.now() / 1000);

const messages = [
  ['status',    'online'],
  ['telemetry', { id: DEVICE, seq: 1, ts: now,     lat: -6.2088, lon: 106.8456, spd: 0,  gps: 'sim', doors: [0, 0, 0], shock: 0, buf: 0 }],
  ['telemetry', { id: DEVICE, seq: 2, ts: now + 3, lat: -6.2020, lon: 106.8340, spd: 38, gps: 'sim', doors: [0, 0, 0], shock: 0, buf: 0 }],
  ['event',     { id: DEVICE, seq: 3, ts: now + 5, type: 'rfid', uid: 'A3F1229C', buf: 0 }],
  ['event',     { id: DEVICE, seq: 4, ts: now + 6, type: 'door_open', door: 2, buf: 0 }],
  ['event',     { id: DEVICE, seq: 5, ts: now + 9, type: 'panic', buf: 0 }],
  // Data ganda (seq & ts sama dengan seq 2) -> harus dilewati
  ['telemetry', { id: DEVICE, seq: 2, ts: now + 3, lat: -6.2020, lon: 106.8340, spd: 38, gps: 'sim', doors: [0, 0, 0], shock: 0, buf: 1 }],
  // Data salah -> harus ditolak
  ['telemetry', 'ini bukan json'],
  ['telemetry', { id: DEVICE, seq: 6, ts: now + 12, lat: 999, lon: 106.8 }],
  ['event',     { id: DEVICE, seq: 7, ts: now + 13, type: 'door_open' }],
];

const client = mqtt.connect(config.mqttUrl, { clientId: 'citguard-test-publisher' });

client.on('connect', async () => {
  for (const [type, payload] of messages) {
    const topic = `citguard/${DEVICE}/${type}`;
    const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
    await client.publishAsync(topic, body, { qos: 1 });
    console.log(`Kirim ${topic}: ${body}`);
  }
  client.end();
});

client.on('error', (err) => {
  console.error('Gagal terhubung ke broker:', err.message);
  process.exit(1);
});
