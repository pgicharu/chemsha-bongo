// Switch "email-down": sends go to a local TCP server that accepts and never
// greets, so nodemailer hits its greeting timeout. Applies to any EMAIL_TRANSPORT.

import net from 'node:net';
import { onSwitch } from './switches.js';

let server = null;
let address = null;
const connections = new Set();

async function open() {
  server = net.createServer((socket) => {
    connections.add(socket);
    socket.on('close', () => connections.delete(socket));
    socket.on('error', () => {});
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  server.unref();
  address = { host: '127.0.0.1', port: server.address().port };
}

function close() {
  address = null;
  for (const socket of connections) socket.destroy();
  server?.close();
  server = null;
}

// Used by sendEmail(): the blackhole address while on, else null.
export function smtpBlackholeAddress() {
  return address;
}

onSwitch('email-down', async (on) => {
  if (on) await open();
  else close();
});
