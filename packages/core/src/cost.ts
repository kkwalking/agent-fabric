import type { ModelUsage, Usage } from "./types.js";

/**
 * Rough cost estimation for usage tracking.
 *
 * The MVP keeps a small built-in price table and falls back to a default
 * rate. Prices are per 1M tokens (USD). Provider/model owners can provide
 * exact prices through a future pricing API / config override.
 */

interface Price {
  inputPerM: number;
  outputPerM: number;
  cachedPerM?: number;
}

const KNOWN: Record<string, Price> = {
  "gpt-4o": { inputPerM: 2.5, outputPerM: 10, cachedPerM: 1.25 },
  "gpt-4o-mini": { inputPerM: 0.15, outputPerM: 0.6, cachedPerM: 0.075 },
  "gpt-4.1": { inputPerM: 2, outputPerM: 8, cachedPerM: 0.5 },
  "gpt-4.1-mini": { inputPerM: 0.4, outputPerM: 1.6, cachedPerM: 0.1 },
  "gpt-4.1-nano": { inputPerM: 0.1, outputPerM: 0.4, cachedPerM: 0.025 },
  "o3": { inputPerM: 2, outputPerM: 8, cachedPerM: 0.5 },
  "o4-mini": { inputPerM: 1.1, outputPerM: 4.4, cachedPerM: 0.275 },
  "claude-sonnet-4-5": { inputPerM: 3, outputPerM: 15, cachedPerM: 0.3 },
  "claude-opus-4-1": { inputPerM: 15, outputPerM: 75, cachedPerM: 1.5 },
  "claude-3-5-sonnet": { inputPerM: 3, outputPerM: 15, cachedPerM: 0.3 },
  "claude-3-7-sonnet": { inputPerM: 3, outputPerM: 15, cachedPerM: 0.3 },
  "claude-3-5-haiku": { inputPerM: 0.8, outputPerM: 4, cachedPerM: 0.08 },
  "gemini-2.5-pro": { inputPerM: 1.25, outputPerM: 10, cachedPerM: 0.31 },
  "gemini-2.5-flash": { inputPerM: 0.3, outputPerM: 2.5, cachedPerM: 0.075 },
  "gemini-2.0-flash": { inputPerM: 0.1, outputPerM: 0.4, cachedPerM: 0.025 },
  "deepseek-chat": { inputPerM: 0.27, outputPerM: 1.1, cachedPerM: 0.07 },
  "deepseek-reasoner": { inputPerM: 0.55, outputPerM: 2.19, cachedPerM: 0.14 },
  "llama-3.3-70b": { inputPerM: 0.25, outputPerM: 0.25 },
  "qwen2.5-coder-32b": { inputPerM: 0.2, outputPerM: 0.6 },
};

const DEFAULT_PRICE: Price = { inputPerM: 1, outputPerM: 2, cachedPerM: 0.2 };

export function priceFor(modelName: string): Price {
  const normalized = modelName.toLowerCase();
  for (const [key, price] of Object.entries(KNOWN)) {
    if (normalized.includes(key)) return price;
  }
  return DEFAULT_PRICE;
}

export function estimateCost(
  modelName: string,
  inputTokens: number,
  outputTokens: number,
  cachedTokens = 0
): number {
  const p = priceFor(modelName);
  const cost =
    (inputTokens / 1_000_000) * p.inputPerM +
    (outputTokens / 1_000_000) * p.outputPerM +
    (cachedTokens / 1_000_000) * (p.cachedPerM ?? p.inputPerM);
  return Number(cost.toFixed(6));
}

export function addUsage(a: Usage | undefined, b: Usage | undefined): Usage {
  const x = a ?? emptyUsage();
  const y = b ?? emptyUsage();
  return {
    inputTokens: x.inputTokens + y.inputTokens,
    outputTokens: x.outputTokens + y.outputTokens,
    cachedTokens: (x.cachedTokens ?? 0) + (y.cachedTokens ?? 0),
    reasoningTokens: (x.reasoningTokens ?? 0) + (y.reasoningTokens ?? 0),
    modelRequests: x.modelRequests + y.modelRequests,
    durationMs: Math.max(x.durationMs ?? 0, y.durationMs ?? 0),
    estimatedCost: (x.estimatedCost ?? 0) + (y.estimatedCost ?? 0),
    byModel: mergeByModel(x.byModel, y.byModel),
  };
}

export function emptyUsage(): Usage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    modelRequests: 0,
    durationMs: 0,
    estimatedCost: 0,
    byModel: {},
  };
}

function mergeByModel(
  a?: Record<string, ModelUsage>,
  b?: Record<string, ModelUsage>
): Record<string, ModelUsage> | undefined {
  const out: Record<string, ModelUsage> = { ...(a ?? {}) };
  for (const [name, mu] of Object.entries(b ?? {})) {
    const prev = out[name] ?? {
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      requests: 0,
      cost: 0,
    };
    out[name] = {
      inputTokens: prev.inputTokens + mu.inputTokens,
      outputTokens: prev.outputTokens + mu.outputTokens,
      cachedTokens: prev.cachedTokens + mu.cachedTokens,
      reasoningTokens: (prev.reasoningTokens ?? 0) + (mu.reasoningTokens ?? 0),
      requests: prev.requests + mu.requests,
      cost: prev.cost + mu.cost,
    };
  }
  return out;
}
