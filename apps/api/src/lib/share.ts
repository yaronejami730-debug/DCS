import { randomBytes } from 'node:crypto';
import type { MiddlewareHandler } from 'hono';
import {
  SHARE_LINK_TTL_DAYS,
  type LinkActivityStep,
  type ShareLink,
  type ShareScope,
} from '@scansign/shared';
import { env } from '../env.js';
import { db } from './supabase.js';
import { forbidden, unauthorized } from './errors.js';
import { requireAuth, type AppBindings } from './auth.js';

/**
 * Share links: one folder, one capability URL, no account.
 *
 * The security model in one sentence — a share token authenticates *as the
 * folder's owner, for that folder only*. Every signing route already scopes its
 * queries by `owner_id`, so resolving a token to the owner's identity makes all
 * of them work unchanged; the extra folder check layered on top is what stops a
 * link to folder A from touching folder B. Both halves are needed: the owner
 * identity alone would be a full account takeover by URL.
 */

export interface ShareContext {
  linkId: string;
  folderId: string;
  /**
   * 'signer' sees nothing of the folder; 'operator' is the account holder on
   * their own phone and may read it. Checked at each route that exposes
   * document data — never assumed.
   */
  scope: ShareScope;
}

export interface ShareBindings {
  Variables: AppBindings['Variables'] & {
    /** Set only when the caller arrived with a share token. */
    share?: ShareContext;
  };
}

export interface ShareLinkRow {
  id: string;
  folder_id: string;
  owner_id: string;
  token: string;
  label: string | null;
  scope: ShareScope;
  require_location: boolean;
  expires_at: string | null;
  revoked_at: string | null;
  last_opened_at: string | null;
  opened_count: number;
  last_activity_at: string | null;
  last_activity_step: LinkActivityStep | null;
  created_at: string;
}

export const SHARE_LINK_SELECT =
  'id, folder_id, owner_id, token, label, scope, require_location, expires_at, revoked_at, last_opened_at, opened_count, last_activity_at, last_activity_step, created_at';

/**
 * 32 bytes of CSPRNG, base64url.
 *
 * Not a UUID: a v4 UUID carries 122 bits in a format people recognise as
 * guessable-looking and paste into bug reports, and this token is the only
 * thing standing between a stranger and someone's contract.
 */
export const mintToken = (): string => randomBytes(32).toString('base64url');

/** Where the signing app lives, for assembling a link the operator can send. */
export const shareUrl = (token: string): string =>
  `${env.SIGNER_PUBLIC_URL.replace(/\/$/, '')}/s/${token}`;

export const isActive = (row: ShareLinkRow): boolean =>
  row.revoked_at === null && (row.expires_at === null || new Date(row.expires_at) > new Date());

/**
 * Which documents a link covers.
 *
 * Empty means the whole folder — see the migration for why that is the
 * permissive end. Callers that need to *act* on the subset must go through
 * `documentsForLink` below rather than reading this and guessing.
 */
export const linkDocumentIds = async (linkId: string): Promise<string[]> => {
  const { data } = await db
    .from('folder_share_link_documents')
    .select('document_id')
    .eq('link_id', linkId)
    .returns<Array<{ document_id: string }>>();
  return (data ?? []).map((r) => r.document_id);
};

/**
 * Replace a link's document subset.
 *
 * The ids are re-checked against the folder rather than trusted: a link is a
 * capability onto one folder, and letting its subset name a document from
 * another would be a way to have a stranger's contract signed by someone who
 * was never shown it.
 */
export const setLinkDocuments = async (
  linkId: string,
  folderId: string,
  documentIds: string[],
): Promise<string[]> => {
  await db.from('folder_share_link_documents').delete().eq('link_id', linkId);
  if (documentIds.length === 0) return [];

  const { data: valid } = await db
    .from('documents')
    .select('id')
    .eq('folder_id', folderId)
    .in('id', documentIds)
    .returns<Array<{ id: string }>>();

  const ids = (valid ?? []).map((d) => d.id);
  if (ids.length === 0) return [];

  await db
    .from('folder_share_link_documents')
    .insert(ids.map((document_id) => ({ link_id: linkId, document_id })));
  return ids;
};

export const toShareLink = (row: ShareLinkRow, documentIds: string[] = []): ShareLink => ({
  id: row.id,
  folderId: row.folder_id,
  token: row.token,
  url: shareUrl(row.token),
  label: row.label,
  scope: row.scope,
  documentIds,
  requireLocation: row.require_location ?? false,
  createdAt: row.created_at,
  expiresAt: row.expires_at,
  revokedAt: row.revoked_at,
  lastOpenedAt: row.last_opened_at,
  openedCount: row.opened_count,
  lastActivityAt: row.last_activity_at ?? null,
  lastActivityStep: row.last_activity_step ?? null,
  active: isActive(row),
});

export const defaultExpiry = (days: number | null | undefined): string | null => {
  if (days === null) return null;
  const ttl = days ?? SHARE_LINK_TTL_DAYS;
  return new Date(Date.now() + ttl * 24 * 60 * 60 * 1000).toISOString();
};

/**
 * Resolve a token, or say precisely why it will not work.
 *
 * The three failure modes are told apart on purpose. "Ce lien a été révoqué"
 * and "Ce lien a expiré" are things the signer can act on — they ask for a new
 * one — whereas a flat 401 sends them to the operator with nothing useful to
 * report.
 */
export const resolveShareToken = async (token: string): Promise<ShareLinkRow> => {
  const { data } = await db
    .from('folder_share_links')
    .select(SHARE_LINK_SELECT)
    .eq('token', token)
    .maybeSingle<ShareLinkRow>();

  if (!data) throw unauthorized('Ce lien de signature est introuvable.');
  if (data.revoked_at) throw forbidden('Ce lien de signature a été révoqué.');
  if (data.expires_at && new Date(data.expires_at) <= new Date()) {
    throw forbidden('Ce lien de signature a expiré. Demandez-en un nouveau.');
  }
  return data;
};

const readShareToken = (header: string | undefined): string | null => {
  if (!header?.startsWith('Share ')) return null;
  const token = header.slice(6).trim();
  return token.length > 0 ? token : null;
};

/**
 * Accept either credential on the same route.
 *
 * `Authorization: Bearer <jwt>` is the operator in the console; `Authorization:
 * Share <token>` is the signer following a link. A scheme rather than a query
 * parameter or a custom header, because tokens in URLs end up in access logs,
 * `Referer` headers and browser history.
 */
export const requireAuthOrShare: MiddlewareHandler<ShareBindings> = async (c, next) => {
  const header = c.req.header('authorization') ?? c.req.header('Authorization');
  const token = readShareToken(header);

  if (!token) {
    // No share token: fall through to the ordinary account check, which owns
    // the "missing credential" and "expired session" messages.
    return requireAuth(c as never, next);
  }

  const link = await resolveShareToken(token);

  const { data: profile } = await db
    .from('profiles')
    .select('email, display_name')
    .eq('id', link.owner_id)
    .maybeSingle<{ email: string | null; display_name: string | null }>();

  // The signer acts with the owner's reach so the existing owner_id scoping
  // keeps working — and is then fenced into one folder by `share`.
  c.set('user', {
    id: link.owner_id,
    email: profile?.email ?? '',
    displayName: profile?.display_name ?? null,
  });
  c.set('share', { linkId: link.id, folderId: link.folder_id, scope: link.scope });

  await next();
};

/**
 * May this caller read the folder's documents?
 *
 * Yes for everyone who legitimately holds a link, including a technician —
 * because the technician has to. The flow is: they download the PDF, print it,
 * sign it by hand, scan it back. Withholding the document would leave them
 * nothing to sign.
 *
 * What still fences them in is `assertShareScope` plus the link's own document
 * subset: a link reaches its folder, and within it only the documents it names.
 * A technician sent the delivery notes cannot pull the contract next to them.
 *
 * The predicate is kept — rather than deleted as now-always-true — because the
 * routes that call it are the ones where a future scope would bite, and losing
 * the call sites would mean rediscovering them all.
 */
export const canReadDocuments = (_share: ShareContext | undefined): boolean => true;

/**
 * Documents a link is allowed to touch: its folder's, narrowed by its subset.
 *
 * The single source of truth for "which documents does this link mean", used
 * both when listing them for the technician and when checking that a document
 * they asked for is one of theirs.
 */
export const documentIdsForLink = async (
  linkId: string,
  folderId: string,
): Promise<string[]> => {
  const chosen = await linkDocumentIds(linkId);
  if (chosen.length > 0) return chosen;

  /**
   * With no explicit subset, a link sends the folder's capture sheets.
   *
   * Those are the PDFs the operator imported *for* signing — the pages the
   * technician prints and signs by hand. The contracts are not sent: the
   * technician never needs them, and handing over a folder's paperwork by
   * default is not a defensible default for a URL that travels by SMS.
   *
   * An operator who genuinely wants a contract in front of the signer says so,
   * by naming it in the subset.
   */
  const { data } = await db
    .from('documents')
    .select('id')
    .eq('folder_id', folderId)
    .eq('role', 'for_signing')
    .returns<Array<{ id: string }>>();
  return (data ?? []).map((d) => d.id);
};

/**
 * The fence.
 *
 * Called by every route that a share token can reach, with whatever folder the
 * request resolved to. An operator's JWT carries no share context and passes
 * straight through; a link holder gets a 403 the moment the ids disagree.
 */
export const assertShareScope = (
  share: ShareContext | undefined,
  folderId: string | null | undefined,
): void => {
  if (!share) return;
  if (!folderId || folderId !== share.folderId) {
    throw forbidden("Ce lien ne donne pas accès à ce dossier.");
  }
};

/**
 * Record that somebody opened the link.
 *
 * Through a SQL function, so the count survives two people opening the same
 * link at once — a read-modify-write from here would lose one of them. Best
 * effort regardless: counting opens must never cost a signature.
 */
export const touchShareLink = async (linkId: string): Promise<void> => {
  try {
    await db.rpc('increment_share_link_open', { link_id: linkId });
  } catch {
    /* the operator loses a timestamp, the signer loses nothing */
  }
};

/**
 * The holder's page said what it is doing. Presence, not history: the last
 * write wins, and best effort — a lost ping must never disturb the signing.
 */
export const recordLinkActivity = async (
  linkId: string,
  step: LinkActivityStep,
): Promise<void> => {
  try {
    await db
      .from('folder_share_links')
      .update({ last_activity_at: new Date().toISOString(), last_activity_step: step })
      .eq('id', linkId);
  } catch {
    /* presence is a nicety */
  }
};
