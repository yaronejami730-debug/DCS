import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { env } from '../env.js';

/**
 * Service-role client. Bypasses RLS, so EVERY query in this codebase must
 * filter on owner_id explicitly. Never expose this key outside the backend.
 */
export const db: SupabaseClient = createClient(
  env.SUPABASE_URL,
  env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false, autoRefreshToken: false } },
);

/**
 * Anon client, used only to exchange credentials for a session on behalf of a
 * client. Keeping it here means no browser client ever needs a
 * Supabase key of its own.
 */
export const authClient: SupabaseClient = createClient(
  env.SUPABASE_URL,
  env.SUPABASE_ANON_KEY,
  { auth: { persistSession: false, autoRefreshToken: false } },
);

export const BUCKET = env.SUPABASE_STORAGE_BUCKET;
