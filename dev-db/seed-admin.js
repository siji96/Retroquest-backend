// Create or reset the default admin account.
// Usage: node dev-db/seed-admin.js [--username=admin] [--reset]
//   --reset  → regenerate password even if the user already exists
// Prints the generated password exactly once. Save it somewhere safe;
// we only store the bcrypt hash in the DB.
import 'dotenv/config';
import { supabase } from '../config/supabase.js';
import { hashPassword, generatePassword } from '../src/util/adminAuth.js';

const args = Object.fromEntries(process.argv.slice(2).map(a => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  return m ? [m[1], m[2] ?? true] : [a, true];
}));

const username = String(args.username || 'admin');
const reset    = !!args.reset;

const { data: existing } = await supabase
  .from('admin_users').select('id, username').eq('username', username).maybeSingle();

if (existing && !reset) {
  console.log(`admin user "${username}" already exists — pass --reset to regenerate password`);
  process.exit(0);
}

const password = generatePassword(16);
const password_hash = await hashPassword(password);

let userId;
if (existing) {
  await supabase.from('admin_users')
    .update({ password_hash, last_login_at: null }).eq('id', existing.id);
  userId = existing.id;
} else {
  const { data, error } = await supabase
    .from('admin_users').insert({ username, password_hash }).select().single();
  if (error) throw error;
  userId = data.id;
}

console.log('');
console.log('┌──────────────────────────────────────────────┐');
console.log('│  RetroQuest admin account ready              │');
console.log('├──────────────────────────────────────────────┤');
console.log(`│  username: ${username.padEnd(34)}│`);
console.log(`│  password: ${password.padEnd(34)}│`);
console.log('└──────────────────────────────────────────────┘');
console.log('  (save this now — the hash in the DB is one-way)');
console.log('');

process.exit(0);
