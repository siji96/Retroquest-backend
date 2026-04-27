// src/routes/chat.js
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { supabase } from '../../config/supabase.js';

const router = Router();

// ── GET /api/chat/:room_id  — last 20 messages (late join) ───
router.get('/:room_id', async (req, res) => {
  try {
    const { data: messages, error } = await supabase
      .from('chat_messages')
      .select('*, players:player_id(anon_handle, avatar, is_team_lead)')
      .eq('room_id', req.params.room_id)
      .order('created_at', { ascending: false })
      .limit(20);

    if (error) throw error;
    res.json({ messages: messages.reverse() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Per-player chat throttle. Mirrors the client-side 5s cooldown in Lobby.jsx
// so a user who bypasses the UI (DevTools, scripted requests) still can't
// flood the room. Keying on `player_id` (falling back to IP) means a single
// attacker can't exhaust the limit for everyone else in the room.
const chatLimiter = rateLimit({
  windowMs: 5_000,
  limit: 1,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: (req) => {
    const pid = req.body?.player_id;
    return typeof pid === 'string' && pid ? 'player:' + pid : 'ip:' + req.ip;
  },
  handler: (req, res) => {
    res.status(429).json({ error: 'Slow down — wait a few seconds between messages.' });
  },
});

// ── POST /api/chat  — store a message ────────────────────────
router.post('/', chatLimiter, async (req, res) => {
  try {
    const { room_id, player_id, content } = req.body;
    if (!content?.trim()) return res.status(400).json({ error: 'Content is required' });
    if (content.length > 200) return res.status(400).json({ error: 'Max 200 characters' });

    const { data: player } = await supabase
      .from('players').select('anon_handle, avatar, is_team_lead, room_id').eq('id', player_id).single();

    // Defense-in-depth: the sender must actually belong to the room they're posting to.
    if (!player || player.room_id !== room_id) {
      return res.status(403).json({ error: 'Not a member of this room' });
    }

    const { data: msg, error } = await supabase
      .from('chat_messages')
      .insert({ room_id, player_id, content: content.trim() })
      .select()
      .single();

    if (error) throw error;

    const payload = {
      id:           msg.id,
      content:      msg.content,
      created_at:   msg.created_at,
      avatar:       player?.avatar ?? 'durian-1',
      handle:       player?.anon_handle ?? 'Unknown',
      is_team_lead: player?.is_team_lead ?? false,
    };

    req.app.locals.io?.to(room_id).emit('chat_message', payload);
    res.json({ message: payload });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
