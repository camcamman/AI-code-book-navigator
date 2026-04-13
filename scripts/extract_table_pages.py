#!/usr/bin/env python3
"""
Extract table regions from a codebook PDF using structure-first detection.
Outputs one mini-PDF per detected table and a metadata registry for RAG.
"""

import os
import re
import json
import csv
import hashlib
from pathlib import Path

import fitz  # PyMuPDF

# -----------------------------
# Defaults / Paths
# -----------------------------
DEFAULT_PDF_PATH = Path("codebooks/2024_irc_2nd_printing.pdf")
DEFAULT_OUTPUT_DIR = Path("output/tables")
DEBUG_CSV_PATH = DEFAULT_OUTPUT_DIR / "debug_page_scores.csv"
DEBUG_REJECT_DIR = DEFAULT_OUTPUT_DIR / "debug_rejects"
NON_TABLE_DIRNAME = "non_tables"

# -----------------------------
# Regexes
# -----------------------------
TABLE_LABEL_RE = re.compile(
    r"(TABLE\s+R\d+(?:\.\d+)*\(\d+\))\b\s*(.*)$",
    re.IGNORECASE,
)
NEGATIVE_TITLE_RE = re.compile(
    r"\b(REFERENCED\s+STANDARDS|INDEX|CONTENTS|APPENDIX)\b",
    re.IGNORECASE,
)

# -----------------------------
# Geometry thresholds
# -----------------------------
LINE_TOL = 2.0
MIN_LINE_LEN = 40.0
LINE_PAD = 1.5
MERGE_TOL = 6.0
REGION_PAD = 4.0
REGION_MIN_W = 80.0
REGION_MIN_H = 60.0

REGION_H_MIN = 4
REGION_V_MIN = 4
REGION_R_MIN = 3

# -----------------------------
# Text layout thresholds
# -----------------------------
ROW_TOL = 4.0
COL_TOL = 8.0
MIN_WORDS = 6

# -----------------------------
# Utilities
# -----------------------------

def normalize_whitespace(text):
    return re.sub(r"\s+", " ", text).strip()


def file_sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while True:
            chunk = f.read(1024 * 1024)
            if not chunk:
                break
            h.update(chunk)
    return h.hexdigest()


def parse_args(argv):
    pdf_path = DEFAULT_PDF_PATH
    output_dir = DEFAULT_OUTPUT_DIR
    metadata_path = None
    debug_rejects = False
    verbose = False

    i = 1
    while i < len(argv):
        arg = argv[i]
        if arg == "--pdf" and i + 1 < len(argv):
            pdf_path = Path(argv[i + 1])
            i += 2
            continue
        if arg == "--output-dir" and i + 1 < len(argv):
            output_dir = Path(argv[i + 1])
            i += 2
            continue
        if arg == "--metadata" and i + 1 < len(argv):
            metadata_path = Path(argv[i + 1])
            i += 2
            continue
        if arg == "--debug-rejects":
            debug_rejects = True
            i += 1
            continue
        if arg == "--verbose":
            verbose = True
            i += 1
            continue
        i += 1

    if os.environ.get("DEBUG_REJECTS") == "1":
        debug_rejects = True
    if os.environ.get("VERBOSE") == "1":
        verbose = True

    return pdf_path, output_dir, metadata_path, debug_rejects, verbose


def expand_rect(rect, pad):
    return fitz.Rect(
        rect.x0 - pad,
        rect.y0 - pad,
        rect.x1 + pad,
        rect.y1 + pad,
    )


def clamp_rect(rect, bounds):
    return fitz.Rect(
        max(bounds.x0, rect.x0),
        max(bounds.y0, rect.y0),
        min(bounds.x1, rect.x1),
        min(bounds.y1, rect.y1),
    )


def rects_touch(a, b, tol):
    return not (
        a.x1 < b.x0 - tol
        or a.x0 > b.x1 + tol
        or a.y1 < b.y0 - tol
        or a.y0 > b.y1 + tol
    )


def merge_rects(rects, tol):
    merged = []
    for rect in rects:
        added = False
        for idx, existing in enumerate(merged):
            if rects_touch(existing, rect, tol):
                merged[idx] = existing | rect
                added = True
                break
        if not added:
            merged.append(rect)

    changed = True
    while changed:
        changed = False
        out = []
        for rect in merged:
            merged_into = False
            for idx, existing in enumerate(out):
                if rects_touch(existing, rect, tol):
                    out[idx] = existing | rect
                    merged_into = True
                    changed = True
                    break
            if not merged_into:
                out.append(rect)
        merged = out
    return merged


def collect_drawings(page):
    drawings = page.get_drawings()
    line_segments = []
    rectangles = []

    for d in drawings:
        items = d.get("items", [])
        for it in items:
            cmd = it[0]
            if cmd == "l":
                p1 = it[1]
                p2 = it[2]
                dx = abs(p2.x - p1.x)
                dy = abs(p2.y - p1.y)
                if dx < MIN_LINE_LEN and dy < MIN_LINE_LEN:
                    continue
                rect = fitz.Rect(
                    min(p1.x, p2.x),
                    min(p1.y, p2.y),
                    max(p1.x, p2.x),
                    max(p1.y, p2.y),
                )
                rect = expand_rect(rect, LINE_PAD)
                orientation = None
                if dx >= MIN_LINE_LEN and dy <= LINE_TOL:
                    orientation = "h"
                elif dy >= MIN_LINE_LEN and dx <= LINE_TOL:
                    orientation = "v"
                if orientation:
                    line_segments.append({"rect": rect, "orientation": orientation})
            elif cmd == "re":
                rect = it[1]
                if isinstance(rect, fitz.Rect):
                    rectangles.append(rect)
                else:
                    try:
                        rectangles.append(fitz.Rect(rect))
                    except Exception:
                        pass
        if d.get("type") == "rect":
            rect = d.get("rect")
            if isinstance(rect, fitz.Rect):
                rectangles.append(rect)

    rectangles = [r for r in rectangles if r.width >= 10 and r.height >= 10]
    return line_segments, rectangles


def analyze_drawings_counts(page):
    line_segments, rectangles = collect_drawings(page)
    horiz = sum(1 for seg in line_segments if seg["orientation"] == "h")
    vert = sum(1 for seg in line_segments if seg["orientation"] == "v")
    rects = len(rectangles)
    return horiz, vert, rects


def infer_rotation_from_lines(page):
    horiz, vert, _ = analyze_drawings_counts(page)
    if horiz + vert < 6:
        return None
    if horiz >= vert * 1.5:
        return 0
    if vert >= horiz * 1.5:
        return 90
    return None


def infer_rotation_from_text(page):
    counts = {0: 0, 90: 0, 180: 0, 270: 0}
    text = page.get_text("dict") or {}
    for block in text.get("blocks", []):
        for line in block.get("lines", []):
            for span in line.get("spans", []):
                direction = span.get("dir")
                if not direction or len(direction) < 2:
                    continue
                dx, dy = direction[0], direction[1]
                if abs(dx) >= abs(dy):
                    angle = 0 if dx >= 0 else 180
                else:
                    angle = 90 if dy >= 0 else 270
                counts[angle] += 1

    total = sum(counts.values())
    if total < 10:
        return None
    best_angle = max(counts, key=counts.get)
    if counts[best_angle] >= total * 0.6:
        return best_angle
    return None


def detect_rotation(page):
    meta = page.rotation if page.rotation in (0, 90, 180, 270) else 0
    if meta in (90, 180, 270):
        return meta, "metadata"
    inferred = infer_rotation_from_lines(page)
    if inferred in (90, 180, 270):
        return inferred, "lines"
    inferred_text = infer_rotation_from_text(page)
    if inferred_text in (90, 180, 270):
        return inferred_text, "text"
    return meta, "metadata"


def build_candidate_regions(page, line_segments, rectangles):
    rects = [seg["rect"] for seg in line_segments] + rectangles
    rects = [r for r in rects if r.width >= 4 and r.height >= 4]
    if not rects:
        return []
    merged = merge_rects(rects, MERGE_TOL)
    merged = [expand_rect(r, REGION_PAD) for r in merged]
    merged = [r for r in merged if r.width >= REGION_MIN_W and r.height >= REGION_MIN_H]
    merged = [clamp_rect(r, page.rect) for r in merged]
    merged.sort(key=lambda r: (r.y0, r.x0))
    return merged


def refine_region(page, region, line_segments, rectangles):
    content_rects = []
    for seg in line_segments:
        if rects_touch(region, seg["rect"], 0):
            content_rects.append(seg["rect"])
    for rect in rectangles:
        if rects_touch(region, rect, 0):
            content_rects.append(rect)
    words = page.get_text("words", clip=region) or []
    for w in words:
        content_rects.append(fitz.Rect(w[0], w[1], w[2], w[3]))

    if not content_rects:
        return region

    merged = content_rects[0]
    for rect in content_rects[1:]:
        merged = merged | rect
    merged = expand_rect(merged, REGION_PAD)
    merged = clamp_rect(merged, page.rect)
    return merged


def cluster_positions(values, tol):
    if not values:
        return []
    values = sorted(values)
    clusters = []
    for v in values:
        if not clusters:
            clusters.append([v])
            continue
        if abs(v - clusters[-1][-1]) <= tol:
            clusters[-1].append(v)
        else:
            clusters.append([v])
    centers = [sum(cluster) / len(cluster) for cluster in clusters]
    return centers


def nearest_center(value, centers, tol):
    best_idx = None
    best_dist = tol + 1
    for idx, center in enumerate(centers):
        dist = abs(value - center)
        if dist <= tol and dist < best_dist:
            best_idx = idx
            best_dist = dist
    return best_idx


def coefficient_of_variation(values):
    if len(values) < 2:
        return None
    mean = sum(values) / len(values)
    if mean == 0:
        return None
    variance = sum((v - mean) ** 2 for v in values) / len(values)
    return (variance ** 0.5) / mean


def analyze_text_layout(page, region):
    words = page.get_text("words", clip=region) or []
    word_count = len(words)
    if word_count == 0:
        return {
            "word_count": 0,
            "rows": 0,
            "cols": 0,
            "aligned_rows": 0,
            "spacing_consistent": False,
            "row_cv": None,
            "col_cv": None,
        }

    row_values = [(w[1] + w[3]) / 2 for w in words]
    col_values = [(w[0] + w[2]) / 2 for w in words]

    row_centers = cluster_positions(row_values, ROW_TOL)
    col_centers = cluster_positions(col_values, COL_TOL)

    row_to_cols = {}
    for idx, word in enumerate(words):
        row = nearest_center((word[1] + word[3]) / 2, row_centers, ROW_TOL)
        col = nearest_center((word[0] + word[2]) / 2, col_centers, COL_TOL)
        if row is None or col is None:
            continue
        row_to_cols.setdefault(row, set()).add(col)

    aligned_rows = sum(1 for cols in row_to_cols.values() if len(cols) >= 2)

    row_centers_sorted = sorted(row_centers)
    col_centers_sorted = sorted(col_centers)

    row_gaps = [
        row_centers_sorted[i + 1] - row_centers_sorted[i]
        for i in range(len(row_centers_sorted) - 1)
    ]
    col_gaps = [
        col_centers_sorted[i + 1] - col_centers_sorted[i]
        for i in range(len(col_centers_sorted) - 1)
    ]

    row_cv = coefficient_of_variation(row_gaps) if row_gaps else None
    col_cv = coefficient_of_variation(col_gaps) if col_gaps else None
    spacing_consistent = False
    if row_cv is not None and row_cv < 0.6:
        spacing_consistent = True
    if col_cv is not None and col_cv < 0.6:
        spacing_consistent = True

    return {
        "word_count": word_count,
        "rows": len(row_centers),
        "cols": len(col_centers),
        "aligned_rows": aligned_rows,
        "spacing_consistent": spacing_consistent,
        "row_cv": row_cv,
        "col_cv": col_cv,
    }


def geometry_in_region(region, line_segments, rectangles):
    h = 0
    v = 0
    for seg in line_segments:
        if rects_touch(region, seg["rect"], 0):
            if seg["orientation"] == "h":
                h += 1
            elif seg["orientation"] == "v":
                v += 1
    rects = sum(1 for rect in rectangles if rects_touch(region, rect, 0))
    return h, v, rects


def compute_table_score(h, v, rects, aligned_rows, rows, cols):
    return (h + v) + (rects * 2) + (aligned_rows * 2) + rows + cols


def classify_region(h, v, rects, text_metrics, negative_title):
    # Accept only when at least two table signals agree:
    # 1) grid lines (h+v), 2) rectangular geometry, 3) aligned columns/rows,
    # 4) consistent spacing. This prevents figure/diagram false positives.
    cond_grid = h >= REGION_H_MIN and v >= REGION_V_MIN
    cond_rect = rects >= REGION_R_MIN
    cond_aligned = text_metrics["aligned_rows"] >= 3 and text_metrics["cols"] >= 2
    cond_spacing = text_metrics["spacing_consistent"] and text_metrics["rows"] >= 3

    conditions = [cond_grid, cond_rect, cond_aligned, cond_spacing]
    true_count = sum(1 for c in conditions if c)

    if true_count < 2:
        return False, "insufficient_conditions", "low"

    if cond_grid and (cond_aligned or cond_rect):
        confidence = "high"
    else:
        confidence = "medium"

    if negative_title and confidence != "high":
        return False, "negative_title", "low"

    if text_metrics["word_count"] < MIN_WORDS and not cond_grid:
        return False, "too_little_text", "low"

    return True, "conditions_met", confidence


def extract_caption_and_label(page, region):
    band = fitz.Rect(0, max(0, region.y0 - 80), page.rect.width, region.y0)
    band_text = page.get_text("text", clip=band) or ""
    region_text = page.get_text("text", clip=region) or ""

    lines = [normalize_whitespace(line) for line in band_text.splitlines() if line.strip()]
    region_lines = [
        normalize_whitespace(line) for line in region_text.splitlines() if line.strip()
    ]

    section_label = None
    caption = None

    for line in lines + region_lines[:3]:
        match = TABLE_LABEL_RE.search(line)
        if match:
            section_label = normalize_whitespace(match.group(1))
            remainder = normalize_whitespace(match.group(2) or "")
            if remainder:
                caption = remainder
            break

    if caption is None and region_lines:
        caption = " ".join(region_lines[:2]).strip()

    return section_label, caption


def safe_clip(rect, bounds):
    if rect is None:
        return None
    if rect.x0 != rect.x0 or rect.y0 != rect.y0 or rect.x1 != rect.x1 or rect.y1 != rect.y1:
        return None
    clipped = clamp_rect(rect, bounds)
    if clipped.width <= 1 or clipped.height <= 1:
        return None
    return clipped


def save_region_as_pdf(src_doc, src_page_number, region, out_path):
    new_doc = fitz.open()
    bounds = src_doc[src_page_number].rect
    clipped = safe_clip(region, bounds)
    if clipped is None:
        new_doc.close()
        return False
    width = max(1, clipped.width)
    height = max(1, clipped.height)
    new_page = new_doc.new_page(width=width, height=height)
    new_page.show_pdf_page(
        fitz.Rect(0, 0, width, height),
        src_doc,
        src_page_number,
        clip=clipped,
    )
    new_doc.save(out_path)
    new_doc.close()
    return True


def save_reject_debug(page, region, out_path):
    pix = page.get_pixmap(clip=region, alpha=False)
    pix.save(out_path.as_posix())


def cleanup_output_dir(output_dir, keep_files, prefix):
    for path in output_dir.glob("*.pdf"):
        if not path.name.startswith(prefix):
            continue
        if path.name not in keep_files:
            path.unlink()


def main():
    pdf_path, output_dir, metadata_path, debug_rejects, verbose = parse_args(os.sys.argv)

    if not pdf_path.exists():
        raise SystemExit(f"PDF not found: {pdf_path}")

    output_dir.mkdir(parents=True, exist_ok=True)

    codebook_id = pdf_path.stem
    if metadata_path is None:
        metadata_path = output_dir / f"{codebook_id}_tables_metadata.json"
    non_table_dir = output_dir / NON_TABLE_DIRNAME

    source_hash_path = output_dir / f".{codebook_id}_source_hash"
    source_hash = file_sha256(pdf_path)
    previous_hash = source_hash_path.read_text().strip() if source_hash_path.exists() else ""
    rebuild_clean = source_hash != previous_hash

    if rebuild_clean:
        for path in output_dir.glob(f"{codebook_id}_*.pdf"):
            path.unlink()
        if non_table_dir.exists():
            for path in non_table_dir.glob(f"{codebook_id}_*.pdf"):
                path.unlink()
        if metadata_path.exists():
            metadata_path.unlink()
        if DEBUG_CSV_PATH.exists():
            DEBUG_CSV_PATH.unlink()
        if DEBUG_REJECT_DIR.exists():
            for path in DEBUG_REJECT_DIR.glob(f"{codebook_id}_*.png"):
                path.unlink()

    if debug_rejects:
        DEBUG_REJECT_DIR.mkdir(parents=True, exist_ok=True)
    non_table_dir.mkdir(parents=True, exist_ok=True)

    registry = []
    extracted_files = set()
    non_table_files = set()
    debug_rows = []

    with fitz.open(pdf_path) as doc:
        for page_number in range(doc.page_count):
            page = doc.load_page(page_number)
            rotation_detected, rotation_source = detect_rotation(page)
            rotation_applied = (360 - rotation_detected) % 360

            normalized_doc = fitz.open()
            normalized_doc.insert_pdf(
                doc,
                from_page=page_number,
                to_page=page_number,
                rotate=rotation_applied,
            )
            norm_page = normalized_doc[0]

            text = norm_page.get_text("text") or ""
            lines = [normalize_whitespace(line) for line in text.splitlines() if line.strip()]
            head = " ".join(lines[:5]) if lines else ""
            negative_title = bool(NEGATIVE_TITLE_RE.search(head))

            line_segments, rectangles = collect_drawings(norm_page)
            regions = build_candidate_regions(norm_page, line_segments, rectangles)

            page_text_metrics = analyze_text_layout(norm_page, norm_page.rect)
            page_h = sum(1 for seg in line_segments if seg["orientation"] == "h")
            page_v = sum(1 for seg in line_segments if seg["orientation"] == "v")
            page_rects = len(rectangles)
            page_score = compute_table_score(
                page_h,
                page_v,
                page_rects,
                page_text_metrics["aligned_rows"],
                page_text_metrics["rows"],
                page_text_metrics["cols"],
            )

            # Fallback: text-only tables with no grid lines
            if not regions:
                if page_text_metrics["aligned_rows"] >= 3 and page_text_metrics["cols"] >= 2:
                    words = norm_page.get_text("words") or []
                    if words:
                        bbox = fitz.Rect(words[0][0], words[0][1], words[0][2], words[0][3])
                        for w in words[1:]:
                            bbox = bbox | fitz.Rect(w[0], w[1], w[2], w[3])
                        regions = [clamp_rect(expand_rect(bbox, REGION_PAD), norm_page.rect)]
                    else:
                        regions = [norm_page.rect]

            if verbose:
                print(
                    f"page={page_number + 1} score={page_score} h={page_h} v={page_v} "
                    f"r={page_rects} words={page_text_metrics['word_count']} "
                    f"rotationApplied={rotation_applied} rotationSource={rotation_source} "
                    f"candidateRegions={len(regions)}"
                )

            table_index = 0
            accepted_tables = 0
            for region_idx, region in enumerate(regions, start=1):
                h, v, rects = geometry_in_region(region, line_segments, rectangles)
                text_metrics = analyze_text_layout(norm_page, region)
                table_score = compute_table_score(
                    h,
                    v,
                    rects,
                    text_metrics["aligned_rows"],
                    text_metrics["rows"],
                    text_metrics["cols"],
                )

                is_table, reason, confidence = classify_region(
                    h, v, rects, text_metrics, negative_title
                )

                decision = "TABLE" if is_table else "REJECT"
                if verbose:
                    print(
                        f"  region={region_idx} decision={decision} reason={reason} "
                        f"h={h} v={v} r={rects} rows={text_metrics['rows']} "
                        f"cols={text_metrics['cols']} alignedRows={text_metrics['aligned_rows']} "
                        f"score={table_score} confidence={confidence}"
                    )

                debug_rows.append(
                    {
                        "page": page_number + 1,
                        "region_index": region_idx,
                        "decision": decision,
                        "reason": reason,
                        "confidence": confidence,
                        "rotation_applied": rotation_applied,
                        "rotation_source": rotation_source,
                        "table_score": table_score,
                        "horizontal_lines": h,
                        "vertical_lines": v,
                        "rectangles": rects,
                        "word_count": text_metrics["word_count"],
                        "rows": text_metrics["rows"],
                        "cols": text_metrics["cols"],
                        "aligned_rows": text_metrics["aligned_rows"],
                        "spacing_consistent": int(text_metrics["spacing_consistent"]),
                        "bbox": f"{region.x0:.1f},{region.y0:.1f},{region.x1:.1f},{region.y1:.1f}",
                    }
                )

                # Fail-closed: low confidence or failed validation -> no extraction.
                if not is_table or confidence == "low":
                    reject_name = (
                        f"{codebook_id}_page{page_number + 1}_region{region_idx}_{reason}.pdf"
                    )
                    reject_path = non_table_dir / reject_name
                    if save_region_as_pdf(normalized_doc, 0, region, reject_path):
                        non_table_files.add(reject_path.name)
                    if debug_rejects:
                        reject_name = (
                            f"{codebook_id}_page{page_number + 1}_region{region_idx}_{reason}.png"
                        )
                        reject_path = DEBUG_REJECT_DIR / reject_name
                        save_reject_debug(norm_page, region, reject_path)
                    continue

                table_index += 1
                accepted_tables += 1
                table_region = refine_region(norm_page, region, line_segments, rectangles)
                filename = f"{codebook_id}_page{page_number + 1}_table{table_index}.pdf"
                out_path = output_dir / filename
                if save_region_as_pdf(normalized_doc, 0, table_region, out_path):
                    extracted_files.add(out_path.name)
                else:
                    if verbose:
                        print(
                            f"  region={region_idx} decision=REJECT reason=invalid_clip"
                        )
                    continue

                section_label, caption = extract_caption_and_label(norm_page, table_region)
                if not section_label:
                    section_label = None

                if caption is None:
                    caption = ""

                pdf_rel_path = out_path
                try:
                    pdf_rel_path = out_path.relative_to(output_dir.parent)
                except Exception:
                    pass

                registry.append(
                    {
                        "codebookId": codebook_id,
                        "page": page_number + 1,
                        "tableIndex": table_index,
                        "pdfPath": str(pdf_rel_path),
                        "sectionLabel": section_label,
                        "caption": caption,
                        "rotationApplied": rotation_applied,
                        "confidence": confidence,
                    }
                )

            page_decision = "TABLE_PAGE" if accepted_tables > 0 else "NOT_TABLE_PAGE"
            if accepted_tables > 0:
                page_reason = "table_detected"
            elif not regions:
                page_reason = "no_regions"
            else:
                page_reason = "all_regions_rejected"
            debug_rows.append(
                {
                    "page": page_number + 1,
                    "region_index": 0,
                    "decision": page_decision,
                    "reason": page_reason,
                    "confidence": "page",
                    "rotation_applied": rotation_applied,
                    "rotation_source": rotation_source,
                    "table_score": page_score,
                    "horizontal_lines": page_h,
                    "vertical_lines": page_v,
                    "rectangles": page_rects,
                    "word_count": page_text_metrics["word_count"],
                    "rows": page_text_metrics["rows"],
                    "cols": page_text_metrics["cols"],
                    "aligned_rows": page_text_metrics["aligned_rows"],
                    "spacing_consistent": int(page_text_metrics["spacing_consistent"]),
                    "bbox": "",
                }
            )

            # if accepted_tables > 0 or verbose:
            #     print(
            #         f"page={page_number + 1} decision={page_decision} reason={page_reason} "
            #         f"tables={accepted_tables}"
            #     )

            # normalized_doc.close()

    # Cleanup stale files
    cleanup_output_dir(output_dir, extracted_files, f"{codebook_id}_")
    if non_table_dir.exists():
        cleanup_output_dir(non_table_dir, non_table_files, f"{codebook_id}_")

    # Write debug CSV
    DEBUG_CSV_PATH.parent.mkdir(parents=True, exist_ok=True)
    with DEBUG_CSV_PATH.open("w", newline="", encoding="utf-8") as handle:
        if debug_rows:
            writer = csv.DictWriter(handle, fieldnames=list(debug_rows[0].keys()))
            writer.writeheader()
            writer.writerows(debug_rows)

    # Write metadata registry
    metadata_path.parent.mkdir(parents=True, exist_ok=True)
    metadata_path.write_text(
        json.dumps(registry, ensure_ascii=True, indent=2), encoding="utf-8"
    )

    source_hash_path.write_text(source_hash, encoding="utf-8")

    print(f"Extracted {len(registry)} tables -> {output_dir}")
    print(f"Metadata written to {metadata_path}")
    print(f"Debug CSV written to {DEBUG_CSV_PATH}")


if __name__ == "__main__":
    raise SystemExit(main())
