export type LlmMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type LlmClientOptions = {
  apiKey: string;
  baseUrl: string;
  model: string;
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
};

function stripThinkTags(content: string) {
  return content.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
}

function stripMarkdownCodeFences(content: string) {
  const trimmed = content.trim();
  const withoutStart = trimmed.replace(/^```(?:json)?\s*/i, "");
  return withoutStart.replace(/\s*```$/, "").trim();
}

function parseJsonContent<T>(content: string): T {
  const cleaned = stripMarkdownCodeFences(stripThinkTags(content));

  try {
    return JSON.parse(cleaned) as T;
  } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(cleaned.slice(start, end + 1)) as T;
    }
    throw new Error(`invalid_llm_json_response:${cleaned}`);
  }
}

export class LlmClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly temperature: number;
  private readonly maxTokens: number;
  private readonly timeoutMs: number;

  constructor(options: LlmClientOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.model = options.model;
    this.temperature = options.temperature ?? 0.4;
    this.maxTokens = options.maxTokens ?? 4096;
    this.timeoutMs = options.timeoutMs ?? 60_000;
  }

  async chat(messages: LlmMessage[]) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          messages,
          temperature: this.temperature,
          max_tokens: this.maxTokens,
          response_format: { type: "json_object" },
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`llm_request_failed:${response.status}:${text}`);
      }

      const payload = (await response.json()) as {
        choices?: Array<{ message?: { content?: string | null } }>;
      };
      const content = payload.choices?.[0]?.message?.content;
      if (typeof content !== "string" || content.trim().length === 0) {
        throw new Error("llm_response_content_missing");
      }
      return content;
    } finally {
      clearTimeout(timer);
    }
  }

  async chatJson<T>(messages: LlmMessage[]) {
    const content = await this.chat(messages);
    return parseJsonContent<T>(content);
  }
}

export function loadLlmClientFromEnv() {
  const apiKey = process.env.LLM_API_KEY;
  if (!apiKey) {
    throw new Error("LLM_API_KEY is required when LLM mode is enabled");
  }

  return new LlmClient({
    apiKey,
    baseUrl: process.env.LLM_BASE_URL ?? "https://api.openai.com/v1",
    model: process.env.LLM_MODEL_NAME ?? "gpt-4o-mini",
    temperature: Number(process.env.LLM_TEMPERATURE ?? 0.4),
    maxTokens: Number(process.env.LLM_MAX_TOKENS ?? 4096),
    timeoutMs: Number(process.env.LLM_TIMEOUT_MS ?? 60_000),
  });
}
