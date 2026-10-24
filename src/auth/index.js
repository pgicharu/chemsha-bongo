// Accounts: sign-up, confirmation, login, password reset, sessions.
// The rest of the app imports auth from this file only. req.user and
// socket.data.user are { id, name, email, avatar, confirmed } or null.

export { sessionMiddleware, loadUser } from './session.js';
export { requireUser, requireConfirmed } from './guards.js';
export { authRouter } from './routes.js';
export { attachSocketAuth } from './socket.js';
