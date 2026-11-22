// Mengembalikan trip demo ke kondisi awal agar skenario bisa diulang.
// Jalankan: node tools/reset-demo.js [TRIP_ID]
// Catatan: hanya untuk demo lab. Telemetry, event, alert, dan audit_log TIDAK dihapus;
// laporan hanya menghitung data sejak started_at yang baru.
require('../src/config');
const pool = require('../src/db');

const tripId = process.argv[2] || 'TRK-001';

(async () => {
  try {
    const [t] = await pool.query(
      "UPDATE trips SET status = 'active', started_at = NOW(3), ended_at = NULL WHERE trip_id = ?",
      [tripId]
    );
    if (t.affectedRows === 0) {
      console.log(`Trip ${tripId} tidak ditemukan.`);
    } else {
      await pool.query(
        'UPDATE trip_stops SET arrived_at = NULL, departed_at = NULL WHERE trip_id = ?',
        [tripId]
      );
      console.log(`Trip ${tripId} direset: status active, waktu mulai sekarang, semua stop dikosongkan.`);
      console.log('Restart backend (Ctrl+C lalu npm start) supaya status deviasi di memori ikut bersih.');
    }
  } catch (err) {
    console.error('Gagal reset:', err.message);
  } finally {
    await pool.end();
  }
})();
