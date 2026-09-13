// Static catalogue. CodeBuddy exposes no live model list, so this ships as a
// curated table (mirrored from the upstream CLI's advertised models).

import type { ModelInfo } from "./types";

export const codebuddyModels: ModelInfo[] = [
  { id: "default-model", maxInputTokens: 176000, maxOutputTokens: 24000 },
  { id: "default-model-lite", maxInputTokens: 176000, maxOutputTokens: 24000 },
  { id: "claude-sonnet-4.6", maxInputTokens: 176000, maxOutputTokens: 24000, ownedBy: "anthropic" },
  { id: "claude-opus-5", maxInputTokens: 1000000, maxOutputTokens: 128000, ownedBy: "anthropic" },
  { id: "claude-opus-4.7-1m", maxInputTokens: 1000000, maxOutputTokens: 128000, ownedBy: "anthropic" },
  { id: "claude-opus-4.6", maxInputTokens: 1000000, maxOutputTokens: 128000, ownedBy: "anthropic" },
  { id: "claude-haiku-4.5", maxInputTokens: 176000, maxOutputTokens: 24000, ownedBy: "anthropic" },
  { id: "gpt-5.6-sol", maxInputTokens: 1050000, maxOutputTokens: 128000, ownedBy: "openai" },
  { id: "gpt-5.6-luna", maxInputTokens: 1050000, maxOutputTokens: 128000, ownedBy: "openai" },
  { id: "gpt-5.6-terra", maxInputTokens: 1050000, maxOutputTokens: 128000, ownedBy: "openai" },
  { id: "gpt-6-astra", maxInputTokens: 1050000, maxOutputTokens: 128000, ownedBy: "openai" },
  { id: "gpt-5.5", maxInputTokens: 1000000, maxOutputTokens: 72000, ownedBy: "openai" },
  { id: "gpt-5.4", maxInputTokens: 272000, maxOutputTokens: 128000, ownedBy: "openai" },
  { id: "gpt-5.3-codex", maxInputTokens: 272000, maxOutputTokens: 128000, ownedBy: "openai" },
  { id: "gpt-5.1-codex", maxInputTokens: 272000, maxOutputTokens: 128000, ownedBy: "openai" },
  { id: "gemini-3.1-pro", maxInputTokens: 400000, maxOutputTokens: 64000, ownedBy: "google" },
  { id: "gemini-3.0-flash", maxInputTokens: 400000, maxOutputTokens: 64000, ownedBy: "google" },
  { id: "gemini-3.5-flash", maxInputTokens: 1000000, maxOutputTokens: 65536, ownedBy: "google" },
  { id: "gemini-2.5-flash", maxInputTokens: 400000, maxOutputTokens: 64000, ownedBy: "google" },
  { id: "gemini-3.1-flash-lite", maxInputTokens: 200000, maxOutputTokens: 65536, ownedBy: "google" },
  { id: "gemini-2.5-pro", maxInputTokens: 400000, maxOutputTokens: 64000, ownedBy: "google" },
  { id: "deepseek-v3-0324", maxInputTokens: 128000, maxOutputTokens: 8192, ownedBy: "deepseek" },
  { id: "deepseek-v4.1-flash", maxInputTokens: 1000000, maxOutputTokens: 128000, ownedBy: "deepseek" },
  { id: "glm-5.3", maxInputTokens: 1000000, maxOutputTokens: 131072, ownedBy: "zhipu" },
  { id: "glm-5.3-flash", maxInputTokens: 1000000, maxOutputTokens: 131072, ownedBy: "zhipu" },
  { id: "glm-5.2", maxInputTokens: 1000000, maxOutputTokens: 131072, ownedBy: "zhipu" },
  { id: "glm-5.0", maxInputTokens: 200000, maxOutputTokens: 48000, ownedBy: "zhipu" },
  { id: "kimi-k3", maxInputTokens: 1000000, maxOutputTokens: 1048576, ownedBy: "moonshot" },
  { id: "kimi-k2.5", maxInputTokens: 164000, maxOutputTokens: 32000, ownedBy: "moonshot" },
  { id: "minimax-m3", maxInputTokens: 512000, maxOutputTokens: 48000, ownedBy: "minimax" },
];
