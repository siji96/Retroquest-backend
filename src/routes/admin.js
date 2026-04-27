// src/routes/admin.js — admin login + token verify + session list + audit log.
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { supabase } from '../../config/supabase.js';
import { verifyPassword, signAdminToken, requireAdmin } from '../util/adminAuth.js';
import { recordAudit, clientContext } from '../util/audit.js';

const router = Router();

function parseArrayField(v) {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string') { try { const p = JSON.parse(v); return Array.isArray(p) ? p : []; } catch { return []; } }
  return [];
}

// Per-IP brute-force throttle. 5 attempts per 15 minutes is plenty for the single-admin
// dev model; the response includes Retry-After so the UI could surface a friendly message.
// (Default keyGenerator handles IPv6 subnets correctly; we drop the custom one so we
// don't trip the library's IPv6-bypass guard.)
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: (req, res) => {
    recordAudit('admin_login_ratelimited', {
      actor_kind: 'admin', actor_name: String(req.body?.username || '').slice(0, 60),
      ...clientContext(req),
    });
    res.status(429).json({ error: 'Too many sign-in attempts — try again in a few minutes.' });
  },
});

// ── POST /api/admin/login  — exchange username+password for a token
router.post('/login', loginLimiter, async (req, res) => {
  const ctx = clientContext(req);
  const inputUsername = String(req.body?.username || '').slice(0, 60);
  try {
    const { username, password } = req.body || {};
    if (!username || !password) {
      recordAudit('admin_login_fail', { actor_kind: 'admin', actor_name: inputUsername, ...ctx, meta: { reason: 'missing_fields' } });
      return res.status(400).json({ error: 'username and password required' });
    }

    const { data: user } = await supabase
      .from('admin_users').select('id, username, password_hash')
      .eq('username', username).maybeSingle();

    // Constant-time compare regardless of whether the user exists (user enumeration defence).
    const hash = user?.password_hash ?? '$2b$12$invalid_placeholder_for_constant_time_compare_____';
    const ok = await verifyPassword(password, hash);
    if (!user || !ok) {
      recordAudit('admin_login_fail', {
        actor_kind: 'admin', actor_name: inputUsername, ...ctx,
        meta: { reason: user ? 'bad_password' : 'unknown_user' },
      });
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    await supabase.from('admin_users')
      .update({ last_login_at: new Date().toISOString() }).eq('id', user.id);

    const token = signAdminToken({ id: user.id, username: user.username });
    recordAudit('admin_login_ok', { actor_kind: 'admin', actor_id: user.id, actor_name: user.username, ...ctx });
    res.json({ ok: true, token, username: user.username });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/admin/verify ────────────────────────────────────
router.get('/verify', requireAdmin, (req, res) => {
  res.json({ ok: true, username: req.admin.u, exp: req.admin.exp });
});

// ── GET /api/admin/sessions  — list completed retro sessions
router.get('/sessions', requireAdmin, async (_req, res) => {
  try {
    const { data, error } = await supabase
      .from('session_summaries')
      .select(`
        room_id, total_cards, total_votes, mood_emoji, mood_label,
        committed_items, export_text, created_at,
        rooms:room_id ( code, created_at, ended_at, is_active )
      `)
      .order('created_at', { ascending: false })
      .limit(50);
    if (error) throw error;

    const sessions = (data ?? []).map(row => {
      const snap = (() => { try { return JSON.parse(row.export_text || '{}'); } catch { return {}; } })();
      const commits = parseArrayField(row.committed_items).map(c => typeof c === 'string' ? c : (c?.text ?? ''));
      return {
        id: row.rooms?.code ?? row.room_id,
        room_id: row.room_id,
        date: new Date(row.created_at).toLocaleString(),
        timestamp: new Date(row.created_at).getTime(),
        phase: row.rooms?.is_active === false ? 'completed' : 'active',
        totalCards: row.total_cards ?? 0,
        totalVotes: row.total_votes ?? 0,
        mood_emoji: row.mood_emoji,
        mood_label: row.mood_label,
        commits,
        players: Array.isArray(snap.players) ? snap.players : [],
        cards:   Array.isArray(snap.cards)   ? snap.cards   : [],
        duplicates: Array.isArray(snap.cards) ? snap.cards.filter(c => c.isDuplicate).length : 0,
      };
    });
    res.json({ sessions });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/admin/audit  — last 100 events (newest first)
router.get('/audit', requireAdmin, async (_req, res) => {
  try {
    const { data, error } = await supabase
      .from('audit_log')
      .select('id, event_type, actor_kind, actor_id, actor_name, room_id, ip, user_agent, meta, created_at')
      .order('created_at', { ascending: false })
      .limit(100);
    if (error) throw error;
    res.json({ entries: data ?? [] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

export default router;
