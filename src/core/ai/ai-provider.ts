import type { AiUseCase } from "./ai-use-cases";
import type { AiInputFor } from "./prompt-contracts";
import type { AiOutputPayloadFor } from "./structured-outputs";
import type { AiError } from "./ai-errors";

export type AiProviderMode = "local_preview" | "openai" | "disabled";

export interface AiProviderMeta {
  id: string;
  label: string;
  mode: AiProviderMode;
  connected: boolean;
  notes: string[];
}

export type AiResult<U extends AiUseCase> =
  | { ok: true; payload: AiOutputPayloadFor<U> }
  | { ok: false; error: AiError };

export interface AiProvider {
  readonly meta: AiProviderMeta;
  generate<U extends AiUseCase>(
    useCase: U,
    input: AiInputFor<U>,
  ): Promise<AiResult<U>>;
}
