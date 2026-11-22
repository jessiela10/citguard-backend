// Mendengarkan event real-time dari backend untuk pengujian.
// Jalankan: node tools/ws-listen.js
const { io } = require('socket.io-client');

const socket = io('http://localhost:3001');

socket.on('connect', () => console.log('Tersambung ke backend, id:', socket.id));
socket.on('telemetry', (d) => console.log('[telemetry]', JSON.stringify(d)));
socket.on('event', (d) => console.log('[event]', JSON.stringify(d)));
socket.on('device_status', (d) => console.log('[device_status]', JSON.stringify(d)));
socket.on('alert', (d) => console.log('[ALERT]', JSON.stringify(d)));
socket.on('alert_update', (d) => console.log('[alert_update]', JSON.stringify(d)));
socket.on('trip_stop', (d) => console.log('[trip_stop]', JSON.stringify(d)));
socket.on('trip_status', (d) => console.log('[trip_status]', JSON.stringify(d)));
socket.on('connect_error', (err) => console.error('Gagal tersambung:', err.message));
