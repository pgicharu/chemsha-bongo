// Route guards for logged-in and confirmed users.

export function requireUser(req, res, next) {
  if (req.user) return next();
  res.status(401).json({ error: 'Please log in', code: 'unauthenticated' });
}

// 401 when not logged in (so the page shows the login form), 403 when unconfirmed.
export function requireConfirmed(req, res, next) {
  if (!req.user) return requireUser(req, res, next);
  if (req.user.confirmed) return next();
  res.status(403).json({ error: 'Please confirm your email first', code: 'unconfirmed' });
}
