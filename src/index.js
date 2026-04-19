// src/index.js  — RetroQuest backend entry point
import 'dotenv/config';
import { createServer } from 'http';
import { Server }        from 'socket.io';
import express           from 'express';
import cors              from 'cors';
import helmet            from 'helmet';

import roomsRouter       from './routes/rooms.js';
import iceRouter         from './routes/ice.js';
import cardsRouter       from './routes/cards.js';
import reviewRouter      from './routes/review.js';
import chatRouter        from './routes/chat.js';
import leaderboardRouter from './routes/leaderboard.js';
import { registerSocketHandlers } from './socket/handlers.js';

// ── App ───────────────────────────────────────────────────────
const app    = express();
const server = createServer(app);
const PORT   = process.env.PORT ?? 3001;

// Allowed origins: Vercel production URL + localhost dev
const ORIGINS = [
  process.env.NEXT_PUBLIC_APP_URL,
  'http://localhost:3000',
  'http://localhost:5173',
].filter(Boolean);

// ── Socket.IO ─────────────────────────────────────────────────
const io = new Server(server, {
  cors: { origin: ORIGINS, credentials: true },
  pingTimeout:  60000,
  pingInterval: 25000,
});

// Make io available in all route handlers via app.locals
app.locals.io = io;
registerSocketHandlers(io);

// ── Middleware ────────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: false,  // frontend handles its own CSP
}));
app.use(cors({ origin: ORIGINS, credentials: true }));
app.use(express.json({ limit: '64kb' }));

// ── Health check ─────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({
  status: 'ok',
  service: 'retroquest-backend',
  version: '1.1.0',
  timestamp: new Date().toISOString(),
}));

// ── Routes ────────────────────────────────────────────────────
app.use('/api/rooms',       roomsRouter);
app.use('/api/ice',         iceRouter);
app.use('/api/cards',       cardsRouter);
// Cards nested under rooms for GET /api/rooms/:id/cards
app.get('/api/rooms/:id/cards', (req, res, next) => {
  req.url = `/rooms/${req.params.id}/cards`;
  cardsRouter(req, res, next);
});
app.use('/api/review',      reviewRouter);
app.use('/api/chat',        chatRouter);
app.use('/api/leaderboard', leaderboardRouter);

// ── 404 fallback ─────────────────────────────────────────────
app.use((_req, res) => res.status(404).json({ error: 'Not found' }));

// ── Global error handler ──────────────────────────────────────
app.use((err, _req, res, _next) => {
  console.error('[error]', err);
  res.status(500).json({ error: 'Internal server error' });
});

// ── Start ─────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`
  ╔══════════════════════════════════════╗
  ║  RetroQuest Backend v1.1             ║
  ║  http://localhost:${PORT}               ║
  ║  Supabase: ${process.env.SUPABASE_URL ? '✓ connected' : '✗ MISSING URL'}        ║
  ║  Anthropic: ${process.env.ANTHROPIC_API_KEY ? '✓ key set   ' : '✗ MISSING KEY '}       ║
  ╚══════════════════════════════════════╝
  `);
});

export { app, server };
