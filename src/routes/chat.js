// src/routes/chat.js
import { Router } from 'express';
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

// ── POST /api/chat  — store a message ────────────────────────
router.post('/', async (req, res) => {
  try {
    const { room_id, player_id, content } = req.body;
    if (!content?.trim()) return res.status(400).json({ error: 'Content is required' });
    if (content.length > 200) return res.status(400).json({ error: 'Max 200 characters' });

    const { data: player } = await supabase
      .from('players').select('anon_handle, avatar, is_team_lead').eq('id', player_id).single();

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
      avatar:       player?.avatar ?? '🦄',
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
