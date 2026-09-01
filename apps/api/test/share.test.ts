import { describe, expect, it } from 'vitest';
import {
  assertShareScope,
  canReadDocuments,
  defaultExpiry,
  isActive,
  mintToken,
  type ShareContext,
  type ShareLinkRow,
} from '../src/lib/share.js';

/**
 * The share-link rules, pinned.
 *
 * A share token is a bearer credential that resolves to the folder owner's
 * identity, so the two guards below are the entire boundary between "a
 * technician can photograph a signature" and "anyone with a URL can read an
 * account". They are cheap to get subtly wrong in a refactor and expensive to
 * discover in production, which is exactly what a test is for.
 */

const row = (over: Partial<ShareLinkRow> = {}): ShareLinkRow => ({
  id: 'link-1',
  folder_id: 'folder-1',
  owner_id: 'owner-1',
  token: 'tok',
  label: null,
  scope: 'signer',
  require_location: false,
  expires_at: null,
  revoked_at: null,
  last_opened_at: null,
  opened_count: 0,
  last_activity_at: null,
  last_activity_step: null,
  created_at: new Date().toISOString(),
  ...over,
});

const share = (over: Partial<ShareContext> = {}): ShareContext => ({
  linkId: 'link-1',
  folderId: 'folder-1',
  scope: 'signer',
  ...over,
});

describe('share token', () => {
  it('is long and unpredictable', () => {
    const a = mintToken();
    const b = mintToken();
    expect(a).not.toEqual(b);
    // 32 bytes of base64url. Short enough to fit a QR code, long enough that
    // guessing is not a strategy.
    expect(a.length).toBeGreaterThanOrEqual(42);
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

describe('link lifetime', () => {
  it('is active while neither revoked nor expired', () => {
    expect(isActive(row())).toBe(true);
    expect(isActive(row({ expires_at: new Date(Date.now() + 60_000).toISOString() }))).toBe(true);
  });

  it('is dead once revoked, even with time left', () => {
    expect(
      isActive(
        row({
          revoked_at: new Date().toISOString(),
          expires_at: new Date(Date.now() + 86_400_000).toISOString(),
        }),
      ),
    ).toBe(false);
  });

  it('is dead once expired, even if never revoked', () => {
    expect(isActive(row({ expires_at: new Date(Date.now() - 1000).toISOString() }))).toBe(false);
  });

  it('defaults to a bounded life, and takes null only when asked explicitly', () => {
    expect(defaultExpiry(undefined)).not.toBeNull();
    expect(defaultExpiry(7)).not.toBeNull();
    // An unbounded capability URL has to be a decision, never a default.
    expect(defaultExpiry(null)).toBeNull();
  });
});

describe('folder fence', () => {
  it('lets the console through untouched', () => {
    // No share context at all: this is an operator with a real account token,
    // already scoped by owner_id at the query.
    expect(() => assertShareScope(undefined, 'any-folder')).not.toThrow();
  });

  it('allows a link into its own folder', () => {
    expect(() => assertShareScope(share(), 'folder-1')).not.toThrow();
  });

  it('refuses a link pointed at another folder', () => {
    expect(() => assertShareScope(share(), 'folder-2')).toThrow(/ne donne pas accès/i);
  });

  it('refuses when the folder could not be resolved at all', () => {
    // A route that lost its folder must fail closed. Passing null through
    // would otherwise read as "no folder to check, carry on".
    expect(() => assertShareScope(share(), null)).toThrow();
    expect(() => assertShareScope(share(), undefined)).toThrow();
  });
});

describe('document visibility', () => {
  /**
   * Every link holder may read documents — including the technician, because
   * the flow requires it: they download the PDF, print it, sign it by hand and
   * scan it back. Withholding the document would leave them nothing to sign.
   *
   * What fences them in is not visibility but reach: `assertShareScope` pins a
   * link to its folder, and the link's own document subset pins it to a slice
   * of that folder. Those are the two tests above and below, and they are the
   * ones that matter.
   */
  it('is open to the console', () => {
    expect(canReadDocuments(undefined)).toBe(true);
  });

  it('is open to an operator link — the owner on their own phone', () => {
    expect(canReadDocuments(share({ scope: 'operator' }))).toBe(true);
  });

  it('is open to a signer link, which has a document to sign', () => {
    expect(canReadDocuments(share({ scope: 'signer' }))).toBe(true);
  });
});
