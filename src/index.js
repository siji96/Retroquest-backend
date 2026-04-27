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
import chatRouter        from './routes/chat.js';
import leaderboardRouter from './routes/leaderboard.js';
import adminRouter       from './routes/admin.js';
import { registerSocketHandlers } from './socket/handlers.js';
import { resumePersistedTimers } from './util/timers.js';
import { recordAudit, clientContext } from './util/audit.js';

// ── App ───────────────────────────────────────────────────────
const app    = express();
const server = createServer(app);
const PORT   = process.env.PORT ?? 3001;

// Trust the first proxy hop (Railway / Vercel / similar) so req.ip is the real client.
// Rate limit + audit log both depend on this being accurate.
app.set('trust proxy', 1);

// Normalize: strip trailing slash so an env var set as `https://foo.app/` still
// matches the browser-supplied Origin `https://foo.app` (browsers never send
// the trailing slash in the Origin header).
const stripSlash = (s) => (typeof s === 'string' ? s.replace(/\/$/, '') : s);
const ORIGINS = [
  stripSlash(process.env.NEXT_PUBLIC_APP_URL),
  'http://localhost:3000',
  'http://localhost:5173',
].filter(Boolean);

// Strict CORS: reject unlisted origins with an error the browser will respect
// (preflight fails → request blocked). Requests with no Origin header (curl, health
// probes, same-origin navigations) are allowed through.
const corsOptions = {
  origin(origin, cb) {
    if (!origin || ORIGINS.includes(stripSlash(origin))) return cb(null, true);
    recordAudit('cors_rejected', { meta: { origin } });
    return cb(new Error(`Origin not allowed: ${origin}`));
  },
  credentials: true,
  methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  maxAge: 600,
};

// ── Socket.IO ─────────────────────────────────────────────────
const io = new Server(server, {
  cors: { origin: ORIGINS, credentials: true, methods: ['GET', 'POST'] },
  pingTimeout:  60000,
  pingInterval: 25000,
});

app.locals.io = io;
registerSocketHandlers(io);
resumePersistedTimers(io).catch(err => console.error('[timer] resume failed:', err.message));

// ── Middleware ────────────────────────────────────────────────
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors(corsOptions));
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
app.get('/api/rooms/:id/cards', (req, res, next) => {
  req.url = `/rooms/${req.params.id}/cards`;
  cardsRouter(req, res, next);
});
app.use('/api/chat',        chatRouter);
app.use('/api/leaderboard', leaderboardRouter);
app.use('/api/admin',       adminRouter);

// ── 404 fallback ─────────────────────────────────────────────
app.use((_req, res) => res.status(404).json({ error: 'Not found' }));

// ── Global error handler ──────────────────────────────────────
app.use((err, req, res, _next) => {
  if (err?.message?.startsWith('Origin not allowed')) {
    return res.status(403).json({ error: 'Origin not allowed' });
  }
  console.error('[error]', err);
  res.status(500).json({ error: 'Internal server error' });
});

server.listen(PORT, () => {
  console.log(`
  ╔══════════════════════════════════════╗
  ║  RetroQuest Backend v1.1             ║
  ║  http://localhost:${PORT}               ║
  ║  Supabase: ${process.env.SUPABASE_URL ? '✓ connected' : '✗ MISSING URL'}        ║
  ╚══════════════════════════════════════╝
  `);
});

export { app, server };
