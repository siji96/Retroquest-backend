// src/routes/rooms.js
import { Router } from 'express';
import { supabase } from '../../config/supabase.js';
import { assertHostOrBootstrap, assertTeamLead, assertRoomMember } from '../util/auth.js';
import { recordAudit, clientContext } from '../util/audit.js';
import { sanitizeAvatar } from '../util/validators.js';
import { promoteNextLeadIfNeeded } from '../socket/handlers.js';

const router = Router();

const genCode = () => Math.random().toString(36).slice(2, 8).toUpperCase();

// ── POST /api/rooms  — create a room ────────────────────────
router.post('/', async (req, res) => {
  try {
    const {
      cfg_bots_enabled      = true,
      cfg_room_open         = true,
      cfg_ice_enabled       = true,
      cfg_ice_timer_secs    = 10,
      cfg_retro_submit_secs = 90,
      cfg_retro_submit_unlimited = false,
      cfg_retro_vote_secs   = 60,
    } = req.body;

    let code, exists = true;
    while (exists) {
      code = genCode();
      const { data } = await supabase.from('rooms').select('id').eq('code', code).single();
      exists = !!data;
    }

    const { data: room, error } = await supabase.from('rooms').insert({
      code, cfg_bots_enabled, cfg_room_open, cfg_ice_enabled,
      cfg_ice_timer_secs, cfg_retro_submit_secs, cfg_retro_submit_unlimited, cfg_retro_vote_secs,
    }).select().single();

    if (error) throw error;
    res.json({ room });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/rooms/:code  — get room by join code ────────────
router.get('/:code', async (req, res) => {
  try {
    const { data: room, error } = await supabase
      .from('rooms').select('*').eq('code', req.params.code.toUpperCase()).single();
    if (error || !room) return res.status(404).json({ error: 'Room not found' });
    if (!room.is_active)  return res.status(410).json({ error: 'Room has ended' });
    res.json({ room });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/rooms/:id/join  — join a room ──────────────────
router.post('/:id/join', async (req, res) => {
  try {
    const { avatar: rawAvatar = '🦄', is_bot = false, session_token = null } = req.body;
    const avatar = sanitizeAvatar(rawAvatar); // reject HTML-payload avatars
    const room_id = req.params.id;

    const { data: room } = await supabase
      .from('rooms').select('cfg_room_open, phase, is_active').eq('id', room_id).single();
    if (!room)           return res.status(404).json({ error: 'Room not found' });
    if (!room.is_active) return res.status(410).json({ error: 'Room has ended' });
    if (!room.cfg_room_open && !is_bot) {
      return res.status(403).json({ error: 'Room is locked — no new players allowed' });
    }

    // Session dedup — rejoin as existing player
    if (session_token) {
      const { data: existing } = await supabase
        .from('players').select('*')
        .eq('room_id', room_id).eq('session_token', session_token).single();
      if (existing) {
        const nowIso = new Date().toISOString();
        await supabase.from('players')
          .update({ avatar, last_seen_at: nowIso }).eq('id', existing.id);
        // Important: live clients in the room had already removed this player
        // from their local roster (either via player_left after voluntary leave
        // or the 40s disconnect grace). Emit `player_joined` again so their UI
        // re-adds the returning player with the updated avatar + (now demoted)
        // is_team_lead flag, instead of leaving a stale slot.
        const returning = { ...existing, avatar, last_seen_at: nowIso };
        req.app.locals.io?.to(room_id).emit('player_joined', returning);
        return res.json({ player: returning });
      }
    }

    const { count } = await supabase.from('players')
      .select('id', { count: 'exact', head: true })
      .eq('room_id', room_id).eq('is_bot', false);
    if (count >= 20) return res.status(409).json({ error: 'Room is full (max 20 players)' });

    const adj = ['Ghost','Ninja','Shadow','Phantom','Agent','Ranger','Scout','Comet','Rebel','Player','Viper','Falcon'];
    const handle = `${adj[Math.floor(Math.random() * adj.length)]}#${100 + Math.floor(Math.random() * 900)}`;

    const { data: player, error } = await supabase.from('players')
      .insert({ room_id, anon_handle: handle, avatar, is_bot, session_token })
      .select().single();
    if (error) throw error;

    req.app.locals.io?.to(room_id).emit('player_joined', player);
    res.json({ player });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/rooms/:id/players ───────────────────────────────
// Excludes zombies: rows where last_seen_at was rewound to the 1970 epoch
// when the player voluntarily left or the disconnect grace confirmed them
// as gone. The row itself is kept around so session_token dedup still works
// if they come back, but we don't want the lobby roster to include them.
router.get('/:id/players', async (req, res) => {
  try {
    const ZOMBIE_CUTOFF = '1970-06-01T00:00:00.000Z';
    const { data: players, error } = await supabase
      .from('players').select('*')
      .eq('room_id', req.params.id)
      .gt('last_seen_at', ZOMBIE_CUTOFF)
      .order('joined_at');
    if (error) throw error;
    res.json({ players });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/rooms/:id/leave ────────────────────────────────
// REST counterpart to the socket `player_left_voluntary` event. The socket
// version is prone to dropping when the client fires `disconnect()` right
// after `emit()` — peers then have to wait out the 40s disconnect grace
// before the leaver disappears, which can leave the returning user looking
// duplicated when they rejoin. Calling this endpoint first gives us a
// guaranteed, ack'd leave.
router.post('/:id/leave', async (req, res) => {
  try {
    const room_id = req.params.id;
    const { player_id } = req.body || {};
    if (!player_id) return res.status(400).json({ error: 'player_id is required' });

    const auth = await assertRoomMember(player_id, room_id);
    if (!auth.ok) return res.status(auth.status).json({ error: auth.error });

    // Mark the row as a zombie (filtered out of GET /players) but keep it
    // so session_token dedup still finds it if the user comes back later.
    await supabase.from('players')
      .update({ last_seen_at: new Date(0).toISOString() })
      .eq('id', player_id);

    await promoteNextLeadIfNeeded(req.app.locals.io, room_id, player_id);
    req.app.locals.io?.to(room_id).emit('player_left', { player_id });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/rooms/:id/start ────────────────────────────────
// Bootstrap or existing team-lead can start; sets is_team_lead flags atomically.
router.post('/:id/start', async (req, res) => {
  try {
    const room_id = req.params.id;
    const { player_id, team_lead_player_id } = req.body;
    if (!player_id) return res.status(400).json({ error: 'player_id is required' });

    const auth = await assertHostOrBootstrap(player_id, room_id);
    if (!auth.ok) return res.status(auth.status).json({ error: auth.error });

    const lead_id = team_lead_player_id || player_id;

    await supabase.from('rooms').update({ team_lead_player_id: lead_id }).eq('id', room_id);
    // Clear then set — atomic enough at app layer for our scale
    await supabase.from('players').update({ is_team_lead: false }).eq('room_id', room_id);
    await supabase.from('players').update({ is_team_lead: true }).eq('id', lead_id);

    req.app.locals.io?.to(room_id).emit('lead_set', { player_id: lead_id });
    recordAudit('team_lead_set', {
      actor_kind: 'player', actor_id: player_id, room_id,
      ...clientContext(req), meta: { new_lead: lead_id, bootstrap: !!auth.bootstrap },
    });
    res.json({ ok: true, team_lead_player_id: lead_id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/rooms/:id/lock ─────────────────────────────────
router.post('/:id/lock', async (req, res) => {
  try {
    const room_id = req.params.id;
    const { player_id, is_open } = req.body;
    if (!player_id) return res.status(400).json({ error: 'player_id is required' });

    const auth = await assertHostOrBootstrap(player_id, room_id);
    if (!auth.ok) return res.status(auth.status).json({ error: auth.error });

    await supabase.from('rooms').update({ cfg_room_open: !!is_open }).eq('id', room_id);
    const event = is_open ? 'room_unlocked' : 'room_locked';
    req.app.locals.io?.to(room_id).emit(event, { is_open: !!is_open });
    recordAudit('room_lock_toggle', {
      actor_kind: 'player', actor_id: player_id, room_id,
      ...clientContext(req), meta: { is_open: !!is_open },
    });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/rooms/:id/phase ────────────────────────────────
const VALID_PHASES = new Set(['lobby', 'ice', 'retro', 'review', 'results']);
router.post('/:id/phase', async (req, res) => {
  try {
    const room_id = req.params.id;
    const { player_id, phase } = req.body;
    if (!player_id) return res.status(400).json({ error: 'player_id is required' });
    if (!VALID_PHASES.has(phase)) return res.status(400).json({ error: 'Invalid phase' });

    const auth = await assertTeamLead(player_id, room_id);
    if (!auth.ok) return res.status(auth.status).json({ error: auth.error });

    await supabase.from('rooms').update({ phase }).eq('id', room_id);
    req.app.locals.io?.to(room_id).emit('phase_changed', { phase });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/rooms/:id/end ──────────────────────────────────
router.post('/:id/end', async (req, res) => {
  try {
    const room_id = req.params.id;
    const { player_id, mood_emoji, mood_label, ai_summary_text, committed_items = [] } = req.body;
    if (!player_id) return res.status(400).json({ error: 'player_id is required' });

    const auth = await assertTeamLead(player_id, room_id);
    if (!auth.ok) return res.status(auth.status).json({ error: auth.error });

    // Normalise committed_items — frontend admin path sometimes sends JSON-stringified arrays
    let items = committed_items;
    if (typeof items === 'string') {
      try { items = JSON.parse(items); } catch { items = []; }
    }
    if (!Array.isArray(items)) items = [];

    // Full DB snapshot for the admin dashboard — single source of truth (no client-supplied blob).
    const [cardsRes, commentsRes, lbRes] = await Promise.all([
      supabase.from('retro_cards')
        .select('id, col, content, vote_count, is_anonymous, is_discussed, is_duplicate, player_id, players:player_id(anon_handle, avatar)')
        .eq('room_id', room_id).order('created_at'),
      supabase.from('card_comments')
        .select('card_id, content, created_at, players:author_player_id(anon_handle, avatar)')
        .eq('room_id', room_id).order('created_at'),
      supabase.from('v_room_leaderboard')
        .select('player_id, anon_handle, avatar, xp_total, is_team_lead, rank')
        .eq('room_id', room_id).order('rank'),
    ]);

    const cards     = cardsRes.data    ?? [];
    const comments  = commentsRes.data ?? [];
    const players   = lbRes.data       ?? [];
    const total_cards = cards.length;
    const total_votes = cards.reduce((a, c) => a + (c.vote_count ?? 0), 0);

    const commentsByCard = comments.reduce((m, c) => {
      (m[c.card_id] ??= []).push({
        avatar: c.players?.avatar ?? '🦄',
        handle: c.players?.anon_handle ?? 'Lead',
        text: c.content, time: c.created_at,
      });
      return m;
    }, {});

    const LANES = ['Went Well', 'Improve', 'Not Sure'];
    const COL_TO_IDX = { went_well: 0, improve: 1, not_sure: 2 };
    const snap = {
      date: new Date().toISOString(),
      players: players.map(p => ({
        name: p.anon_handle, avatar: p.avatar, xp: p.xp_total ?? 0, isHost: !!p.is_team_lead,
      })),
      cards: cards.map(c => ({
        col: COL_TO_IDX[c.col] ?? 0,
        colName: LANES[COL_TO_IDX[c.col] ?? 0],
        txt: c.is_anonymous ? c.content : c.content,
        votes: c.vote_count ?? 0,
        pname: c.is_anonymous ? 'Anonymous' : (c.players?.anon_handle ?? 'Teammate'),
        pav:   c.is_anonymous ? '🕵️' : (c.players?.avatar ?? '🦄'),
        isDuplicate: !!c.is_duplicate,
        comments: commentsByCard[c.id] ?? [],
      })).sort((a, b) => b.votes - a.votes),
    };

    await supabase.from('rooms').update({
      phase: 'results', is_active: false, ended_at: new Date().toISOString(),
    }).eq('id', room_id);

    await supabase.from('session_summaries').upsert({
      room_id, total_cards, total_votes,
      mood_emoji: mood_emoji ?? '✨',
      mood_label: mood_label ?? 'Solid Sprint',
      ai_summary_text,
      committed_items: items,
      export_text: JSON.stringify(snap),
    }, { onConflict: 'room_id' });

    req.app.locals.io?.to(room_id).emit('game_ended');
    recordAudit('room_end', {
      actor_kind: 'player', actor_id: player_id, room_id,
      ...clientContext(req), meta: { total_cards, total_votes, commits: items.length },
    });
    res.json({ ok: true, total_cards, total_votes });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

export default router;
