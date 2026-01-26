#!/usr/bin/env python3
import argparse
import csv
import hashlib
import json
import math
import re
import sys
from pathlib import Path
from typing import List, Dict, Tuple, Optional

import pdfplumber

OUTPUT_DIR = Path("codebooks/IRC-Utah-2021/raw")

SECTION_HEADER_RE = re.compile(
    r"^(?!.*(?:\.\s*){3,})\s*(?:SECTION\s+)?([A-Z]{1,3}\d{3,4}(?:\.\d+)*)\b(?:\s+(.*))?$",
    re.IGNORECASE,
)
SECTION_TEXT_RE = re.compile(
    r"^\s*(?:(SECTION)\s+([A-Z0-9]+)|Appendix\s+([A-Z]+)|([RNPGE]\d+(?:\.\d+)*))\s+(?:[^.]+\.[\s]*|[–—].+)$",
    re.IGNORECASE,
)
CHAPTER_RE = re.compile(r"^CHAPTER\s+([A-Z0-9]+)\b", re.IGNORECASE)
TABLE_LABEL_RE = re.compile(
    r"^TABLE\s+([A-Z]{1,3}\d{3,4}(?:\.\d+)*(?:\([0-9A-Z]+\))?)\b\.?\s*(.*)?$",
    re.IGNORECASE,
)
AMENDMENT_RE = re.compile(r"\b(?:UTAH|STATE|AMENDED|MODIFIED|AMENDMENTS)\b", re.IGNORECASE)

TABLE_SETTINGS = {
    "vertical_strategy": "lines",
    "horizontal_strategy": "lines",
    "intersection_x_tolerance": 5,
    "intersection_y_tolerance": 5,
    "snap_tolerance": 3,
    "join_tolerance": 3,
    "edge_min_length": 3,
    "min_words_vertical": 1,
    "min_words_horizontal": 1,
}
RULING_SNAP_GRID = 0.5
RULING_EPS = 1.0
RULING_MIN_LEN = 6.0
RULING_JOIN_TOLERANCE = 2.0
RULING_INTERSECTION_TOLERANCE = 1.5
TABLE_INTERSECTION_MIN = 4
TABLE_LABEL_SEARCH_WINDOW = 60.0
TABLE_LABEL_TOP_BAND_RATIO = 0.15
TABLE_EMPTY_CELL_RATIO_MAX = 0.8
CHAR_ROTATION_TOLERANCE = 5.0

# Line reconstruction tolerances (tight to fail loudly on ambiguity).
LINE_Y_TOLERANCE = 3.0
WORD_GAP_MIN = 1.0
COLUMN_MARGIN_TOLERANCE = 3.0
HEADER_BODY_INDENT_MIN = 6.0
HEADER_REGION_RATIO = 0.1
FOOTER_REGION_RATIO = 0.1
WORD_GAP_MULTIPLIER = 0.5
HEADER_SIZE_DELTA = 1.0
MAX_HEADER_LINE_GAP = 12.0
TABLE_EDGE_TOLERANCE = 1.0
CENTER_BAND_RATIO = 0.2
SPLIT_CENTER_TOLERANCE_RATIO = 0.15
GUTTER_TOLERANCE = 2.0


def format_error(
    rule: str,
    page_num: Optional[int],
    detail: str,
    stats: Optional[Dict] = None,
) -> str:
    pdf_page = page_num if page_num is not None else "UNKNOWN"
    message = f"RULE={rule} PDF_PAGE={pdf_page} detail={detail}"
    if stats is not None:
        message += f" stats={stats}"
    return message


def ensure_error_context(message: str, page_num: Optional[int]) -> str:
    if message.startswith("RULE="):
        rule = message.split()[0].split("=", 1)[1]
        if page_num is not None and f"PDF_PAGE={page_num}" in message:
            return message
        return format_error(rule, page_num, f"wrapped={message}")
    return format_error("UNHANDLED_EXCEPTION", page_num, f"exception={message}")


def median(values: List[float]) -> float:
    if not values:
        raise RuntimeError(format_error("MEDIAN_EMPTY", None, "Cannot compute median of empty list."))
    values_sorted = sorted(values)
    mid = len(values_sorted) // 2
    if len(values_sorted) % 2 == 1:
        return values_sorted[mid]
    return (values_sorted[mid - 1] + values_sorted[mid]) / 2.0


def percentile(values: List[float], pct: float, page_num: int, label: str) -> float:
    if not values:
        raise RuntimeError(
            format_error(
                "PERCENTILE_EMPTY",
                page_num,
                f"Cannot compute percentile for {label} at pct={pct}.",
            )
        )
    if pct <= 0:
        return min(values)
    if pct >= 100:
        return max(values)
    values_sorted = sorted(values)
    k = (len(values_sorted) - 1) * (pct / 100.0)
    f = math.floor(k)
    c = math.ceil(k)
    if f == c:
        return values_sorted[int(k)]
    d0 = values_sorted[f] * (c - k)
    d1 = values_sorted[c] * (k - f)
    return d0 + d1


def compute_char_metrics(words: List[Dict], page_num: int) -> Tuple[float, float]:
    widths: List[float] = []
    for w in words:
        text = w.get("text") or ""
        if not text:
            continue
        width = (w["x1"] - w["x0"]) / max(len(text), 1)
        if width > 0:
            widths.append(width)
    if not widths:
        raise RuntimeError(
            format_error(
                "CHAR_WIDTH_MISSING",
                page_num,
                "Cannot derive median char width (no widths).",
            )
        )
    median_width = median(widths)
    return median_width, median_width * WORD_GAP_MULTIPLIER


def join_words_with_spacing(
    words: List[Dict], gap_threshold: float, median_char_width: float
) -> str:
    parts: List[str] = []
    prev_x1: Optional[float] = None
    for w in words:
        if prev_x1 is not None:
            gap = w["x0"] - prev_x1
            if gap > gap_threshold:
                # Preserve spacing deterministically using geometry-derived width.
                count = max(1, int(round(gap / median_char_width)))
                parts.append(" " * count)
        parts.append(w["text"])
        prev_x1 = w["x1"]
    return "".join(parts)


def words_to_lines(
    words: List[Dict],
    y_tolerance: float = LINE_Y_TOLERANCE,
    gap_threshold: float = WORD_GAP_MIN,
    median_char_width: float = 1.0,
) -> List[Dict]:
    words_sorted = sorted(words, key=lambda w: (w["top"], w["x0"]))
    lines: List[Dict] = []
    for w in words_sorted:
        if not lines or abs(w["top"] - lines[-1]["top"]) > y_tolerance:
            lines.append(
                {
                    "top": w["top"],
                    "bottom": w["bottom"],
                    "x0": w["x0"],
                    "x1": w["x1"],
                    "words": [w],
                }
            )
        else:
            lines[-1]["words"].append(w)
            lines[-1]["x0"] = min(lines[-1]["x0"], w["x0"])
            lines[-1]["x1"] = max(lines[-1]["x1"], w["x1"])
            lines[-1]["bottom"] = max(lines[-1]["bottom"], w["bottom"])
    for line in lines:
        line["words"].sort(key=lambda w: w["x0"])
        line["text"] = join_words_with_spacing(
            line["words"], gap_threshold, median_char_width
        )
        sizes = [w["size"] for w in line["words"] if isinstance(w.get("size"), (int, float))]
        line["size_median"] = median(sizes) if sizes else None
        line["bold"] = any("bold" in (w.get("fontname") or "").lower() for w in line["words"])
    return [l for l in lines if l["text"]]


def is_centered_line(line: Dict, page_width: float) -> bool:
    band_half = (page_width * CENTER_BAND_RATIO) / 2.0
    center = page_width / 2.0
    left = center - band_half
    right = center + band_half
    return line["x0"] >= left and line["x1"] <= right


def has_dot_leaders(text: str) -> bool:
    return re.search(r"(?:\.\s*){3,}", text) is not None


def has_prose_punctuation(text: str) -> bool:
    if has_dot_leaders(text):
        return False
    return re.search(r"[.!?;:]", text) is not None


def ends_with_page_reference(text: str) -> bool:
    return (
        re.search(r"\b[A-Z]{1,3}-\d+\b\s*$", text) is not None
        or re.search(r"\b\d+\b\s*$", text) is not None
    )


def is_toc_reference_line(text: str) -> bool:
    if not has_dot_leaders(text):
        return False
    return ends_with_page_reference(text)


def is_toc_reference_continuation(
    line_text: str, next_line_text: Optional[str]
) -> bool:
    if not next_line_text:
        return False
    if not has_dot_leaders(next_line_text) or not ends_with_page_reference(next_line_text):
        return False
    return (
        re.match(r"^\s*(?:SECTION\s+)?[A-Z]{1,3}\d{3,4}(?:\.\d+)*\b", line_text, re.IGNORECASE)
        is not None
        or re.match(r"^\s*APPENDIX\s+[A-Z]{1,3}\b", line_text, re.IGNORECASE) is not None
    )


def is_table_of_contents_header(text: str) -> bool:
    collapsed = re.sub(r"\s+", "", text).upper()
    return "TABLEOFCONTENTS" in collapsed


def is_appendix_reference_line(text: str) -> bool:
    return re.search(r"^\s*APPENDIX\s+[A-Z]{1,3}\b", text, re.IGNORECASE) is not None


def is_appendix_toc_line(text: str) -> bool:
    if not is_appendix_reference_line(text):
        return False
    stripped = text.strip()
    if has_dot_leaders(stripped) or ends_with_page_reference(stripped):
        return True
    if stripped == stripped.upper() and not has_prose_punctuation(stripped):
        return True
    return False


def is_reference_header_line(text: str) -> bool:
    return (
        re.search(
            r"^\s*(SECTION|APPENDIX|TABLE|FIGURE|CHAPTER|PART)\s+\1\s*$",
            text,
            re.IGNORECASE,
        )
        is not None
    )


def is_spanning_note_line(line: Dict, body_median_size: Optional[float], page_width: float) -> bool:
    if body_median_size is None:
        return False
    size = line.get("size_median")
    if size is None:
        return False
    if (line["x1"] - line["x0"]) < (page_width * 0.7):
        return False
    return size <= (body_median_size - HEADER_SIZE_DELTA)


def is_spanning_heading_line(line: Dict, page_width: float) -> bool:
    text = line["text"]
    if re.search(r"[a-z]", text):
        return False
    letters = re.findall(r"[A-Z]", text.upper())
    if len(letters) < 4:
        return False
    center = (line["x0"] + line["x1"]) / 2.0
    return abs(center - (page_width / 2.0)) <= (page_width * (CENTER_BAND_RATIO / 2.0))


def is_index_letter_line(line: Dict, page_width: float) -> bool:
    text = line["text"].strip()
    if len(text) != 1:
        return False
    if not text.isalpha():
        return False
    center = (line["x0"] + line["x1"]) / 2.0
    return abs(center - (page_width / 2.0)) <= (page_width * (CENTER_BAND_RATIO / 2.0))


def is_index_digit_line(line: Dict, page_width: float) -> bool:
    text = line["text"].strip()
    if len(text) != 1 or not text.isdigit():
        return False
    center = (line["x0"] + line["x1"]) / 2.0
    return abs(center - (page_width / 2.0)) <= (page_width * (CENTER_BAND_RATIO / 2.0))


def is_spanning_symbol_line(line: Dict, page_width: float) -> bool:
    text = line["text"].strip()
    if re.match(r"^\(cid:\d+\)$", text):
        center = (line["x0"] + line["x1"]) / 2.0
        return abs(center - (page_width / 2.0)) <= (page_width * (CENTER_BAND_RATIO / 2.0))
    if len(text) != 1:
        return False
    if text.isalnum() or text.isspace():
        return False
    center = (line["x0"] + line["x1"]) / 2.0
    return abs(center - (page_width / 2.0)) <= (page_width * (CENTER_BAND_RATIO / 2.0))


def is_center_spanning_token(
    word: Dict,
    split_x: float,
    gutter_left: float,
    gutter_right: float,
    page_width: float,
    page_median_word_height: float,
    table_bboxes: List[Tuple[float, float, float, float]],
    eps: float = 2.0,
) -> bool:
    text = (word.get("text") or "").strip()
    if not re.match(r"^[A-Z]$", text):
        return False
    x0 = word["x0"]
    x1 = word["x1"]
    if not (x0 < split_x < x1):
        return False
    if not (x0 >= (gutter_left - eps) and x1 <= (gutter_right + eps)):
        return False
    word_height = word.get("bottom", word.get("top", 0.0)) - word.get("top", 0.0)
    if word_height < (0.9 * page_median_word_height):
        return False
    if inside_any_table(word, table_bboxes):
        return False
    return True


def is_gutter_fragment_line(line: Dict, median_char_width: float) -> bool:
    text = line["text"].strip()
    if len(text) > 3:
        return False
    if not re.match(r"^-?[A-Za-z]{1,2}$", text):
        return False
    width = line["x1"] - line["x0"]
    return width <= (median_char_width * 3.0)


def is_gutter_punct_fragment_line(line: Dict, median_char_width: float) -> bool:
    text = line["text"].strip()
    if len(text) > 2:
        return False
    if re.search(r"[A-Za-z0-9]", text):
        return False
    width = line["x1"] - line["x0"]
    return width <= (median_char_width * 3.0)


def is_gutter_numeric_fragment_line(line: Dict, median_char_width: float) -> bool:
    text = line["text"].strip()
    if len(text) > 3:
        return False
    if not re.search(r"\d", text):
        return False
    if re.search(r"[A-Za-z]", text):
        return False
    if not re.match(r"^[0-9().]+$", text):
        return False
    width = line["x1"] - line["x0"]
    return width <= (median_char_width * 3.0)


def is_gutter_tiny_line(
    line: Dict, median_char_width: float, gutter_left: float, gutter_right: float
) -> bool:
    text = line["text"].strip()
    if len(text) > 3:
        return False
    if not text:
        return False
    width = line["x1"] - line["x0"]
    if width > (median_char_width * 3.0):
        return False
    return line["x0"] >= gutter_left and line["x1"] <= gutter_right


def line_intersects_table(
    line: Dict, table_bboxes: List[Tuple[float, float, float, float]]
) -> bool:
    x0 = line["x0"]
    x1 = line["x1"]
    y0 = line["top"]
    y1 = line.get("bottom", line["top"])
    for bx0, by0, bx1, by1 in table_bboxes:
        if x1 < bx0 or x0 > bx1 or y1 < by0 or y0 > by1:
            continue
        return True
    return False


def select_top_spanning_lines(
    lines: List[Dict], page_width: float, page_num: int
) -> Tuple[List[Dict], Optional[float]]:
    if not lines:
        raise RuntimeError(
            format_error(
                "LINE_DATA_MISSING",
                page_num,
                "No body lines available to identify spanning headings.",
            )
        )
    lines_sorted = sorted(lines, key=lambda l: (l["top"], l["x0"]))
    top_lines: List[Dict] = []
    last_top: Optional[float] = None
    first_non_center_top: Optional[float] = None
    for line in lines_sorted:
        centered = is_centered_line(line, page_width)
        if not top_lines:
            if centered:
                top_lines.append(line)
                last_top = line["top"]
                continue
            first_non_center_top = line["top"]
            break
        if centered:
            if last_top is not None and (line["top"] - last_top) <= MAX_HEADER_LINE_GAP:
                top_lines.append(line)
                last_top = line["top"]
                continue
            first_non_center_top = line["top"]
            break
        first_non_center_top = line["top"]
        break
    if first_non_center_top is None:
        return [], None
    return top_lines, first_non_center_top


def detect_column_split(
    words: List[Dict],
    page_width: float,
    page_num: int,
    median_char_width: float,
    table_bboxes: List[Tuple[float, float, float, float]],
    split_debug: Optional[List[Dict]] = None,
) -> Tuple[float, float, float]:
    if not words:
        raise RuntimeError(
            format_error(
                "COLUMN_SPLIT_MISSING",
                page_num,
                "No body words available to detect column split.",
            )
        )
    center_x = page_width / 2.0
    filtered_words = [
        w
        for w in words
        if not (
            w["x0"] < (center_x + GUTTER_TOLERANCE)
            and w["x1"] > (center_x - GUTTER_TOLERANCE)
        )
    ]
    words_for_gap = filtered_words if len(filtered_words) >= 2 else words
    words_sorted = sorted(words_for_gap, key=lambda w: w["x0"])
    max_x1 = words_sorted[0]["x1"]
    best_gap = 0.0
    best_left = None
    best_right = None
    gaps: List[Tuple[float, float, float]] = []
    for w in words_sorted[1:]:
        gap = w["x0"] - max_x1
        gaps.append((gap, max_x1, w["x0"]))
        if gap > best_gap:
            best_gap = gap
            best_left = max_x1
            best_right = w["x0"]
        max_x1 = max(max_x1, w["x1"])
    center_x = page_width / 2.0
    left_cluster = [w for w in words if w["x0"] < center_x]
    right_cluster = [w for w in words if w["x0"] > center_x]
    single_side: Optional[str] = None
    if left_cluster and not right_cluster:
        best_left = max(w["x1"] for w in left_cluster)
        best_right = center_x
        best_gap = best_right - best_left
        single_side = "left"
    elif right_cluster and not left_cluster:
        best_left = center_x
        best_right = min(w["x0"] for w in right_cluster)
        best_gap = best_right - best_left
        single_side = "right"
    if best_left is None or best_right is None or best_gap <= 0.0:
        if left_cluster and right_cluster:
            best_left = max(w["x1"] for w in left_cluster)
            best_right = min(w["x0"] for w in right_cluster)
            best_gap = best_right - best_left
        elif left_cluster and not right_cluster:
            best_left = max(w["x1"] for w in left_cluster)
            best_right = center_x
            best_gap = best_right - best_left
            single_side = "left"
        elif right_cluster and not left_cluster:
            best_left = center_x
            best_right = min(w["x0"] for w in right_cluster)
            best_gap = best_right - best_left
            single_side = "right"
        if best_left is None or best_right is None or best_gap <= 0.0:
            raise RuntimeError(
                format_error(
                    "COLUMN_SPLIT_MISSING",
                    page_num,
                    "No candidate gutter gap found.",
                )
            )
    competing = [
        (gap, left, right)
        for gap, left, right in gaps
        if gap == best_gap and not (left == best_left and right == best_right)
    ]
    if competing and single_side is None:
        raise RuntimeError(
            format_error(
                "COLUMN_SPLIT_COMPETING",
                page_num,
                "Multiple competing gutter gaps of equal width.",
            )
        )
    split_x = (best_left + best_right) / 2.0
    relax_cross_check = False
    if single_side is None and abs(split_x - (page_width / 2.0)) > (
        page_width * SPLIT_CENTER_TOLERANCE_RATIO
    ):
        center_x = page_width / 2.0
        left_cluster = [w for w in words if w["x0"] < center_x]
        right_cluster = [w for w in words if w["x0"] > center_x]
        if left_cluster and right_cluster:
            alt_left = max(w["x1"] for w in left_cluster)
            alt_right = min(w["x0"] for w in right_cluster)
            if alt_left < alt_right:
                split_x = (alt_left + alt_right) / 2.0
                best_left = alt_left
                best_right = alt_right
            else:
                split_x = center_x
                left_words = [w for w in words if w["x1"] <= split_x]
                right_words = [w for w in words if w["x0"] >= split_x]
                if left_words and right_words:
                    left_max_x1 = max(w["x1"] for w in left_words)
                    right_min_x0 = min(w["x0"] for w in right_words)
                    if left_max_x1 < right_min_x0:
                        best_left = left_max_x1
                        best_right = right_min_x0
                    else:
                        best_left = center_x - GUTTER_TOLERANCE
                        best_right = center_x + GUTTER_TOLERANCE
                        relax_cross_check = True
                else:
                    best_left = center_x - GUTTER_TOLERANCE
                    best_right = center_x + GUTTER_TOLERANCE
                    relax_cross_check = True
        if abs(split_x - center_x) > (page_width * SPLIT_CENTER_TOLERANCE_RATIO):
            raise RuntimeError(
                format_error(
                    "COLUMN_SPLIT_OFFCENTER",
                    page_num,
                    f"Split {split_x:.2f} too far from center.",
                )
            )
    left_words = [w for w in words if w["x1"] < split_x]
    right_words = [w for w in words if w["x0"] > split_x]
    if not left_words or not right_words:
        if not left_words and not right_words:
            raise RuntimeError(
                format_error(
                    "COLUMN_SPLIT_CLUSTER_MISSING",
                    page_num,
                    "Column split does not yield two word clusters.",
                )
            )
        if not right_words:
            left_max = max(w["x1"] for w in words)
            if left_max > (split_x + GUTTER_TOLERANCE):
                raise RuntimeError(
                    format_error(
                        "COLUMN_SPLIT_CLUSTER_MISSING",
                        page_num,
                        "Column split does not yield two word clusters.",
                    )
                )
        if not left_words:
            right_min = min(w["x0"] for w in words)
            if right_min < (split_x - GUTTER_TOLERANCE):
                raise RuntimeError(
                    format_error(
                        "COLUMN_SPLIT_CLUSTER_MISSING",
                        page_num,
                        "Column split does not yield two word clusters.",
                    )
                )
    if left_words and right_words:
        left_max_x1 = max(w["x1"] for w in left_words)
        right_min_x0 = min(w["x0"] for w in right_words)
        if not (left_max_x1 < split_x and right_min_x0 > split_x):
            raise RuntimeError(
                format_error(
                    "COLUMN_SPLIT_OVERLAP",
                    page_num,
                    "Column split overlaps body text clusters.",
                    stats={"left_max_x1": left_max_x1, "right_min_x0": right_min_x0},
                )
            )
    heights = [
        w.get("bottom", w.get("top", 0.0)) - w.get("top", 0.0)
        for w in words
        if w.get("bottom") is not None and w.get("top") is not None
    ]
    page_median_word_height = median(heights) if heights else 0.0
    if page_median_word_height > 0.0:
        center_token_candidates = []
        for w in words:
            text = (w.get("text") or "").strip()
            if not re.match(r"^[A-Z]$", text):
                continue
            if not (w["x0"] < split_x < w["x1"]):
                continue
            word_height = w.get("bottom", w.get("top", 0.0)) - w.get("top", 0.0)
            if word_height < (0.9 * page_median_word_height):
                continue
            if inside_any_table(w, table_bboxes):
                continue
            center_token_candidates.append(w)
        if center_token_candidates:
            min_x0 = min(w["x0"] for w in center_token_candidates)
            max_x1 = max(w["x1"] for w in center_token_candidates)
            if best_left is None or min_x0 < best_left:
                best_left = min_x0
            if best_right is None or max_x1 > best_right:
                best_right = max_x1
    for w in words:
        if w["x0"] < split_x < w["x1"]:
            center = (w["x0"] + w["x1"]) / 2.0
            width = w["x1"] - w["x0"]
            text = (w.get("text") or "").strip()
            if width <= (median_char_width * 4.0):
                continue
            if len(text) <= 2 and width <= (median_char_width * 12.0):
                continue
            if is_center_spanning_token(
                w,
                split_x,
                best_left,
                best_right,
                page_width,
                page_median_word_height,
                table_bboxes,
            ):
                if split_debug is not None:
                    split_debug.append(
                        {
                            "rule": "CENTER_SPANNING_TOKEN_IGNORED_FOR_SPLIT_CROSS",
                            "page": page_num,
                            "text": text,
                            "bbox": [w["x0"], w["top"], w["x1"], w["bottom"]],
                            "split_x": split_x,
                            "gutter": [best_left, best_right],
                        }
                    )
                continue
            allowed_center_delta = GUTTER_TOLERANCE * (2.0 if relax_cross_check else 1.0)
            if not (abs(center - split_x) <= allowed_center_delta):
                raise RuntimeError(
                    format_error(
                        "COLUMN_SPLIT_CROSS",
                        page_num,
                        "Body word crosses split position.",
                        stats={"word": w.get("text"), "bbox": [w["x0"], w["top"], w["x1"], w["bottom"]]},
                    )
                )
    return split_x, best_left, best_right


# CANONICAL: two-column line reconstruction (char geometry).
def build_ordered_lines(
    chars: List[Dict],
    words: List[Dict],
    page_width: float,
    page_height: float,
    page_num: int,
    body_median_size: float,
    table_bboxes: List[Tuple[float, float, float, float]],
    split_debug: Optional[List[Dict]] = None,
) -> Tuple[List[Dict], Dict[str, float]]:
    if not chars:
        return [], {}

    header_limit = page_height * HEADER_REGION_RATIO
    footer_limit = page_height * (1.0 - FOOTER_REGION_RATIO)

    body_chars = [c for c in chars if header_limit < c["top"] < footer_limit]
    if not body_chars:
        raise RuntimeError(
            format_error(
                "BODY_CHAR_MISSING",
                page_num,
                "No body characters available for line reconstruction.",
            )
        )
    page_median_width, page_gap_threshold = compute_char_metrics(body_chars, page_num)
    lines = words_to_lines(body_chars, LINE_Y_TOLERANCE, page_gap_threshold, page_median_width)

    top_lines, first_non_center_top = select_top_spanning_lines(
        lines, page_width, page_num
    )
    top_line_tops = {line["top"] for line in top_lines}
    centered_structural_lines = [
        line
        for line in lines
        if is_centered_line(line, page_width)
        and not SECTION_HEADER_RE.match(line["text"].strip())
        and not TABLE_LABEL_RE.match(line["text"].strip())
    ]
    centered_structural_tops = {line["top"] for line in centered_structural_lines}
    spanning_note_lines = [
        line
        for line in lines
        if is_spanning_note_line(line, body_median_size, page_width)
        and not SECTION_HEADER_RE.match(line["text"].strip())
        and not TABLE_LABEL_RE.match(line["text"].strip())
    ]
    spanning_note_tops = {line["top"] for line in spanning_note_lines}
    spanning_heading_lines = [
        line
        for line in lines
        if is_spanning_heading_line(line, page_width)
        and not SECTION_HEADER_RE.match(line["text"].strip())
        and not TABLE_LABEL_RE.match(line["text"].strip())
    ]
    spanning_heading_tops = {line["top"] for line in spanning_heading_lines}

    body_words = [w for w in words if header_limit < w["top"] < footer_limit]
    words_for_split = [
        w
        for w in body_words
        if not any(abs(w["top"] - t) <= LINE_Y_TOLERANCE for t in top_line_tops)
        and not any(abs(w["top"] - t) <= LINE_Y_TOLERANCE for t in centered_structural_tops)
        and not any(abs(w["top"] - t) <= LINE_Y_TOLERANCE for t in spanning_note_tops)
        and not any(abs(w["top"] - t) <= LINE_Y_TOLERANCE for t in spanning_heading_tops)
    ]
    split_word_heights = [
        w.get("bottom", w.get("top", 0.0)) - w.get("top", 0.0)
        for w in words_for_split
        if w.get("bottom") is not None and w.get("top") is not None
    ]
    page_median_word_height = median(split_word_heights) if split_word_heights else 0.0
    if not words_for_split:
        spanning_lines: List[Dict] = []
        for line in lines:
            if line in top_lines:
                line["column"] = "spanning"
                line["role"] = "spanning_header"
                spanning_lines.append(line)
                continue
            if line in centered_structural_lines:
                line["column"] = "center_structural"
                line["role"] = "center_structural"
                continue
            if line in spanning_note_lines and not line_intersects_table(line, table_bboxes):
                line["column"] = "spanning"
                line["role"] = "spanning_reference"
                spanning_lines.append(line)
                continue
            if line in spanning_heading_lines and not line_intersects_table(line, table_bboxes):
                line["column"] = "spanning"
                line["role"] = "spanning_reference"
                spanning_lines.append(line)
                continue
        ordered_lines = sorted(spanning_lines, key=lambda l: (l["top"], l["x0"]))
        bounds_source = body_words or body_chars
        x0_values = [w["x0"] for w in bounds_source if w.get("x0") is not None]
        x1_values = [w["x1"] for w in bounds_source if w.get("x1") is not None]
        if not x0_values or not x1_values:
            raise RuntimeError(
                format_error(
                    "COLUMN_SPLIT_MISSING",
                    page_num,
                    "No body words available for split detection after removing headings.",
                )
            )
        split_x = (min(x0_values) + max(x1_values)) / 2.0
        left_x0 = percentile(x0_values, 5.0, page_num, "left_x0")
        column_bounds = {
            "split_x": split_x,
            "gutter_left": split_x,
            "gutter_right": split_x,
            "left_x0_min": min(x0_values),
            "right_x0_min": min(x0_values),
            "left_x0_p5": left_x0,
            "right_x0_p5": left_x0,
            "left_x0": left_x0,
            "margin_percentile": 5.0,
            "spacing_thresholds": {
                "page_median_char_width": page_median_width,
                "page_gap_threshold": page_gap_threshold,
                "word_gap_multiplier": WORD_GAP_MULTIPLIER,
            },
        }
        return ordered_lines, column_bounds
    split_x, gutter_left, gutter_right = detect_column_split(
        words_for_split,
        page_width,
        page_num,
        page_median_width,
        table_bboxes,
        split_debug,
    )
    left_lines: List[Dict] = []
    right_lines: List[Dict] = []
    spanning_lines: List[Dict] = []
    for line in lines:
        if line in top_lines:
            line["column"] = "spanning"
            line["role"] = "spanning_header"
            spanning_lines.append(line)
            continue
        if line in centered_structural_lines:
            line["column"] = "center_structural"
            line["role"] = "center_structural"
            continue
        if line in spanning_note_lines and not line_intersects_table(line, table_bboxes):
            line["column"] = "spanning"
            line["role"] = "spanning_reference"
            spanning_lines.append(line)
            continue
        if line in spanning_heading_lines and not line_intersects_table(line, table_bboxes):
            line["column"] = "spanning"
            line["role"] = "spanning_reference"
            spanning_lines.append(line)
            continue

    excluded_line_tops = {
        line["top"] for line in spanning_lines
    } | {line["top"] for line in centered_structural_lines}
    body_words_filtered = [
        w
        for w in body_words
        if not any(abs(w["top"] - t) <= LINE_Y_TOLERANCE for t in excluded_line_tops)
    ]
    left_words: List[Dict] = []
    right_words: List[Dict] = []
    gutter_words: List[Dict] = []
    for w in body_words_filtered:
        if w["x0"] < split_x < w["x1"]:
            if is_center_spanning_token(
                w,
                split_x,
                gutter_left,
                gutter_right,
                page_width,
                page_median_word_height,
                table_bboxes,
            ):
                gutter_words.append(w)
                continue
        center = (w["x0"] + w["x1"]) / 2.0
        if center < (split_x - (GUTTER_TOLERANCE / 2.0)):
            left_words.append(w)
            continue
        if center > (split_x + (GUTTER_TOLERANCE / 2.0)):
            right_words.append(w)
            continue
        gutter_words.append(w)

    if gutter_words:
        gutter_lines = words_to_lines(
            gutter_words, LINE_Y_TOLERANCE, page_gap_threshold, page_median_width
        )
        for line in gutter_lines:
            dot_leaders = has_dot_leaders(line["text"])
            toc_like = is_toc_reference_line(line["text"])
            appendix_like = is_appendix_reference_line(line["text"])
            reference_header_like = is_reference_header_line(line["text"])
            note_like = is_spanning_note_line(line, body_median_size, page_width)
            index_letter_like = is_index_letter_line(line, page_width)
            index_digit_like = is_index_digit_line(line, page_width)
            symbol_like = is_spanning_symbol_line(line, page_width)
            fragment_like = is_gutter_fragment_line(line, page_median_width)
            punct_fragment_like = is_gutter_punct_fragment_line(line, page_median_width)
            numeric_fragment_like = is_gutter_numeric_fragment_line(
                line, page_median_width
            )
            tiny_like = is_gutter_tiny_line(line, page_median_width, gutter_left, gutter_right)
            section_header_match = SECTION_HEADER_RE.match(line["text"].strip()) is not None
            prose_like = has_prose_punctuation(line["text"])
            if note_like:
                prose_like = False
            if symbol_like:
                prose_like = False
            if punct_fragment_like:
                prose_like = False
            if numeric_fragment_like:
                prose_like = False
            if tiny_like:
                prose_like = False
            intersects_table = line_intersects_table(line, table_bboxes)
            if re.match(r"^[A-Z]$", line["text"].strip()) and not intersects_table:
                line["column"] = "spanning"
                line["role"] = "spanning_reference"
                spanning_lines.append(line)
                continue
            if (
                not prose_like
                and (
                    dot_leaders
                    or toc_like
                    or appendix_like
                    or reference_header_like
                    or note_like
                    or index_letter_like
                    or index_digit_like
                    or symbol_like
                    or fragment_like
                    or punct_fragment_like
                    or numeric_fragment_like
                    or tiny_like
                )
                and not intersects_table
                and not section_header_match
            ):
                line["column"] = "spanning"
                line["role"] = "spanning_reference"
                spanning_lines.append(line)
                continue
            raise RuntimeError(
                format_error(
                    "GUTTER_LINE_AMBIGUOUS",
                    page_num,
                    "Line intersects gutter region.",
                    stats={
                        "text": line["text"],
                        "bbox": [line["x0"], line["top"], line["x1"], line.get("bottom", line["top"])],
                        "dot_leaders": dot_leaders,
                        "toc_like": toc_like,
                        "appendix_like": appendix_like,
                        "reference_header_like": reference_header_like,
                        "note_like": note_like,
                        "index_letter_like": index_letter_like,
                        "index_digit_like": index_digit_like,
                        "symbol_like": symbol_like,
                        "fragment_like": fragment_like,
                        "punct_fragment_like": punct_fragment_like,
                        "numeric_fragment_like": numeric_fragment_like,
                        "tiny_like": tiny_like,
                        "section_header_match": section_header_match,
                        "prose_like": prose_like,
                        "intersects_table": intersects_table,
                    },
                )
            )

    if not left_words and not right_words:
        raise RuntimeError(
            format_error(
                "COLUMN_BODY_MISSING",
                page_num,
                "Missing left and right column body words.",
            )
        )

    left_lines = words_to_lines(left_words, LINE_Y_TOLERANCE, page_gap_threshold, page_median_width)
    right_lines = words_to_lines(right_words, LINE_Y_TOLERANCE, page_gap_threshold, page_median_width)
    for line in left_lines:
        line["column"] = "left"
    for line in right_lines:
        line["column"] = "right"

    ordered_lines = (
        sorted(spanning_lines, key=lambda l: (l["top"], l["x0"]))
        + sorted(left_lines, key=lambda l: (l["top"], l["x0"]))
        + sorted(right_lines, key=lambda l: (l["top"], l["x0"]))
    )

    column_bounds = {
        "split_x": split_x,
        "gutter_left": gutter_left,
        "gutter_right": gutter_right,
        "left_x0_min": min((w["x0"] for w in left_words), default=0.0),
        "right_x0_min": min((w["x0"] for w in right_words), default=0.0),
        "left_x0_p5": percentile([w["x0"] for w in left_words], 5.0, page_num, "left_x0_p5")
        if left_words
        else 0.0,
        "right_x0_p5": percentile(
            [w["x0"] for w in right_words], 5.0, page_num, "right_x0_p5"
        )
        if right_words
        else 0.0,
        "left_x0": percentile([w["x0"] for w in left_words], 5.0, page_num, "left_x0")
        if left_words
        else 0.0,
        "margin_percentile": 5.0,
        "spacing_thresholds": {
            "page_median_char_width": page_median_width,
            "page_gap_threshold": page_gap_threshold,
            "word_gap_multiplier": WORD_GAP_MULTIPLIER,
        },
    }

    return ordered_lines, column_bounds


def get_following_lines(lines: List[Dict], idx: int) -> Tuple[Optional[Dict], Optional[Dict]]:
    next_line = lines[idx + 1] if idx + 1 < len(lines) else None
    next_next_line = lines[idx + 2] if idx + 2 < len(lines) else None
    return next_line, next_next_line


def is_header_position(line: Dict, column_bounds: Dict[str, float]) -> bool:
    return abs(line["x0"] - column_bounds["left_x0"]) <= COLUMN_MARGIN_TOLERANCE


def header_position_tolerance(column_bounds: Dict[str, float]) -> float:
    tolerance = COLUMN_MARGIN_TOLERANCE
    spacing = column_bounds.get("spacing_thresholds", {})
    char_width = spacing.get("page_median_char_width")
    if isinstance(char_width, (int, float)):
        tolerance = max(tolerance, char_width * 3.0)
    return tolerance


def is_header_position_any(line: Dict, column_bounds: Dict[str, float]) -> bool:
    tolerance = header_position_tolerance(column_bounds)
    if line.get("column") == "right":
        right_x0 = column_bounds.get("right_x0_p5") or column_bounds.get("right_x0_min")
        if right_x0 is None:
            return False
        return abs(line["x0"] - right_x0) <= tolerance
    return abs(line["x0"] - column_bounds["left_x0"]) <= tolerance


def is_header_style(line: Dict, body_median_size: float) -> bool:
    line_size = line.get("size_median")
    if line_size is None:
        return False
    if line.get("bold"):
        return True
    return line_size >= body_median_size + HEADER_SIZE_DELTA


def is_body_indented(line: Dict, column_bounds: Dict[str, float]) -> bool:
    return line["x0"] >= column_bounds["left_x0"] + HEADER_BODY_INDENT_MIN


def passes_header_position_style(
    line: Dict, column_bounds: Dict[str, float], body_median_size: float
) -> bool:
    return is_header_position_any(line, column_bounds) and is_header_style(
        line, body_median_size
    )


# CANONICAL: section boundary detection (regex + header position/style checks).
def detect_section_start(
    line: Dict,
    next_line: Optional[Dict],
    next_next_line: Optional[Dict],
    column_bounds: Dict[str, float],
    page_num: int,
    body_median_size: float,
    debug: Optional[List[Dict]] = None,
) -> Optional[str]:
    if is_toc_reference_line(line["text"]) or is_appendix_toc_line(line["text"]):
        if debug is not None:
            debug.append(
                {
                    "text": line["text"],
                    "decision": "reject",
                    "reason": "toc_reference_line",
                    "page": page_num,
                }
            )
        return None
    if next_line and is_toc_reference_continuation(line["text"], next_line["text"]):
        if debug is not None:
            debug.append(
                {
                    "text": line["text"],
                    "decision": "reject",
                    "reason": "toc_reference_continuation",
                    "page": page_num,
                }
            )
        return None
    match = SECTION_TEXT_RE.match(line["text"])
    if not match:
        section_only_match = re.match(
            r"^\s*SECTION\s+([A-Z]{1,3}\d{3,4}(?:\.\d+)*)\b\s*$",
            line["text"],
            re.IGNORECASE,
        )
        if section_only_match:
            if next_line:
                title_line = next_line["text"]
                if (
                    title_starts_with_upper_or_digit(title_line)
                    and title_has_non_id_text(title_line)
                    and not has_dot_leaders(title_line)
                    and not has_prose_punctuation(title_line)
                ):
                    section_id = section_only_match.group(1)
                    if not passes_header_position_style(
                        line, column_bounds, body_median_size
                    ):
                        if debug is not None:
                            debug.append(
                                {
                                    "text": line["text"],
                                    "decision": "reject",
                                    "reason": "header_position_style",
                                    "page": page_num,
                                }
                            )
                        return None
                    if debug is not None:
                        debug.append(
                            {
                                "text": line["text"],
                                "decision": "accept",
                                "section_id": section_id,
                                "page": page_num,
                            }
                        )
                    return section_id
            else:
                section_id = section_only_match.group(1)
                if not passes_header_position_style(line, column_bounds, body_median_size):
                    if debug is not None:
                        debug.append(
                            {
                                "text": line["text"],
                                "decision": "reject",
                                "reason": "header_position_style",
                                "page": page_num,
                            }
                        )
                    return None
                if debug is not None:
                    debug.append(
                        {
                            "text": line["text"],
                            "decision": "accept",
                            "section_id": section_id,
                            "page": page_num,
                        }
                    )
                return section_id
        bare_id_match = re.match(
            r"^\s*([A-Z]{1,3}\d{3,4}(?:\.\d+)*)\b\s*$",
            line["text"],
            re.IGNORECASE,
        )
        if bare_id_match and next_line and not is_body_indented(line, column_bounds):
            title_line = next_line["text"]
            if (
                not is_body_indented(next_line, column_bounds)
                and title_has_space_or_lowercase(title_line)
                and title_starts_with_upper_or_digit(title_line)
                and title_has_non_id_text(title_line)
                and not title_all_caps_no_space(title_line)
                and not has_dot_leaders(title_line)
                and not has_prose_punctuation(title_line)
            ):
                section_id = bare_id_match.group(1)
                if not passes_header_position_style(line, column_bounds, body_median_size):
                    if debug is not None:
                        debug.append(
                            {
                                "text": line["text"],
                                "decision": "reject",
                                "reason": "header_position_style",
                                "page": page_num,
                            }
                        )
                    return None
                if debug is not None:
                    debug.append(
                        {
                            "text": line["text"],
                            "decision": "accept",
                            "section_id": section_id,
                            "page": page_num,
                        }
                    )
                return section_id
        appendix_match = re.match(
            r"^\s*APPENDIX\s+([A-Z]+)\b(?:\s+(.+))?$",
            line["text"],
            re.IGNORECASE,
        )
        appendix_title = appendix_match.group(2) if appendix_match else None
        if (
            appendix_match
            and appendix_title
            and not has_dot_leaders(line["text"])
            and title_starts_with_upper_or_digit(appendix_title)
            and title_has_non_id_text(appendix_title)
        ):
            section_id = f"Appendix {appendix_match.group(1)}"
            if not passes_header_position_style(line, column_bounds, body_median_size):
                if debug is not None:
                    debug.append(
                        {
                            "text": line["text"],
                            "decision": "reject",
                            "reason": "header_position_style",
                            "page": page_num,
                        }
                    )
                return None
            if debug is not None:
                debug.append(
                    {
                        "text": line["text"],
                        "decision": "accept",
                        "section_id": section_id,
                        "page": page_num,
                    }
                )
            return section_id
        header_match = SECTION_HEADER_RE.match(line["text"].strip())
        if (
            header_match
            and header_match.group(2)
            and not re.match(r"^\s*SECTION\b", line["text"], re.IGNORECASE)
            and not has_dot_leaders(line["text"])
            and title_starts_with_upper_or_digit(header_match.group(2))
            and title_has_non_id_text(header_match.group(2))
            and not (
                title_all_caps_no_space(header_match.group(2))
                and len(header_match.group(2).strip()) > 4
            )
        ):
            section_id = header_match.group(1)
            if not passes_header_position_style(line, column_bounds, body_median_size):
                if debug is not None:
                    debug.append(
                        {
                            "text": line["text"],
                            "decision": "reject",
                            "reason": "header_position_style",
                            "page": page_num,
                        }
                    )
                return None
            if debug is not None:
                debug.append(
                    {
                        "text": line["text"],
                        "decision": "accept",
                        "section_id": section_id,
                        "page": page_num,
                    }
                )
            return section_id
        return None
    section_token = match.group(2)
    appendix_token = match.group(3)
    id_token = match.group(4)
    if section_token:
        section_id = section_token
    elif appendix_token:
        section_id = f"Appendix {appendix_token}"
    else:
        section_id = id_token
    if section_token:
        title_text = re.sub(
            rf"^\s*SECTION\s+{re.escape(section_id)}\s+",
            "",
            line["text"],
            flags=re.IGNORECASE,
        )
    elif appendix_token:
        title_text = re.sub(
            rf"^\s*APPENDIX\s+{re.escape(appendix_token)}\s+",
            "",
            line["text"],
            flags=re.IGNORECASE,
        )
    else:
        title_text = re.sub(
            rf"^\s*{re.escape(section_id)}\s+",
            "",
            line["text"],
            flags=re.IGNORECASE,
        )
    if not title_starts_with_upper_or_digit(title_text) or not title_has_non_id_text(
        title_text
    ):
        return None
    if (
        not section_id.lower().startswith("appendix")
        and title_all_caps_no_space(title_text)
        and len(title_text.strip()) > 4
    ):
        return None
    if not passes_header_position_style(line, column_bounds, body_median_size):
        if debug is not None:
            debug.append(
                {
                    "text": line["text"],
                    "decision": "reject",
                    "reason": "header_position_style",
                    "page": page_num,
                }
            )
        return None
    if debug is not None:
        debug.append(
            {
                "text": line["text"],
                "decision": "accept",
                "section_id": section_id,
                "page": page_num,
            }
        )
    return section_id


def section_id_depth(section_id: str) -> int:
    return len(re.findall(r"\d+", section_id))


def title_starts_with_upper_or_digit(title: Optional[str]) -> bool:
    if not title:
        return False
    stripped = title.strip()
    if not stripped:
        return False
    first_char = stripped[0]
    return first_char.isupper() or first_char.isdigit()


def title_has_non_id_text(title: Optional[str]) -> bool:
    if not title:
        return False
    stripped = title.strip()
    if not stripped:
        return False
    without_ids = re.sub(
        r"[A-Z]{1,3}\d{3,4}(?:\.\d+)*", "", stripped, flags=re.IGNORECASE
    )
    without_ids = re.sub(r"[^A-Za-z0-9]+", "", without_ids)
    return bool(without_ids)


def title_all_caps_no_space(title: Optional[str]) -> bool:
    if not title:
        return False
    stripped = title.strip()
    if not stripped:
        return False
    if " " in stripped:
        return False
    if not stripped.isalpha():
        return False
    return stripped.upper() == stripped


def title_has_space_or_lowercase(title: Optional[str]) -> bool:
    if not title:
        return False
    stripped = title.strip()
    if not stripped:
        return False
    if " " in stripped:
        return True
    return any(ch.islower() for ch in stripped)


def title_starts_with_upper(title: Optional[str]) -> bool:
    if not title:
        return False
    stripped = title.strip()
    if not stripped:
        return False
    return stripped[0].isupper()


def detect_section_start_text(
    line_text: str, next_line_text: Optional[str]
) -> Optional[str]:
    if is_toc_reference_line(line_text) or is_appendix_toc_line(line_text):
        return None
    if is_toc_reference_continuation(line_text, next_line_text):
        return None
    match = SECTION_TEXT_RE.match(line_text)
    if match:
        section_token = match.group(2)
        appendix_token = match.group(3)
        id_token = match.group(4)
        if section_token:
            section_id = section_token
        elif appendix_token:
            section_id = f"Appendix {appendix_token}"
        else:
            section_id = id_token
        if section_token:
            title_text = re.sub(
                rf"^\s*SECTION\s+{re.escape(section_id)}\s+",
                "",
                line_text,
                flags=re.IGNORECASE,
            )
        elif appendix_token:
            title_text = re.sub(
                rf"^\s*APPENDIX\s+{re.escape(appendix_token)}\s+",
                "",
                line_text,
                flags=re.IGNORECASE,
            )
        else:
            title_text = re.sub(
                rf"^\s*{re.escape(section_id)}\s+",
                "",
                line_text,
                flags=re.IGNORECASE,
            )
        if not title_starts_with_upper_or_digit(title_text) or not title_has_non_id_text(
            title_text
        ):
            return None
        if (
            not section_id.lower().startswith("appendix")
            and title_all_caps_no_space(title_text)
            and len(title_text.strip()) > 4
        ):
            return None
        return section_id
    section_only_match = re.match(
        r"^\s*SECTION\s+([A-Z]{1,3}\d{3,4}(?:\.\d+)*)\b\s*$",
        line_text,
        re.IGNORECASE,
    )
    if section_only_match:
        section_id = section_only_match.group(1)
        if next_line_text:
            title_line = next_line_text
            if (
                title_starts_with_upper_or_digit(title_line)
                and title_has_non_id_text(title_line)
                and not has_dot_leaders(title_line)
                and not has_prose_punctuation(title_line)
            ):
                return section_id
            return None
        return section_id
    bare_id_match = re.match(
        r"^\s*([A-Z]{1,3}\d{3,4}(?:\.\d+)*)\b\s*$",
        line_text,
        re.IGNORECASE,
    )
    if bare_id_match and next_line_text:
        title_line = next_line_text
        if (
            title_has_space_or_lowercase(title_line)
            and title_starts_with_upper(title_line)
            and title_has_non_id_text(title_line)
            and not title_all_caps_no_space(title_line)
            and not has_dot_leaders(title_line)
            and not has_prose_punctuation(title_line)
        ):
            return bare_id_match.group(1)
        return None
    appendix_match = re.match(
        r"^\s*APPENDIX\s+([A-Z]+)\b(?:\s+(.+))?$",
        line_text,
        re.IGNORECASE,
    )
    appendix_title = appendix_match.group(2) if appendix_match else None
    if (
        appendix_match
        and appendix_title
        and not has_dot_leaders(line_text)
        and title_starts_with_upper_or_digit(appendix_title)
        and title_has_non_id_text(appendix_title)
    ):
        return f"Appendix {appendix_match.group(1)}"
    header_match = SECTION_HEADER_RE.match(line_text.strip())
    if (
        header_match
        and header_match.group(2)
        and not re.match(r"^\s*SECTION\b", line_text, re.IGNORECASE)
        and not has_dot_leaders(line_text)
        and title_starts_with_upper_or_digit(header_match.group(2))
        and title_has_non_id_text(header_match.group(2))
        and not (
            title_all_caps_no_space(header_match.group(2))
            and len(header_match.group(2).strip()) > 4
        )
    ):
        return header_match.group(1)
    return None


def parse_true_section_heading(line_text: str) -> Optional[str]:
    match = re.match(
        r"^\s*([A-Z]{1,3}\d{3,4}(?:\.\d+){0,6})\b(.*)$",
        line_text,
        re.IGNORECASE,
    )
    if not match:
        return None
    end_idx = match.end(1)
    if end_idx < len(line_text) and line_text[end_idx] == "(":
        return None
    rest = match.group(2).lstrip()
    if not rest:
        return None
    if not rest[0].isalpha() or not rest[0].isupper():
        return None
    return match.group(1)


def parse_section_marker_line(line_text: str) -> Optional[str]:
    match = re.match(
        r"^\s*SECTION\s+([A-Z]{1,3}\d{3,4}(?:\.\d+){0,6})\b",
        line_text,
        re.IGNORECASE,
    )
    if not match:
        return None
    return match.group(1)


def is_strict_header_line_text(line_text: str) -> bool:
    if SECTION_TEXT_RE.match(line_text):
        return True
    header_match = SECTION_HEADER_RE.match(line_text.strip())
    if header_match and header_match.group(2):
        return True
    if re.match(r"^\s*SECTION\s+[A-Z]{1,3}\d{3,4}(?:\.\d+)*\b", line_text, re.IGNORECASE):
        return True
    if re.match(r"^\s*APPENDIX\s+[A-Z]+\b", line_text, re.IGNORECASE):
        return True
    return False


def enforce_section_integrity(section_ids: List[str], output_dir: Path) -> None:
    if not section_ids:
        return
    section_id_set = set(section_ids)
    for section_id in sorted(section_ids):
        path = output_dir / f"section_{section_id}.txt"
        if not path.exists():
            raise RuntimeError(
                f"SECTION_INTEGRITY_VIOLATION: missing file for {section_id}"
            )
        lines = path.read_text(encoding="utf-8").splitlines()
        body_start = 0
        for idx, line in enumerate(lines):
            if line.strip() == "":
                body_start = idx + 1
                break
        body_lines = lines[body_start:]
        for idx, line in enumerate(body_lines):
            if not line.strip():
                continue
            candidate = parse_true_section_heading(line)
            if candidate and candidate != section_id and candidate in section_id_set:
                raise RuntimeError(
                    f"SECTION_INTEGRITY_VIOLATION: {path.name} line {idx + body_start + 1} "
                    f"file_section={section_id} found={candidate}"
                )


def split_header_footer_words(
    words: List[Dict], page_height: float
) -> Tuple[List[Dict], List[Dict]]:
    header_limit = page_height * HEADER_REGION_RATIO
    footer_limit = page_height * (1.0 - FOOTER_REGION_RATIO)
    header_words = [w for w in words if w["top"] <= header_limit]
    footer_words = [w for w in words if w["bottom"] >= footer_limit]
    return header_words, footer_words


def words_to_snippet(words: List[Dict]) -> str:
    ordered = sorted(words, key=lambda w: (w["top"], w["x0"]))
    return " ".join(w["text"] for w in ordered)


# CANONICAL: amendment keyword scan in header/footer only.
def scan_for_amendment_indicators(
    page_num: int, header_text: str, footer_text: str
) -> None:
    combined = f"{header_text} {footer_text}"
    match = AMENDMENT_RE.search(combined)
    if match:
        raise RuntimeError(
            format_error(
                "AMENDMENT_SCAN",
                page_num,
                f"Keyword '{match.group(0)}' detected in header/footer.",
                stats={"snippet": combined},
            )
        )


def format_pdf_pages(pages: List[int]) -> str:
    if not pages:
        raise RuntimeError(
            format_error("PDF_PAGE_RANGE", None, "No PDF pages provided.")
        )
    if pages != list(range(pages[0], pages[-1] + 1)):
        raise RuntimeError(
            format_error(
                "PDF_PAGE_RANGE",
                pages[0] if pages else None,
                f"Non-contiguous PDF page range: {pages}",
            )
        )
    if len(pages) == 1:
        return f"{pages[0]}"
    return f"{pages[0]}\u2013{pages[-1]}"


def build_label_lines(
    words: List[Dict],
    page_num: int,
) -> List[Dict]:
    if not words:
        return []
    median_width, gap_threshold = compute_char_metrics(words, page_num)
    lines = words_to_lines(words, LINE_Y_TOLERANCE, gap_threshold, median_width)
    for line in lines:
        line["column"] = "single"
    return sorted(lines, key=lambda l: l["top"])


def inside_any_table(word: Dict, table_bboxes: List[Tuple[float, float, float, float]]) -> bool:
    x = (word["x0"] + word["x1"]) / 2.0
    y = (word["top"] + word["bottom"]) / 2.0
    for x0, y0, x1, y1 in table_bboxes:
        if x0 <= x <= x1 and y0 <= y <= y1:
            return True
    return False


def rotation_dimensions(
    width: float, height: float, rotation: int
) -> Tuple[float, float]:
    if rotation in (90, 270):
        return height, width
    return width, height


def rotate_point(x: float, y: float, width: float, height: float, rotation: int) -> Tuple[float, float]:
    if rotation == 0:
        return x, y
    if rotation == 90:
        return height - y, x
    if rotation == 270:
        return y, width - x
    raise RuntimeError(format_error("ROTATION_INVALID", None, f"rotation={rotation}"))


def rotate_bbox(
    bbox: Tuple[float, float, float, float], width: float, height: float, rotation: int
) -> Tuple[float, float, float, float]:
    x0, top, x1, bottom = bbox
    points = [
        (x0, top),
        (x1, top),
        (x1, bottom),
        (x0, bottom),
    ]
    rotated = [rotate_point(px, py, width, height, rotation) for px, py in points]
    xs = [p[0] for p in rotated]
    ys = [p[1] for p in rotated]
    return (min(xs), min(ys), max(xs), max(ys))


def unrotate_bbox(
    bbox: Tuple[float, float, float, float], width: float, height: float, rotation: int
) -> Tuple[float, float, float, float]:
    if rotation == 0:
        return bbox
    rot_width, rot_height = rotation_dimensions(width, height, rotation)
    inverse = 270 if rotation == 90 else 90
    return rotate_bbox(bbox, rot_width, rot_height, inverse)


def snap_value(value: float) -> float:
    return round(value / RULING_SNAP_GRID) * RULING_SNAP_GRID


def angle_diff(a: float, b: float) -> float:
    diff = abs(a - b) % 360.0
    return min(diff, 360.0 - diff)


def classify_char_rotation(char: Dict) -> Optional[int]:
    matrix = char.get("matrix")
    if matrix and len(matrix) >= 4:
        a, b, _, _ = matrix[:4]
        angle = math.degrees(math.atan2(b, a))
        angle = angle % 360.0
        for candidate in (0, 90, 180, 270):
            if angle_diff(angle, candidate) <= CHAR_ROTATION_TOLERANCE:
                return candidate
        return None
    if char.get("upright") is True:
        return 0
    return None


def point_in_bbox(x: float, y: float, bbox: Tuple[float, float, float, float]) -> bool:
    x0, y0, x1, y1 = bbox
    return x0 <= x <= x1 and y0 <= y <= y1


def count_points_in_bboxes(
    points: List[Tuple[float, float]], bboxes: List[Tuple[float, float, float, float]]
) -> int:
    if not points or not bboxes:
        return 0
    count = 0
    for x, y in points:
        for bbox in bboxes:
            if point_in_bbox(x, y, bbox):
                count += 1
                break
    return count


def merge_collinear_lines(lines: List[Dict], orientation: str) -> List[Dict]:
    grouped: Dict[float, List[Dict]] = {}
    key_field = "top" if orientation == "h" else "x0"
    for line in lines:
        key = line[key_field]
        grouped.setdefault(key, []).append(line)
    merged: List[Dict] = []
    for key in sorted(grouped.keys()):
        items = grouped[key]
        if orientation == "h":
            items.sort(key=lambda l: l["x0"])
            current = None
            for line in items:
                if current is None:
                    current = dict(line)
                    continue
                if line["x0"] - current["x1"] <= RULING_JOIN_TOLERANCE:
                    current["x1"] = max(current["x1"], line["x1"])
                else:
                    merged.append(current)
                    current = dict(line)
            if current is not None:
                merged.append(current)
        else:
            items.sort(key=lambda l: l["top"])
            current = None
            for line in items:
                if current is None:
                    current = dict(line)
                    continue
                if line["top"] - current["bottom"] <= RULING_JOIN_TOLERANCE:
                    current["bottom"] = max(current["bottom"], line["bottom"])
                else:
                    merged.append(current)
                    current = dict(line)
            if current is not None:
                merged.append(current)
    return merged


def line_overlaps_bbox(
    line: Dict, bbox: Tuple[float, float, float, float], orientation: str
) -> bool:
    x0, y0, x1, y1 = bbox
    if orientation == "h":
        y = line["top"]
        if y < (y0 - TABLE_EDGE_TOLERANCE) or y > (y1 + TABLE_EDGE_TOLERANCE):
            return False
        return not (
            line["x1"] < (x0 - TABLE_EDGE_TOLERANCE)
            or line["x0"] > (x1 + TABLE_EDGE_TOLERANCE)
        )
    x = line["x0"]
    if x < (x0 - TABLE_EDGE_TOLERANCE) or x > (x1 + TABLE_EDGE_TOLERANCE):
        return False
    return not (
        line["bottom"] < (y0 - TABLE_EDGE_TOLERANCE)
        or line["top"] > (y1 + TABLE_EDGE_TOLERANCE)
    )


def get_ruling_lines(page: pdfplumber.page.Page, rotation: int) -> Tuple[List[Dict], List[Dict]]:
    width = page.width
    height = page.height
    segments: List[Tuple[float, float, float, float]] = []
    edges = list(page.edges or [])
    lines = list(page.lines or [])
    rects = list(page.rects or [])
    for edge in edges + lines:
        x0 = edge.get("x0")
        x1 = edge.get("x1")
        top = edge.get("top")
        bottom = edge.get("bottom")
        if x0 is None or x1 is None or top is None or bottom is None:
            y0 = edge.get("y0")
            y1 = edge.get("y1")
            if x0 is None or x1 is None or y0 is None or y1 is None:
                continue
            top = height - max(y0, y1)
            bottom = height - min(y0, y1)
        segments.append((x0, top, x1, bottom))
    for rect in rects:
        x0 = rect.get("x0")
        x1 = rect.get("x1")
        top = rect.get("top")
        bottom = rect.get("bottom")
        if x0 is None or x1 is None or top is None or bottom is None:
            y0 = rect.get("y0")
            y1 = rect.get("y1")
            if x0 is None or x1 is None or y0 is None or y1 is None:
                continue
            top = height - max(y0, y1)
            bottom = height - min(y0, y1)
        segments.extend(
            [
                (x0, top, x1, top),
                (x0, bottom, x1, bottom),
                (x0, top, x0, bottom),
                (x1, top, x1, bottom),
            ]
        )
    h_lines: List[Dict] = []
    v_lines: List[Dict] = []
    for x0, top, x1, bottom in segments:
        rx0, rtop = rotate_point(x0, top, width, height, rotation)
        rx1, rbottom = rotate_point(x1, bottom, width, height, rotation)
        if abs(rtop - rbottom) <= RULING_EPS:
            y = snap_value(rtop)
            x_start = snap_value(min(rx0, rx1))
            x_end = snap_value(max(rx0, rx1))
            if (x_end - x_start) < RULING_MIN_LEN:
                continue
            h_lines.append({"x0": x_start, "x1": x_end, "top": y, "bottom": y})
        elif abs(rx0 - rx1) <= RULING_EPS:
            x = snap_value(rx0)
            y_start = snap_value(min(rtop, rbottom))
            y_end = snap_value(max(rtop, rbottom))
            if (y_end - y_start) < RULING_MIN_LEN:
                continue
            v_lines.append({"x0": x, "x1": x, "top": y_start, "bottom": y_end})
    h_lines = merge_collinear_lines(h_lines, "h")
    v_lines = merge_collinear_lines(v_lines, "v")
    return h_lines, v_lines


def is_real_ruled_table(
    table_obj: Dict,
    page: pdfplumber.page.Page,
    debug: Optional[List[Dict]] = None,
) -> bool:
    rotation = table_obj.get("rotation", 0)
    if "bbox_rotated" in table_obj:
        bbox_rotated = table_obj["bbox_rotated"]
    else:
        bbox = table_obj.get("bbox")
        if not bbox:
            return False
        bbox_rotated = rotate_bbox(bbox, page.width, page.height, rotation)
    h_lines, v_lines = get_ruling_lines(page, rotation)
    h_in = [l for l in h_lines if line_overlaps_bbox(l, bbox_rotated, "h")]
    v_in = [l for l in v_lines if line_overlaps_bbox(l, bbox_rotated, "v")]
    ok = len(h_in) >= 2 and len(v_in) >= 2
    if debug is not None:
        debug.append(
            {
                "table_index": table_obj.get("table_index"),
                "bbox": list(table_obj.get("bbox") or bbox_rotated),
                "bbox_rotated": list(bbox_rotated),
                "rotation": rotation,
                "h_in_bbox": len(h_in),
                "v_in_bbox": len(v_in),
                "accepted": ok,
            }
        )
    return ok


def detect_ruled_tables(
    h_lines: List[Dict],
    v_lines: List[Dict],
    rotation: int,
    page_num: int,
) -> List[Dict]:
    if len(h_lines) < 2 or len(v_lines) < 2:
        return []
    intersections: List[Tuple[int, int]] = []
    for hi, h in enumerate(h_lines):
        hy = h["top"]
        hx0 = h["x0"]
        hx1 = h["x1"]
        for vi, v in enumerate(v_lines):
            vx = v["x0"]
            if (
                hx0 - RULING_INTERSECTION_TOLERANCE
                <= vx
                <= hx1 + RULING_INTERSECTION_TOLERANCE
                and v["top"] - RULING_INTERSECTION_TOLERANCE
                <= hy
                <= v["bottom"] + RULING_INTERSECTION_TOLERANCE
            ):
                intersections.append((hi, vi))
    if not intersections:
        return []
    node_count = len(h_lines) + len(v_lines)
    adj: List[List[int]] = [[] for _ in range(node_count)]
    for hi, vi in intersections:
        h_node = hi
        v_node = len(h_lines) + vi
        adj[h_node].append(v_node)
        adj[v_node].append(h_node)
    visited = [False] * node_count
    candidates: List[Dict] = []
    for node in range(node_count):
        if visited[node]:
            continue
        stack = [node]
        component = []
        while stack:
            cur = stack.pop()
            if visited[cur]:
                continue
            visited[cur] = True
            component.append(cur)
            for nxt in adj[cur]:
                if not visited[nxt]:
                    stack.append(nxt)
        h_indices = [i for i in component if i < len(h_lines)]
        v_indices = [i - len(h_lines) for i in component if i >= len(h_lines)]
        if len(h_indices) < 2 or len(v_indices) < 2:
            continue
        intersection_count = sum(
            1 for hi, vi in intersections if hi in h_indices and vi in v_indices
        )
        if intersection_count < TABLE_INTERSECTION_MIN:
            continue
        comp_h = [h_lines[i] for i in h_indices]
        comp_v = [v_lines[i] for i in v_indices]
        x0 = min(line["x0"] for line in comp_h + comp_v)
        x1 = max(line["x1"] for line in comp_h + comp_v)
        top = min(line["top"] for line in comp_h + comp_v)
        bottom = max(line["bottom"] for line in comp_h + comp_v)
        candidates.append(
            {
                "bbox_rotated": (x0, top, x1, bottom),
                "h_lines": comp_h,
                "v_lines": comp_v,
                "rotation": rotation,
                "intersection_count": intersection_count,
                "confidence_reason": f"grid_h{len(comp_h)}_v{len(comp_v)}_i{intersection_count}",
                "page_num": page_num,
            }
        )
    candidates.sort(key=lambda c: (c["bbox_rotated"][1], c["bbox_rotated"][0]))
    return candidates


def rotate_objects(
    items: List[Dict], width: float, height: float, rotation: int
) -> List[Dict]:
    if rotation == 0:
        return [dict(item) for item in items]
    rotated: List[Dict] = []
    for item in items:
        x0 = item.get("x0")
        x1 = item.get("x1")
        top = item.get("top")
        bottom = item.get("bottom")
        if x0 is None or x1 is None or top is None or bottom is None:
            continue
        bbox_rot = rotate_bbox((x0, top, x1, bottom), width, height, rotation)
        rotated_item = dict(item)
        rotated_item["x0"] = bbox_rot[0]
        rotated_item["top"] = bbox_rot[1]
        rotated_item["x1"] = bbox_rot[2]
        rotated_item["bottom"] = bbox_rot[3]
        rotated.append(rotated_item)
    return rotated


def unique_sorted_positions(values: List[float], tolerance: float) -> List[float]:
    if not values:
        return []
    values_sorted = sorted(values)
    merged = [values_sorted[0]]
    for value in values_sorted[1:]:
        if abs(value - merged[-1]) > tolerance:
            merged.append(value)
    return merged


def median_char_width_for_words(words: List[Dict]) -> float:
    widths: List[float] = []
    for w in words:
        text = w.get("text") or ""
        if not text:
            continue
        width = (w["x1"] - w["x0"]) / max(len(text), 1)
        if width > 0:
            widths.append(width)
    if not widths:
        return 1.0
    return median(widths)


def extract_table_cells_from_grid(
    words: List[Dict], candidate: Dict, page_num: int
) -> Dict:
    bbox = candidate["bbox_rotated"]
    x0, top, x1, bottom = bbox
    v_positions = unique_sorted_positions([v["x0"] for v in candidate["v_lines"]], RULING_EPS)
    h_positions = unique_sorted_positions([h["top"] for h in candidate["h_lines"]], RULING_EPS)
    v_positions = [p for p in v_positions if x0 - RULING_EPS <= p <= x1 + RULING_EPS]
    h_positions = [p for p in h_positions if top - RULING_EPS <= p <= bottom + RULING_EPS]
    v_positions.sort()
    h_positions.sort()
    if len(v_positions) < 2 or len(h_positions) < 2:
        return {
            "ok": False,
            "rows": [],
            "columns": [],
            "empty_ratio": 1.0,
            "row_count": 0,
            "col_count": 0,
            "reason": "grid_insufficient",
        }
    words_in_bbox = []
    for w in words:
        wx = (w["x0"] + w["x1"]) / 2.0
        wy = (w["top"] + w["bottom"]) / 2.0
        if x0 <= wx <= x1 and top <= wy <= bottom:
            words_in_bbox.append(w)
    rows: List[List[str]] = []
    for r in range(len(h_positions) - 1):
        row_cells: List[str] = []
        cell_top = h_positions[r]
        cell_bottom = h_positions[r + 1]
        for c in range(len(v_positions) - 1):
            cell_x0 = v_positions[c]
            cell_x1 = v_positions[c + 1]
            cell_words = [
                w
                for w in words_in_bbox
                if cell_x0 <= (w["x0"] + w["x1"]) / 2.0 <= cell_x1
                and cell_top <= (w["top"] + w["bottom"]) / 2.0 <= cell_bottom
            ]
            if cell_words:
                median_width = median_char_width_for_words(cell_words)
                gap_threshold = median_width * WORD_GAP_MULTIPLIER
                lines = words_to_lines(cell_words, LINE_Y_TOLERANCE, gap_threshold, median_width)
                cell_text = "\n".join(l["text"] for l in lines)
            else:
                cell_text = ""
            row_cells.append(cell_text)
        rows.append(row_cells)
    total_cells = sum(len(r) for r in rows)
    empty_cells = sum(1 for r in rows for cell in r if not cell.strip())
    empty_ratio = (empty_cells / total_cells) if total_cells else 1.0
    col_count = len(rows[0]) if rows else 0
    row_count = len(rows)
    ok = (
        row_count >= 2
        and col_count >= 2
        and empty_ratio <= TABLE_EMPTY_CELL_RATIO_MAX
    )
    columns = rows[0] if rows else []
    body_rows = rows[1:] if len(rows) > 1 else []
    return {
        "ok": ok,
        "rows": body_rows,
        "columns": columns,
        "empty_ratio": empty_ratio,
        "row_count": row_count,
        "col_count": col_count,
        "reason": "ok" if ok else "degenerate",
    }


def extract_tables_with_rotation(
    page: pdfplumber.page.Page,
    words: List[Dict],
    page_num: int,
) -> Tuple[List[Dict], Dict]:
    width = page.width
    height = page.height
    char_points_by_angle: Dict[int, List[Tuple[float, float]]] = {0: [], 90: [], 180: [], 270: []}
    for c in page.chars:
        char_rotation = classify_char_rotation(c)
        if char_rotation is None:
            continue
        x0 = c.get("x0")
        x1 = c.get("x1")
        top = c.get("top")
        bottom = c.get("bottom")
        if x0 is None or x1 is None or top is None or bottom is None:
            continue
        cx = (x0 + x1) / 2.0
        cy = (top + bottom) / 2.0
        char_points_by_angle[char_rotation].append((cx, cy))
    rotation_results: List[Dict] = []
    rotations = [0, 90, 270]
    for rotation in rotations:
        h_lines, v_lines = get_ruling_lines(page, rotation)
        candidates = detect_ruled_tables(h_lines, v_lines, rotation, page_num)
        total_intersections = sum(c["intersection_count"] for c in candidates)
        total_area = 0.0
        for c in candidates:
            x0, top, x1, bottom = c["bbox_rotated"]
            total_area += max(0.0, (x1 - x0) * (bottom - top))
        target_angle = (360 - rotation) % 360
        bboxes_orig = [
            unrotate_bbox(c["bbox_rotated"], width, height, rotation) for c in candidates
        ]
        orientation_score = count_points_in_bboxes(
            char_points_by_angle.get(target_angle, []), bboxes_orig
        )
        rotation_results.append(
            {
                "rotation": rotation,
                "candidates": candidates,
                "total_intersections": total_intersections,
                "total_area": total_area,
                "orientation_score": orientation_score,
                "orientation_target": target_angle,
                "h_line_count": len(h_lines),
                "v_line_count": len(v_lines),
            }
        )
    rotation_results.sort(
        key=lambda r: (
            r["orientation_score"],
            r["total_intersections"],
            r["total_area"],
            -r["rotation"],
        )
    )
    best = rotation_results[-1]
    second = rotation_results[-2] if len(rotation_results) > 1 else None
    tie_breaker: Optional[str] = None
    if best["total_intersections"] > 0 and second:
        if (
            best["orientation_score"] == second["orientation_score"]
            and best["total_intersections"] == second["total_intersections"]
            and best["total_area"] == second["total_area"]
        ):
            if best["orientation_score"] == 0 and second["orientation_score"] == 0:
                tie_breaker = "default_rotation_0"
                for candidate in rotation_results:
                    if candidate["rotation"] == 0:
                        best = candidate
                        break
            else:
                raise RuntimeError(
                    format_error(
                        "TABLE_ROTATION_AMBIGUOUS",
                        page_num,
                        "Multiple rotations yield equal table evidence.",
                        stats={"best": best, "second": second},
                    )
                )
    if best["total_intersections"] <= 0:
        return [], {
            "rotation_results": rotation_results,
            "chosen_rotation": None,
            "tie_breaker": tie_breaker,
        }
    chosen_rotation = best["rotation"]
    rot_width, rot_height = rotation_dimensions(width, height, chosen_rotation)
    rotated_words = rotate_objects(words, width, height, chosen_rotation)
    inverse_rotation = 0
    if chosen_rotation == 90:
        inverse_rotation = 270
    elif chosen_rotation == 270:
        inverse_rotation = 90
    candidates: List[Dict] = []
    for c in best["candidates"]:
        bbox_rot = c["bbox_rotated"]
        bbox_orig = rotate_bbox(bbox_rot, rot_width, rot_height, inverse_rotation)
        extraction = extract_table_cells_from_grid(rotated_words, c, page_num)
        c = dict(c)
        c["bbox"] = bbox_orig
        c["extraction"] = extraction
        candidates.append(c)
    return candidates, {
        "rotation_results": rotation_results,
        "chosen_rotation": chosen_rotation,
        "tie_breaker": tie_breaker,
    }

# CANONICAL: table label binding (nearest overlapping label above bbox).
def find_table_label_for_bbox(
    label_lines: List[Dict],
    bbox: Tuple[float, float, float, float],
    page_num: int,
    debug: Optional[List[Dict]] = None,
) -> Tuple[Optional[str], Optional[str], Optional[Dict], bool]:
    x0, y0, x1, y1 = bbox

    def overlaps(line: Dict) -> bool:
        line_x0 = line["x0"]
        line_x1 = line.get("x1", line["x0"])
        return not (line_x1 < x0 or line_x0 > x1)

    labels = []
    for line in label_lines:
        line_text = line["text"].strip()
        match = TABLE_LABEL_RE.match(line_text)
        if match and overlaps(line):
            labels.append({"line": line, "match": match})

    above = [
        l
        for l in labels
        if l["line"]["bottom"] <= y0
        and y0 - l["line"]["bottom"] <= TABLE_LABEL_SEARCH_WINDOW
    ]
    chosen = None
    search_region = "above"
    if above:
        above.sort(key=lambda l: l["line"]["bottom"])
        chosen = above[-1]
    else:
        band_height = (y1 - y0) * TABLE_LABEL_TOP_BAND_RATIO
        inside_band = [
            l
            for l in labels
            if y0 <= l["line"]["top"] <= (y0 + band_height)
        ]
        if inside_band:
            inside_band.sort(key=lambda l: l["line"]["top"])
            chosen = inside_band[0]
            search_region = "inside_top_band"

    if not chosen:
        if debug is not None:
            debug.append(
                {
                    "bbox": {"x0": x0, "y0": y0, "x1": x1, "y1": y1},
                    "labels_found": [l["line"]["text"] for l in labels],
                    "chosen_label": None,
                    "search_region": None,
                }
            )
        return None, None, None, False

    line = chosen["line"]
    match = chosen["match"]
    table_id = match.group(1).strip()
    title = (match.group(2) or "").strip()
    continued = "CONTINUED" in line["text"].upper()
    if debug is not None:
        debug.append(
            {
                "bbox": {"x0": x0, "y0": y0, "x1": x1, "y1": y1},
                "labels_found": [l["line"]["text"] for l in labels],
                "chosen_label": line["text"],
                "search_region": search_region,
                "table_id": table_id,
                "continued": continued,
            }
        )
    return table_id, title, line, continued


# CANONICAL: table continuation marker detection.
def has_continued_marker(label_lines: List[Dict], table_id: str) -> bool:
    target = table_id.upper()
    for line in label_lines:
        text = line["text"].upper()
        if "TABLE" in text and target in text and "CONTINUED" in text:
            return True
    return False


def write_section(
    section_id: str,
    chapter: str,
    pdf_pages: List[int],
    lines: List[str],
) -> None:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    filename = f"section_{section_id}.txt"
    path = OUTPUT_DIR / filename
    header = [
        f"PDF_PAGE: {format_pdf_pages(pdf_pages)}",
        f"SECTION_ID: {section_id}",
        f"SECTION: IRC 2021 | {chapter} | Section {section_id}",
        "",
    ]
    body = "\n".join(lines)
    path.write_text("\n".join(header) + body + "\n", encoding="utf-8")


def write_table(
    table_id: str,
    title: str,
    pdf_pages: List[int],
    columns: List[str],
    rows: List[List[str]],
    footnotes: List[str],
    metadata: Optional[Dict] = None,
) -> None:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    filename = f"table_{table_id}.txt"
    path = OUTPUT_DIR / filename
    lines = [
        f"PDF_PAGE: {format_pdf_pages(pdf_pages)}",
        f"TABLE_ID: {table_id}",
        f"TITLE: {title}",
        "",
        "COLUMNS:",
    ]
    for col in columns:
        lines.append(f"- {col}")
    lines.append("")
    lines.append("ROWS:")
    for row in rows:
        lines.append("- " + " | ".join(row))
    lines.append("")
    lines.append("FOOTNOTES:")
    for note in footnotes:
        lines.append(f"- {note}")
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    csv_path = OUTPUT_DIR / f"table_{table_id}.csv"
    with csv_path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle)
        writer.writerow(columns)
        for row in rows:
            writer.writerow(row)
    json_path = OUTPUT_DIR / f"table_{table_id}.json"
    meta = {
        "pdf_pages": pdf_pages,
        "table_id": table_id,
        "title": title,
        "columns": columns,
        "rows": rows,
        "footnotes": footnotes,
    }
    if metadata:
        meta.update(metadata)
    json_path.write_text(json.dumps(meta, indent=2), encoding="utf-8")


def write_fallback_page(page_num: int, lines: List[str]) -> None:
    fallback_dir = OUTPUT_DIR / "fallback_text"
    fallback_dir.mkdir(parents=True, exist_ok=True)
    path = fallback_dir / f"page_{page_num:04d}.txt"
    header = [
        f"PDF_PAGE: {page_num}",
        "MODE: UNSECTIONED_FALLBACK",
        "--------------------------------",
    ]
    body = "\n".join(lines)
    path.write_text("\n".join(header) + "\n" + body + "\n", encoding="utf-8")


def clean_cell(cell: Optional[str]) -> str:
    if cell is None:
        return ""
    return cell


def compute_pdf_sha256(pdf_path: Path) -> str:
    hasher = hashlib.sha256()
    with pdf_path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            hasher.update(chunk)
    return hasher.hexdigest()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Extract IRC 2021 sections and tables.")
    parser.add_argument(
        "--pdf",
        type=str,
        default=str(OUTPUT_DIR / "2021_International_Residential_Code.pdf"),
    )
    parser.add_argument("--out", type=str, default=str(OUTPUT_DIR))
    parser.add_argument("--page-start", type=int, default=None)
    parser.add_argument("--page-end", type=int, default=None)
    parser.add_argument("--debug-dump", action="store_true")
    return parser.parse_args()


def write_report(report_path: Path, report: Dict) -> None:
    report_path.write_text(json.dumps(report, indent=2), encoding="utf-8")


# Pipeline summary (runtime order):
# 1) Header/footer extraction.
# 2) SHA-256 allowlist enforcement + amendment keyword scan.
# 3) Two-column line reconstruction (char geometry).
# 4) Section start detection (regex + header position/style checks).
# 5) Table detection/extraction (ruled-line grid).
# 6) Table label binding (nearest overlapping label above bbox).
# 7) Table continuation logic (continued marker OR repeated header + carryover label).
# 8) Output writing + parse report/debug dump.
def main() -> int:
    args = parse_args()
    pdf_path = Path(args.pdf)
    if not pdf_path.exists():
        raise RuntimeError(
            format_error(
                "PDF_INPUT_MISSING",
                None,
                f"PDF not found: {pdf_path}",
            )
        )
    global OUTPUT_DIR
    OUTPUT_DIR = Path(args.out)
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    print("Pipeline summary:")
    print("1) header/footer extraction")
    print("2) amendment scan + SHA-256 allowlist enforcement")
    print("3) two-column line reconstruction (char geometry)")
    print("4) section boundary detection (font + position checks)")
    print("5) table extraction + label binding + continuation checks")
    print("6) output writing + parse report")
    pdf_hash = compute_pdf_sha256(pdf_path)
    print(f"PDF_SHA256: {pdf_hash}")
    (OUTPUT_DIR / "_source_pdf_sha256.txt").write_text(f"{pdf_hash}\n", encoding="utf-8")
    allowlist_path = OUTPUT_DIR / "_allowed_pdf_hashes.txt"
    report_warnings: List[str] = []
    # Allowlist enforces unamended sources; create it on first run to lock the hash.
    if allowlist_path.exists():
        allowed = {
            line.strip()
            for line in allowlist_path.read_text(encoding="utf-8").splitlines()
            if line.strip()
        }
        if pdf_hash not in allowed:
            raise RuntimeError(
                format_error(
                    "PDF_HASH_NOT_ALLOWED",
                    None,
                    f"Hash {pdf_hash} not in allowlist {allowlist_path}.",
                )
            )
    else:
        allowlist_path.write_text(f"{pdf_hash}\n", encoding="utf-8")
        warning = (
            f"WARNING: allowlist not found; created {allowlist_path} with current hash."
        )
        print(warning)
        report_warnings.append(warning)

    sections_extracted = 0
    tables_extracted = 0
    skipped_regions: List[str] = []
    section_stack: List[Dict] = []
    current_chapter = "Chapter Unknown"
    section_occurrences: Dict[str, int] = {}
    pending_table: Optional[Dict] = None
    last_table_id_by_base: Dict[str, str] = {}
    fallback_pages: Dict[int, List[str]] = {}

    with pdfplumber.open(pdf_path) as pdf:
        total_pages = len(pdf.pages)
        page_start = args.page_start or 1
        page_end = args.page_end or total_pages
        if page_start < 1 or page_end < page_start:
            raise RuntimeError(
                format_error(
                    "PAGE_RANGE_INVALID",
                    None,
                    f"Invalid page range: {page_start}–{page_end} (total {total_pages}).",
                )
            )
        if page_end > total_pages:
            warning = (
                f"PAGE_RANGE_CLAMPED: requested end {page_end} exceeds total {total_pages}; "
                f"clamping to {total_pages}."
            )
            report_warnings.append(warning)
            page_end = total_pages
        report = {"pdf_sha256": pdf_hash, "warnings": report_warnings, "pages": []}
        report_path = OUTPUT_DIR / "_parse_report.json"
        debug_dir = OUTPUT_DIR / "_debug_pages"
        if args.debug_dump:
            debug_dir.mkdir(parents=True, exist_ok=True)

        for page_num in range(page_start, page_end + 1):
            page = pdf.pages[page_num - 1]
            page_width = page.width
            page_height = page.height

            page_entry = {
                "pdf_page": page_num,
                "header_text_snippet": None,
                "footer_text_snippet": None,
                "column_bounds": None,
                "thresholds": {},
                "warnings": [],
                "errors": [],
                "spanning_reference_lines": [],
                "table_label_bindings": [],
                "table_continuation": [],
                "tables_found": [],
                "column_split_debug": [],
            }
            header_text_snippet = ""
            footer_text_snippet = ""
            column_bounds: Dict[str, float] = {}
            label_candidates: List[Dict] = []
            table_label_bindings: List[Dict] = []
            table_continuation_debug: List[Dict] = []
            section_debug: List[Dict] = []
            try:
                word_tokens = page.extract_words(
                    use_text_flow=False,
                    keep_blank_chars=False,
                    extra_attrs=["x0", "x1", "top", "bottom", "size", "fontname"],
                )
                chars_all = page.chars
                if not chars_all:
                    raise RuntimeError(
                        format_error(
                            "CHAR_DATA_MISSING",
                            page_num,
                            "No character data on page.",
                        )
                    )
                # Font metadata is required for header-style validation; missing data is unsafe.
                for c in chars_all:
                    if c.get("size") is None or c.get("fontname") is None:
                        raise RuntimeError(
                            format_error(
                                "FONT_METADATA_MISSING",
                                page_num,
                                "Missing font metadata; cannot validate headers.",
                                stats={"char": c},
                            )
                        )
                header_words, footer_words = split_header_footer_words(word_tokens, page_height)
                header_text_snippet = words_to_snippet(header_words)
                footer_text_snippet = words_to_snippet(footer_words)
                if not header_words and not footer_words:
                    raise RuntimeError(
                        format_error(
                            "HEADER_FOOTER_MISSING",
                            page_num,
                            "Missing header/footer content.",
                        )
                    )
                scan_for_amendment_indicators(
                    page_num, header_text_snippet, footer_text_snippet
                )
                page_entry["header_text_snippet"] = header_text_snippet
                page_entry["footer_text_snippet"] = footer_text_snippet
                is_toc_page = is_table_of_contents_header(header_text_snippet)
                table_candidates, table_rotation_debug = extract_tables_with_rotation(
                    page, word_tokens, page_num
                )
                for idx, c in enumerate(table_candidates, start=1):
                    c["table_index"] = idx
                table_ruled_filter: List[Dict] = []
                real_tables = [
                    c for c in table_candidates if is_real_ruled_table(c, page, table_ruled_filter)
                ]
                if table_rotation_debug.get("tie_breaker"):
                    page_entry["warnings"].append(
                        f"TABLE_ROTATION_TIE_DEFAULT PDF_PAGE={page_num} method={table_rotation_debug['tie_breaker']}"
                    )
                chosen_rotation = table_rotation_debug.get("chosen_rotation")
                if chosen_rotation is None:
                    chosen_rotation = 0
                for c in table_candidates:
                    c["is_real_ruled"] = any(rt is c for rt in real_tables)
                tables = [c for c in real_tables if c["extraction"]["ok"]]
                table_bboxes = [c["bbox"] for c in real_tables]
                for idx, c in enumerate(table_candidates, start=1):
                    extraction = c["extraction"]
                    if not extraction["ok"]:
                        warning = (
                            f"TABLE_EXTRACTION_DEGENERATE PDF_PAGE={page_num} "
                            f"bbox={list(c['bbox'])} reason={extraction['reason']}"
                        )
                        page_entry["warnings"].append(warning)
                    page_entry["tables_found"].append(
                        {
                            "table_index": idx,
                            "bbox": list(c["bbox"]),
                            "rotation": c["rotation"],
                            "intersection_count": c["intersection_count"],
                            "confidence_reason": c["confidence_reason"],
                            "extraction": {
                                "ok": extraction["ok"],
                                "row_count": extraction["row_count"],
                                "col_count": extraction["col_count"],
                                "empty_ratio": extraction["empty_ratio"],
                                "reason": extraction["reason"],
                            },
                            "real_ruled": c.get("is_real_ruled", False),
                        }
                    )

                chars_no_tables = [c for c in chars_all if not inside_any_table(c, table_bboxes)]
                words_no_tables = [
                    w for w in word_tokens if not inside_any_table(w, table_bboxes)
                ]
                if args.debug_dump:
                    exclusion_debug = []
                    for c in real_tables:
                        bbox = c["bbox"]
                        in_bbox = sum(
                            1 for ch in chars_all if inside_any_table(ch, [bbox])
                        )
                        remaining = sum(
                            1 for ch in chars_no_tables if inside_any_table(ch, [bbox])
                        )
                        exclusion_debug.append(
                            {
                                "table_index": c["table_index"],
                                "bbox": list(bbox),
                                "chars_in_bbox": in_bbox,
                                "chars_excluded": max(0, in_bbox - remaining),
                            }
                        )
                    page_entry["table_char_exclusion"] = exclusion_debug
                body_chars = [
                    c
                    for c in chars_no_tables
                    if (page_height * HEADER_REGION_RATIO)
                    < c["top"]
                    < page_height * (1.0 - FOOTER_REGION_RATIO)
                ]
                body_sizes = [
                    c["size"] for c in body_chars if isinstance(c.get("size"), (int, float))
                ]
                if not body_sizes:
                    warning = (
                        f"NO_BODY_CONTENT PDF_PAGE={page_num} detail=No body chars in page body region."
                    )
                    page_entry["warnings"].append(warning)
                    body_median_size = None
                    ordered_lines = []
                    column_bounds = {}
                else:
                    body_median_size = median(body_sizes)
                    ordered_lines, column_bounds = build_ordered_lines(
                        chars_no_tables,
                        words_no_tables,
                        page_width,
                        page_height,
                        page_num,
                        body_median_size,
                        table_bboxes,
                        page_entry["column_split_debug"],
                    )
                    if not column_bounds:
                        raise RuntimeError(
                            format_error(
                                "COLUMN_BOUNDS_MISSING",
                                page_num,
                                "Missing column bounds.",
                            )
                        )
                    page_entry["column_bounds"] = column_bounds
                    page_entry["spanning_reference_lines"] = [
                        {
                            "text": line["text"],
                            "bbox": [
                                line["x0"],
                                line["top"],
                                line.get("x1"),
                                line.get("bottom"),
                            ],
                            "role": line.get("role"),
                        }
                        for line in ordered_lines
                        if line.get("role") == "spanning_reference"
                    ]
                label_lines_original = build_label_lines(word_tokens, page_num)
                rotated_label_lines = label_lines_original
                if table_candidates:
                    rotated_words = rotate_objects(
                        word_tokens, page_width, page_height, chosen_rotation
                    )
                    rotated_label_lines = build_label_lines(rotated_words, page_num)
                label_candidates = [
                    {
                        "text": line["text"],
                        "top": line["top"],
                        "x0": line["x0"],
                        "x1": line.get("x1"),
                        "column": line.get("column"),
                    }
                    for line in label_lines_original
                    if TABLE_LABEL_RE.match(line["text"].strip())
                ]
                page_entry["thresholds"] = {
                    "header_region_ratio": HEADER_REGION_RATIO,
                    "footer_region_ratio": FOOTER_REGION_RATIO,
                    "line_y_tolerance": LINE_Y_TOLERANCE,
                    "column_margin_tolerance": COLUMN_MARGIN_TOLERANCE,
                    "header_body_indent_min": HEADER_BODY_INDENT_MIN,
                    "header_size_delta": HEADER_SIZE_DELTA,
                    "max_header_line_gap": MAX_HEADER_LINE_GAP,
                    "body_median_font_size": body_median_size,
                    "spacing_thresholds": column_bounds.get("spacing_thresholds"),
                    "margin_percentile": column_bounds.get("margin_percentile"),
                    "table_edge_tolerance": TABLE_EDGE_TOLERANCE,
                }

                # Identify chapter changes.
                for line in ordered_lines:
                    chap_match = CHAPTER_RE.match(line["text"])
                    if chap_match:
                        current_chapter = f"Chapter {chap_match.group(1)}"
                        break

                # Map table labels and extract table content atomically.
                table_label_entries: List[Tuple[float, str]] = []
                table_footnote_tops: List[float] = []
                table_entries: List[Dict] = []

                # A bottom-touching table may continue, but only merge when continuation is provable.
                # CANONICAL: table continuation logic (only merge when continuation is provable).
                if pending_table and not tables:
                    continued_marker_present = has_continued_marker(
                        label_lines_original, pending_table["table_id"]
                    )
                    carryover_label_present = any(
                        TABLE_LABEL_RE.match(line["text"].strip())
                        and pending_table["table_id"] in line["text"].upper()
                        for line in label_lines_original
                    )
                    if continued_marker_present:
                        raise RuntimeError(
                            format_error(
                                "TABLE_CONTINUATION",
                                page_num,
                                f"Continuation label found without table grid for TABLE {pending_table['table_id']}.",
                            )
                        )
                    if carryover_label_present:
                        raise RuntimeError(
                            format_error(
                                "TABLE_CONTINUATION",
                                page_num,
                                f"Carryover TABLE label found without grid for TABLE {pending_table['table_id']}.",
                            )
                        )
                    table_continuation_debug.append(
                        {
                            "table_id": pending_table["table_id"],
                            "decision": "finalize_no_continuation",
                            "page": page_num,
                            "continued_marker": continued_marker_present,
                            "carryover_label": carryover_label_present,
                        }
                    )
                    write_table(
                        pending_table["table_id"],
                        pending_table["title"],
                        pending_table["pdf_pages"],
                        pending_table["columns"],
                        pending_table["rows"],
                        pending_table["footnotes"],
                        pending_table.get("metadata"),
                    )
                    tables_extracted += 1
                    pending_table = None

                for t in tables:
                    table_index = t["table_index"]
                    table_id, title, label_line, continued = find_table_label_for_bbox(
                        rotated_label_lines, t["bbox_rotated"], page_num, table_label_bindings
                    )
                    unlabeled = table_id is None
                    if unlabeled:
                        table_id = f"UNLABELED_P{page_num}_T{table_index}"
                        title = ""
                        page_entry["warnings"].append(
                            f"TABLE_LABEL_MISSING PDF_PAGE={page_num} bbox={list(t['bbox'])}"
                        )
                    base_id = re.sub(r"\(.*\)$", "", table_id).strip()
                    continued_from = None
                    if continued:
                        prior_id = last_table_id_by_base.get(base_id)
                        if prior_id:
                            continued_from = prior_id
                            table_id = prior_id
                        else:
                            page_entry["warnings"].append(
                                f"TABLE_CONTINUED_WITHOUT_PRIOR PDF_PAGE={page_num} table_id={table_id}"
                            )
                    else:
                        last_table_id_by_base[base_id] = table_id
                    label_top = None
                    label_text = None
                    if label_line is not None:
                        label_text = label_line["text"]
                        label_bbox_rot = (
                            label_line["x0"],
                            label_line["top"],
                            label_line.get("x1", label_line["x0"]),
                            label_line.get("bottom", label_line["top"]),
                        )
                        label_bbox_orig = unrotate_bbox(
                            label_bbox_rot, page_width, page_height, chosen_rotation
                        )
                        label_top = label_bbox_orig[1]
                        table_label_entries.append((label_top, label_text))
                    if table_index - 1 < len(page_entry["tables_found"]):
                        page_entry["tables_found"][table_index - 1].update(
                            {
                                "table_id": table_id,
                                "title": title,
                                "label_text": label_text,
                                "unlabeled": unlabeled,
                                "continued": continued,
                            }
                        )

                    columns = [clean_cell(c) for c in t["extraction"]["columns"]]
                    rows = [
                        [clean_cell(c) for c in r] for r in t["extraction"]["rows"]
                    ]

                    # Capture footnotes as lines just below the table bbox.
                    footnotes = []
                    for line in ordered_lines:
                        if t["bbox"][3] < line["top"] <= (t["bbox"][3] + 60):
                            if line["text"].startswith(("*", "a.", "b.", "c.", "For SI:")):
                                footnotes.append(line["text"])
                                table_footnote_tops.append(line["top"])

                    touches_bottom = t["bbox"][3] >= page.height - 15
                    table_entries.append(
                        {
                            "table_id": table_id,
                            "title": title,
                            "columns": columns,
                            "rows": rows,
                            "footnotes": footnotes,
                            "touches_bottom": touches_bottom,
                            "unlabeled": unlabeled,
                            "bbox": t["bbox"],
                            "rotation": t["rotation"],
                            "intersection_count": t["intersection_count"],
                            "confidence_reason": t["confidence_reason"],
                            "continued": continued,
                            "continued_from": continued_from,
                            "metadata": {
                                "bbox": t["bbox"],
                                "rotation": t["rotation"],
                                "intersection_count": t["intersection_count"],
                                "confidence_reason": t["confidence_reason"],
                                "continued": continued,
                                "continued_from": continued_from,
                            },
                        }
                    )

                if pending_table and table_entries:
                    continued_marker = has_continued_marker(
                        label_lines_original, pending_table["table_id"]
                    )
                    carryover_label = any(
                        TABLE_LABEL_RE.match(line["text"].strip())
                        and pending_table["table_id"] in line["text"].upper()
                        for line in label_lines_original
                    )
                    continuation_matches = []
                    for entry in table_entries:
                        if entry["table_id"] != pending_table["table_id"]:
                            continue
                        header_matches = entry["columns"] == pending_table["columns"]
                        if continued_marker or (header_matches and carryover_label):
                            continuation_matches.append(entry)

                    if continued_marker and not continuation_matches:
                        raise RuntimeError(
                            format_error(
                                "TABLE_CONTINUATION",
                                page_num,
                                f"Continuation label found without matching grid for TABLE {pending_table['table_id']}.",
                            )
                        )
                    if len(continuation_matches) > 1:
                        raise RuntimeError(
                            format_error(
                                "TABLE_CONTINUATION",
                                page_num,
                                f"Multiple continuation matches for TABLE {pending_table['table_id']}.",
                                stats={"matches": [m["table_id"] for m in continuation_matches]},
                            )
                        )

                    if continuation_matches:
                        entry = continuation_matches[0]
                        if pending_table.get("metadata") and pending_table["metadata"].get(
                            "rotation"
                        ) != entry["rotation"]:
                            raise RuntimeError(
                                format_error(
                                    "TABLE_CONTINUATION",
                                    page_num,
                                    "Continuation rotation mismatch.",
                                    stats={
                                        "pending_rotation": pending_table["metadata"].get(
                                            "rotation"
                                        ),
                                        "entry_rotation": entry["rotation"],
                                    },
                                )
                            )
                        pending_table["rows"].extend(entry["rows"])
                        pending_table["footnotes"].extend(entry["footnotes"])
                        pending_table["pdf_pages"].append(page_num)
                        if pending_table.get("metadata") and "bboxes" in pending_table["metadata"]:
                            pending_table["metadata"]["bboxes"].append(entry["bbox"])
                        table_continuation_debug.append(
                            {
                                "table_id": pending_table["table_id"],
                                "decision": "merged_continuation",
                                "page": page_num,
                                "continued_marker": continued_marker,
                                "header_matches": entry["columns"] == pending_table["columns"],
                                "carryover_label": carryover_label,
                            }
                        )
                        table_entries.remove(entry)
                        if not entry["touches_bottom"]:
                            write_table(
                                pending_table["table_id"],
                                pending_table["title"],
                                pending_table["pdf_pages"],
                                pending_table["columns"],
                                pending_table["rows"],
                                pending_table["footnotes"],
                                pending_table.get("metadata"),
                            )
                            tables_extracted += 1
                            pending_table = None
                    else:
                        if any(
                            entry["table_id"] == pending_table["table_id"] for entry in table_entries
                        ):
                            raise RuntimeError(
                                format_error(
                                    "TABLE_CONTINUATION",
                                    page_num,
                                    f"Table id {pending_table['table_id']} reappears without proven continuation.",
                                )
                            )
                        table_continuation_debug.append(
                            {
                                "table_id": pending_table["table_id"],
                                "decision": "finalize_no_continuation",
                                "page": page_num,
                                "continued_marker": continued_marker,
                                "carryover_label": carryover_label,
                            }
                        )
                        write_table(
                            pending_table["table_id"],
                            pending_table["title"],
                            pending_table["pdf_pages"],
                            pending_table["columns"],
                            pending_table["rows"],
                            pending_table["footnotes"],
                            pending_table.get("metadata"),
                        )
                        tables_extracted += 1
                        pending_table = None

                for entry in table_entries:
                    if not entry["title"] and not entry.get("unlabeled"):
                        page_entry["warnings"].append(
                            f"TABLE_TITLE_MISSING PDF_PAGE={page_num} table_id={entry['table_id']}"
                        )
                    if entry["touches_bottom"]:
                        if pending_table:
                            raise RuntimeError(
                                format_error(
                                    "TABLE_CONTINUATION",
                                    page_num,
                                    "Multiple pending tables on same page.",
                                )
                            )
                        pending_table = {
                            "table_id": entry["table_id"],
                            "title": entry["title"],
                            "columns": entry["columns"],
                            "rows": entry["rows"],
                            "footnotes": entry["footnotes"],
                            "pdf_pages": [page_num],
                            "metadata": {
                                "bboxes": [entry["bbox"]],
                                "rotation": entry["rotation"],
                                "intersection_count": entry["intersection_count"],
                                "confidence_reason": entry["confidence_reason"],
                                "continued": entry["continued"],
                                "continued_from": entry["continued_from"],
                            },
                        }
                        table_continuation_debug.append(
                            {
                                "table_id": entry["table_id"],
                                "decision": "pending_touch_bottom",
                                "page": page_num,
                            }
                        )
                        continue

                    write_table(
                        entry["table_id"],
                        entry["title"],
                        [page_num],
                        entry["columns"],
                        entry["rows"],
                        entry["footnotes"],
                        entry.get("metadata"),
                    )
                    tables_extracted += 1

                if args.debug_dump:
                    rotation_results = []
                    for r in table_rotation_debug.get("rotation_results", []):
                        rotation_results.append(
                            {
                                "rotation": r["rotation"],
                                "total_intersections": r["total_intersections"],
                                "total_area": r["total_area"],
                                "orientation_score": r.get("orientation_score"),
                                "orientation_target": r.get("orientation_target"),
                                "h_line_count": r["h_line_count"],
                                "v_line_count": r["v_line_count"],
                                "candidate_count": len(r["candidates"]),
                            }
                        )
                    table_debug_payload = {
                        "pdf_page": page_num,
                        "chosen_rotation": chosen_rotation,
                        "rotation_results": rotation_results,
                        "tables": page_entry.get("tables_found"),
                        "ruled_filter": table_ruled_filter,
                    }
                    (debug_dir / f"debug_tables_page_{page_num}.json").write_text(
                        json.dumps(table_debug_payload, indent=2), encoding="utf-8"
                    )
                    if table_candidates:
                        img = page.to_image(resolution=150)
                        img.draw_rects([c["bbox"] for c in table_candidates], stroke="red")
                        img.save(debug_dir / f"debug_tables_page_{page_num}.png")

                page_entry["table_label_bindings"] = table_label_bindings
                page_entry["table_continuation"] = table_continuation_debug
                page_entry["section_candidates"] = section_debug

                fallback_lines: List[str] = []
                for line in ordered_lines:
                    if line.get("role") == "spanning_reference":
                        continue
                    is_label_line = any(
                        abs(line["top"] - label_top) <= LINE_Y_TOLERANCE
                        and line["text"] == label_text
                        for label_top, label_text in table_label_entries
                    )
                    if is_label_line or line["top"] in table_footnote_tops:
                        continue
                    fallback_lines.append(line["text"])
                fallback_pages[page_num] = fallback_lines

                # Build section text, excluding table labels and footnotes.
                for idx, line in enumerate(ordered_lines):
                    if is_toc_page:
                        continue
                    candidate_id = parse_true_section_heading(line["text"])
                    marker_id = parse_section_marker_line(line["text"])
                    if marker_id:
                        if section_stack:
                            entry = section_stack.pop()
                            pdf_pages = list(
                                range(entry["start_page"], entry["end_page"] + 1)
                            )
                            write_section(
                                entry["id"],
                                entry["chapter"],
                                pdf_pages,
                                entry["lines"],
                            )
                            sections_extracted += 1
                        continue
                    is_label_line = any(
                        abs(line["top"] - label_top) <= LINE_Y_TOLERANCE
                        and line["text"] == label_text
                        for label_top, label_text in table_label_entries
                    )
                    if candidate_id:
                        if (
                            line.get("role") == "spanning_reference"
                            or is_label_line
                            or line["top"] in table_footnote_tops
                        ):
                            raise RuntimeError(
                                format_error(
                                    "SECTION_HEADER_SKIPPED",
                                    page_num,
                                    "Section header line excluded from section text.",
                                    stats={"text": line["text"]},
                                )
                            )
                        if section_stack and candidate_id == section_stack[-1]["id"]:
                            raise RuntimeError(
                                "SECTION_APPEND_VIOLATION: header text appended to previous section"
                            )
                        new_depth = section_id_depth(candidate_id)
                        if section_stack:
                            while (
                                section_stack
                                and new_depth <= section_stack[-1]["depth"]
                                and candidate_id != section_stack[-1]["id"]
                            ):
                                entry = section_stack.pop()
                                pdf_pages = list(
                                    range(entry["start_page"], entry["end_page"] + 1)
                                )
                                write_section(
                                    entry["id"],
                                    entry["chapter"],
                                    pdf_pages,
                                    entry["lines"],
                                )
                                sections_extracted += 1
                        if candidate_id in section_occurrences:
                            prev_pdf = section_occurrences[candidate_id]
                            raise RuntimeError(
                                format_error(
                                    "SECTION_DUPLICATE",
                                    page_num,
                                    f"Duplicate section id {candidate_id}.",
                                    stats={
                                        "previous_pdf_page": prev_pdf,
                                    },
                                )
                            )
                        section_occurrences[candidate_id] = page_num
                        section_stack.append(
                            {
                                "id": candidate_id,
                                "depth": new_depth,
                                "lines": [line["text"]],
                                "start_page": page_num,
                                "end_page": page_num,
                                "chapter": current_chapter,
                            }
                        )
                        continue
                    if line.get("role") == "spanning_reference":
                        continue
                    if is_label_line or line["top"] in table_footnote_tops:
                        continue

                    if section_stack:
                        section_stack[-1]["lines"].append(line["text"])
                        section_stack[-1]["end_page"] = page_num
            except Exception as exc:
                error_message = ensure_error_context(str(exc), page_num)
                page_entry["errors"].append(error_message)
                if args.debug_dump:
                    debug_payload = {
                        "pdf_page": page_num,
                        "header_text_snippet": header_text_snippet,
                        "footer_text_snippet": footer_text_snippet,
                        "warnings": page_entry["warnings"],
                        "column_bounds": column_bounds or None,
                        "thresholds": page_entry.get("thresholds"),
                        "spanning_reference_lines": page_entry.get("spanning_reference_lines"),
                        "table_label_candidates": label_candidates,
                        "table_label_bindings": table_label_bindings,
                        "table_continuation": table_continuation_debug,
                        "column_split_debug": page_entry.get("column_split_debug"),
                        "tables_found": page_entry.get("tables_found"),
                        "section_candidates": section_debug,
                        "errors": page_entry["errors"],
                    }
                    (debug_dir / f"page_{page_num}.json").write_text(
                        json.dumps(debug_payload, indent=2), encoding="utf-8"
                    )
                report["pages"].append(page_entry)
                write_report(report_path, report)
                raise RuntimeError(error_message) from exc

            if args.debug_dump:
                debug_payload = {
                    "pdf_page": page_num,
                    "header_text_snippet": header_text_snippet,
                    "footer_text_snippet": footer_text_snippet,
                    "warnings": page_entry["warnings"],
                    "column_bounds": column_bounds or None,
                    "thresholds": page_entry.get("thresholds"),
                    "spanning_reference_lines": page_entry.get("spanning_reference_lines"),
                    "table_label_candidates": label_candidates,
                    "table_label_bindings": table_label_bindings,
                    "table_continuation": table_continuation_debug,
                    "column_split_debug": page_entry.get("column_split_debug"),
                    "tables_found": page_entry.get("tables_found"),
                    "section_candidates": section_debug,
                }
                (debug_dir / f"page_{page_num}.json").write_text(
                    json.dumps(debug_payload, indent=2), encoding="utf-8"
                )
            report["pages"].append(page_entry)

        write_report(report_path, report)

        # Flush final section.
        if pending_table:
            raise RuntimeError(
                format_error(
                    "TABLE_CONTINUATION",
                    pending_table["pdf_pages"][-1] if pending_table["pdf_pages"] else None,
                    f"Unterminated TABLE {pending_table['table_id']} at end of document.",
                )
            )

        while section_stack:
            entry = section_stack.pop()
            pdf_pages = list(range(entry["start_page"], entry["end_page"] + 1))
            write_section(
                entry["id"],
                entry["chapter"],
                pdf_pages,
                entry["lines"],
            )
            sections_extracted += 1
        enforce_section_integrity(list(section_occurrences.keys()), OUTPUT_DIR)
        if sections_extracted == 0:
            for page_num in sorted(fallback_pages.keys()):
                write_fallback_page(page_num, fallback_pages[page_num])

    print(f"Sections extracted: {sections_extracted}")
    print(f"Tables extracted: {tables_extracted}")
    if skipped_regions:
        print("Skipped/ambiguous regions:")
        for item in skipped_regions:
            print(f"- {item}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
