// Append-only audit helper. Never blocks callers — errors are logged, not thrown.
// Event types used across the codebase (keep this list in sync when adding new events):
//   admin_login_ok, admin_login_fail, admin_login_ratelimited
//   room_lock_toggle, team_lead_set, host_promoted, room_end
//   cors_rejected
import { supabase } from '../../config/supabase.js';

export function clientContext(req) {
  // `req.ip` respects Express `trust proxy` so we can see the real client behind Railway's LB.
  const ua = String(req.headers?.['user-agent'] || '').slice(0, 200);
  return { ip: req.ip, user_agent: ua };
}

export function recordAudit(event_type, fields = {}) {
  const row = {
    event_type,
    actor_kind: fields.actor_kind ?? null,
    actor_id:   fields.actor_id   ?? null,
    actor_name: fields.actor_name ?? null,
    room_id:    fields.room_id    ?? null,
    ip:         fields.ip         ?? null,
    user_agent: fields.user_agent ?? null,
    meta:       fields.meta       ?? {},
  };
  // Fire-and-forget — never block the request path on audit writes.
  supabase.from('audit_log').insert(row).then(
    () => {},
    (err) => console.warn('[audit] write failed:', err?.message, 'event:', event_type),
  );
  console.log(`[audit] ${event_type}`, row.actor_name ?? row.actor_id ?? '', row.ip ?? '');
}
