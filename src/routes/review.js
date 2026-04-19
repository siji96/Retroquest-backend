// src/routes/review.js
import { Router } from 'express';
import { supabase } from '../../config/supabase.js';

const router = Router();

// ── POST /api/review/navigate  — broadcast card index ────────
// Team Lead navigates; all participants follow
router.post('/navigate', async (req, res) => {
  try {
    const { room_id, card_index, player_id } = req.body;

    // Verify Team Lead
    const { data: player } = await supabase
      .from('players').select('is_team_lead').eq('id', player_id).single();
    if (!player?.is_team_lead) {
      return res.status(403).json({ error: 'Only the Team Lead can navigate' });
    }

    req.app.locals.io?.to(room_id).emit('review_navigate', { card_index });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
