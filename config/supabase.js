// config/supabase.js
// Uses service_role key — server-side only, bypasses RLS
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
dotenv.config();

const url  = process.env.SUPABASE_URL;
const key  = process.env.SUPABASE_SERVICE_KEY;

if (!url || !key) {
  throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY in environment');
}

export const supabase = createClient(url, key, {
  auth: { persistSession: false },
});
