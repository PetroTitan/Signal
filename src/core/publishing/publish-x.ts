import "server-only";
/**
 * Phase F1 — X publisher placeholder.
 *
 * Intentionally not implemented in F1. Reddit is the first fully
 * implemented publisher; X and LinkedIn follow under separate
 * approval gates once Reddit is proven in live mode.
 */

import { publishNotImplemented } from "./publishing-result";
import type { PublishOutcome } from "./publishing-types";

export async function publishToX(): Promise<PublishOutcome> {
  return publishNotImplemented("x");
}
