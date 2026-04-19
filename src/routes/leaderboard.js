// src/routes/leaderboard.js
import { Router } from 'express';
import { supabase } from '../../config/supabase.js';

const router = Router();

// ── GET /api/leaderboard/:room_id ────────────────────────────
router.get('/:room_id', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('v_room_leaderboard')
      .select('*')
      .eq('room_id', req.params.room_id)
      .order('rank');

    if (error) throw error;
    res.json({ leaderboard: data });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
