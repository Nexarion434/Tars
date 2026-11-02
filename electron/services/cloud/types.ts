/**
 * A Tars server's clients and what each may do (docs/superpowers/plans/2026-11-02-tars-cloud.md).
 * The server decides, at every request; what a client is told it may do only
 * shapes its window.
 */

/** see: the fleet, screens, live output. drive: start, stop, message, keys, size. create: projects and agents. files: a project's files. */
export const SCOPES = ['see', 'drive', 'create', 'files'] as const;
export type Scope = (typeof SCOPES)[number];

/** desktop: a Tars on another machine, over SSH. outside-agent: Hermes and the like, with a ceiling (no keys, no size). */
export const CLIENT_KINDS = ['desktop', 'outside-agent'] as const;
export type ClientKind = (typeof CLIENT_KINDS)[number];

export interface CloudClient {
  /** c_ and 8 hex. */
  id: string;
  name: string;
  kind: ClientKind;
  scopes: Scope[];
  /** sha256 of the credential, hex. The credential itself is never kept. */
  hash: string;
  createdAt: string;
  /** Absent: until revoked. */
  expiresAt?: string;
}

/** What a listing shows: never the hash, never a credential. */
export type ClientView = Omit<CloudClient, 'hash'>;
