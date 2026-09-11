/**
 * Types shared between the server loader and the client controls.
 *
 * `load-relationships.server.ts` carries `server-only`, so a client
 * component that imported its types would pull the whole server tree
 * into a client chunk. These live here instead: pure types plus two
 * constants, importable from either side.
 */

import type { BlueskyRelationshipState } from "@/lib/supabase/types";

export const RELATIONSHIP_TABS = [
  "targets",
  "candidates",
  "following",
  "mutual",
  "history",
  "batches",
] as const;

export type RelationshipTab = (typeof RELATIONSHIP_TABS)[number];

export const RELATIONSHIP_STATES: BlueskyRelationshipState[] = [
  "unknown",
  "not_following",
  "following",
  "follows_you",
  "mutual",
];

export interface PageInfo {
  page: number;
  pageSize: number;
  /** Exact, from Postgres — never derived from the current page. */
  total: number;
  totalPages: number;
}

export interface RelationshipsQuery {
  tab: RelationshipTab;
  search: string;
  state: BlueskyRelationshipState | null;
  page: number;
  historyPage: number;
}
