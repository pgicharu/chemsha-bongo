// Bot players: real accounts (is_bot = true) that play through the same
// Socket.IO events and HTTP API as browsers. Used for demo traffic and load
// testing; the CLI is scripts/bots.js.

export { MAX_BOTS } from './accounts.js';
export { joinLiveGame, summarizeLiveBots } from './live-player.js';
export { runSelfPacedBots } from './self-paced.js';
export { runAutoHost } from './auto-host.js';
export { describeError } from './http.js';
