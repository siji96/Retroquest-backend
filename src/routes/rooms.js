// src/routes/rooms.js
import { Router } from 'express';
import { supabase } from '../../config/supabase.js';

const router = Router();

// ── helpers ─────────────────────────────────────────────────
const genCode = () =>
  Math.random().toString(36).slice(2, 8).toUpperCase();

// ── POST /api/rooms  — create a room ────────────────────────
router.post('/', async (req, res) => {
  try {
    const {
      cfg_bots_enabled      = true,
      cfg_room_open         = true,
      cfg_ice_timer_secs    = 10,
      cfg_retro_submit_secs = 90,
      cfg_retro_vote_secs   = 60,
    } = req.body;

    // Generate unique 6-char code
    let code, exists = true;
    while (exists) {
      code = genCode();
      const { data } = await supabase
        .from('rooms').select('id').eq('code', code).single();
      exists = !!data;
    }

    const { data: room, error } = await supabase
      .from('rooms')
      .insert({
        code,
        cfg_bots_enabled,
        cfg_room_open,
        cfg_ice_timer_secs,
        cfg_retro_submit_secs,
        cfg_retro_vote_secs,
      })
      .select()
      .single();

    if (error) throw error;
    res.json({ room });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/rooms/:code  — get room by join code ────────────
router.get('/:code', async (req, res) => {
  try {
    const { data: room, error } = await supabase
      .from('rooms')
      .select('*')
      .eq('code', req.params.code.toUpperCase())
      .single();

    if (error || !room) return res.status(404).json({ error: 'Room not found' });
    if (!room.is_active)  return res.status(410).json({ error: 'Room has ended' });
    res.json({ room });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/rooms/:id/join  — join a room ──────────────────
router.post('/:id/join', async (req, res) => {
  try {
    const { avatar = '🦄', is_bot = false, session_token = null } = req.body;
    const room_id = req.params.id;

    // Check room lock
    const { data: room } = await supabase
      .from('rooms').select('cfg_room_open, phase, is_active').eq('id', room_id).single();

    if (!room) return res.status(404).json({ error: 'Room not found' });
    if (!room.is_active) return res.status(410).json({ error: 'Room has ended' });
    if (!room.cfg_room_open && !is_bot) {
      return res.status(403).json({ error: 'Room is locked — no new players allowed' });
    }

    // ── Dedup: if session_token provided, reuse existing player ──
    if (session_token) {
      const { data: existing } = await supabase
        .from('players')
        .select('*')
        .eq('room_id', room_id)
        .eq('session_token', session_token)
        .single();

      if (existing) {
        // Update avatar in case they changed it + refresh last_seen
        await supabase.from('players')
          .update({ avatar, last_seen_at: new Date().toISOString() })
          .eq('id', existing.id);
        return res.json({ player: { ...existing, avatar } });
      }
    }

    // Check room cap (only non-dedup new joins)
    const { count } = await supabase
      .from('players')
      .select('id', { count: 'exact', head: true })
      .eq('room_id', room_id)
      .eq('is_bot', false);

    if (count >= 20) {
      return res.status(409).json({ error: 'Room is full (max 20 players)' });
    }

    // Generate anon handle
    const adj = ['Ghost','Ninja','Shadow','Phantom','Agent','Ranger','Scout','Comet','Rebel','Player','Viper','Falcon'];
    const handle = `${adj[Math.floor(Math.random() * adj.length)]}#${100 + Math.floor(Math.random() * 900)}`;

    const { data: player, error } = await supabase
      .from('players')
      .insert({ room_id, anon_handle: handle, avatar, is_bot, session_token })
      .select()
      .single();

    if (error) throw error;

    // Emit to room
    req.app.locals.io?.to(room_id).emit('player_joined', player);

    res.json({ player });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/rooms/:id/players ───────────────────────────────
router.get('/:id/players', async (req, res) => {
  try {
    const { data: players, error } = await supabase
      .from('players')
      .select('*')
      .eq('room_id', req.params.id)
      .order('joined_at');
    if (error) throw error;
    res.json({ players });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/rooms/:id/start ────────────────────────────────
router.post('/:id/start', async (req, res) => {
  try {
    const { team_lead_player_id } = req.body;
    const room_id = req.params.id;

    // Update room
    await supabase.from('rooms').update({
      team_lead_player_id,
    }).eq('id', room_id);

    // ✅ Set is_team_lead on the player record
    // First clear any existing lead
    await supabase.from('players')
      .update({ is_team_lead: false })
      .eq('room_id', room_id);

    // Then set new lead
    await supabase.from('players')
      .update({ is_team_lead: true })
      .eq('id', team_lead_player_id);

    // Broadcast lead change to room
    req.app.locals.io?.to(room_id).emit('lead_set', { player_id: team_lead_player_id });

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/rooms/:id/lock ─────────────────────────────────
router.post('/:id/lock', async (req, res) => {
  try {
    const { is_open } = req.body;
    await supabase.from('rooms').update({ cfg_room_open: is_open }).eq('id', req.params.id);
    const event = is_open ? 'room_unlocked' : 'room_locked';
    req.app.locals.io?.to(req.params.id).emit(event, { is_open });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/rooms/:id/phase ────────────────────────────────
router.post('/:id/phase', async (req, res) => {
  try {
    const { phase } = req.body;
    await supabase.from('rooms').update({ phase }).eq('id', req.params.id);
    req.app.locals.io?.to(req.params.id).emit('phase_changed', { phase });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/rooms/:id/end ──────────────────────────────────
router.post('/:id/end', async (req, res) => {
  try {
    const { mood_emoji, mood_label, ai_summary_text, committed_items = [] } = req.body;

    // Tally totals
    const { data: cards } = await supabase.from('retro_cards').select('vote_count').eq('room_id', req.params.id);
    const total_cards = cards?.length ?? 0;
    const total_votes = cards?.reduce((a, c) => a + (c.vote_count ?? 0), 0) ?? 0;

    await supabase.from('rooms').update({
      phase: 'results',
      is_active: false,
      ended_at: new Date().toISOString(),
    }).eq('id', req.params.id);

    await supabase.from('session_summaries').upsert({
      room_id: req.params.id,
      total_cards,
      total_votes,
      mood_emoji: mood_emoji ?? '✨',
      mood_label: mood_label ?? 'Solid Sprint',
      ai_summary_text,
      committed_items,
    }, { onConflict: 'room_id' });

    req.app.locals.io?.to(req.params.id).emit('game_ended');
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
