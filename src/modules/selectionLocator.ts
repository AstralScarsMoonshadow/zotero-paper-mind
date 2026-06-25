export interface LocatedSelectionContext {
  found: boolean;
  start: number;
  end: number;
  sectionTitle: string;
  previousSectionTitle: string;
  nextSectionTitle: string;
  beforeContext: string;
  selectedInPaper: string;
  afterContext: string;
  evidence: string;

  paragraphIndexInPaper?: number;
  paragraphIndexInSection?: number;
  sectionParagraphCount?: number;
  readablePosition?: string;
}

interface NormalizedText {
  text: string;
  map: number[];
}

interface Heading {
  title: string;
  position: number;
}

function normalizeWithMap(input: string): NormalizedText {
  const chars: string[] = [];
  const map: number[] = [];

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];

    if (/\s/.test(ch)) {
      continue;
    }

    chars.push(ch.toLowerCase());
    map.push(i);
  }

  return {
    text: chars.join(""),
    map,
  };
}

function normalizePlain(input: string): string {
  return input.replace(/\s+/g, "").toLowerCase();
}

function isLikelyHeading(line: string): boolean {
  const text = line.trim();

  if (!text || text.length > 140) {
    return false;
  }

  if (/^(abstract|introduction|related work|background|preliminaries|method|methods|methodology|approach|model|architecture|experiments?|evaluation|results|analysis|discussion|limitations?|conclusions?|references|appendix)\b/i.test(text)) {
    return true;
  }

  if (/^\d+(\.\d+)*\.?\s+[A-Z][A-Za-z0-9,;:()\-–— ]{2,120}$/.test(text)) {
    return true;
  }

  if (/^[IVX]+\.\s+[A-Z][A-Za-z0-9,;:()\-–— ]{2,120}$/.test(text)) {
    return true;
  }

  return false;
}

function extractHeadings(rawText: string): Heading[] {
  const headings: Heading[] = [];
  const lineRegex = /[^\n]+/g;

  let match: RegExpExecArray | null;

  while ((match = lineRegex.exec(rawText)) !== null) {
    const line = match[0].trim();

    if (isLikelyHeading(line)) {
      headings.push({
        title: line,
        position: match.index,
      });
    }
  }

  return headings;
}

function findSection(
  headings: Heading[],
  position: number,
  rawTextLength: number,
): {
  current: string;
  previous: string;
  next: string;
  currentStart: number;
  nextStart: number;
} {
  let current = "";
  let previous = "";
  let next = "";
  let currentStart = 0;
  let nextStart = rawTextLength;

  for (let i = 0; i < headings.length; i++) {
    const heading = headings[i];

    if (heading.position <= position) {
      previous = current;
      current = heading.title;
      currentStart = heading.position;
      continue;
    }

    next = heading.title;
    nextStart = heading.position;
    break;
  }

  return {
    current: current || "未检测到明确章节标题",
    previous: previous || "无",
    next: next || "无",
    currentStart,
    nextStart,
  };
}

function countParagraphs(text: string): number {
  const blocks = text
    .split(/\n\s*\n/g)
    .map((p) => p.trim())
    .filter((p) => p.length >= 30);

  return Math.max(1, blocks.length);
}

function paragraphIndexBefore(text: string): number {
  const blocks = text
    .split(/\n\s*\n/g)
    .map((p) => p.trim())
    .filter((p) => p.length >= 30);

  return blocks.length + 1;
}

function locateByWhitespaceInsensitiveMatch(
  rawText: string,
  selectedText: string,
): { start: number; end: number } | null {
  const raw = normalizeWithMap(rawText);
  const selectedNorm = normalizePlain(selectedText);

  if (selectedNorm.length < 30) {
    return null;
  }

  let query = selectedNorm;

  if (query.length > 1600) {
    query = query.slice(0, 800) + selectedNorm.slice(-800);
  }

  let index = raw.text.indexOf(query);

  if (index < 0 && selectedNorm.length > 500) {
    query = selectedNorm.slice(0, 500);
    index = raw.text.indexOf(query);
  }

  if (index < 0 && selectedNorm.length > 500) {
    query = selectedNorm.slice(
      Math.floor(selectedNorm.length / 2),
      Math.floor(selectedNorm.length / 2) + 500,
    );
    index = raw.text.indexOf(query);
  }

  if (index < 0) {
    return null;
  }

  const start = raw.map[index] ?? 0;
  const end =
    raw.map[Math.min(index + query.length - 1, raw.map.length - 1)] ?? start;

  return {
    start,
    end: Math.min(rawText.length, end + 1),
  };
}

export function locateSelectionInPaper(
  rawText: string,
  selectedText: string,
  beforeChars = 3000,
  afterChars = 3500,
): LocatedSelectionContext {
  const exactIndex = rawText.indexOf(selectedText);

  let start = exactIndex;
  let end = exactIndex >= 0 ? exactIndex + selectedText.length : -1;

  if (exactIndex < 0) {
    const located = locateByWhitespaceInsensitiveMatch(rawText, selectedText);

    if (located) {
      start = located.start;
      end = located.end;
    }
  }

  if (start < 0 || end < 0) {
    return {
      found: false,
      start: -1,
      end: -1,
      sectionTitle: "未定位",
      previousSectionTitle: "未定位",
      nextSectionTitle: "未定位",
      beforeContext: "",
      selectedInPaper: selectedText,
      afterContext: "",
      evidence:
        "没有在全文 raw text 中匹配到选中段落。可能是 PDF 复制文本与 Zotero 全文缓存的换行、连字符或 OCR 文本差异较大。",
      readablePosition: "未能精确定位",
    };
  }

  const headings = extractHeadings(rawText);
  const section = findSection(headings, start, rawText.length);

  const beforeStart = Math.max(0, start - beforeChars);
  const afterEnd = Math.min(rawText.length, end + afterChars);

  const sectionTextBeforeSelection = rawText.slice(section.currentStart, start);
  const wholeTextBeforeSelection = rawText.slice(0, start);
  const fullSectionText = rawText.slice(section.currentStart, section.nextStart);

  const paragraphIndexInSection = paragraphIndexBefore(sectionTextBeforeSelection);
  const paragraphIndexInPaper = paragraphIndexBefore(wholeTextBeforeSelection);
  const sectionParagraphCount = countParagraphs(fullSectionText);

  const readablePosition =
    section.current === "未检测到明确章节标题"
      ? `全文第 ${paragraphIndexInPaper} 段附近`
      : `${section.current} 下第 ${paragraphIndexInSection} 段`;

  return {
    found: true,
    start,
    end,
    sectionTitle: section.current,
    previousSectionTitle: section.previous,
    nextSectionTitle: section.next,
    beforeContext: rawText.slice(beforeStart, start).trim(),
    selectedInPaper: rawText.slice(start, end).trim(),
    afterContext: rawText.slice(end, afterEnd).trim(),
    evidence: `已在全文中定位到选段。阅读位置：${readablePosition}。段落编号基于 Zotero 全文缓存的自然段切分，可能与 PDF 视觉排版略有差异。`,
    paragraphIndexInPaper,
    paragraphIndexInSection,
    sectionParagraphCount,
    readablePosition,
  };
}

