/**
 * Multi-provider LLM client.
 * Supports: openai-compatible (OpenAI, Groq, Grok, Ollama, etc.) + anthropic.
 * Provider config is loaded from the AiProvider DB table; falls back to env vars.
 */

import { prisma } from "@/lib/prisma";
import { config } from "@/config";
import { getSettings } from "@/lib/settings";
import { fetchWithRetry } from "@/lib/retry";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatCompletionOptions {
  temperature?: number;
  max_tokens?: number;
  response_format?: { type: "json_object" | "text" };
  /** Spend-ledger label ("scoring", "tailoring", …) — recorded in LlmUsage. */
  purpose?: string;
  /** Override the provider's model for this call (e.g. cheap triage model). */
  model?: string;
}

export interface ChatCompletionResult {
  text: string;
  usage?: { prompt_tokens: number; completion_tokens: number };
}

interface ProviderConfig {
  providerType: string;
  baseUrl: string;
  apiKey: string;
  model: string;
}

async function loadProvider(providerId?: string): Promise<ProviderConfig> {
  // Try DB first
  try {
    let provider = null;
    if (providerId) {
      provider = await prisma.aiProvider.findUnique({ where: { id: providerId } });
    } else {
      provider = await prisma.aiProvider.findFirst({ where: { isDefault: true } });
    }
    if (provider) {
      return {
        providerType: provider.providerType,
        baseUrl: provider.baseUrl,
        apiKey: provider.apiKey,
        model: provider.model,
      };
    }
  } catch {
    // DB might not be available during build
  }

  // No AiProvider row → default OpenAI endpoint. The model is taken from live
  // settings (the dashboard "Default model" field), falling back to the config
  // default. This is what makes that UI field actually change the live model.
  const settings = await getSettings().catch(() => null);
  return {
    providerType: "openai-compatible",
    baseUrl: "https://api.openai.com/v1",
    apiKey: config.ai.fallbackApiKey,
    model: settings?.ai.defaultModel || config.ai.defaultModel,
  };
}

export async function chatCompletion(
  messages: ChatMessage[],
  opts: ChatCompletionOptions = {},
  providerId?: string
): Promise<ChatCompletionResult> {
  const provider = await loadProvider(providerId);
  if (opts.model) provider.model = opts.model;

  const result = provider.providerType === "anthropic"
    ? await callAnthropic(provider, messages, opts)
    : await callOpenAICompatible(provider, messages, opts);

  // Spend ledger — awaited (a fire-and-forget write can be dropped when the
  // serverless function freezes after responding) but never allowed to break
  // the LLM path; silently no-ops when the DB is unavailable (local scripts).
  if (result.usage) {
    await prisma.llmUsage.create({
      data: {
        model: provider.model,
        purpose: opts.purpose ?? "other",
        promptTokens: result.usage.prompt_tokens,
        completionTokens: result.usage.completion_tokens,
      },
    }).catch(() => {});
  }

  return result;
}

async function callOpenAICompatible(
  provider: ProviderConfig,
  messages: ChatMessage[],
  opts: ChatCompletionOptions
): Promise<ChatCompletionResult> {
  const url = `${provider.baseUrl.replace(/\/$/, "")}/chat/completions`;

  const body: Record<string, unknown> = {
    model: provider.model,
    messages,
    temperature: opts.temperature ?? 0.3,
    max_tokens: opts.max_tokens ?? 2048,
  };
  if (opts.response_format) body.response_format = opts.response_format;

  const res = await fetchWithRetry(() => fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${provider.apiKey}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  }));

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`LLM request failed ${res.status}: ${text}`);
  }

  const data = await res.json() as {
    choices: Array<{ message: { content: string } }>;
    usage?: { prompt_tokens: number; completion_tokens: number };
  };

  return {
    text: data.choices[0]?.message?.content ?? "",
    usage: data.usage,
  };
}

async function callAnthropic(
  provider: ProviderConfig,
  messages: ChatMessage[],
  opts: ChatCompletionOptions
): Promise<ChatCompletionResult> {
  const url = `${provider.baseUrl.replace(/\/$/, "")}/messages`;

  const system = messages.find(m => m.role === "system")?.content;
  const filtered = messages.filter(m => m.role !== "system");

  const body: Record<string, unknown> = {
    model: provider.model,
    max_tokens: opts.max_tokens ?? 2048,
    messages: filtered,
  };
  if (system) body.system = system;
  if (opts.temperature !== undefined) body.temperature = opts.temperature;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": provider.apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Anthropic request failed ${res.status}: ${text}`);
  }

  const data = await res.json() as {
    content: Array<{ type: string; text: string }>;
    usage?: { input_tokens: number; output_tokens: number };
  };

  const text = data.content.find(b => b.type === "text")?.text ?? "";
  return {
    text,
    usage: data.usage
      ? { prompt_tokens: data.usage.input_tokens, completion_tokens: data.usage.output_tokens }
      : undefined,
  };
}

/** Parse JSON from LLM output, tolerating markdown code fences and stray prose. */
export function parseJsonResponse<T>(text: string): T {
  const cleaned = text
    .replace(/^```(?:json)?\s*/m, "")
    .replace(/\s*```\s*$/m, "")
    .trim();
  try {
    return JSON.parse(cleaned) as T;
  } catch {
    // Tolerate prose wrapped around the JSON ("Here's the result: { … }") by
    // grabbing the outermost object. Does not fix truncated/incomplete JSON.
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start !== -1 && end > start) {
      return JSON.parse(cleaned.slice(start, end + 1)) as T;
    }
    throw new Error("LLM response contained no parseable JSON object");
  }
}
