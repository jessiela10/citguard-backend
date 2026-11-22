const { Server } = require('socket.io');

let io = null;

function initRealtime(httpServer, corsOrigin) {
  io = new Server(httpServer, { cors: { origin: corsOrigin } });

  io.on('connection', (socket) => {
    console.log(`[WS] Dashboard tersambung: ${socket.id}`);
    socket.on('disconnect', () => console.log(`[WS] Dashboard terputus: ${socket.id}`));
  });
}

function emit(eventName, payload) {
  if (io) io.emit(eventName, payload);
}

module.exports = { initRealtime, emit };