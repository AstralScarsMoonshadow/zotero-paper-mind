import {
  callLLM,
  getLLMConfig,
  saveLLMConfig,
} from "./llm";

import {
  buildSelectionPrompt,
} from "./prompt";

import {
  buildFocusedReadingPrompt,
  buildSelectionQuestionPrompt,
} from "./readingPrompt";
import { locateSelectionInPaper } from "./selectionLocator";
import {
  getCachedExplanation,
  saveCachedExplanation,
} from "./explanationCache";

import {
  analyzeFullPaperText,
  clearPaperProfile,
  clearPaperRawText,
  getPaperProfile,
  getPaperProfileMeta,
  getPaperRawText,
  getCachedParagraphReadingContext,
  savePaperRawText,
} from "./paperContext";

import {
  getCurrentPaperIdentity,
  getCurrentPaperText,
} from "./currentPaper";

declare const Services: any;
declare const Components: any;

function debugLog(message: string, error?: unknown) {
  try {
    Zotero.debug(`[Paper Assistant] ${message}${error ? ": " + String(error) : ""}`);
  } catch (_) {
    // ignore
  }
}

function readDirectSelectedText(win: Window): string {
  const visited = new Set<Window>();

  const readFromInput = (element: Element | null): string => {
    try {
      const input = element as HTMLInputElement | HTMLTextAreaElement | null;
      if (
        input &&
        typeof input.value === "string" &&
        typeof input.selectionStart === "number" &&
        typeof input.selectionEnd === "number" &&
        input.selectionEnd > input.selectionStart
      ) {
        return input.value.slice(input.selectionStart, input.selectionEnd).trim();
      }
    } catch (_) {
      // ignore
    }

    return "";
  };

  const readFromWindow = (targetWin: Window | null | undefined): string => {
    if (!targetWin || visited.has(targetWin)) {
      return "";
    }

    visited.add(targetWin);

    try {
      const selected = targetWin.getSelection?.()?.toString().trim();
      if (selected) {
        return selected;
      }
    } catch (_) {
      // ignore
    }

    try {
      const activeText = readFromInput(targetWin.document?.activeElement || null);
      if (activeText) {
        return activeText;
      }
    } catch (_) {
      // ignore
    }

    try {
      for (let i = 0; i < targetWin.frames.length; i += 1) {
        const frameText = readFromWindow(targetWin.frames[i]);
        if (frameText) {
          return frameText;
        }
      }
    } catch (_) {
      // ignore
    }

    return "";
  };

  try {
    const focusedWindow = (win.document as any)?.commandDispatcher?.focusedWindow as Window | undefined;
    const focusedText = readFromWindow(focusedWindow);
    if (focusedText) {
      return focusedText;
    }
  } catch (_) {
    // ignore
  }

  return readFromWindow(win);
}

let paperAssistantAnalysisRunning = false;
let paperAssistantAnalysisStopRequested = false;

function requestStopPaperAnalysis() {
  paperAssistantAnalysisStopRequested = true;
}

function assertPaperAnalysisNotStopped() {
  if (paperAssistantAnalysisStopRequested) {
    throw new Error("全文分析已终止。");
  }
}

async function readClipboardText(win: Window): Promise<string> {
  try {
    const clipboard = (win.navigator as any)?.clipboard;
    if (clipboard?.readText) {
      const text = await clipboard.readText();
      if (typeof text === "string" && text.trim()) {
        return text;
      }
    }
  } catch (error) {
    debugLog("navigator.clipboard.readText failed", error);
  }

  try {
    const internal = (Zotero as any).Utilities?.Internal;
    if (internal?.getClipboard) {
      const text = internal.getClipboard("text/unicode");
      if (typeof text === "string" && text.trim()) {
        return text;
      }
    }
  } catch (error) {
    debugLog("Zotero.Utilities.Internal.getClipboard failed", error);
  }

  try {
    const Cc = Components.classes;
    const Ci = Components.interfaces;

    const flavors = ["text/unicode", "text/plain", "text/html"];

    for (const flavor of flavors) {
      try {
        const transferable = Cc[
          "@mozilla.org/widget/transferable;1"
        ].createInstance(Ci.nsITransferable);

        transferable.init(null);
        transferable.addDataFlavor(flavor);

        const hasData = Services.clipboard.hasDataMatchingFlavors(
          [flavor],
          1,
          Services.clipboard.kGlobalClipboard,
        );

        if (!hasData) {
          continue;
        }

        Services.clipboard.getData(
          transferable,
          Services.clipboard.kGlobalClipboard,
        );

        const data = {};
        const dataLength = {};

        transferable.getTransferData(flavor, data, dataLength);

        const value = (data as any).value;
        if (!value) {
          continue;
        }

        value.QueryInterface(Ci.nsISupportsString);

        let text = value.data as string;

        if (flavor === "text/html") {
          text = text
            .replace(/<style[\s\S]*?<\/style>/gi, "")
            .replace(/<script[\s\S]*?<\/script>/gi, "")
            .replace(/<[^>]+>/g, " ")
            .replace(/\s+/g, " ")
            .trim();
        }

        if (text.trim()) {
          return text;
        }
      } catch (error) {
        debugLog(`XPCOM clipboard flavor ${flavor} failed`, error);
      }
    }
  } catch (error) {
    debugLog("XPCOM clipboard failed", error);
  }

  return "";
}

interface ResultWindowController {
  setContent: (title: string, text: string) => void;
  focus: () => void;
}

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderInlineText(input: string): string {
  return escapeHtml(input)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/`([^`]+)`/g, "<code>$1</code>");
}

function isMarkdownTableLine(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith("|") && trimmed.endsWith("|") && trimmed.split("|").length >= 4;
}

function isMarkdownTableSeparator(line: string): boolean {
  return /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line.trim());
}

function splitMarkdownTableRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim())
    .filter((cell) => cell.length > 0);
}

function normalizeMarkdownTablesToCards(input: string): string {
  const lines = input.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const output: string[] = [];

  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const next = lines[i + 1] || "";

    if (isMarkdownTableLine(line) && isMarkdownTableSeparator(next)) {
      const headers = splitMarkdownTableRow(line);
      const rows: string[][] = [];

      i += 2;

      while (i < lines.length && isMarkdownTableLine(lines[i])) {
        rows.push(splitMarkdownTableRow(lines[i]));
        i += 1;
      }

      for (const row of rows) {
        if (!row.length) {
          continue;
        }

        const title = row[0] || "条目";
        output.push(`### ${title}`);

        for (let index = 1; index < row.length; index += 1) {
          const key = headers[index] || `字段 ${index}`;
          const value = row[index] || "未说明";
          output.push(`- **${key}**：${value}`);
        }

        output.push("");
      }

      continue;
    }

    output.push(line);
    i += 1;
  }

  return output.join("\n");
}

function getKeyValueCardClass(key: string): string {
  const coreKeys = [
    "方法名称",
    "目标问题",
    "核心思想",
    "输入",
    "输出",
  ];

  const moduleKeys = [
    "局部增强",
    "全局融合",
    "多尺度注意力聚合",
    "加权双向特征金字塔网络",
    "算法流程",
    "训练目标",
    "损失函数",
    "关键假设",
    "适用场景",
    "不适用或风险场景",
    "主要模块",
    "方法结构",
    "实验设计",
    "方法对比",
    "关键术语",
  ];

  if (coreKeys.some((item) => key.includes(item))) {
    return "kv-card kv-core";
  }

  if (moduleKeys.some((item) => key.includes(item))) {
    return "kv-card kv-module";
  }

  return "kv-card";
}

function isStandaloneSectionKey(key: string, value: string): boolean {
  if (value.trim()) {
    return false;
  }

  return [
    "主要模块",
    "算法流程",
    "训练目标",
    "损失函数",
    "关键假设",
    "适用场景",
    "不适用或风险场景",
    "方法结构",
    "实验设计",
    "方法对比",
    "关键术语",
    "论文结构脑图",
    "论文结构图",
  ].some((item) => key.includes(item));
}

function renderPaperAssistantHTML(text: string): string {
  const normalizedText = normalizeMarkdownTablesToCards(text);
  const lines = normalizedText.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");

  let html = "";
  let paragraph: string[] = [];
  let list: string[] = [];
  let mindmapOpen = false;

  const closeMindmap = () => {
    if (mindmapOpen) {
      html += "</div>";
      mindmapOpen = false;
    }
  };

  const flushParagraph = () => {
    if (!paragraph.length) {
      return;
    }

    closeMindmap();
    html += `<p>${paragraph.join("<br />")}</p>`;
    paragraph = [];
  };

  const flushList = () => {
    if (!list.length) {
      return;
    }

    closeMindmap();
    html += `<ul>${list.join("")}</ul>`;
    list = [];
  };

  const isMindmapLine = (line: string) => {
    const trimmed = line.trim();
    return (
      trimmed.startsWith("中心问题") ||
      trimmed.startsWith("核心问题") ||
      /^[│\s]*[├└]─/.test(line)
    );
  };

  const getMindmapDepth = (line: string) => {
    const trimmed = line.trim();

    if (trimmed.startsWith("中心问题") || trimmed.startsWith("核心问题")) {
      return 0;
    }

    const prefix = (line.match(/^[\s│]*/) || [""])[0];
    const pipeDepth = (prefix.match(/│/g) || []).length;
    const spaceDepth = Math.floor(prefix.replace(/│/g, "").length / 3);

    if (/^[├└]─/.test(trimmed)) {
      return 1;
    }

    return Math.min(5, Math.max(1, pipeDepth + spaceDepth + 1));
  };

  const cleanMindmapText = (line: string) => {
    const trimmed = line.trim();

    if (trimmed.startsWith("中心问题") || trimmed.startsWith("核心问题")) {
      return trimmed.replace(/^中心问题/, "核心问题");
    }

    return trimmed.replace(/^[│\s]*[├└]─\s*/, "");
  };

  for (const line of lines) {
    const raw = line.trimEnd();
    const trimmed = raw.trim();

    if (!trimmed) {
      flushParagraph();
      flushList();
      closeMindmap();
      continue;
    }

    const h1 = trimmed.match(/^#\s+(.+)$/);
    if (h1) {
      flushParagraph();
      flushList();
      closeMindmap();
      html += `<h1>${renderInlineText(h1[1])}</h1>`;
      continue;
    }

    const h2 = trimmed.match(/^##\s+(.+)$/);
    if (h2) {
      flushParagraph();
      flushList();
      closeMindmap();
      html += `<h2>${renderInlineText(h2[1])}</h2>`;
      continue;
    }

    const h3 = trimmed.match(/^###\s+(.+)$/);
    if (h3) {
      flushParagraph();
      flushList();
      closeMindmap();
      html += `<h3>${renderInlineText(h3[1])}</h3>`;
      continue;
    }

    if (isMindmapLine(raw)) {
      flushParagraph();
      flushList();

      if (!mindmapOpen) {
        html += `<div class="mindmap-block">`;
        mindmapOpen = true;
      }

      const depth = getMindmapDepth(raw);
      const nodeText = cleanMindmapText(raw);
      const isRoot = depth === 0;

      html += `<div class="mindmap-node ${isRoot ? "mindmap-root" : `mindmap-depth-${depth}`}" style="--depth: ${depth}">
        <span class="mindmap-dot"></span>
        <span class="mindmap-text">${renderInlineText(nodeText)}</span>
      </div>`;
      continue;
    }

    const meta = trimmed.match(/^【([^】]+)】\s*(.*)$/);
    if (meta) {
      flushParagraph();
      flushList();
      closeMindmap();
      html += `<div class="meta-row"><span class="meta-key">${renderInlineText(meta[1])}</span><span class="meta-value">${renderInlineText(meta[2] || "")}</span></div>`;
      continue;
    }

    const keyValue = trimmed.match(/^([^：:|]{2,32})[：:]\s*(.*)$/);
    if (keyValue) {
      const key = keyValue[1].trim();
      const value = keyValue[2].trim();

      flushParagraph();
      flushList();
      closeMindmap();

      if (isStandaloneSectionKey(key, value)) {
        html += `<h2>${renderInlineText(key)}</h2>`;
      } else {
        const cardClass = getKeyValueCardClass(key);
        html += `<div class="${cardClass}"><div class="kv-key">${renderInlineText(key)}</div><div class="kv-value">${renderInlineText(value || "未说明")}</div></div>`;
      }

      continue;
    }

    const bullet = trimmed.match(/^[-*•]\s+(.+)$/);
    if (bullet) {
      flushParagraph();
      closeMindmap();
      list.push(`<li>${renderInlineText(bullet[1])}</li>`);
      continue;
    }

    const numbered = trimmed.match(/^\d+[.、]\s+(.+)$/);
    if (numbered) {
      flushParagraph();
      closeMindmap();
      list.push(`<li>${renderInlineText(numbered[1])}</li>`);
      continue;
    }

    paragraph.push(renderInlineText(trimmed));
  }

  flushParagraph();
  flushList();
  closeMindmap();

  return html || `<p>${escapeHtml(text)}</p>`;
}

function createResultWindow(win: Window): ResultWindowController {
  let resultWindow: Window | null = null;

  try {
    resultWindow = Services.ww.openWindow(
      win,
      "about:blank",
      "_blank",
      "chrome,centerscreen,resizable,width=900,height=720",
      null,
    ) as Window;
  } catch (error) {
    return {
      setContent: (title: string, text: string) => {
        win.alert(`${title}\n\n${text}`);
      },
      focus: () => {},
    };
  }

  const doc = resultWindow.document;

  doc.open();
  doc.write(`
<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Paper Assistant</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif;
      margin: 0;
      background: #f6f7f9;
      color: #222;
    }
    header {
      position: sticky;
      top: 0;
      background: #ffffff;
      border-bottom: 1px solid #ddd;
      padding: 12px 16px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      z-index: 10;
    }
    h1 {
      font-size: 18px;
      margin: 0;
      font-weight: 600;
    }
    button {
      padding: 6px 12px;
      cursor: pointer;
    }
    main {
      padding: 16px;
    }
    pre {
      white-space: pre-wrap;
      word-wrap: break-word;
      background: #ffffff;
      border: 1px solid #ddd;
      border-radius: 8px;
      padding: 16px;
      line-height: 1.6;
      font-size: 14px;
      min-height: 420px;
    }
    textarea {
      width: 100%;
      height: 280px;
      margin-top: 12px;
      display: none;
    }
      .result-article {
      max-width: 920px;
      margin: 0 auto;
      background: transparent;
      line-height: 1.75;
      font-size: 15px;
      color: #1f2328;
    }

    .result-article p {
      margin: 10px 0 14px;
      background: #ffffff;
      border: 1px solid #e5e7eb;
      border-radius: 10px;
      padding: 12px 14px;
    }

    .answer-section {
      background: #ffffff;
      border: 1px solid #e5e7eb;
      border-radius: 12px;
      padding: 14px 16px;
      margin: 14px 0;
      box-shadow: 0 1px 2px rgba(0, 0, 0, 0.04);
    }

    .answer-section-hero {
      border-left: 5px solid #2563eb;
      background: #f8fbff;
    }

    .answer-section h1 {
      margin: 0;
      font-size: 20px;
      line-height: 1.4;
      font-weight: 700;
      color: #111827;
    }

    .result-article h2 {
      margin: 0 0 10px;
      padding-left: 10px;
      border-left: 4px solid #2563eb;
      font-size: 17px;
      line-height: 1.45;
      font-weight: 700;
      color: #111827;
    }

    .result-article h3 {
      margin: 14px 0 8px;
      font-size: 15px;
      line-height: 1.45;
      font-weight: 700;
      color: #374151;
    }

    .result-article ul {
      margin: 10px 0 14px;
      padding: 10px 14px 10px 32px;
      background: #ffffff;
      border: 1px solid #e5e7eb;
      border-radius: 10px;
    }

    .result-article li {
      margin: 6px 0;
      padding-left: 2px;
    }

    .result-article strong {
      color: #111827;
      font-weight: 700;
    }

    .result-article code {
      font-family: "Cascadia Code", Consolas, monospace;
      background: #f3f4f6;
      color: #111827;
      border-radius: 5px;
      padding: 1px 5px;
      font-size: 0.92em;
    }

    .meta-row {
      display: grid;
      grid-template-columns: 88px 1fr;
      gap: 10px;
      align-items: start;
      max-width: 920px;
      margin: 6px auto;
      padding: 9px 12px;
      background: #ffffff;
      border: 1px solid #e5e7eb;
      border-radius: 10px;
    }

    .meta-key {
      font-size: 12px;
      font-weight: 700;
      color: #4b5563;
      letter-spacing: 0.02em;
    }

    .meta-value {
      font-size: 13px;
      color: #111827;
    }

      .kv-card {
      max-width: 920px;
      margin: 8px auto;
      display: grid;
      grid-template-columns: 132px 1fr;
      gap: 12px;
      align-items: start;
      padding: 12px 14px;
      background: #ffffff;
      border: 1px solid #e5e7eb;
      border-left: 4px solid #cbd5e1;
      border-radius: 12px;
      box-shadow: 0 1px 2px rgba(15, 23, 42, 0.04);
    }

    .kv-core {
      border-left-color: #2563eb;
      background: #f8fbff;
    }

    .kv-module {
      border-left-color: #0891b2;
      background: #fcfeff;
    }

    .kv-key {
      font-size: 13px;
      line-height: 1.5;
      font-weight: 800;
      color: #334155;
      letter-spacing: 0.02em;
    }

    .kv-value {
      font-size: 15px;
      line-height: 1.75;
      color: #111827;
    }

    .kv-core .kv-key {
      color: #1d4ed8;
    }

    .kv-module .kv-key {
      color: #0e7490;
    }

    .result-article h2 {
      max-width: 920px;
      margin: 22px auto 10px;
      padding: 10px 14px;
      border-left: 5px solid #2563eb;
      border-radius: 10px;
      background: #eff6ff;
      font-size: 18px;
      line-height: 1.45;
      font-weight: 800;
      color: #1e3a8a;
    }
      /* Paper Assistant refined reading layout v4 */

    .result-article {
      max-width: 1040px;
      margin: 0 auto;
      line-height: 1.75;
      font-size: 15px;
      color: #111827;
    }

    .result-article h1 {
      max-width: 1040px;
      margin: 18px auto 16px;
      padding: 16px 18px;
      border-left: 6px solid #2563eb;
      border-radius: 14px;
      background: #eff6ff;
      font-size: 22px;
      line-height: 1.45;
      font-weight: 850;
      color: #1e3a8a;
    }

    .result-article h2 {
      max-width: 1040px;
      margin: 28px auto 12px;
      padding: 10px 14px;
      border-left: 5px solid #2563eb;
      border-radius: 10px;
      background: #f8fafc;
      font-size: 18px;
      line-height: 1.45;
      font-weight: 820;
      color: #111827;
    }

    .result-article h3 {
      max-width: 1040px;
      margin: 18px auto 8px;
      font-size: 16px;
      font-weight: 800;
      color: #1f2937;
    }

    .result-article p,
    .result-article ul {
      max-width: 1040px;
      margin-left: auto;
      margin-right: auto;
    }

    .mindmap-block {
      max-width: 1040px;
      margin: 14px auto 26px;
      padding: 18px;
      border: 1px solid #dbeafe;
      border-radius: 18px;
      background:
        radial-gradient(circle at 16px 16px, rgba(37, 99, 235, 0.08) 0 2px, transparent 3px),
        linear-gradient(180deg, #f8fbff 0%, #ffffff 100%);
      box-shadow: 0 10px 28px rgba(15, 23, 42, 0.08);
    }

    .mindmap-node {
      position: relative;
      display: flex;
      align-items: center;
      gap: 10px;
      width: fit-content;
      max-width: calc(100% - var(--depth) * 34px);
      margin: 8px 0 8px calc(var(--depth) * 34px);
      padding: 9px 13px;
      border: 1px solid #e5e7eb;
      border-radius: 999px;
      background: #ffffff;
      color: #1f2937;
      font-size: 14px;
      line-height: 1.45;
      box-shadow: 0 2px 8px rgba(15, 23, 42, 0.06);
    }

    .mindmap-node::before {
      content: "";
      position: absolute;
      left: calc(-1 * min(34px, var(--depth) * 34px));
      top: 50%;
      width: calc(var(--depth) * 34px);
      border-top: 2px solid #cbd5e1;
    }

    .mindmap-root {
      margin-left: 0;
      border-color: #2563eb;
      background: #2563eb;
      color: #ffffff;
      font-weight: 850;
      border-radius: 14px;
      font-size: 15px;
    }

    .mindmap-root::before {
      display: none;
    }

    .mindmap-depth-1 {
      border-color: #93c5fd;
      background: #eff6ff;
      font-weight: 780;
      color: #1e3a8a;
    }

    .mindmap-depth-2 {
      border-color: #bae6fd;
      background: #f0f9ff;
      color: #075985;
    }

    .mindmap-depth-3,
    .mindmap-depth-4,
    .mindmap-depth-5 {
      border-color: #e2e8f0;
      background: #ffffff;
      color: #334155;
    }

    .mindmap-dot {
      width: 8px;
      height: 8px;
      flex: 0 0 auto;
      border-radius: 999px;
      background: currentColor;
      opacity: 0.65;
    }

    .mindmap-text {
      white-space: normal;
      word-break: break-word;
    }
      .header-actions {
      display: flex;
      align-items: center;
      gap: 8px;
    }

    #stop-analysis-btn {
      border: 1px solid #dc2626;
      background: #fff1f2;
      color: #b91c1c;
      border-radius: 6px;
      font-weight: 700;
    }

    #stop-analysis-btn:hover {
      background: #fee2e2;
    }
  </style>
</head>
<body>
  <header>
    <h1 id="title">Paper Assistant</h1>
    <div class="header-actions">
      <button id="stop-analysis-btn">终止全文分析</button>
      <button id="copy-btn">复制结果</button>
    </div>
  </header>
  <main>
    <article id="result" class="result-article">初始化中……</article>
    <textarea id="copy-source"></textarea>
  </main>
</body>
</html>
`);
  doc.close();

  const titleNode = doc.getElementById("title");
  const resultNode = doc.getElementById("result");
  const copyBtn = doc.getElementById("copy-btn") as HTMLButtonElement | null;
  const stopAnalysisBtn = doc.getElementById("stop-analysis-btn") as HTMLButtonElement | null;
  const copySource = doc.getElementById("copy-source") as HTMLTextAreaElement | null;

  stopAnalysisBtn?.addEventListener("click", () => {
    requestStopPaperAnalysis();
    stopAnalysisBtn.textContent = "已请求终止";
    stopAnalysisBtn.setAttribute("disabled", "true");
  });

  copyBtn?.addEventListener("click", async () => {
    const text = copySource?.value || resultNode?.textContent || "";

    try {
      await resultWindow?.navigator.clipboard.writeText(text);
      copyBtn.textContent = "已复制";
    } catch (_) {
      if (!copySource) {
        return;
      }

      copySource.style.display = "block";
      copySource.value = text;
      copySource.focus();
      copySource.select();
      doc.execCommand("copy");
      copyBtn.textContent = "已复制";
    }
  });

  return {
    setContent: (title: string, text: string) => {
      try {
        doc.title = title;

        if (titleNode) {
          titleNode.textContent = title;
        }

        if (resultNode) {
          resultNode.innerHTML = renderPaperAssistantHTML(text);
        }

        if (copySource) {
          copySource.value = text;
        }

        if (copyBtn) {
          copyBtn.textContent = "复制结果";
        }

        resultWindow?.scrollTo(0, 0);
      } catch (error) {
        win.alert(`${title}\n\n${text}`);
      }
    },
    focus: () => {
      try {
        resultWindow?.focus();
      } catch (_) {
        // ignore
      }
    },
  };
}

function configureAPI(win: Window) {
  const current = getLLMConfig();

  const endpoint = win.prompt(
    "API endpoint:",
    current.endpoint || "https://api.deepseek.com/v1",
  );

  if (endpoint === null) {
    return;
  }

  const keyPrompt =
    current.apiKey.trim()
      ? "API key 已存在。输入新的 API key；留空则保留当前 key："
      : "请输入 DeepSeek API key：";

  const apiKeyInput = win.prompt(keyPrompt, "");

  if (apiKeyInput === null) {
    return;
  }

  const model = win.prompt(
    "Model name:",
    current.model || "deepseek-chat",
  );

  if (model === null) {
    return;
  }

  const apiKey = apiKeyInput.trim() || current.apiKey;

  if (!apiKey.trim()) {
    win.alert("API key 不能为空。");
    return;
  }

  saveLLMConfig({
    endpoint: endpoint.trim() || "https://api.deepseek.com/v1",
    apiKey,
    model: model.trim() || "deepseek-chat",
  });

  win.alert(
    "Paper Assistant API 配置已保存。\n\n当前建议配置：\nendpoint = https://api.deepseek.com/v1\nmodel = deepseek-chat",
  );
}

async function analyzeCurrentPaper(win: Window) {
  if (paperAssistantAnalysisRunning) {
    requestStopPaperAnalysis();
    win.alert("已请求终止全文分析。\n\n当前正在进行的 API 请求可能会先返回；返回后不会继续后续分析。");
    return;
  }

  paperAssistantAnalysisRunning = true;
  paperAssistantAnalysisStopRequested = false;

  const resultView = createResultWindow(win);

  resultView.setContent(
    "Paper Assistant 自动通读当前论文",
    "正在尝试读取当前 Zotero 论文全文……\n\n运行期间再次点击“论文全文分析”即可请求终止。",
  );
  resultView.focus();

  try {
    assertPaperAnalysisNotStopped();

    const paper = await getCurrentPaperText();

    if (!paper.itemKey) {
      throw new Error("读取到了论文全文，但没有识别到 Zotero itemKey，无法按论文保存 Paper Profile。");
    }

    assertPaperAnalysisNotStopped();

    const ok = win.confirm(
      `已读取到当前论文全文。\n\n来源：${paper.source}\n标题：${paper.title ?? "Untitled"}\nitemKey：${paper.itemKey}\n文本长度：${paper.text.length} characters\n\n是否发送给模型进行全文分析？`,
    );

    if (!ok) {
      resultView.setContent(
        "Paper Assistant 自动通读当前论文",
        "用户取消了全文分析。",
      );
      return;
    }

    assertPaperAnalysisNotStopped();

    await savePaperRawText(paper.text, paper.itemKey, {
      title: paper.title ?? "Untitled",
      source: paper.source,
    });

    const profile = await analyzeFullPaperText(
      paper.text,
      (message) => {
        assertPaperAnalysisNotStopped();

        resultView.setContent(
          "Paper Assistant 自动通读当前论文",
          `${paper.title ?? ""}\nitemKey: ${paper.itemKey}\n\n${message}\n\n运行期间再次点击“论文全文分析”即可请求终止。`,
        );
        resultView.focus();
      },
      paper.itemKey,
      {
        title: paper.title ?? "Untitled",
        source: paper.source,
      },
    );

    assertPaperAnalysisNotStopped();

    const meta = await getPaperProfileMeta(paper.itemKey);

    resultView.setContent(
      "Paper Assistant 当前论文全文分析完成",
      `${meta}\n来源：${paper.source}\n标题：${paper.title ?? "Untitled"}\n\n${profile}`,
    );
    resultView.focus();
  } catch (error) {
    const message = String(error);

    resultView.setContent(
      message.includes("全文分析已终止")
        ? "Paper Assistant 全文分析已终止"
        : "Paper Assistant 自动通读当前论文失败",
      message,
    );
    resultView.focus();
  } finally {
    paperAssistantAnalysisRunning = false;
    paperAssistantAnalysisStopRequested = false;
  }
}

async function showPaperContext(win: Window) {
  try {
    const paper = await getCurrentPaperIdentity();
    const profile = await getPaperProfile(paper.itemKey);
    const meta = await getPaperProfileMeta(paper.itemKey);

    if (!profile.trim()) {
      win.alert(
        `当前论文还没有保存 Paper Profile。\n\n标题：${paper.title}\nitemKey：${paper.itemKey}\n\n请先运行 Paper Assistant: Analyze Current Paper。`,
      );
      return;
    }

    const resultView = createResultWindow(win);
    resultView.setContent(
      "Paper Assistant 当前论文上下文",
      `标题：${paper.title}\nitemKey：${paper.itemKey}\n${meta}\n\n${profile}`,
    );
    resultView.focus();
  } catch (error) {
    win.alert(String(error));
  }
}

async function clearPaperContext(win: Window) {
  try {
    const paper = await getCurrentPaperIdentity();

    const ok = win.confirm(
      `确定清除当前论文的 Paper Profile 吗？\n\n标题：${paper.title}\nitemKey：${paper.itemKey}`,
    );

    if (!ok) {
      return;
    }

    await clearPaperProfile(paper.itemKey);
    await clearPaperRawText(paper.itemKey);
    win.alert("当前论文的 Paper Profile 已清除。");
  } catch (error) {
    win.alert(String(error));
  }
}

async function explainClipboard(win: Window, forceReinterpret = false, saveResult = true, modeLabel?: string, providedText = "") {
  const text = providedText.trim() ? providedText : await readClipboardText(win);

  if (!text.trim()) {
    win.alert(
      "没有读取到剪贴板文本。\n\n请确认：\n1. 你已经选中文字\n2. 已经按 Ctrl+C\n3. 可以先在记事本里 Ctrl+V 测试剪贴板是否有文字",
    );
    return;
  }

  if (text.length > 12000) {
    win.alert(
      "选中文本太长。当前建议一次选择 1–3 个自然段。\n\n你可以先选短一点的段落测试。",
    );
    return;
  }

  const resultView = createResultWindow(win);

  let itemKey = "";
  let title = "";
  let paperProfile = "";
  let rawText = "";

  try {
    const paper = await getCurrentPaperIdentity();
    itemKey = paper.itemKey;
    title = paper.title;
    paperProfile = await getPaperProfile(itemKey);
    rawText = await getPaperRawText(itemKey);
  } catch (error) {
    debugLog("getCurrentPaperIdentity failed", error);
  }

  if (paperProfile.trim() && rawText.trim()) {
    resultView.setContent(
      "Paper Assistant",
      forceReinterpret
        ? `已检测到当前论文的全文缓存。\n\n标题：${title}\nitemKey：${itemKey}\n\n正在强制重新精读选中段落……`
        : `已检测到当前论文的全文缓存。\n\n标题：${title}\nitemKey：${itemKey}\n\n正在查找本地段落解读缓存……`,
    );
  } else if (paperProfile.trim()) {
    resultView.setContent(
      "Paper Assistant",
      `已检测到 Paper Profile，但没有找到全文原文缓存。\n\n标题：${title}\nitemKey：${itemKey}\n\n将退化为全文摘要辅助解释。建议重新运行 Analyze Current Paper。`,
    );
  } else {
    resultView.setContent(
      "Paper Assistant",
      "未检测到当前论文的全文上下文。正在按普通选段模式解释。\n\n若要启用精读模式，请先运行：Paper Assistant: Analyze Current Paper",
    );
  }

  resultView.focus();

  try {
    let prompt = buildSelectionPrompt(text);
    let prefix = "【模式】普通选段解释\n\n";
    let location: any = null;

    if (paperProfile.trim()) {
      location = rawText.trim()
        ? locateSelectionInPaper(rawText, text)
        : {
            found: false,
            start: -1,
            end: -1,
            sectionTitle: "未定位",
            previousSectionTitle: "未定位",
            nextSectionTitle: "未定位",
            beforeContext: "",
            selectedInPaper: text,
            afterContext: "",
            evidence: "没有找到当前论文的 raw full text，只能基于 Paper Profile 和选段解释。",
            readablePosition: "未定位",
          };

      const cachedContext =
        location.found && itemKey
          ? await getCachedParagraphReadingContext(itemKey, location.start)
          : "";

      prompt = buildFocusedReadingPrompt(
        paperProfile,
        text,
        location,
        cachedContext,
      );

      prefix = location.found
        ? `【模式】${modeLabel || (forceReinterpret ? "强制重新精读" : "全文定位精读")}\n【论文】${title}\n【itemKey】${itemKey}\n【定位】${location.readablePosition || location.sectionTitle}\n\n`
        : `【模式】${modeLabel || (forceReinterpret ? "强制重新精读" : "全文摘要辅助精读")}\n【论文】${title}\n【itemKey】${itemKey}\n【定位】未能在全文原文中精确匹配选段\n\n`;
    }

    if (!forceReinterpret && saveResult && itemKey && paperProfile.trim()) {
      const cachedExplanation = await getCachedExplanation(itemKey, text, location);

      if (cachedExplanation?.result) {
        resultView.setContent(
          "Paper Assistant 精读结果（缓存）",
          `${prefix}【来源】本地段落解读缓存，未调用模型\n【缓存时间】${cachedExplanation.updatedAt || cachedExplanation.createdAt}\n\n${cachedExplanation.result}`,
        );
        resultView.focus();
        return;
      }
    }

    resultView.setContent(
      "Paper Assistant",
      forceReinterpret
        ? `${prefix}正在结合该段所在模块、前后段缓存、模块关系和全文 Paper Profile 重新精读……`
        : `${prefix}未命中本地段落解读缓存，正在首次精读并保存结果……`,
    );
    resultView.focus();

    const result = await callLLM(prompt);

    if (saveResult && itemKey && paperProfile.trim()) {
      await saveCachedExplanation(itemKey, text, result, location);
    }

    resultView.setContent(
      forceReinterpret
        ? "Paper Assistant 强制重新精读结果"
        : "Paper Assistant 精读结果",
      `${prefix}${forceReinterpret ? (saveResult ? "【来源】强制重新精读，已覆盖本地段落解读缓存\n\n" : "【来源】段落内句子重分析，未覆盖段落解读缓存\n\n") : ""}${result}`,
    );
    resultView.focus();
  } catch (error) {
    resultView.setContent(
      "Paper Assistant 出错",
      String(error),
    );
    resultView.focus();
  }
}

async function askQuestionAboutSelection(win: Window, providedText = "") {
  const selectedText = providedText.trim() ? providedText : await readClipboardText(win);

  if (!selectedText.trim()) {
    win.alert(
      "没有读取到剪贴板文本。\n\n请先在论文中选中你要追问的段落或句子，然后按 Ctrl+C。",
    );
    return;
  }

  if (selectedText.length > 12000) {
    win.alert(
      "选中文本太长。追问模式建议一次选择一个自然段，或者段落中的一句话。",
    );
    return;
  }

  let questionWindow: Window | null = null;

  try {
    questionWindow = Services.ww.openWindow(
      win,
      "about:blank",
      "_blank",
      "chrome,centerscreen,resizable,width=900,height=760",
      null,
    ) as Window;
  } catch (error) {
    win.alert(`无法打开追问窗口：${String(error)}`);
    return;
  }

  const doc = questionWindow.document;

  doc.open();
  doc.write(`
<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Paper Assistant 追问当前选段</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif;
      margin: 0;
      background: #f6f7f9;
      color: #222;
    }
    header {
      position: sticky;
      top: 0;
      background: #fff;
      border-bottom: 1px solid #ddd;
      padding: 12px 16px;
      z-index: 10;
    }
    h1 {
      font-size: 18px;
      margin: 0 0 6px 0;
      font-weight: 600;
    }
    .hint {
      font-size: 13px;
      color: #555;
      line-height: 1.5;
    }
    main {
      padding: 16px;
    }
    label {
      display: block;
      font-weight: 600;
      margin: 14px 0 6px;
    }
    textarea {
      width: 100%;
      box-sizing: border-box;
      font-family: inherit;
      font-size: 14px;
      line-height: 1.5;
      border: 1px solid #ccc;
      border-radius: 8px;
      padding: 10px;
      background: #fff;
    }
    #selected-text {
      height: 130px;
      color: #333;
    }
    #question {
      height: 110px;
    }
        .qa-answer {
      max-width: 920px;
      margin-top: 14px;
      min-height: 260px;
      background: transparent;
      border: none;
      padding: 0;
    }

    .qa-answer p {
      margin: 10px 0 14px;
      background: #ffffff;
      border: 1px solid #e5e7eb;
      border-radius: 10px;
      padding: 12px 14px;
      line-height: 1.75;
      font-size: 15px;
    }

    .qa-answer h1 {
      margin: 0 0 14px;
      padding: 14px 16px;
      border-left: 5px solid #2563eb;
      background: #f8fbff;
      border-radius: 12px;
      font-size: 20px;
      line-height: 1.45;
      font-weight: 700;
      color: #111827;
    }

    .qa-answer h2 {
      margin: 18px 0 10px;
      padding-left: 10px;
      border-left: 4px solid #2563eb;
      font-size: 17px;
      line-height: 1.45;
      font-weight: 700;
      color: #111827;
    }

    .qa-answer h3 {
      margin: 14px 0 8px;
      font-size: 15px;
      line-height: 1.45;
      font-weight: 700;
      color: #374151;
    }

    .qa-answer ul {
      margin: 10px 0 14px;
      padding: 10px 14px 10px 32px;
      background: #ffffff;
      border: 1px solid #e5e7eb;
      border-radius: 10px;
      line-height: 1.7;
      font-size: 15px;
    }

    .qa-answer li {
      margin: 6px 0;
    }

    .qa-answer strong {
      color: #111827;
      font-weight: 700;
    }

    .qa-answer code {
      font-family: "Cascadia Code", Consolas, monospace;
      background: #f3f4f6;
      color: #111827;
      border-radius: 5px;
      padding: 1px 5px;
      font-size: 0.92em;
    }
    .actions {
      display: flex;
      gap: 8px;
      margin-top: 10px;
      align-items: center;
    }
    button {
      padding: 7px 14px;
      cursor: pointer;
    }
    .small {
      color: #666;
      font-size: 12px;
    }
      .result-article {
      max-width: 920px;
      margin: 0 auto;
      background: transparent;
      line-height: 1.75;
      font-size: 15px;
      color: #1f2328;
    }

    .result-article p {
      margin: 10px 0 14px;
      background: #ffffff;
      border: 1px solid #e5e7eb;
      border-radius: 10px;
      padding: 12px 14px;
    }

    .answer-section {
      background: #ffffff;
      border: 1px solid #e5e7eb;
      border-radius: 12px;
      padding: 14px 16px;
      margin: 14px 0;
      box-shadow: 0 1px 2px rgba(0, 0, 0, 0.04);
    }

    .answer-section-hero {
      border-left: 5px solid #2563eb;
      background: #f8fbff;
    }

    .answer-section h1 {
      margin: 0;
      font-size: 20px;
      line-height: 1.4;
      font-weight: 700;
      color: #111827;
    }

    .result-article h2 {
      margin: 0 0 10px;
      padding-left: 10px;
      border-left: 4px solid #2563eb;
      font-size: 17px;
      line-height: 1.45;
      font-weight: 700;
      color: #111827;
    }

    .result-article h3 {
      margin: 14px 0 8px;
      font-size: 15px;
      line-height: 1.45;
      font-weight: 700;
      color: #374151;
    }

    .result-article ul {
      margin: 10px 0 14px;
      padding: 10px 14px 10px 32px;
      background: #ffffff;
      border: 1px solid #e5e7eb;
      border-radius: 10px;
    }

    .result-article li {
      margin: 6px 0;
      padding-left: 2px;
    }

    .result-article strong {
      color: #111827;
      font-weight: 700;
    }

    .result-article code {
      font-family: "Cascadia Code", Consolas, monospace;
      background: #f3f4f6;
      color: #111827;
      border-radius: 5px;
      padding: 1px 5px;
      font-size: 0.92em;
    }

    .meta-row {
      display: grid;
      grid-template-columns: 88px 1fr;
      gap: 10px;
      align-items: start;
      max-width: 920px;
      margin: 6px auto;
      padding: 9px 12px;
      background: #ffffff;
      border: 1px solid #e5e7eb;
      border-radius: 10px;
    }

    .meta-key {
      font-size: 12px;
      font-weight: 700;
      color: #4b5563;
      letter-spacing: 0.02em;
    }

    .meta-value {
      font-size: 13px;
      color: #111827;
    }

      .kv-card {
      max-width: 920px;
      margin: 8px auto;
      display: grid;
      grid-template-columns: 132px 1fr;
      gap: 12px;
      align-items: start;
      padding: 12px 14px;
      background: #ffffff;
      border: 1px solid #e5e7eb;
      border-left: 4px solid #cbd5e1;
      border-radius: 12px;
      box-shadow: 0 1px 2px rgba(15, 23, 42, 0.04);
    }

    .kv-core {
      border-left-color: #2563eb;
      background: #f8fbff;
    }

    .kv-module {
      border-left-color: #0891b2;
      background: #fcfeff;
    }

    .kv-key {
      font-size: 13px;
      line-height: 1.5;
      font-weight: 800;
      color: #334155;
      letter-spacing: 0.02em;
    }

    .kv-value {
      font-size: 15px;
      line-height: 1.75;
      color: #111827;
    }

    .kv-core .kv-key {
      color: #1d4ed8;
    }

    .kv-module .kv-key {
      color: #0e7490;
    }

    .result-article h2 {
      max-width: 920px;
      margin: 22px auto 10px;
      padding: 10px 14px;
      border-left: 5px solid #2563eb;
      border-radius: 10px;
      background: #eff6ff;
      font-size: 18px;
      line-height: 1.45;
      font-weight: 800;
      color: #1e3a8a;
    }
      /* Paper Assistant refined reading layout v4 */

    .result-article {
      max-width: 1040px;
      margin: 0 auto;
      line-height: 1.75;
      font-size: 15px;
      color: #111827;
    }

    .result-article h1 {
      max-width: 1040px;
      margin: 18px auto 16px;
      padding: 16px 18px;
      border-left: 6px solid #2563eb;
      border-radius: 14px;
      background: #eff6ff;
      font-size: 22px;
      line-height: 1.45;
      font-weight: 850;
      color: #1e3a8a;
    }

    .result-article h2 {
      max-width: 1040px;
      margin: 28px auto 12px;
      padding: 10px 14px;
      border-left: 5px solid #2563eb;
      border-radius: 10px;
      background: #f8fafc;
      font-size: 18px;
      line-height: 1.45;
      font-weight: 820;
      color: #111827;
    }

    .result-article h3 {
      max-width: 1040px;
      margin: 18px auto 8px;
      font-size: 16px;
      font-weight: 800;
      color: #1f2937;
    }

    .result-article p,
    .result-article ul {
      max-width: 1040px;
      margin-left: auto;
      margin-right: auto;
    }

    .mindmap-block {
      max-width: 1040px;
      margin: 14px auto 26px;
      padding: 18px;
      border: 1px solid #dbeafe;
      border-radius: 18px;
      background:
        radial-gradient(circle at 16px 16px, rgba(37, 99, 235, 0.08) 0 2px, transparent 3px),
        linear-gradient(180deg, #f8fbff 0%, #ffffff 100%);
      box-shadow: 0 10px 28px rgba(15, 23, 42, 0.08);
    }

    .mindmap-node {
      position: relative;
      display: flex;
      align-items: center;
      gap: 10px;
      width: fit-content;
      max-width: calc(100% - var(--depth) * 34px);
      margin: 8px 0 8px calc(var(--depth) * 34px);
      padding: 9px 13px;
      border: 1px solid #e5e7eb;
      border-radius: 999px;
      background: #ffffff;
      color: #1f2937;
      font-size: 14px;
      line-height: 1.45;
      box-shadow: 0 2px 8px rgba(15, 23, 42, 0.06);
    }

    .mindmap-node::before {
      content: "";
      position: absolute;
      left: calc(-1 * min(34px, var(--depth) * 34px));
      top: 50%;
      width: calc(var(--depth) * 34px);
      border-top: 2px solid #cbd5e1;
    }

    .mindmap-root {
      margin-left: 0;
      border-color: #2563eb;
      background: #2563eb;
      color: #ffffff;
      font-weight: 850;
      border-radius: 14px;
      font-size: 15px;
    }

    .mindmap-root::before {
      display: none;
    }

    .mindmap-depth-1 {
      border-color: #93c5fd;
      background: #eff6ff;
      font-weight: 780;
      color: #1e3a8a;
    }

    .mindmap-depth-2 {
      border-color: #bae6fd;
      background: #f0f9ff;
      color: #075985;
    }

    .mindmap-depth-3,
    .mindmap-depth-4,
    .mindmap-depth-5 {
      border-color: #e2e8f0;
      background: #ffffff;
      color: #334155;
    }

    .mindmap-dot {
      width: 8px;
      height: 8px;
      flex: 0 0 auto;
      border-radius: 999px;
      background: currentColor;
      opacity: 0.65;
    }

    .mindmap-text {
      white-space: normal;
      word-break: break-word;
    }
      .header-actions {
      display: flex;
      align-items: center;
      gap: 8px;
    }

    #stop-analysis-btn {
      border: 1px solid #dc2626;
      background: #fff1f2;
      color: #b91c1c;
      border-radius: 6px;
      font-weight: 700;
    }

    #stop-analysis-btn:hover {
      background: #fee2e2;
    }
  </style>
</head>
<body>
  <header>
    <h1>Paper Assistant 追问当前选段</h1>
    <div class="hint">
      当前选段已经锁定。你现在可以切回 Zotero/PDF 继续复制术语、公式或句子，再粘贴到下面的问题框里。
    </div>
  </header>
  <main>
    <label>已锁定的选中段落 / 句子</label>
    <textarea id="selected-text" readonly></textarea>

    <label>你的追问</label>
    <textarea id="question" placeholder="例如：这里的 invariant representation 是什么意思？这句话为什么能推出后面的结论？这个公式对应方法里的哪一部分？"></textarea>

    <div class="actions">
      <button id="ask-btn">提交追问</button>
      <span class="small">快捷键：Ctrl + Enter</span>
    </div>

    <article id="answer" class="qa-answer result-article">等待输入问题……</article>
  </main>
</body>
</html>
`);
  doc.close();

  const selectedNode = doc.getElementById("selected-text") as HTMLTextAreaElement | null;
  const questionNode = doc.getElementById("question") as HTMLTextAreaElement | null;
  const askBtn = doc.getElementById("ask-btn") as HTMLButtonElement | null;
  const answerNode = doc.getElementById("answer");

  const setAnswerContent = (text: string) => {
    if (answerNode) {
      answerNode.innerHTML = renderPaperAssistantHTML(text);
    }
  };

  if (selectedNode) {
    selectedNode.value = selectedText;
  }

  questionNode?.focus();

  let isRunning = false;

  const runQuestion = async () => {
    if (isRunning) {
      return;
    }

    const question = questionNode?.value.trim() || "";

    if (!question) {
      setAnswerContent("请先输入你的问题。");
      return;
    }

    isRunning = true;

    if (askBtn) {
      askBtn.disabled = true;
      askBtn.textContent = "回答中……";
    }

    setAnswerContent("正在读取当前论文缓存并调用 API 回答……");

    let itemKey = "";
    let title = "";
    let paperProfile = "";
    let rawText = "";

    try {
      const paper = await getCurrentPaperIdentity();
      itemKey = paper.itemKey;
      title = paper.title;
      paperProfile = await getPaperProfile(itemKey);
      rawText = await getPaperRawText(itemKey);
    } catch (error) {
      debugLog("getCurrentPaperIdentity failed", error);
    }

    try {
      const location = rawText.trim()
        ? locateSelectionInPaper(rawText, selectedText)
        : {
            found: false,
            start: -1,
            end: -1,
            sectionTitle: "未定位",
            previousSectionTitle: "未定位",
            nextSectionTitle: "未定位",
            beforeContext: "",
            selectedInPaper: selectedText,
            afterContext: "",
            evidence: "没有找到当前论文 raw full text。",
            readablePosition: "未定位",
          };

      const cachedParagraphContext =
        location.found && itemKey
          ? await getCachedParagraphReadingContext(itemKey, location.start)
          : "";

      const cachedExplanation =
        itemKey && paperProfile.trim()
          ? await getCachedExplanation(itemKey, selectedText, location)
          : null;

      const prompt = buildSelectionQuestionPrompt(
        paperProfile,
        selectedText,
        question,
        location,
        cachedParagraphContext,
        cachedExplanation?.result || "",
      );

      const contextMode = cachedExplanation?.result
        ? "已参考全文通读缓存、段落/模块缓存、已有段落精读缓存"
        : "已参考全文通读缓存和段落/模块缓存；当前段落尚无精读缓存";

      setAnswerContent([
          `【论文】${title || "未识别"}`,
          `【定位】${location.readablePosition || location.sectionTitle}`,
          `【上下文】${contextMode}`,
          "",
          `【你的问题】${question}`,
          "",
          "正在调用 API 回答……",
        ].join("\n"));

      const answer = await callLLM(prompt);

      setAnswerContent([
          `【论文】${title || "未识别"}`,
          `【定位】${location.readablePosition || location.sectionTitle}`,
          `【上下文】${contextMode}`,
          "",
          `【你的问题】${question}`,
          "",
          answer,
        ].join("\n"));
    } catch (error) {
      setAnswerContent(`追问出错：${String(error)}`);
    } finally {
      isRunning = false;

      if (askBtn) {
        askBtn.disabled = false;
        askBtn.textContent = "提交追问";
      }
    }
  };

  askBtn?.addEventListener("click", () => {
    runQuestion();
  });

  questionNode?.addEventListener("keydown", (event) => {
    const keyboardEvent = event as KeyboardEvent;

    if ((keyboardEvent.ctrlKey || keyboardEvent.metaKey) && keyboardEvent.key === "Enter") {
      event.preventDefault();
      runQuestion();
    }
  });

  try {
    questionWindow.focus();
  } catch (_) {
    // ignore
  }
}

const PAPER_ASSISTANT_PLUGIN_ID = "paper-assistant@dangguili29";

type ReaderEventHandlerRecord = {
  type: string;
  handler: (event: any) => void;
};

function getReaderEventText(event: any): string {
  const params = event?.params || {};

  const candidates = [
    params.text,
    params.annotation?.text,
    params.annotation?.annotationText,
    params.annotationText,
    params.selection?.text,
  ];

  for (const value of candidates) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }

  return "";
}

function unregisterReaderSelectionContextMenu(win: Window) {
  const state = (win as any).__paperAssistantReaderContextMenu;

  try {
    if (Array.isArray(state?.listeners)) {
      for (const item of state.listeners as ReaderEventHandlerRecord[]) {
        (Zotero as any).Reader.unregisterEventListener(item.type, item.handler);
      }
    }
  } catch (error) {
    debugLog("unregister reader event listeners failed", error);
  }

  try {
    if (typeof state?.selectionTimer === "number") {
      win.clearTimeout(state.selectionTimer);
    }
  } catch (_) {
    // ignore
  }

  delete (win as any).__paperAssistantReaderContextMenu;
}

function registerReaderSelectionContextMenu(win: _ZoteroTypes.MainWindow) {
  unregisterReaderSelectionContextMenu(win);

  let lastSelectedText = "";
  let selectionTimer: number | null = null;

  const rememberSelection = (text: string) => {
    const normalized = text.trim();

    if (!normalized) {
      return;
    }

    lastSelectedText = normalized;

    if (selectionTimer !== null) {
      win.clearTimeout(selectionTimer);
    }

    selectionTimer = win.setTimeout(() => {
      lastSelectedText = "";
      selectionTimer = null;
    }, 60000);
  };

  const selectionPopupHandler = (event: any) => {
    const text = getReaderEventText(event);

    if (text) {
      rememberSelection(text);
    }
  };

  const viewContextMenuHandler = (event: any) => {
    const append = event?.append;

    if (typeof append !== "function") {
      return;
    }

    const eventText = getReaderEventText(event);
    const directText = readDirectSelectedText(win).trim();
    const selectedText = eventText || directText || lastSelectedText;

    if (!selectedText.trim()) {
      return;
    }

    rememberSelection(selectedText);

    append({
      label: "Paper Assistant：段落精读",
      onCommand: () => {
        const textForCommand = selectedText;

        win.setTimeout(() => {
          void explainClipboard(win, false, true, undefined, textForCommand).catch((error: unknown) => {
            win.alert(`Paper Assistant 段落精读出错：${String(error)}`);
          });
        }, 50);
      },
    });

    append({
      label: "Paper Assistant：追问选段",
      onCommand: () => {
        const textForCommand = selectedText;

        win.setTimeout(() => {
          void askQuestionAboutSelection(win, textForCommand).catch((error: unknown) => {
            win.alert(`Paper Assistant 追问选段出错：${String(error)}`);
          });
        }, 50);
      },
    });
  };

  (Zotero as any).Reader.registerEventListener(
    "renderTextSelectionPopup",
    selectionPopupHandler,
    PAPER_ASSISTANT_PLUGIN_ID,
  );

  (Zotero as any).Reader.registerEventListener(
    "createViewContextMenu",
    viewContextMenuHandler,
    PAPER_ASSISTANT_PLUGIN_ID,
  );

  (win as any).__paperAssistantReaderContextMenu = {
    listeners: [
      {
        type: "renderTextSelectionPopup",
        handler: selectionPopupHandler,
      },
      {
        type: "createViewContextMenu",
        handler: viewContextMenuHandler,
      },
    ],
    selectionTimer,
  };

  debugLog("reader selection context menu registered by Zotero.Reader API");
}

export function registerPaperAssistantMenu(win: _ZoteroTypes.MainWindow) {
  const doc = win.document;

  const menuIds = [
    "paper-assistant-root-menu",

    "paper-assistant-menu-test",
    "paper-assistant-menu-configure-api",
    "paper-assistant-menu-analyze-current-paper",
    "paper-assistant-menu-show-context",
    "paper-assistant-menu-clear-context",
    "paper-assistant-menu-explain-clipboard",
    "paper-assistant-menu-force-reinterpret",
    "paper-assistant-menu-ask-selection",

    "paper-assistant-system-menu",
    "paper-assistant-cache-menu",
    "paper-assistant-reading-menu",
  ];

  for (const id of menuIds) {
    doc.getElementById(id)?.remove();
  }

  const toolsPopup = doc.getElementById("menu_ToolsPopup");
  if (!toolsPopup) {
    return;
  }

  const stopAnalysisItem = (doc as any).createXULElement("menuitem");
  stopAnalysisItem.id = "paper-assistant-menu-stop-analysis";
  stopAnalysisItem.setAttribute("label", "Paper Assistant: 终止全文分析");
  stopAnalysisItem.addEventListener("command", () => {
    if (!paperAssistantAnalysisRunning) {
      win.alert("当前没有正在运行的论文全文分析。");
      return;
    }

    requestStopPaperAnalysis();
    win.alert("已请求终止全文分析。\n\n当前正在进行的 API 请求可能会先返回；返回后不会继续后续分块分析。");
  });


  function createSubMenu(parent: Element, id: string, label: string): Element {
    const menu = (doc as any).createXULElement("menu");
    menu.id = id;
    menu.setAttribute("label", label);

    const popup = (doc as any).createXULElement("menupopup");
    popup.id = `${id}-popup`;

    menu.appendChild(popup);
    parent.appendChild(menu);

    return popup;
  }

  function createMenuItem(
    parent: Element,
    id: string,
    label: string,
    onCommand: () => void | Promise<void>,
  ) {
    const item = (doc as any).createXULElement("menuitem");
    item.id = id;
    item.setAttribute("label", label);
    item.addEventListener("command", async () => {
      await onCommand();
    });
    parent.appendChild(item);
  }

  const rootMenu = (doc as any).createXULElement("menu");
  rootMenu.id = "paper-assistant-root-menu";
  rootMenu.setAttribute("label", "Paper Assistant");

  const rootPopup = (doc as any).createXULElement("menupopup");
  rootPopup.id = "paper-assistant-root-popup";
  rootMenu.appendChild(rootPopup);

  const systemPopup = createSubMenu(
    rootPopup,
    "paper-assistant-system-menu",
    "系统",
  );

  createMenuItem(
    systemPopup,
    "paper-assistant-menu-test",
    "测试",
    () => {
      win.alert("Paper Assistant 已运行");
    },
  );

  createMenuItem(
    systemPopup,
    "paper-assistant-menu-configure-api",
    "API 设置",
    () => {
      configureAPI(win);
    },
  );

  const cachePopup = createSubMenu(
    rootPopup,
    "paper-assistant-cache-menu",
    "论文缓存",
  );

  createMenuItem(
    cachePopup,
    "paper-assistant-menu-show-context",
    "查看当前论文缓存",
    async () => {
      await showPaperContext(win);
    },
  );

  createMenuItem(
    cachePopup,
    "paper-assistant-menu-clear-context",
    "清除当前论文缓存",
    async () => {
      await clearPaperContext(win);
    },
  );

  createMenuItem(
    rootPopup,
    "paper-assistant-menu-analyze-current-paper",
    "论文全文分析 / 再点终止",
    async () => {
      await analyzeCurrentPaper(win);
    },
  );

  toolsPopup.appendChild(rootMenu);

  registerReaderSelectionContextMenu(win);
}

export function unregisterPaperAssistantMenu(win: Window) {
  const menuIds = [
    "paper-assistant-root-menu",

    "paper-assistant-menu-test",
    "paper-assistant-menu-configure-api",
    "paper-assistant-menu-analyze-current-paper",
    "paper-assistant-menu-show-context",
    "paper-assistant-menu-clear-context",
    "paper-assistant-menu-explain-clipboard",
    "paper-assistant-menu-force-reinterpret",
    "paper-assistant-menu-ask-selection",

    "paper-assistant-system-menu",
    "paper-assistant-cache-menu",
    "paper-assistant-reading-menu",
  ];

  for (const id of menuIds) {
    win.document.getElementById(id)?.remove();
  }

  unregisterReaderSelectionContextMenu(win);
}



























