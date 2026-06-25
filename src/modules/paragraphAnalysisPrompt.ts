import type { PaperModule, ParagraphRecord } from "./paragraphIndex";

export function buildParagraphCardsPrompt(
  paragraphs: ParagraphRecord[],
  rawText: string,
  paperTitle = "",
  paperProfile = "",
): string {
  const payload = paragraphs.map((p) => ({
    id: p.id,
    sectionTitle: p.sectionTitle,
    paragraphIndexInSection: p.paragraphIndexInSection,
    paragraphIndexInPaper: p.paragraphIndexInPaper,
    text: rawText.slice(p.start, p.end).slice(0, 1800),
  }));

  return `
你正在为一篇论文构建“阅读蒸馏缓存”。

论文标题：
${paperTitle || "未知标题"}

全文 Paper Profile：
${paperProfile || "暂无"}

你的任务不是写普通摘要，而是把论文按原始结构蒸馏成阅读骨架。请特别注意：

1. 必须根据论文标题和章节标题判断论文的核心对象。
   例如：
   - 如果标题暗示一个新方法、新框架、新模型、新算法、新理论，应重点识别讲解该方法/框架/模型/算法/理论原理的章节。
   - Method / Approach / Model / Architecture / Framework / Algorithm / Theory / Derivation / Proof / Construction / Proposed Method 等通常是核心章节。
   - Introduction / Background / Related Work / Conclusion / Abstract 通常不是逐段深解重点，除非它们明确提出核心定义或主命题。

2. 对“原理、新方法、模型结构、算法流程、理论推导、证明、实验机制解释”等核心章节：
   - 每个自然段都要生成较细的段落简析。
   - brief 不要只写一句话摘要，而要写 3–5 句“小讲解”：
     - 这一段具体讲了什么？
     - 它解释了方法/原理/模型的哪个部件？
     - 它为什么在这里出现？
     - 它和前后段的逻辑关系是什么？
   - functionInModule 要指出它在该模块下的功能。

3. 对 Abstract / Introduction / Background / Related Work / Conclusion / Limitation 这类非核心章节：
   - brief 可以更短，1–2 句即可。
   - 重点说明该段在模块中的作用，不需要过度展开。

4. 结构骨架不能变：
   - 不要重新发明章节。
   - 不要把论文改写成自己的结构。
   - 必须尊重输入的 sectionTitle 和段落顺序。

5. 只返回 JSON 数组，不要 Markdown，不要解释。

字段要求：
[
  {
    "id": "P00001",
    "moduleType": "abstract|background|related_work|problem|principle|method|new_method|model_architecture|algorithm|theory|proof|experiment|result_analysis|limitation|conclusion|other",
    "distillationLevel": "core_paragraph|module_brief",
    "brief": "...",
    "functionInModule": "...",
    "relationToPrevious": "...",
    "relationToNext": "...",
    "roleInPaper": "...",
    "keyTerms": ["..."]
  }
]

输入段落：
${JSON.stringify(payload, null, 2)}
`;
}

export function buildModuleMapPrompt(
  paperProfile: string,
  modules: PaperModule[],
  paragraphs: ParagraphRecord[],
  paperTitle = "",
): string {
  const modulePayload = modules.map((m) => ({
    id: m.id,
    title: m.title,
    paragraphCount: m.paragraphCount,
    paragraphBriefs: paragraphs
      .filter((p) => p.moduleId === m.id)
      .slice(0, 18)
      .map((p) => ({
        id: p.id,
        brief: p.brief || p.textPreview,
        functionInModule: p.functionInModule || "",
        moduleType: p.moduleType || "",
        distillationLevel: p.distillationLevel || "",
      })),
  }));

  return `
你正在为一篇论文构建“标题驱动的论文结构蒸馏缓存”。

论文标题：
${paperTitle || "未知标题"}

要求：
- 根据论文标题判断论文的核心对象：新方法、新框架、新模型、新理论、新算法、实验结论等。
- 保留论文原始章节骨架，不要重排章节。
- 找出真正讲解“原理 / 新方法 / 模型结构 / 算法流程 / 理论推导”的核心模块。
- 对非核心模块，只做模块级简要解释。
- 生成模块间关系：上一模块如何引出下一模块，下一模块如何使用上一模块。
- 只返回 JSON，不要 Markdown，不要解释。

JSON 格式：
{
  "titleReadingFrame": {
    "paperTitle": "...",
    "centralObject": "论文最核心要解释的对象，例如某方法/框架/理论/模型",
    "coreQuestion": "这篇论文主要要解决或证明什么",
    "readingStrategy": "读这篇论文时应该重点跟踪什么"
  },
  "modules": [
    {
      "id": "M0001",
      "moduleType": "abstract|background|related_work|problem|principle|method|new_method|model_architecture|algorithm|theory|proof|experiment|result_analysis|limitation|conclusion|other",
      "distillationLevel": "core_paragraph|module_brief",
      "summary": "...",
      "roleInPaper": "...",
      "relationToPrevious": "...",
      "relationToNext": "...",
      "whyCoreOrNonCore": "为什么这个模块需要逐段精读或只需模块简读"
    }
  ],
  "moduleRelations": [
    {
      "fromModuleId": "M0001",
      "toModuleId": "M0002",
      "relation": "..."
    }
  ]
}

【全文 Paper Profile】
${paperProfile}

【模块与段落简析】
${JSON.stringify(modulePayload, null, 2)}
`;
}





