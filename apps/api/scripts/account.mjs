#!/usr/bin/env node
/**
 * Account admin utility. Uses the service role key, so it runs on the server
 * only — never ship this to a client.
 *
 *   node apps/api/scripts/account.mjs list
 *   node apps/api/scripts/account.mjs create <email> <password> [displayName]
 *   node apps/api/scripts/account.mjs confirm <email>
 *   node apps/api/scripts/account.mjs password <email> <newPassword>
 */
import { createClient } from '@supabase/supabase-js';
import { config } from 'dotenv';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(here, '../../../.env'), quiet: true });

const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env');
  process.exit(1);
}

const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const findByEmail = async (email) => {
  const { data, error } = await db.auth.admin.listUsers({ page: 1, perPage: 1000 });
  if (error) throw error;
  return data.users.find((u) => u.email?.toLowerCase() === email.toLowerCase()) ?? null;
};

const [command, ...args] = process.argv.slice(2);

switch (command) {
  case 'list': {
    const { data, error } = await db.auth.admin.listUsers({ page: 1, perPage: 1000 });
    if (error) throw error;
    for (const u of data.users) {
      console.log(`${u.email}\t${u.id}\tconfirmed=${Boolean(u.email_confirmed_at)}`);
    }
    break;
  }
  case 'create': {
    const [email, password, displayName] = args;
    if (!email || !password) throw new Error('usage: create <email> <password> [displayName]');
    const { data, error } = await db.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { display_name: displayName ?? null },
    });
    if (error) throw error;
    console.log(`created ${data.user.email} (${data.user.id})`);
    break;
  }
  case 'confirm': {
    const [email] = args;
    const user = await findByEmail(email ?? '');
    if (!user) throw new Error(`no account for ${email}`);
    const { error } = await db.auth.admin.updateUserById(user.id, { email_confirm: true });
    if (error) throw error;
    console.log(`confirmed ${email}`);
    break;
  }
  case 'password': {
    const [email, password] = args;
    const user = await findByEmail(email ?? '');
    if (!user) throw new Error(`no account for ${email}`);
    const { error } = await db.auth.admin.updateUserById(user.id, { password });
    if (error) throw error;
    console.log(`password updated for ${email}`);
    break;
  }
  default:
    console.log(
      'usage: account.mjs list | create <email> <password> [name] | confirm <email> | password <email> <pass>',
    );
    process.exit(command ? 1 : 0);
}
