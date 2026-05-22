export * from "./ai-use-cases";
export * from "./structured-outputs";
export * from "./prompt-contracts";
export * from "./ai-cost-policy";
export * from "./ai-safety-policy";
export * from "./ai-errors";
export * from "./ai-telemetry";
export * from "./ai-provider";
export * from "./mock-ai-provider";
export * from "./openai-provider.placeholder";

import { MockAiProvider } from "./mock-ai-provider";
import { OpenAiProviderPlaceholder } from "./openai-provider.placeholder";
import type { AiProvider } from "./ai-provider";

let activeProvider: AiProvider | null = null;

export function getActiveAiProvider(): AiProvider {
  if (!activeProvider) {
    activeProvider = new MockAiProvider();
  }
  return activeProvider;
}

export function listAiProviders(): AiProvider[] {
  return [new MockAiProvider(), new OpenAiProviderPlaceholder()];
}
