# Zotero Paper Mind

AI-assisted academic paper reading plugin for Zotero.

Zotero Paper Mind helps users read academic papers inside Zotero by combining full-paper analysis, paragraph-level interpretation, contextual explanation, follow-up questioning, and local caching.

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

## API mode

The current implementation uses an OpenAI-compatible API interface.

Tested configuration:

```text
endpoint = https://api.deepseek.com/v1
model    = deepseek-chat