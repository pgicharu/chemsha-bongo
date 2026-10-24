// GET /health: liveness only. Intentionally shallow; it does not check the
// database, so it can report ok while dependencies are down.

import { Router } from 'express';

export const healthRouter = Router();

healthRouter.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});
