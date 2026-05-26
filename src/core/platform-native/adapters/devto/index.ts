/**
 * Phase F6.0 — dev.to platform-native adapter (STUB).
 *
 * Real adapter ships in a follow-up PR. This file exists so the
 * adapter boundary is in place from day one: when the real PR lands,
 * it replaces THIS file ONLY — no other platform changes.
 */

import { makeStubAdapter } from "../stub-adapter";

export const devtoAdapter = makeStubAdapter("devto");
