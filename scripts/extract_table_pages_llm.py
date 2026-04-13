#!/usr/bin/env python3
"""
Detect full-page tables from PDF page text using an OpenAI model.

For each detected table page, the script exports:
- a one-page PDF under tables/
- an optional PNG under tables/img/
- a JSON metadata registry
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional


DEFAULT_MODEL = os.environ.get("OPENAI_TABLE_MODEL") or os.environ.get("OPENAI_MODEL") or "gpt-4o-mini"
SYSTEM_PROMPT = """You classify pages from building-code PDFs.

Determine whether the page is a full-page table, meaning the page is primarily a grid of rows and columns.
Ignore small inline tables and ordinary prose pages.
If you are unsure, return false.

Return only valid JSON:
{
  "is_table": true|false,
  "label": "Table R905.1" or null
}

If no clear table label is visible in the text, use null for label."""


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pdf", required=True, help="Path to the source PDF.")
    parser.add_argument("--codebook-id", required=True, help="Identifier used in exported filenames and metadata.")
    parser.add_argument(
        "--output-dir",
        default="tables",
        help="Directory for table PDFs and metadata JSON. Default: tables",
    )
    parser.add_argument(
        "--metadata",
        default=None,
        help="Output path for metadata JSON. Default: <output-dir>/<codebook-id>_tables.json",
    )
    parser.add_argument(
        "--model",
        default=DEFAULT_MODEL,
        help=f"OpenAI model name. Default: {DEFAULT_MODEL}",
    )
    parser.add_argument(
        "--start-page",
        type=int,
        default=1,
        help="1-based first page to inspect. Default: 1",
    )
    parser.add_argument(
        "--end-page",
        type=int,
        default=None,
        help="1-based last page to inspect. Default: last page in PDF",
    )
    parser.add_argument(
        "--render-png",
        action=argparse.BooleanOptionalAction,
        default=True,
        help="Render a PNG for each detected table page. Default: true",
    )
    parser.add_argument(
        "--dpi",
        type=int,
        default=150,
        help="PNG render DPI when --render-png is enabled. Default: 150",
    )
    parser.add_argument(
        "--verbose",
        action="store_true",
        help="Print per-page classification results.",
    )
    return parser.parse_args()


def require_module(name: str, install_hint: str):
    try:
        return __import__(name)
    except ImportError as exc:
        raise SystemExit(f"Missing dependency '{name}'. Install it with: {install_hint}") from exc


def get_fitz():
    return require_module("fitz", "pip install pymupdf")


def get_openai_client():
    openai = require_module("openai", "pip install openai")
    if not os.environ.get("OPENAI_API_KEY"):
        raise SystemExit("OPENAI_API_KEY is not set in the environment.")
    return openai.OpenAI()


def extract_json_object(text: str) -> Dict[str, Any]:
    stripped = text.strip()
    if stripped.startswith("```"):
        stripped = stripped.strip("`").strip()
        if stripped.lower().startswith("json"):
            stripped = stripped[4:].strip()

    start = stripped.find("{")
    end = stripped.rfind("}")
    if start == -1 or end == -1 or end < start:
        raise ValueError(f"Model response did not contain a JSON object: {text!r}")

    payload = json.loads(stripped[start : end + 1])
    if not isinstance(payload, dict):
        raise ValueError(f"Model response JSON was not an object: {payload!r}")
    return payload


def normalize_label(value: Any) -> Optional[str]:
    if value is None:
        return None
    if not isinstance(value, str):
        value = str(value)
    label = " ".join(value.split()).strip()
    if not label or label.lower() == "null":
        return None
    return label


def normalize_bool(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        lowered = value.strip().lower()
        if lowered == "true":
            return True
        if lowered == "false":
            return False
    return bool(value)


def classify_page_text(client: Any, model: str, page_text: str) -> Dict[str, Any]:
    response = client.chat.completions.create(
        model=model,
        temperature=0,
        response_format={"type": "json_object"},
        messages=[
            {"role": "system", "content": SYSTEM_PROMPT},
            {
                "role": "user",
                "content": (
                    "Does this page contain a full-page table (grid of rows/columns)?\n"
                    "Return only:\n"
                    "{\n"
                    '  "is_table": true|false,\n'
                    '  "label": "Table R905.1" or null\n'
                    "}\n\n"
                    "PAGE TEXT:\n"
                    f"{page_text}"
                ),
            },
        ],
    )

    content = response.choices[0].message.content or ""
    payload = extract_json_object(content)
    is_table = normalize_bool(payload.get("is_table"))
    label = normalize_label(payload.get("label"))
    return {"is_table": is_table, "label": label}


def ensure_dir(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True)


def path_for_metadata(path: Path) -> str:
    try:
        return path.resolve().relative_to(Path.cwd().resolve()).as_posix()
    except ValueError:
        return path.as_posix()


def export_single_page_pdf(doc: Any, page_index: int, output_path: Path) -> None:
    fitz = get_fitz()
    mini_doc = fitz.open()
    try:
        mini_doc.insert_pdf(doc, from_page=page_index, to_page=page_index)
        mini_doc.save(output_path)
    finally:
        mini_doc.close()


def render_page_png(page: Any, output_path: Path, dpi: int) -> None:
    fitz = get_fitz()
    scale = dpi / 72.0
    pixmap = page.get_pixmap(matrix=fitz.Matrix(scale, scale), alpha=False)
    pixmap.save(output_path)


def main() -> int:
    args = parse_args()
    pdf_path = Path(args.pdf)
    if not pdf_path.exists():
        raise SystemExit(f"PDF not found: {pdf_path}")

    fitz = get_fitz()
    client = get_openai_client()

    output_dir = Path(args.output_dir)
    image_dir = output_dir / "img"
    metadata_path = Path(args.metadata) if args.metadata else output_dir / f"{args.codebook_id}_tables.json"

    ensure_dir(output_dir)
    if args.render_png:
        ensure_dir(image_dir)
    ensure_dir(metadata_path.parent)

    metadata: List[Dict[str, Any]] = []
    doc = fitz.open(pdf_path)

    try:
        total_pages = doc.page_count
        start_page = max(1, args.start_page)
        end_page = total_pages if args.end_page is None else min(total_pages, args.end_page)

        if start_page > end_page:
            raise SystemExit(
                f"Invalid page range: start_page={start_page}, end_page={end_page}, total_pages={total_pages}"
            )

        for page_number in range(start_page, end_page + 1):
            page_index = page_number - 1
            page = doc.load_page(page_index)
            page_text = (page.get_text("text") or "").strip()

            if not page_text:
                if args.verbose:
                    print(f"[page {page_number}] skipped: no visible text")
                continue

            result = classify_page_text(client, args.model, page_text)

            if args.verbose:
                print(
                    f"[page {page_number}] is_table={result['is_table']} "
                    f"label={json.dumps(result['label'])}"
                )

            if not result["is_table"]:
                continue

            pdf_output_path = output_dir / f"{args.codebook_id}_page{page_number}_table.pdf"
            export_single_page_pdf(doc, page_index, pdf_output_path)

            image_output_path: Optional[Path] = None
            if args.render_png:
                image_output_path = image_dir / f"{args.codebook_id}_page{page_number}_table.png"
                render_page_png(page, image_output_path, args.dpi)

            metadata.append(
                {
                    "codebookId": args.codebook_id,
                    "page": page_number,
                    "label": result["label"],
                    "pdfPath": path_for_metadata(pdf_output_path),
                    "imagePath": path_for_metadata(image_output_path) if image_output_path else None,
                }
            )
    finally:
        doc.close()

    metadata_path.write_text(json.dumps(metadata, indent=2) + "\n", encoding="utf-8")

    print(
        json.dumps(
            {
                "codebookId": args.codebook_id,
                "pagesProcessed": (end_page - start_page + 1),
                "tablesDetected": len(metadata),
                "metadataPath": path_for_metadata(metadata_path),
            },
            indent=2,
        )
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
