// src/routes/ice.js
import { Router } from 'express';
import { supabase } from '../../config/supabase.js';
import { assertTeamLead, assertRoomMember } from '../util/auth.js';
import { getRoomTimer } from '../util/timers.js';

const router = Router();

// ── GET /api/ice/questions/:room_id ──────────────────────────
router.get('/questions/:room_id', async (req, res) => {
  try {
    const room_id = req.params.room_id;
    const { data: custom } = await supabase
      .from('ice_questions').select('*').eq('room_id', room_id).order('created_at');
    if (custom && custom.length > 0) {
      return res.json({ questions: custom, source: 'custom' });
    }
    const { data: defaults, error } = await supabase
      .from('ice_questions').select('*').is('room_id', null).limit(5);
    if (error) throw error;
    res.json({ questions: defaults, source: 'default' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/ice/questions  — save custom questions (lead) ──
router.post('/questions', async (req, res) => {
  try {
    const { room_id, player_id, questions } = req.body;
    if (!player_id) return res.status(400).json({ error: 'player_id is required' });
    const auth = await assertTeamLead(player_id, room_id);
    if (!auth.ok) return res.status(auth.status).json({ error: auth.error });

    if (!Array.isArray(questions) || questions.length === 0) {
      return res.status(400).json({ error: 'questions array is required' });
    }
    if (questions.length > 10) {
      return res.status(400).json({ error: 'Maximum 10 custom questions per room' });
    }

    const rows = questions.map(q => ({
      room_id,
      question_text: q.q,
      option_a: q.opts[0] ?? '',
      option_b: q.opts[1] ?? '',
      option_c: q.opts[2] ?? '',
      option_d: q.opts[3] ?? '',
      correct_idx: q.correct,
      xp_value: q.xp ?? 100,
    }));

    await supabase.from('ice_questions').delete().eq('room_id', room_id);
    const { data, error } = await supabase.from('ice_questions').insert(rows).select();
    if (error) throw error;
    res.json({ questions: data });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/ice/answer  — record a player's answer ─────────
// Server derives time_left_sec from the authoritative room timer (A-4).
// Broadcasts ice_answered only on a genuine first-time answer (RT-1).
router.post('/answer', async (req, res) => {
  try {
    const { room_id, player_id, question_id, chosen_idx } = req.body;
    if (!player_id) return res.status(400).json({ error: 'player_id is required' });

    const auth = await assertRoomMember(player_id, room_id);
    if (!auth.ok) return res.status(auth.status).json({ error: auth.error });

    const { data: q, error: qErr } = await supabase
      .from('ice_questions').select('correct_idx, xp_value').eq('id', question_id).single();
    if (qErr || !q) return res.status(404).json({ error: 'Question not found' });

    // Server-side time_left_sec. Untrusted client value is ignored.
    const t = getRoomTimer(room_id);
    const time_left_sec = t?.phase === 'ice' ? t.timer : 0;

    const is_correct = chosen_idx === q.correct_idx;
    const base_xp    = q.xp_value ?? 100;
    const xp_earned  = is_correct ? (base_xp + time_left_sec * 10) : 0;

    // First answer wins — unique(player_id, question_id) dedupes
    const { data: ans } = await supabase
      .from('ice_answers')
      .upsert(
        { room_id, player_id, question_id, chosen_idx, is_correct, time_left_sec, xp_earned },
        { onConflict: 'player_id,question_id', ignoreDuplicates: true }
      )
      .select().maybeSingle();

    const wasFirstInsert = !!ans;

    if (wasFirstInsert && xp_earned > 0) {
      await supabase.from('xp_transactions').upsert(
        { room_id, player_id, amount: xp_earned, source: 'ice_correct', ref_id: ans.id },
        { onConflict: 'player_id,source,ref_id', ignoreDuplicates: true }
      );
    }

    // RT-1: only broadcast on first-time answer. Duplicates return is_correct from the stored row.
    if (wasFirstInsert) {
      req.app.locals.io?.to(room_id).emit('ice_answered', {
        player_id, question_id, chosen_idx, is_correct, xp_earned,
      });
    }

    res.json({ is_correct, xp_earned, duplicate: !wasFirstInsert });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

export default router;
