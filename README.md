# AI Codebook Navigator

This project parses building-code PDFs, extracts amendment text, builds OpenAI embedding indexes, and serves a local UI for asking code questions against those indexed materials.

The current repo is set up for:

- Base codebook: `irc-utah-2021`
- Amendment codebook: `irc-utah-2021-amendments`

## What This Repo Does

There are four main stages:

1. Parse the base codebook PDF into section and table text files.
2. Extract Utah IRC amendment items into individual text files.
3. Convert those files into embedding-backed index JSON files for RAG.
4. Start the Next.js UI and ask questions.

There is also an optional LLM-based script that detects full-page table pages and exports them as mini-PDFs and PNGs.

## Prerequisites

Install Node dependencies:

```bash
npm install
```

Use the Python virtualenv if you have one:

```bash
source .venv/bin/activate
```

Install Python packages used by the parsing scripts:

```bash
pip install pdfplumber pymupdf openai
```

System dependency required for amendment extraction:

```bash
brew install poppler
```

Environment variable required in `.env`:

```bash
OPENAI_API_KEY=...
```

Optional model env vars:

```bash
OPENAI_EMBEDDING_MODEL=text-embedding-3-small
OPENAI_TABLE_MODEL=gpt-4o-mini
```

## Quick Start

If the parsed text files already exist and you only need to get the app working again:

```bash
npx -y tsx scripts/indexAllCodebooks.ts --codebook irc-utah-2021
npx -y tsx scripts/indexAllCodebooks.ts --codebook irc-utah-2021-amendments

npm run dev
```

Then open `http://localhost:3000`.

## Full Pipeline

### 1. Parse The Base Codebook PDF

Source PDF currently in the repo:

`codebooks/IRC-Utah-2021/raw/source/2024_irc_2nd_printing.pdf`

Run:

```bash
python3 scripts/pdfParsingIRCCodeBook.py \
  --pdf codebooks/IRC-Utah-2021/raw/source/2024_irc_2nd_printing.pdf \
  --out codebooks/IRC-Utah-2021/raw
```

This writes files like:

- `codebooks/IRC-Utah-2021/raw/section_*.txt`
- `codebooks/IRC-Utah-2021/raw/table_*.txt`
- `codebooks/IRC-Utah-2021/raw/_parse_report.json`

### 2. Optional: Export Full-Page Tables With OpenAI

This script uses `page.get_text("text")`, asks OpenAI whether the page is a full-page table, and exports any detected table pages as a one-page PDF and optional PNG.

Run:

```bash
python3 scripts/extract_table_pages_llm.py \
  --pdf codebooks/IRC-Utah-2021/raw/source/2024_irc_2nd_printing.pdf \
  --codebook-id 2024_irc_2nd_printing \
  --output-dir tables \
  --verbose
```

This writes:

- `tables/<codebookId>_page<page>_table.pdf`
- `tables/img/<codebookId>_page<page>_table.png`
- `tables/<codebookId>_tables.json`

Important:

- This is currently an export/inspection workflow.
- It is not yet wired into the main RAG indexer.

### 3. Download And Extract IRC Utah Amendments

Download and split the Utah amendments PDF into individual amendment text files:

```bash
npx -y tsx scripts/downloadUtahIrcAmendments.ts
```

This writes files under:

- `codebooks/irc-utah-2021-amendments/raw/items/`
- `codebooks/irc-utah-2021-amendments/_download_extract_report.json`

If you already have a local amendment source file and want to re-extract from disk instead of downloading:

```bash
npx -y tsx scripts/extractIrcAmendments.ts
```

### 4. Build The RAG Indexes

Build the base codebook index:

```bash
npx -y tsx scripts/indexAllCodebooks.ts --codebook irc-utah-2021
```

Build the amendment index:

```bash
npx -y tsx scripts/indexAllCodebooks.ts --codebook irc-utah-2021-amendments
```

This writes:

- `codebooks/IRC-Utah-2021/irc-utah-2021.index.json`
- `codebooks/irc-utah-2021-amendments/irc-utah-2021-amendments.index.json`

The UI expects these index files to exist.

### 5. Start The UI

Run:

```bash
npm run dev
```

Then open:

```text
http://localhost:3000
```

## Most Common Commands

Rebuild base parse:

```bash
python3 scripts/pdfParsingIRCCodeBook.py \
  --pdf codebooks/IRC-Utah-2021/raw/source/2024_irc_2nd_printing.pdf \
  --out codebooks/IRC-Utah-2021/raw
```

Re-run table-page export:

```bash
python3 scripts/extract_table_pages_llm.py \
  --pdf codebooks/IRC-Utah-2021/raw/source/2024_irc_2nd_printing.pdf \
  --codebook-id 2024_irc_2nd_printing \
  --output-dir tables
```

Rebuild amendment items:

```bash
npx -y tsx scripts/downloadUtahIrcAmendments.ts
```

Rebuild both indexes:

```bash
npx -y tsx scripts/indexAllCodebooks.ts --codebook irc-utah-2021
npx -y tsx scripts/indexAllCodebooks.ts --codebook irc-utah-2021-amendments
```

Run the UI:

```bash
npm run dev
```

## Troubleshooting

### `Index file not found for codebook 'irc-utah-2021'`

The base index has not been rebuilt yet. Run:

```bash
npx -y tsx scripts/indexAllCodebooks.ts --codebook irc-utah-2021
```

### `OPENAI_API_KEY is not set`

Add it to `.env` and restart the command.

### `pdftotext` not found

Install Poppler:

```bash
brew install poppler
```

### Python module not found

Install the Python dependencies:

```bash
pip install pdfplumber pymupdf openai
```

## Notes For Future Cleanup

These are good follow-up improvements, but not required to run the system:

- Add npm scripts for parse, amendments, indexing, and dev.
- Decide whether full-page table exports should feed into the RAG index.
- Add this workflow to CI or a Makefile-style command wrapper.
