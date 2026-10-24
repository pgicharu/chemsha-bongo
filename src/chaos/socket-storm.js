// Switch "socket-storm": every 5 s drops about 30% of player connections.
// Closes the transport rather than calling socket.disconnect(), which would
// tell the client not to reconnect.

import { onSwitch } from './switches.js';

const WAVE_EVERY_MS = 5_000;
const SHARE_DROPPED = 0.3;

let io = null;
let timer = null;

function dropConnection(socket) {
  const transport = socket.conn.transport;
  if (transport.name === 'websocket' && typeof transport.socket?.terminate === 'function') {
    transport.socket.terminate();
  } else {
    socket.conn.close();
  }
}

function wave() {
  if (!io) return;
  for (const socket of io.sockets.sockets.values()) {
    if (socket.data.role === 'player' && Math.random() < SHARE_DROPPED) dropConnection(socket);
  }
}

// Called once from registerGameSockets() (game/sockets.js).
export function watchForSocketStorm(socketServer) {
  io = socketServer;
}

onSwitch('socket-storm', (on) => {
  clearInterval(timer);
  timer = null;
  if (on) {
    timer = setInterval(wave, WAVE_EVERY_MS);
    timer.unref();
  }
});
