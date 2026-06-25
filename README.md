# Zotero Paper Mind

AI-assisted academic paper reading plugin for Zotero.

Zotero Paper Mind helps users read academic papers inside Zotero by combining full-paper analysis, paragraph-level close reading, follow-up questioning, and local caching. The goal is to reduce repeated manual copying between Zotero and external AI tools.

> Current status: active development. The plugin is usable, but APIs, UI behavior, and cache format may still change.

## Features

### Full-paper analysis

The plugin can read the currently opened Zotero paper, extract its full text, and send it to a configured OpenAI-compatible LLM endpoint for full-paper analysis.

The analysis is designed to generate:

- paper-level reading profile
- research problem and motivation
- method overview
- module-level structure
- experiment summary
- key terminology
- paper structure mind map
- paragraph and module context for later close reading

### Paragraph close reading

After a paper has been analyzed, selected text can be interpreted with paper-level context.

The plugin attempts to locate the selected passage inside the full paper and explain:

- what the selected paragraph means
- where it appears in the paper structure
- what role it plays in the argument or method
- which technical terms are necessary for understanding it
- how it connects to nearby paragraphs or modules

### Follow-up Q&A

The plugin supports follow-up questions about a selected passage. The answer can use:

- selected text
- full-paper profile
- paragraph cache
- module context
- previous close-reading cache

### Local cache

Paper profiles, raw full text, paragraph analysis, and close-reading results are stored locally.

Cache files are separated by Zotero item key, so each paper has its own saved context.

Cache files should not be committed to this repository.

## Installation

### Install from GitHub Release

1. Open the repository release page.
2. Download the latest `.xpi` file.
3. Open Zotero.
4. Go to:

```text
Tools → Add-ons
```

5. Click the gear icon and choose:

```text
Install Add-on From File
```

6. Select the downloaded `.xpi` file.
7. Restart Zotero when prompted.

After installation, the plugin menu appears under:

```text
Tools → Paper Assistant
```

### Configure API

Before using full-paper analysis or paragraph close reading, configure an OpenAI-compatible API endpoint:

```text
Tools → Paper Assistant → Configure API
```

Example configuration:

```text
endpoint = https://api.deepseek.com/v1
model    = deepseek-chat
```

You also need to enter your own API key.

## Basic usage

1. Open a paper in Zotero.
2. Run full-paper analysis from the Paper Assistant menu.
3. Wait for the plugin to build the paper profile and local cache.
4. Select a paragraph in the Zotero PDF reader.
5. Use the Paper Assistant reader context menu for paragraph close reading or follow-up Q&A.

## Development

### Requirements

- Zotero 9.x
- Node.js
- npm
- Git

### Install dependencies

```bash
npm install
```

### Build

```bash
npm run build
```

The generated plugin package is created under:

```text
.scaffold/build
```

### Clean build on Windows PowerShell

```powershell
if (Test-Path .\.scaffold\build) { Remove-Item -Recurse -Force .\.scaffold\build }
npm run build
```

## Repository structure

```text
src/
  hooks.ts
  modules/
    currentPaper.ts
    explanationCache.ts
    llm.ts
    menu.ts
    paperContext.ts
    paragraphAnalysisPrompt.ts
    paragraphIndex.ts
    prompt.ts
    readingPrompt.ts
    selectionLocator.ts
```

## Privacy

The plugin sends selected text or paper text to the configured LLM endpoint when analysis is requested.

Do not commit:

```text
PaperAssistantCache/
.env
.env.local
*.xpi
.scaffold/build/
node_modules/
```

API keys and local caches should remain private.

## Notes

This project does not use a ChatGPT Plus subscription as a backend. ChatGPT Plus and API access are separate systems. The plugin currently works through configurable API endpoints.

## License

AGPL-3.0-or-later
