// Program utama: database, MQTT, REST API, Socket.IO, dan event engine dalam satu proses.
const http = require('http');
const mqtt = require('mqtt');
const config = require('./config');
const pool = require('./db');
const { handleMessage } = require('./handler');
const { createApp } = require('./api');
const { initRealtime } = require('./realtime');
const engine = require('./engine');

async function main() {
  // Cek koneksi database lebih dulu
  try {
    await pool.query('SELECT 1');
    console.log('[DB] Terhubung ke MariaDB (XAMPP)');
  } catch (err) {
    console.error('[DB] Gagal terhubung:', err.message);
    console.error('     Pastikan MySQL di XAMPP Control Panel sudah Start.');
    process.exit(1);
  }

  // REST API dan Socket.IO berjalan di port yang sama
  const server = http.createServer(createApp(config.corsOrigin));
  initRealtime(server, config.corsOrigin);
  server.listen(config.port, () => {
    console.log(`[API] http://localhost:${config.port}/api/health`);
  });

  // Deteksi perangkat yang berhenti mengirim data
  engine.startWatchdog();

  // MQTT
  const client = mqtt.connect(config.mqttUrl, { clientId: 'citguard-backend' });

  client.on('connect', () => {
    console.log(`[MQTT] Terhubung ke ${config.mqttUrl}`);
    client.subscribe(config.mqttTopic, { qos: 1 }, (err) => {
      if (err) console.error('[MQTT] Gagal subscribe:', err.message);
      else console.log(`[MQTT] Subscribe ke ${config.mqttTopic}`);
    });
  });

  // Pesan diproses satu per satu sesuai urutan masuk
  let queue = Promise.resolve();
  client.on('message', (topic, message) => {
    queue = queue
      .then(() => handleMessage(topic, message))
      .catch((err) => console.error(`[ERROR] ${topic}:`, err.message));
  });

  client.on('reconnect', () => console.log('[MQTT] Mencoba sambung ulang...'));
  client.on('error', (err) => console.error('[MQTT] Error:', err.message));

  // Tutup dengan rapi saat Ctrl+C
  process.on('SIGINT', async () => {
    console.log('Menutup backend...');
    client.end();
    server.close();
    await pool.end();
    process.exit(0);
  });
}

main();
