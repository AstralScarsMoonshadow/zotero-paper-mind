import { callLLM } from "./llm";
import {
  buildChunkSummaryPrompt,
  buildMergePaperProfilePrompt,
} from "./prompt";
import {
  buildModuleMapPrompt,
  buildParagraphCardsPrompt,
} from "./paragraphAnalysisPrompt";
import {
  buildParagraphIndex,
  PaperModule,
  ParagraphRecord,
} from "./paragraphIndex";
import type { LocatedSelectionContext } from "./selectionLocator";

declare const IOUtils: any;

const CACHE_ROOT = "D:\\projects\\Claude_Code\\Paper_assistant";
const PAPER_CACHE_DIR = `${CACHE_ROOT}\\PaperAssistantCache`;

export interface ModuleRelation {
  fromModuleId: string;
  toModuleId: string;
  relation: string;
}

export interface PaperCacheExtra {
  title?: string;
  source?: string;
}

export interface PaperCacheFile {
  version: number;
  itemKey: string;
  title: string;
  source: string;
  profile: string;
  meta: string;
  rawText: string;
  modules: PaperModule[];
  paragraphs: ParagraphRecord[];
  moduleRelations: ModuleRelation[];
  updatedAt: string;
}

function normalizeItemKey(itemKey?: string): string {
  return (itemKey || "unknown").replace(/[^A-Za-z0-9_-]/g, "_").trim() || "unknown";
}

function getCachePath(itemKey?: string): string {
  return `${PAPER_CACHE_DIR}\\${normalizeItemKey(itemKey)}.json`;
}

async function ensureCacheDir() {
  await IOUtils.makeDirectory(CACHE_ROOT, { ignoreExisting: true });
  await IOUtils.makeDirectory(PAPER_CACHE_DIR, { ignoreExisting: true });
}

function createEmptyCache(itemKey?: string): PaperCacheFile {
  return {
    version: 2,
    itemKey: normalizeItemKey(itemKey),
    title: "",
    source: "",
    profile: "",
    meta: "",
    rawText: "",
    modules: [],
    paragraphs: [],
    moduleRelations: [],
    updatedAt: new Date().toISOString(),
  };
}

async function readCache(itemKey?: string): Promise<PaperCacheFile> {
  await ensureCacheDir();

  const path = getCachePath(itemKey);

  try {
    const exists = await IOUtils.exists(path);

    if (!exists) {
      return createEmptyCache(itemKey);
    }

    const text = await IOUtils.readUTF8(path);
    const data = JSON.parse(text) as Partial<PaperCacheFile>;

    return {
      ...createEmptyCache(itemKey),
      ...data,
      version: 2,
      itemKey: normalizeItemKey(itemKey),
      modules: data.modules || [],
      paragraphs: data.paragraphs || [],
      moduleRelations: data.moduleRelations || [],
    };
  } catch (_) {
    return createEmptyCache(itemKey);
  }
}

async function writeCache(itemKey: string | undefined, cache: PaperCacheFile) {
  await ensureCacheDir();

  const path = getCachePath(itemKey);

  const nextCache: PaperCacheFile = {
    ...cache,
    version: 2,
    itemKey: normalizeItemKey(itemKey),
    updatedAt: new Date().toISOString(),
  };

  await IOUtils.writeUTF8(path, JSON.stringify(nextCache, null, 2));
}

function extractJsonArray(text: string): any[] {
  try {
    return JSON.parse(text);
  } catch (_) {
    // ignore
  }

  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");

  if (start >= 0 && end > start) {
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch (_) {
      return [];
    }
  }

  return [];
}

function extractJsonObject(text: string): any {
  try {
    return JSON.parse(text);
  } catch (_) {
    // ignore
  }

  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");

  if (start >= 0 && end > start) {
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch (_) {
      return {};
    }
  }

  return {};
}

function normalizeText(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function splitTextInto章节片段s(text: string, 章节片段Size = 8000): string[] {
  const normalized = normalizeText(text);
  const paragraphs = normalized.split(/\n\s*\n/g);

  const 章节片段s: string[] = [];
  let current = "";

  for (const paragraph of paragraphs) {
    const p = paragraph.trim();

    if (!p) {
      continue;
    }

    if ((current + "\n\n" + p).length <= 章节片段Size) {
      current = current ? current + "\n\n" + p : p;
      continue;
    }

    if (current) {
      章节片段s.push(current);
      current = "";
    }

    if (p.length <= 章节片段Size) {
      current = p;
    } else {
      for (let i = 0; i < p.length; i += 章节片段Size) {
        章节片段s.push(p.slice(i, i + 章节片段Size));
      }
    }
  }

  if (current) {
    章节片段s.push(current);
  }

  return 章节片段s;
}

function groupParagraphs(paragraphs: ParagraphRecord[], groupSize = 12): ParagraphRecord[][] {
  const groups: ParagraphRecord[][] = [];

  for (let i = 0; i < paragraphs.length; i += groupSize) {
    groups.push(paragraphs.slice(i, i + groupSize));
  }

  return groups;
}

async function enrichParagraphs(
  rawText: string,
  paragraphs: ParagraphRecord[],
  paperTitle = "",
  paperProfile = "",
  onProgress?: (message: string) => void,
): Promise<ParagraphRecord[]> {
  const groups = groupParagraphs(paragraphs, 12);
  const byId = new Map(paragraphs.map((p) => [p.id, { ...p }]));

  for (let i = 0; i < groups.length; i++) {
    onProgress?.(`正在生成段落阅读缓存：第 ${i + 1}/${groups.length} 组……`);

    const prompt = buildParagraphCardsPrompt(groups[i], rawText, paperTitle, paperProfile);
    const response = await callLLM(prompt);
    const cards = extractJsonArray(response);

    for (const card of cards) {
      if (!card?.id || !byId.has(card.id)) {
        continue;
      }

      const old = byId.get(card.id)!;

      byId.set(card.id, {
        ...old,
        brief: typeof card.brief === "string" ? card.brief : old.brief,
        functionInModule:
          typeof card.functionInModule === "string"
            ? card.functionInModule
            : old.functionInModule,
        relationToPrevious:
          typeof card.relationToPrevious === "string"
            ? card.relationToPrevious
            : old.relationToPrevious,
        relationToNext:
          typeof card.relationToNext === "string"
            ? card.relationToNext
            : old.relationToNext,
        roleInPaper:
          typeof card.roleInPaper === "string"
            ? card.roleInPaper
            : old.roleInPaper,
        moduleType:
          typeof card.moduleType === "string"
            ? card.moduleType
            : old.moduleType,
        distillationLevel:
          typeof card.distillationLevel === "string"
            ? card.distillationLevel
            : old.distillationLevel,
        keyTerms: Array.isArray(card.keyTerms) ? card.keyTerms.map(String) : old.keyTerms,
      });
    }
  }

  return Array.from(byId.values()).map((p) => ({
    ...p,
    brief: p.brief || p.textPreview,
    functionInModule: p.functionInModule || "未生成",
    relationToPrevious: p.relationToPrevious || "未生成",
    relationToNext: p.relationToNext || "未生成",
    roleInPaper: p.roleInPaper || "未生成",
    moduleType: p.moduleType || "other",
    distillationLevel: p.distillationLevel || "module_brief",
    keyTerms: p.keyTerms || [],
  }));
}

async function enrichModules(
  profile: string,
  modules: PaperModule[],
  paragraphs: ParagraphRecord[],
  paperTitle = "",
  onProgress?: (message: string) => void,
): Promise<{ modules: PaperModule[]; moduleRelations: ModuleRelation[] }> {
  onProgress?.("正在生成模块关系缓存……");

  const prompt = buildModuleMapPrompt(profile, modules, paragraphs, paperTitle);
  const response = await callLLM(prompt);
  const data = extractJsonObject(response);

  const moduleMap = new Map(modules.map((m) => [m.id, { ...m }]));

  if (Array.isArray(data.modules)) {
    for (const moduleData of data.modules) {
      if (!moduleData?.id || !moduleMap.has(moduleData.id)) {
        continue;
      }

      const old = moduleMap.get(moduleData.id)!;

      moduleMap.set(moduleData.id, {
        ...old,
        summary: typeof moduleData.summary === "string" ? moduleData.summary : old.summary,
        roleInPaper:
          typeof moduleData.roleInPaper === "string"
            ? moduleData.roleInPaper
            : old.roleInPaper,
        relationToPrevious:
          typeof moduleData.relationToPrevious === "string"
            ? moduleData.relationToPrevious
            : old.relationToPrevious,
        relationToNext:
          typeof moduleData.relationToNext === "string"
            ? moduleData.relationToNext
            : old.relationToNext,
        moduleType:
          typeof moduleData.moduleType === "string"
            ? moduleData.moduleType
            : old.moduleType,
        distillationLevel:
          typeof moduleData.distillationLevel === "string"
            ? moduleData.distillationLevel
            : old.distillationLevel,
      });
    }
  }

  const moduleRelations: ModuleRelation[] = Array.isArray(data.moduleRelations)
    ? data.moduleRelations
        .filter((r: any) => r?.fromModuleId && r?.toModuleId && r?.relation)
        .map((r: any) => ({
          fromModuleId: String(r.fromModuleId),
          toModuleId: String(r.toModuleId),
          relation: String(r.relation),
        }))
    : [];

  return {
    modules: Array.from(moduleMap.values()),
    moduleRelations,
  };
}

export function getPaperCachePath(itemKey?: string): string {
  return getCachePath(itemKey);
}

export async function getPaperProfile(itemKey?: string): Promise<string> {
  const cache = await readCache(itemKey);
  return cache.profile || "";
}

export async function getPaperProfileMeta(itemKey?: string): Promise<string> {
  const cache = await readCache(itemKey);
  return cache.meta || "";
}

export async function savePaperProfile(
  profile: string,
  meta: string,
  itemKey?: string,
  extra?: PaperCacheExtra,
) {
  const cache = await readCache(itemKey);

  cache.profile = profile;
  cache.meta = meta;

  if (extra?.title) {
    cache.title = extra.title;
  }

  if (extra?.source) {
    cache.source = extra.source;
  }

  await writeCache(itemKey, cache);
}

export async function clearPaperProfile(itemKey?: string) {
  const cache = await readCache(itemKey);

  cache.profile = "";
  cache.meta = "";
  cache.modules = [];
  cache.paragraphs = [];
  cache.moduleRelations = [];

  await writeCache(itemKey, cache);
}

export async function savePaperRawText(
  rawText: string,
  itemKey?: string,
  extra?: PaperCacheExtra,
) {
  const cache = await readCache(itemKey);

  cache.rawText = rawText;

  if (extra?.title) {
    cache.title = extra.title;
  }

  if (extra?.source) {
    cache.source = extra.source;
  }

  await writeCache(itemKey, cache);
}

export async function getPaperRawText(itemKey?: string): Promise<string> {
  const cache = await readCache(itemKey);
  return cache.rawText || "";
}

export async function clearPaperRawText(itemKey?: string) {
  const cache = await readCache(itemKey);

  cache.rawText = "";

  await writeCache(itemKey, cache);
}

export async function getCachedParagraphReadingContext(
  itemKey: string,
  position: number,
): Promise<string> {
  const cache = await readCache(itemKey);

  if (!cache.paragraphs.length) {
    return "";
  }

  let currentIndex = cache.paragraphs.findIndex(
    (p) => p.start <= position && position <= p.end,
  );

  if (currentIndex < 0) {
    currentIndex = cache.paragraphs.findIndex((p) => p.start >= position);

    if (currentIndex < 0) {
      currentIndex = cache.paragraphs.length - 1;
    }
  }

  const current = cache.paragraphs[currentIndex];
  const previous = cache.paragraphs.slice(Math.max(0, currentIndex - 2), currentIndex);
  const next = cache.paragraphs.slice(currentIndex + 1, currentIndex + 3);
  const module = cache.modules.find((m) => m.id === current.moduleId);

  const relatedRelations = cache.moduleRelations.filter(
    (r) => r.fromModuleId === current.moduleId || r.toModuleId === current.moduleId,
  );

  const formatPara = (p: ParagraphRecord) => {
    return [
      `- ${p.id}｜${p.sectionTitle} 下第 ${p.paragraphIndexInSection} 段`,
      `  简析：${p.brief || p.textPreview}`,
      `  模块功能：${p.functionInModule || ""}`,
      `  承接上段：${p.relationToPrevious || ""}`,
      `  引出下段：${p.relationToNext || ""}`,
      `  全文角色：${p.roleInPaper || ""}`,
      `  关键词：${(p.keyTerms || []).join(", ")}`,
    ].join("\n");
  };

  return [
    "【通读阶段保存的段落缓存】",
    "",
    "【当前段落】",
    formatPara(current),
    "",
    "【前两段缓存简析】",
    previous.length ? previous.map(formatPara).join("\n\n") : "无",
    "",
    "【后两段缓存简析】",
    next.length ? next.map(formatPara).join("\n\n") : "无",
    "",
    "【所属模块缓存】",
    module
      ? [
          `模块：${module.title}`,
          `模块摘要：${module.summary || ""}`,
          `模块在全文中的作用：${module.roleInPaper || ""}`,
          `与上一模块关系：${module.relationToPrevious || ""}`,
          `与下一模块关系：${module.relationToNext || ""}`,
        ].join("\n")
      : "未找到模块缓存",
    "",
    "【相关模块关系】",
    relatedRelations.length
      ? relatedRelations
          .map((r) => `- ${r.fromModuleId} → ${r.toModuleId}: ${r.relation}`)
          .join("\n")
      : "无",
  ].join("\n");
}

export async function analyzeFullPaperText(
  fullText: string,
  onProgress?: (message: string) => void,
  itemKey?: string,
  extra?: PaperCacheExtra,
): Promise<string> {
  const normalized = normalizeText(fullText);

  if (normalized.length < 1000) {
    throw new Error(
      "全文文本太短。请确认当前论文能被 Zotero 读取全文，或者 PDF 已建立全文索引。",
    );
  }

  const 章节片段s = splitTextInto章节片段s(normalized, 8000);

  if (章节片段s.length > 30) {
    throw new Error(
      `当前论文被切成 ${章节片段s.length} 块，可能过长。当前 MVP 建议先测试 30 块以内的论文。`,
    );
  }

  onProgress?.("正在建立章节与自然段索引……");

  const paragraphIndex = buildParagraphIndex(normalized);

  const summaries: string[] = [];

  for (let i = 0; i < 章节片段s.length; i++) {
    onProgress?.(`正在分析全文：第 ${i + 1}/${章节片段s.length} 块……`);

    const prompt = buildChunkSummaryPrompt(章节片段s[i], i + 1, 章节片段s.length);
    const summary = await callLLM(prompt);

    summaries.push(`\n\n# 章节片段 ${i + 1}/${章节片段s.length}\n${summary}`);
  }

  onProgress?.("正在合并全文理解摘要……");

  const mergedPrompt = buildMergePaperProfilePrompt(summaries.join("\n\n"));
  const profile = await callLLM(mergedPrompt);

  const enrichedParagraphs = await enrichParagraphs(
    normalized,
    paragraphIndex.paragraphs,
    extra?.title || "",
    profile,
    onProgress,
  );

  const moduleResult = await enrichModules(
    profile,
    paragraphIndex.modules,
    enrichedParagraphs,
    extra?.title || "",
    onProgress,
  );

  const meta = [
    `分析时间：${new Date().toLocaleString()}`,
    `原文长度：${normalized.length} characters`,
    `分块数量：${章节片段s.length}`,
    `模块数量：${moduleResult.modules.length}`,
    `自然段数量：${enrichedParagraphs.length}`,
    itemKey ? `Zotero itemKey：${itemKey}` : "",
    `缓存文件：${getCachePath(itemKey)}`,
  ]
    .filter(Boolean)
    .join("\n");

  const cache = await readCache(itemKey);

  cache.rawText = normalized;
  cache.profile = profile;
  cache.meta = meta;
  cache.modules = moduleResult.modules;
  cache.paragraphs = enrichedParagraphs;
  cache.moduleRelations = moduleResult.moduleRelations;

  if (extra?.title) {
    cache.title = extra.title;
  }

  if (extra?.source) {
    cache.source = extra.source;
  }

  await writeCache(itemKey, cache);

  return profile;
}












