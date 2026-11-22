// Membaca pengaturan dari file .env
require('dotenv').config();

module.exports = {
  mqttUrl: process.env.MQTT_URL || 'mqtt://localhost:1883',
  mqttTopic: process.env.MQTT_TOPIC || 'citguard/#',
  port: Number(process.env.PORT || 3001),
  corsOrigin: process.env.CORS_ORIGIN || 'http://localhost:5173',
};
// Membaca pengaturan dari file .env
require('dotenv').config();

const num = (name, fallback) => Number(process.env[name] || fallback);

module.exports = {
  mqttUrl: process.env.MQTT_URL || 'mqtt://localhost:1883',
  mqttTopic: process.env.MQTT_TOPIC || 'citguard/#',
  port: num('PORT', 3001),
  corsOrigin: process.env.CORS_ORIGIN || 'http://localhost:5173',

  // Aturan event engine (Tahap 4)
  deviationConsecutive: num('DEVIATION_CONSECUTIVE', 2), // berapa titik berturut-turut di luar rute sebelum alert
  rfidWindowS: num('RFID_WINDOW_S', 300),                // scan RFID petugas berlaku 5 menit sebelum pintu dibuka
  positionMaxAgeS: num('POSITION_MAX_AGE_S', 60),        // posisi terakhir dianggap valid jika umurnya <= 60 detik
  offlineTimeoutS: num('OFFLINE_TIMEOUT_S', 30),         // tidak ada data selama 30 detik = offline
  watchdogIntervalS: num('WATCHDOG_INTERVAL_S', 10),     // cek perangkat offline setiap 10 detik
};
