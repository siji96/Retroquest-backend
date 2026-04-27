// Auth helpers used by both REST routes and socket handlers.
// Single source of truth: players.room_id + players.is_team_lead.
import { supabase } from '../../config/supabase.js';

// Cache minor: look up the player + verify they belong to the given room.
async function loadPlayer(player_id, room_id) {
  if (!player_id || !room_id) return null;
  const { data } = await supabase
    .from('players')
    .select('id, room_id, is_team_lead')
    .eq('id', player_id)
    .single();
  if (!data || data.room_id !== room_id) return null;
  return data;
}

// Permission checks return `{ ok, status, error }`. Routes can spread into res.
export async function assertRoomMember(player_id, room_id) {
  const p = await loadPlayer(player_id, room_id);
  if (!p) return { ok: false, status: 403, error: 'Not a member of this room' };
  return { ok: true, player: p };
}

export async function assertTeamLead(player_id, room_id) {
  const p = await loadPlayer(player_id, room_id);
  if (!p)              return { ok: false, status: 403, error: 'Not a member of this room' };
  if (!p.is_team_lead) return { ok: false, status: 403, error: 'Team-lead only' };
  return { ok: true, player: p };
}

// Pre-start routes (/lock, /start) need to work BEFORE anyone is team lead.
// Rule: if no team_lead exists yet (pre-game bootstrap) → any room member can act.
// Once someone is team_lead → only team_lead can act.
export async function assertHostOrBootstrap(player_id, room_id) {
  const p = await loadPlayer(player_id, room_id);
  if (!p) return { ok: false, status: 403, error: 'Not a member of this room' };
  if (p.is_team_lead) return { ok: true, player: p };

  // Check if anyone else in the room is team_lead.
  const { data: lead } = await supabase
    .from('players').select('id').eq('room_id', room_id).eq('is_team_lead', true).maybeSingle();
  if (lead) return { ok: false, status: 403, error: 'Team-lead only' };

  return { ok: true, player: p, bootstrap: true };
}
