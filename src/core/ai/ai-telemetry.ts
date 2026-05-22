import type { AiUseCase } from "./ai-use-cases";
import type { AiErrorCode } from "./ai-errors";

export interface AiCallTelemetry {
  id: string;
  useCase: AiUseCase;
  providerId: string;
  startedAt: string;
  durationMs: number;
  inputChars: number;
  outputChars: number;
  errorCode?: AiErrorCode;
  costEstimateUsd?: number;
}

export interface AiTelemetrySink {
  record(event: AiCallTelemetry): void;
}

export const noopTelemetrySink: AiTelemetrySink = {
  record() {
    // Telemetry is intentionally a no-op until a real sink ships.
  },
};
