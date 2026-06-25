export interface PaperModule {
  id: string;
  title: string;
  start: number;
  end: number;
  paragraphCount: number;
  summary?: string;
  roleInPaper?: string;
  moduleType?: string;
  distillationLevel?: string;
  relationToPrevious?: string;
  relationToNext?: string;
}

export interface ParagraphRecord {
  id: string;
  moduleId: string;
  sectionTitle: string;
  paragraphIndexInPaper: number;
  paragraphIndexInSection: number;
  start: number;
  end: number;
  textPreview: string;
  brief?: string;
  functionInModule?: string;
  relationToPrevious?: string;
  relationToNext?: string;
  roleInPaper?: string;
  keyTerms?: string[];
  moduleType?: string;
  distillationLevel?: string;
}

export interface ParagraphIndex {
  modules: PaperModule[];
  paragraphs: ParagraphRecord[];
}

function isLikelyHeading(block: string): boolean {
  const text = block.trim();

  if (!text || text.length > 140) {
    return false;
  }

  if (text.includes(". ") && text.length > 90) {
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

function splitBlocksWithOffsets(rawText: string): Array<{ text: string; start: number; end: number }> {
  const blocks: Array<{ text: string; start: number; end: number }> = [];
  const regex = /\S[\s\S]*?(?=\n\s*\n|$)/g;

  let match: RegExpExecArray | null;

  while ((match = regex.exec(rawText)) !== null) {
    const original = match[0];
    const leading = original.search(/\S/);
    const trailing = original.length - original.trimEnd().length;

    const start = match.index + Math.max(0, leading);
    const end = match.index + original.length - trailing;
    const text = rawText.slice(start, end).trim();

    if (text) {
      blocks.push({ text, start, end });
    }
  }

  return blocks;
}

function createModule(index: number, title: string, start: number): PaperModule {
  return {
    id: `M${String(index).padStart(4, "0")}`,
    title,
    start,
    end: start,
    paragraphCount: 0,
  };
}

export function buildParagraphIndex(rawText: string): ParagraphIndex {
  const blocks = splitBlocksWithOffsets(rawText);

  const modules: PaperModule[] = [];
  const paragraphs: ParagraphRecord[] = [];

  let currentModule = createModule(1, "Full Paper", 0);
  modules.push(currentModule);

  let paragraphIndexInPaper = 0;
  let paragraphIndexInSection = 0;

  for (const block of blocks) {
    if (isLikelyHeading(block.text)) {
      currentModule.end = block.start;

      currentModule = createModule(
        modules.length + 1,
        block.text.replace(/\s+/g, " ").trim(),
        block.start,
      );

      modules.push(currentModule);
      paragraphIndexInSection = 0;
      continue;
    }

    if (block.text.length < 30) {
      continue;
    }

    paragraphIndexInPaper += 1;
    paragraphIndexInSection += 1;
    currentModule.paragraphCount += 1;
    currentModule.end = block.end;

    paragraphs.push({
      id: `P${String(paragraphIndexInPaper).padStart(5, "0")}`,
      moduleId: currentModule.id,
      sectionTitle: currentModule.title,
      paragraphIndexInPaper,
      paragraphIndexInSection,
      start: block.start,
      end: block.end,
      textPreview: block.text.slice(0, 700),
    });
  }

  for (let i = 0; i < modules.length; i++) {
    const current = modules[i];
    const next = modules[i + 1];

    if (next) {
      current.end = next.start;
    } else {
      current.end = rawText.length;
    }
  }

  return {
    modules: modules.filter((m) => m.paragraphCount > 0 || m.title !== "Full Paper"),
    paragraphs,
  };
}


