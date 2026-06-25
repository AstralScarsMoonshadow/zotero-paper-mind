import type { LocatedSelectionContext } from "./selectionLocator";

export function buildFocusedReadingPrompt(
  paperProfile: string,
  selectedText: string,
  location: LocatedSelectionContext,
  cachedParagraphContext = "",
): string {
  return `
你是一个论文阅读导师。用户的目标是理解当前选中的论文段落。

要求：
1. 不机械补全栏目。对理解当前段落无直接帮助的内容不输出。
2. 避免报告式长段落。
3. 不使用表格。
4. 不复述全文 Paper Profile。
5. 只解释影响当前段落理解的术语。
6. 不输出字符位置、offset、start-end。
7. 只使用“小标题 + 第几段”的阅读定位。
8. 默认控制在 700–1200 字；短段落应更短。

【全文 Paper Profile】
${paperProfile}

【通读阶段缓存的段落与模块分析】
"""
${cachedParagraphContext || "无"}
"""

【插件定位信息】
- 阅读位置：${location.readablePosition || location.sectionTitle}
- 所属章节：${location.sectionTitle}
- 上一个章节标题：${location.previousSectionTitle}
- 下一个章节标题：${location.nextSectionTitle}

【选段上文局部上下文】
"""
${location.beforeContext}
"""

【用户当前选中的段落】
"""
${selectedText}
"""

【选段下文局部上下文】
"""
${location.afterContext}
"""

输出格式：

# 核心结论

用 2–4 句话说明：
- 当前段落的主要内容
- 当前段落在模块中的功能
- 阅读该段时应保留的关键判断

## 文本释义

按句群解释，不逐字翻译。

格式：
- 第一部分：……
- 第二部分：……
- 转折或结论：……

若原文较短，只写 2–3 条。

## 段落功能

只写对理解有帮助的信息：

- 所属位置：${location.readablePosition || location.sectionTitle}
- 本段功能：定义概念、说明结构、引出改进、解释机制、承接实验结果等
- 上下文链条：上文内容 → 本段推进 → 下文承接

避免“承上启下”等空泛表述。

## 必要术语

最多 4 个。

格式：
- **术语**：定义；在本段中的作用。

以下栏目只有确有必要才输出：

### 方法结构

当本段涉及模型结构、算法、模块替换、机制设计时输出。
说明该内容属于论文方法的哪个子部分。

### 对比关系

当本段明确涉及 baseline、SOTA、替换、改进、实验比较时输出。
只说明与当前段落直接相关的比较。

### 辨析

当当前段落存在容易误解的地方时输出。
最多 2 条。


全局输出禁令：
- 禁止使用 Markdown 表格。
- 禁止输出任何用竖杠分隔字段的内容。
- 禁止输出类似「| A | B | C |」的行。
- 禁止输出「| :--- | :--- |」这类表格分隔线。
- 对比内容必须使用卡片式结构。
- 术语内容必须使用术语说明结构。
- 指标内容必须使用短列表结构。
- 证据来源必须写成普通短句，不要写成表格列。
- 不要输出 章节片段、论文缓存、论文缓存5 等内部处理信息。

对比内容格式：

## 方法对比

### 对比对象名称
**优势**：……
**代价**：……
**证据**：……

如果没有明确代价，写：
**代价**：当前缓存未提供明确说明。

输出风格：
- 中文为主，保留必要英文术语。
- 使用短段和短列表。
- 重点加粗。
- 不使用“判断依据”。
- 不使用表格。
- 不使用口语化标题。
`;
}

export function buildSelectionQuestionPrompt(
  paperProfile: string,
  selectedText: string,
  userQuestion: string,
  location: LocatedSelectionContext,
  cachedParagraphContext = "",
  cachedExplanation = "",
): string {
  return `
你是一个论文阅读答疑助手。用户已经选中论文中的一段或一句，现在只追问一个具体问题。

目标：直接解决该问题，不重新完整解释整段。

【用户问题】
${userQuestion}

【选中段落】
"""
${selectedText}
"""

【定位信息】
- 阅读位置：${location.readablePosition || location.sectionTitle}
- 所属章节：${location.sectionTitle}

【全文通读 Paper Profile】
${paperProfile || "无"}

【通读阶段保存的段落 / 模块缓存】
"""
${cachedParagraphContext || "无"}
"""

【该段已有精读缓存】
"""
${cachedExplanation || "无"}
"""


全局输出禁令：
- 禁止使用 Markdown 表格。
- 禁止输出任何用竖杠分隔字段的内容。
- 禁止输出类似「| A | B | C |」的行。
- 禁止输出「| :--- | :--- |」这类表格分隔线。
- 对比内容必须使用卡片式结构。
- 术语内容必须使用术语说明结构。
- 指标内容必须使用短列表结构。
- 证据来源必须写成普通短句，不要写成表格列。
- 不要输出 章节片段、论文缓存、论文缓存5 等内部处理信息。

对比内容格式：

## 方法对比

### 对比对象名称
**优势**：……
**代价**：……
**证据**：……

如果没有明确代价，写：
**代价**：当前缓存未提供明确说明。

回答原则：
1. 先给结论。
2. 不默认输出全文关系。
3. 只有问题涉及全文方法、实验结论、SOTA、baseline、贡献时，才补充全文关系。
4. 不机械补全栏目。
5. 避免报告式长段落。
6. 不复述已有段落精读缓存。
7. 不输出字符位置、offset、start-end。
8. 依据不足时，明确说明“当前段落或缓存不足以判断”。

输出格式：

# 答案

用 2–4 句话回答用户问题。先给结论，不铺垫。

## 核心要点

用 2–4 个 bullet。只保留与问题直接相关的要点。

可用格式：
- **定义**：……
- **作用**：……
- **位置**：……
- **关系**：……

不相关项不要输出。

## 段落位置

用一条短逻辑链说明它在当前段落中的位置。

格式示例：
上文内容  
→ 当前句/当前概念  
→ 下文承接

## 辨析

只有确实容易误解时输出。最多 2 条。

## 扩展关系

只有用户问题确实需要全文方法、实验或结论关系时输出。
否则不要出现这个标题。
`;
}





