/**
 * Tests must not depend on a developer's .env, and must never reach the real
 * Supabase project. Fill in placeholder credentials before any module that
 * validates the environment gets imported.
 */
process.env.SUPABASE_URL ||= 'http://127.0.0.1:54321';
process.env.SUPABASE_ANON_KEY ||= 'test-anon-key-placeholder-value';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-service-role-key-placeholder';
process.env.SUPABASE_STORAGE_BUCKET ||= 'scansign';
process.env.SIGNATURE_SERVICE_URL ||= 'http://127.0.0.1:59999';
