/**
 * Phase E2.6 — runtime report envelope.
 *
 * Wraps the existing VerificationReport with runtime-specific bits
 * (connector snapshots, evidence). Renderers can choose either shape.
 */

import type { PrReadinessVerdict } from "@/core/verification";
import type { ConnectorRuntimeSnapshot } from "./runtime-types";
import type { RuntimeCheckResult } from "./runtime-result";

export interface RuntimeVerificationReport {
  runId: string;
  verificationRunId: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  connectors: ConnectorRuntimeSnapshot[];
  results: RuntimeCheckResult[];
  prVerdict: PrReadinessVerdict;
}
