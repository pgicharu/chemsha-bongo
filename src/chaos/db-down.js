// Switch "db-down": replaces the db.js pool with one whose connections never
// complete, so queries fail after the pool's connect timeout. Off restores it.

import net from 'node:net';
import { replacePool } from '../db.js';
import { onSwitch } from './switches.js';

class UnreachableSocket extends net.Socket {
  connect() {
    return this;
  }
}

onSwitch('db-down', (on) => {
  replacePool(on ? { stream: () => new UnreachableSocket() } : {});
});
