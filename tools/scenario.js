// Simulator ESP32 untuk skenario demo.
// Jalankan: node tools/scenario.js <nama>
//   normal | deviasi | pintu-sah | pintu-ilegal | offline | panik | kantong-kurang
const mqtt = require('mqtt');
const config = require('../src/config');

const DEVICE = 'CIT-001';
const OFFICER_UID = 'A3F1229C';   // Budi Santoso, ditugaskan di TRK-001
const BAG_UID = 'D1E2F301';       // KANTONG-001
const DEPOT = [-6.2088, 106.8456];
const MID = [-6.2020, 106.8340];  // titik rute di tengah jalan (bukan ATM)
const ATM = [-6.1950, 106.8230];  // ATM Bank - Thamrin (stop 1)
const NEXT = [-6.1850, 106.8250]; // titik rute setelah ATM Thamrin

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nowTs = () => Math.floor(Date.now() / 1000);
let seq = nowTs();                // selalu naik, jadi tidak bentrok dengan run sebelumnya
let pos = DEPOT;
const doors = [0, 0, 0];

const client = mqtt.connect(config.mqttUrl, { clientId: `citguard-sim-${process.pid}` });

async function publish(type, payload) {
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
  await client.publishAsync(`citguard/${DEVICE}/${type}`, body, { qos: 1 });
  console.log(`-> ${type}: ${body}`);
}

function telemetry(lat, lon, spd, opts = {}) {
  pos = [lat, lon];
  return publish('telemetry', {
    id: DEVICE, seq: seq++, ts: opts.ts ?? nowTs(),
    lat, lon, spd, gps: 'sim', doors: [...doors], shock: 0, buf: opts.buf ?? 0,
  });
}

function event(type, fields = {}) {
  return publish('event', { id: DEVICE, seq: seq++, ts: nowTs(), type, ...fields, buf: 0 });
}

// Bergerak dari titik a ke b dalam beberapa langkah, 1 detik per langkah
async function drive(a, b, steps, spd = 40) {
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    await telemetry(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, spd);
    await sleep(1000);
  }
}

// Serah-terima di ATM: scan petugas, buka pintu 1, scan kantong, tutup pintu
async function handover() {
  await event('rfid', { uid: OFFICER_UID });
  await sleep(1000);
  doors[0] = 1;
  await event('door_open', { door: 1 });
  await telemetry(...ATM, 0);
  await sleep(1000);
  await event('rfid', { uid: BAG_UID });
  await sleep(1000);
  doors[0] = 0;
  await event('door_close', { door: 1 });
  await telemetry(...ATM, 0);
  await sleep(1000);
}

const scenarios = {
  // 1. Perjalanan normal: depot -> ATM Thamrin, serah-terima 1 kantong, lanjut jalan. Tidak ada alert.
  async normal() {
    await telemetry(...DEPOT, 0);
    await sleep(1000);
    await drive(DEPOT, MID, 4);
    await drive(MID, ATM, 4);
    await telemetry(...ATM, 0);     // tiba di ATM (stop 1 tercatat)
    await sleep(1000);
    await handover();
    await drive(ATM, NEXT, 3);      // berangkat (stop 1 ditutup, kantong 1/1 sesuai)
  },

  // 2. Deviasi rute: keluar jalur beberapa titik, lalu kembali. 1 alert route_deviation.
  async deviasi() {
    await telemetry(...DEPOT, 0);
    await sleep(1000);
    await drive(DEPOT, MID, 3);
    for (const p of [[-6.2040, 106.8320], [-6.2065, 106.8305], [-6.2090, 106.8290]]) {
      await telemetry(...p, 35);
      await sleep(1000);
    }
    await drive([-6.2090, 106.8290], MID, 3);
  },

  // 3. Pintu dibuka sah: di ATM, scan RFID petugas, buka pintu, scan kantong, tutup.
  async 'pintu-sah'() {
    await telemetry(...ATM, 0);
    await sleep(1000);
    await handover();
  },

  // 4. Pintu dibuka tidak sah: di tengah jalan, tanpa scan RFID. 1 alert unauthorized_door.
  async 'pintu-ilegal'() {
    await telemetry(...MID, 0);
    await sleep(1000);
    doors[1] = 1;
    await event('door_open', { door: 2 });
    await telemetry(...MID, 0);
    await sleep(2000);
    doors[1] = 0;
    await event('door_close', { door: 2 });
    await telemetry(...MID, 0);
  },

  // 5. Gangguan jaringan: berhenti kirim 40 detik (alert device_offline),
  //    lalu kirim ulang data yang "tersimpan di microSD" dengan buf=1.
  async offline() {
    await drive(DEPOT, MID, 2);
    console.log('');
    console.log('[SIM] Wi-Fi diputus. Menyimpan data ke buffer selama 40 detik...');
    const buffered = [];
    for (let i = 1; i <= 8; i++) {
      await sleep(5000);
      const t = i / 8;
      buffered.push({
        lat: MID[0] + (ATM[0] - MID[0]) * t, lon: MID[1] + (ATM[1] - MID[1]) * t, ts: nowTs(),
      });
      console.log(`  buffer ${i}/8`);
    }
    console.log('[SIM] Wi-Fi pulih. Mengirim ulang isi buffer...');
    await publish('status', 'online');
    for (const b of buffered) await telemetry(b.lat, b.lon, 40, { ts: b.ts, buf: 1 });
    await telemetry(...ATM, 0);
  },

  // 6. Tombol panik. 1 alert panic.
  async panik() {
    await telemetry(...MID, 20);
    await sleep(1000);
    await event('panic');
    await telemetry(...MID, 0);
  },

  // 7. Serah-terima kurang: tiba di ATM, tidak ada kantong yang discan, lalu berangkat.
  //    1 alert bag_mismatch (0 dari 1 kantong).
  async 'kantong-kurang'() {
    await drive(MID, ATM, 4);
    await telemetry(...ATM, 0);
    await sleep(2000);
    await drive(ATM, NEXT, 3);
  },
};

const name = process.argv[2];
if (!scenarios[name]) {
  console.log('Pilih skenario: ' + Object.keys(scenarios).join(' | '));
  console.log('Contoh: node tools/scenario.js normal');
  process.exit(1);
}

client.on('connect', async () => {
  console.log(`[SIM] Skenario "${name}" dimulai`);
  await publish('status', 'online');
  await scenarios[name]();

  // Seperti ESP32 sungguhan: tetap kirim posisi tiap 3 detik sampai dihentikan
  console.log('');
  console.log('[SIM] Skenario selesai. Kendaraan diam, tetap mengirim data tiap 3 detik.');
  console.log('[SIM] Tekan Ctrl+C untuk berhenti.');
  setInterval(() => telemetry(pos[0], pos[1], 0).catch(() => {}), 3000);
});

client.on('error', (err) => {
  console.error('Gagal terhubung ke broker:', err.message);
  process.exit(1);
});
