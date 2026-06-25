export interface LLMConfig {
  endpoint: string;
  apiKey: string;
  model: string;
}

const PREF_ENDPOINT = "extensions.paperAssistant.endpoint";
const PREF_API_KEY = "extensions.paperAssistant.apiKey";
const PREF_MODEL = "extensions.paperAssistant.model";

function getPrefString(key: string, defaultValue = ""): string {
  try {
    const value = (Zotero as any).Prefs.get(key, true);
    return typeof value === "string" ? value : defaultValue;
  } catch (_) {
    return defaultValue;
  }
}

function setPrefString(key: string, value: string) {
  (Zotero as any).Prefs.set(key, value, true);
}

export function getLLMConfig(): LLMConfig {
  return {
    endpoint: getPrefString(PREF_ENDPOINT, "https://api.deepseek.com/v1"),
    apiKey: getPrefString(PREF_API_KEY, ""),
    model: getPrefString(PREF_MODEL, "deepseek-chat"),
  };
}

export function saveLLMConfig(config: LLMConfig) {
  setPrefString(PREF_ENDPOINT, config.endpoint.trim());
  setPrefString(PREF_API_KEY, config.apiKey.trim());
  setPrefString(PREF_MODEL, config.model.trim());
}

export function isLLMConfigured(): boolean {
  const config = getLLMConfig();

  return Boolean(
    config.endpoint.trim() &&
      config.apiKey.trim() &&
      config.model.trim(),
  );
}

export async function callLLM(userPrompt: string): Promise<string> {
  const config = getLLMConfig();

  if (!isLLMConfigured()) {
    throw new Error(
      "LLM API 尚未配置。请先点击 Tools → Paper Assistant: Configure API。",
    );
  }

  const url = `${config.endpoint.replace(/\/$/, "")}/chat/completions`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model: config.model,
      messages: [
        {
          role: "system",
          content:
            "你是一个严谨、准确、面向科研论文阅读的中文助手。你擅长翻译英文论文、解释方法、提取术语，并指出段落在论文论证中的作用。",
        },
        {
          role: "user",
          content: userPrompt,
        },
      ],
      temperature: 0.2,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `LLM API 请求失败：${response.status} ${response.statusText}\n${errorText}`,
    );
  }

  const data = (await response.json()) as any;

  const content = data?.choices?.[0]?.message?.content;

  if (!content) {
    throw new Error(
      `LLM API 返回格式异常：${JSON.stringify(data).slice(0, 1000)}`,
    );
  }

  return content;
}

