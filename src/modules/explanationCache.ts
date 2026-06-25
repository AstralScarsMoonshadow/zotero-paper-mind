import type { LocatedSelectionContext } from "./selectionLocator";

declare const IOUtils: any;

const CACHE_ROOT = "D:\\projects\\Claude_Code\\Paper_assistant";
const PAPER_CACHE_DIR = `${CACHE_ROOT}\\PaperAssistantCache`;

export interface CachedExplanation {
  key: string;
  textHash: string;
  selectedTextPreview: string;
  sectionTitle: string;
  readablePosition: string;
  result: string;
  createdAt: string;
  updatedAt: string;
}

function normalizeItemKey(itemKey?: string): string {
  return (itemKey || "unknown").replace(/[^A-Za-z0-9_-]/g, "_").trim() || "unknown";
}

function getCachePath(itemKey?: string): string {
  return `${PAPER_CACHE_DIR}\\${normalizeItemKey(itemKey)}.json`;
}

async function ensureCacheDir() {
  await IOUtils.makeDirectory(PAPER_CACHE_DIR, {
    ignoreExisting: true,
  });
}

async function readCache(itemKey: string): Promise<any> {
  await ensureCacheDir();

  const path = getCachePath(itemKey);

  try {
    const exists = await IOUtils.exists(path);

    if (!exists) {
      return {
        version: 2,
        itemKey: normalizeItemKey(itemKey),
        explanations: [],
      };
    }

    const text = await IOUtils.readUTF8(path);
    const cache = JSON.parse(text);

    if (!Array.isArray(cache.explanations)) {
      cache.explanations = [];
    }

    return cache;
  } catch (_) {
    return {
      version: 2,
      itemKey: normalizeItemKey(itemKey),
      explanations: [],
    };
  }
}

async function writeCache(itemKey: string, cache: any) {
  await ensureCacheDir();

  const path = getCachePath(itemKey);

  await IOUtils.writeUTF8(
    path,
    JSON.stringify(cache, null, 2),
  );
}

function normalizeSelectedText(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function hashString(input: string): string {
  let hash = 2166136261;

  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }

  return (hash >>> 0).toString(16).padStart(8, "0");
}

function getExplanationKey(
  selectedText: string,
  location?: LocatedSelectionContext | null,
): {
  key: string;
  textHash: string;
} {
  const normalizedText = normalizeSelectedText(selectedText);
  const textHash = hashString(normalizedText);

  const positionPart = location?.found
    ? `${location.sectionTitle}|${location.readablePosition || ""}`
    : "unlocated";

  const key = location?.found
    ? hashString(positionPart)
    : hashString(`${positionPart}|${textHash}`);

  return {
    key,
    textHash,
  };
}

export async function getCachedExplanation(
  itemKey: string,
  selectedText: string,
  location?: LocatedSelectionContext | null,
): Promise<CachedExplanation | null> {
  const cache = await readCache(itemKey);
  const { key } = getExplanationKey(selectedText, location);

  const explanations = Array.isArray(cache.explanations)
    ? cache.explanations
    : [];

  const found = explanations.find((item: any) => item?.key === key);

  if (!found?.result) {
    return null;
  }

  return found as CachedExplanation;
}

export async function saveCachedExplanation(
  itemKey: string,
  selectedText: string,
  result: string,
  location?: LocatedSelectionContext | null,
) {
  const cache = await readCache(itemKey);
  const { key, textHash } = getExplanationKey(selectedText, location);

  const explanations: CachedExplanation[] = Array.isArray(cache.explanations)
    ? cache.explanations
    : [];

  const now = new Date().toISOString();

  const nextRecord: CachedExplanation = {
    key,
    textHash,
    selectedTextPreview: selectedText.replace(/\s+/g, " ").trim().slice(0, 500),
    sectionTitle: location?.sectionTitle || "未定位",
    readablePosition: location?.readablePosition || location?.sectionTitle || "未定位",
    result,
    createdAt: now,
    updatedAt: now,
  };

  const existingIndex = explanations.findIndex((item) => item.key === key);

  if (existingIndex >= 0) {
    nextRecord.createdAt = explanations[existingIndex].createdAt || now;
    explanations[existingIndex] = nextRecord;
  } else {
    explanations.push(nextRecord);
  }

  cache.explanations = explanations.slice(-300);

  await writeCache(itemKey, cache);
}


