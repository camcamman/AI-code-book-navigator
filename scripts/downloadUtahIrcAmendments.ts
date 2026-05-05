// Run: npx tsx scripts/downloadUtahIrcAmendments.ts [--sections 202,203,204,205,206] [--min-items N] [--allow-suspicious] [--limit N] [--debug]
// This script fetches the Utah Legislature's versioned XML for IRC Part 2 sections
// and writes one top-level amendment item per file.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_SECTIONS = [202, 203, 204, 205, 206];
const HTML_BASE_URL = "https://le.utah.gov/xcode/Title15A/Chapter3";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CODEBOOK_DIR = path.resolve(
  __dirname,
  "..",
  "codebooks",
  "irc-utah-2021-amendments"
);
const SOURCE_DIR = path.join(CODEBOOK_DIR, "raw", "source");
const OUTPUT_DIR = path.join(CODEBOOK_DIR, "raw", "items");
const REPORT_PATH = path.join(CODEBOOK_DIR, "_download_extract_report.json");

type Args = {
  sections: number[];
  minItems: number;
  allowSuspicious: boolean;
  limit: number | null;
  debug: boolean;
};

type XmlChild = XmlNode | string;

type XmlNode = {
  name: string;
  attrs: Record<string, string>;
  children: XmlChild[];
};

type SectionSource = {
  sectionNumber: string;
  versionId: string;
  htmlUrl: string;
  xmlUrl: string;
  catchline: string | null;
  effDate: string | null;
  topLevelItemsDetected: number;
};

type ItemResult = {
  itemNumber: number;
  itemNumberFromSource: string | null;
  utahSection: string;
  sectionId: string | null;
  opType: string;
  length: number;
  outputFile: string;
  sourceXmlUrl: string;
  suspicious: boolean;
  reasons: string[];
};

type ExtractedItem = {
  utahSection: string;
  subsectionNumber: string;
  itemNumberFromSource: string | null;
  text: string;
  sourceXmlUrl: string;
  catchline: string | null;
  effDate: string | null;
};

const TARGET_REF_RE =
  /\b(?:Section|Sections|Table|Tables|Figure|Figures|Chapter|Chapters)\s+([A-Za-z]?\d+(?:\.\d+)*(?:\s*\([^)]+\))?[A-Za-z]?)/i;

function parseArgs(argv: string[]): Args {
  const out: Args = {
    sections: DEFAULT_SECTIONS.slice(),
    minItems: 20,
    allowSuspicious: false,
    limit: null,
    debug: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === "--sections" && argv[i + 1]) {
      out.sections = parseSectionsArg(argv[++i]);
      continue;
    }
    if (arg.startsWith("--sections=")) {
      out.sections = parseSectionsArg(arg.split("=", 2)[1]);
      continue;
    }
    if (arg === "--min-items" && argv[i + 1]) {
      out.minItems = Number(argv[++i]);
      continue;
    }
    if (arg.startsWith("--min-items=")) {
      out.minItems = Number(arg.split("=", 2)[1]);
      continue;
    }
    if (arg === "--allow-suspicious") {
      out.allowSuspicious = true;
      continue;
    }
    if (arg === "--limit" && argv[i + 1]) {
      out.limit = Number(argv[++i]);
      continue;
    }
    if (arg.startsWith("--limit=")) {
      out.limit = Number(arg.split("=", 2)[1]);
      continue;
    }
    if (arg === "--debug") {
      out.debug = true;
      continue;
    }
  }

  if (!Number.isFinite(out.minItems) || out.minItems < 0) {
    throw new Error(`Invalid --min-items value: ${out.minItems}`);
  }
  if (out.limit !== null && (!Number.isFinite(out.limit) || out.limit <= 0)) {
    throw new Error(`Invalid --limit value: ${out.limit}`);
  }
  if (out.sections.length === 0) {
    throw new Error("At least one section must be provided via --sections");
  }

  return out;
}

function parseSectionsArg(value: string): number[] {
  const nums = value
    .split(",")
    .map((part) => Number.parseInt(part.trim(), 10))
    .filter((n) => Number.isFinite(n) && n > 0);
  return Array.from(new Set(nums)).sort((a, b) => a - b);
}

function ensureDir(dir: string) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function clearGeneratedFiles(dir: string, exts: string[]) {
  if (!fs.existsSync(dir)) return;
  for (const name of fs.readdirSync(dir)) {
    const fullPath = path.join(dir, name);
    if (!fs.statSync(fullPath).isFile()) continue;
    const lower = name.toLowerCase();
    if (exts.some((ext) => lower.endsWith(ext))) {
      fs.rmSync(fullPath);
    }
  }
}

async function fetchText(url: string): Promise<{ text: string; status: number; contentType: string }> {
  const res = await fetch(url);
  const contentType = res.headers.get("content-type") || "";
  const status = res.status;
  const text = await res.text();

  if (!res.ok) {
    throw new Error(`Failed to fetch ${url}. HTTP ${status}`);
  }

  return { text, status, contentType };
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function parseAttrs(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const attrRe = /([A-Za-z_:][A-Za-z0-9:._-]*)="([^"]*)"/g;
  let match: RegExpExecArray | null;
  while ((match = attrRe.exec(raw)) !== null) {
    attrs[match[1]] = decodeXmlEntities(match[2]);
  }
  return attrs;
}

function parseXml(xml: string): XmlNode {
  const sanitized = xml.replace(/^\uFEFF/, "").trim();
  const tokens = sanitized.match(/<[^>]+>|[^<]+/g) ?? [];
  const stack: XmlNode[] = [];
  let root: XmlNode | null = null;

  for (const token of tokens) {
    if (token.startsWith("<?") || token.startsWith("<!")) {
      continue;
    }

    if (token.startsWith("</")) {
      stack.pop();
      continue;
    }

    if (token.startsWith("<")) {
      const selfClosing = token.endsWith("/>");
      const inner = token.slice(1, token.length - (selfClosing ? 2 : 1)).trim();
      if (!inner) continue;

      const firstSpace = inner.search(/\s/);
      const name = firstSpace === -1 ? inner : inner.slice(0, firstSpace);
      const attrText = firstSpace === -1 ? "" : inner.slice(firstSpace + 1);
      const node: XmlNode = {
        name,
        attrs: parseAttrs(attrText),
        children: [],
      };

      if (stack.length > 0) {
        stack[stack.length - 1].children.push(node);
      } else {
        root = node;
      }

      if (!selfClosing) {
        stack.push(node);
      }
      continue;
    }

    const text = decodeXmlEntities(token);
    if (stack.length > 0 && text) {
      stack[stack.length - 1].children.push(text);
    }
  }

  if (!root) {
    throw new Error("Failed to parse Utah XML: missing root node");
  }

  return root;
}

function isXmlNode(value: XmlChild): value is XmlNode {
  return typeof value !== "string";
}

function getChildren(node: XmlNode, name: string): XmlNode[] {
  return node.children.filter((child): child is XmlNode => isXmlNode(child) && child.name === name);
}

function getFirstChildText(node: XmlNode, name: string): string | null {
  const child = getChildren(node, name)[0];
  if (!child) return null;
  return normalizeExtractedText(renderInline(child.children)) || null;
}

function renderInline(children: XmlChild[]): string {
  const parts: string[] = [];

  for (const child of children) {
    if (typeof child === "string") {
      parts.push(child);
      continue;
    }

    if (child.name === "eol") {
      parts.push("\n");
      continue;
    }
    if (child.name === "tab") {
      parts.push("  ");
      continue;
    }
    if (child.name === "xref" || child.name === "center" || child.name === "modchap" || child.name === "history") {
      parts.push(renderInline(child.children));
      continue;
    }
    if (child.name === "tbl") {
      const rendered = renderTable(child);
      if (rendered) {
        parts.push(`\n${rendered}\n`);
      }
      continue;
    }
    if (child.name === "subsection") {
      const rendered = renderNestedSubsection(child);
      if (rendered) {
        parts.push(`\n${rendered}`);
      }
      continue;
    }

    parts.push(renderInline(child.children));
  }

  return parts.join("");
}

function renderCell(node: XmlNode): string {
  return normalizeExtractedText(renderInline(node.children));
}

function renderTable(node: XmlNode): string {
  const rows = getChildren(node, "row")
    .map((row) => {
      const cells = getChildren(row, "cell").map(renderCell);
      if (cells.length === 0) return "";
      return `| ${cells.join(" | ")} |`;
    })
    .filter(Boolean);
  return rows.join("\n");
}

function extractTrailingLabel(numberValue: string | undefined): string | null {
  if (!numberValue) return null;
  const matches = Array.from(numberValue.matchAll(/\(([^()]+)\)/g));
  if (matches.length === 0) return null;
  return matches[matches.length - 1][1];
}

function renderNestedSubsection(node: XmlNode): string {
  const label = extractTrailingLabel(node.attrs.number);
  const body = normalizeExtractedText(renderInline(node.children));
  if (!body) return "";
  return label ? `(${label}) ${body}` : body;
}

function renderTopLevelSubsection(node: XmlNode): string {
  const label = extractTrailingLabel(node.attrs.number);
  const body = normalizeExtractedText(renderInline(node.children));
  if (!body) return "";
  return label ? `(${label}) ${body}` : body;
}

function normalizeExtractedText(value: string): string {
  return value
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function normalizeSectionId(raw: string): string {
  let cleaned = raw.trim().replace(/[.,;:\]]+$/, "");
  cleaned = cleaned.replace(/\s+\(/g, "(");
  if (!cleaned) return cleaned;
  if (/^[0-9]/.test(cleaned)) {
    cleaned = `R${cleaned}`;
  }
  if (/^[a-z]/.test(cleaned)) {
    cleaned = cleaned[0].toUpperCase() + cleaned.slice(1);
  }
  return cleaned;
}

function parseTargetRef(text: string): string | null {
  const match = text.match(TARGET_REF_RE);
  if (!match || !match[1]) return null;
  const normalized = normalizeSectionId(match[1]);
  return normalized || null;
}

function classifyOpType(text: string): string {
  const lower = text.toLowerCase();
  if (
    lower.includes("definition for") &&
    lower.includes("modified by adding the words") &&
    lower.includes("after the word")
  ) {
    return "modify_definition_insert_after";
  }
  if (
    lower.includes("deleted and replaced") ||
    lower.includes("amended to read as follows")
  ) {
    return "replace_section";
  }
  if (lower.includes("sentence is added at the end")) {
    return "append_sentence";
  }
  if (lower.includes("new exception is added")) {
    return "add_exception";
  }
  if (lower.includes("definition is added")) {
    return "add_definition";
  }
  return "unknownop";
}

function buildOutputFilename(globalItemNumber: number, targetRef: string | null, opType: string): string {
  const numberPart = String(globalItemNumber).padStart(4, "0");
  const sectionPart = targetRef ? targetRef.replace(/[^A-Za-z0-9.()]+/g, "-") : "UNKNOWN";
  return `${numberPart}_${sectionPart}_${opType || "unknownop"}.txt`;
}

function validateItem(text: string, targetRef: string | null, opType: string): string[] {
  const reasons: string[] = [];
  if (text.length <= 120) {
    reasons.push("text_too_short");
  }
  if (!/(?:A\s+new\s+)?IRC,\s+(?:Section|Sections|Table|Tables|Figure|Figures|Chapter|Chapters)|In\s+IRC/i.test(text)) {
    reasons.push("missing_irc_target_phrase");
  }
  if (!targetRef) {
    reasons.push("missing_target_ref");
  }
  if (opType === "replace_section" && targetRef) {
    const quotedBlocks = Array.from(text.matchAll(/"([^"]+)"/g)).map((m) => m[1]);
    if (quotedBlocks.length > 0) {
      const containsId = quotedBlocks.some((q) =>
        q.toUpperCase().includes(targetRef.toUpperCase())
      );
      if (!containsId) {
        reasons.push("target_ref_not_in_quoted_block");
      }
    }
  }
  return reasons;
}

async function fetchSectionSource(section: number): Promise<{
  htmlUrl: string;
  xmlUrl: string;
  versionId: string;
  htmlText: string;
  xmlText: string;
}> {
  const htmlUrl = `${HTML_BASE_URL}/15A-3-S${section}.html`;
  const { text: htmlText } = await fetchText(htmlUrl);

  const versionMatch =
    htmlText.match(/var\s+versionDefault\s*=\s*"([^"]+)"/) ||
    htmlText.match(/href="(C15A-3-S\d+_[^"]+)\.xml"/);
  if (!versionMatch || !versionMatch[1]) {
    throw new Error(`Could not find version id on ${htmlUrl}`);
  }

  const versionId = versionMatch[1];
  const xmlUrl = new URL(`${versionId}.xml`, `${HTML_BASE_URL}/`).toString();
  const { text: xmlText } = await fetchText(xmlUrl);

  return { htmlUrl, xmlUrl, versionId, htmlText, xmlText };
}

function writeSourceArtifacts(section: number, versionId: string, htmlText: string, xmlText: string) {
  ensureDir(SOURCE_DIR);
  fs.writeFileSync(path.join(SOURCE_DIR, `15A-3-S${section}.html`), htmlText, "utf8");
  fs.writeFileSync(path.join(SOURCE_DIR, `${versionId}.xml`), xmlText, "utf8");
}

function extractItemsFromSectionXml(root: XmlNode, xmlUrl: string): {
  items: ExtractedItem[];
  sectionNumber: string;
  catchline: string | null;
  effDate: string | null;
} {
  if (root.name !== "section") {
    throw new Error(`Unexpected root element '${root.name}', expected 'section'`);
  }

  const sectionNumber = root.attrs.number || "UNKNOWN";
  const catchline = getFirstChildText(root, "catchline");
  const effDate = getFirstChildText(root, "effdate");
  const items = getChildren(root, "subsection").map((subsection) => ({
    utahSection: sectionNumber,
    subsectionNumber: subsection.attrs.number || sectionNumber,
    itemNumberFromSource: extractTrailingLabel(subsection.attrs.number),
    text: renderTopLevelSubsection(subsection),
    sourceXmlUrl: xmlUrl,
    catchline,
    effDate,
  }));

  return { items, sectionNumber, catchline, effDate };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  ensureDir(CODEBOOK_DIR);
  ensureDir(OUTPUT_DIR);
  ensureDir(SOURCE_DIR);
  ensureDir(path.dirname(REPORT_PATH));

  clearGeneratedFiles(OUTPUT_DIR, [".txt"]);
  clearGeneratedFiles(SOURCE_DIR, [".html", ".xml"]);

  const limit = args.limit ?? Number.POSITIVE_INFINITY;
  const sectionSummaries: SectionSource[] = [];
  const results: ItemResult[] = [];

  let globalItemNumber = 0;
  let written = 0;
  let skipped = 0;
  let suspiciousCount = 0;

  for (const section of args.sections) {
    const { htmlUrl, xmlUrl, versionId, htmlText, xmlText } = await fetchSectionSource(section);
    writeSourceArtifacts(section, versionId, htmlText, xmlText);

    const root = parseXml(xmlText);
    const extracted = extractItemsFromSectionXml(root, xmlUrl);

    sectionSummaries.push({
      sectionNumber: extracted.sectionNumber,
      versionId,
      htmlUrl,
      xmlUrl,
      catchline: extracted.catchline,
      effDate: extracted.effDate,
      topLevelItemsDetected: extracted.items.length,
    });

    console.log(
      `[download] section=${extracted.sectionNumber} version=${versionId} items=${extracted.items.length}`
    );

    for (const item of extracted.items) {
      globalItemNumber += 1;

      if (written >= limit) {
        skipped++;
        continue;
      }

      const targetRef = parseTargetRef(item.text);
      const opType = classifyOpType(item.text);

      if (item.text.length < 200) {
        console.warn(
          `[extract] WARNING: Item ${globalItemNumber} (${item.subsectionNumber}) text length < 200 chars (len=${item.text.length})`
        );
      }

      const reasons = validateItem(item.text, targetRef, opType);
      const suspicious = reasons.length > 0;
      if (suspicious) {
        suspiciousCount++;
      }

      const outputFile = buildOutputFilename(globalItemNumber, targetRef, opType);
      const outPath = path.join(OUTPUT_DIR, outputFile);

      const headerLines = [
        `SECTION: IRC Utah Amendments | Utah Section ${item.subsectionNumber} | Target ${targetRef ?? "UNKNOWN"} | Op ${opType}`,
        `SOURCE_URL: ${item.sourceXmlUrl}`,
      ];
      if (item.effDate) {
        headerLines.push(`EFFECTIVE_DATE: ${item.effDate}`);
      }
      if (item.catchline) {
        headerLines.push(`UTAH_CATCHLINE: ${item.catchline}`);
      }

      fs.writeFileSync(outPath, `${headerLines.join("\n")}\n\n${item.text}\n`, "utf8");
      written++;

      results.push({
        itemNumber: globalItemNumber,
        itemNumberFromSource: item.itemNumberFromSource,
        utahSection: item.subsectionNumber,
        sectionId: targetRef,
        opType,
        length: item.text.length,
        outputFile,
        sourceXmlUrl: item.sourceXmlUrl,
        suspicious,
        reasons,
      });

      if (args.debug) {
        const preview = item.text.slice(0, 140).replace(/\s+/g, " ");
        console.log(
          `[item ${globalItemNumber}] utah=${item.subsectionNumber} target=${targetRef ?? "UNKNOWN"} op=${opType} len=${item.text.length} preview="${preview}"`
        );
      }
    }
  }

  const report = {
    sourceType: "utah_section_xml",
    sections: sectionSummaries,
    totalItemsDetected: sectionSummaries.reduce(
      (sum, section) => sum + section.topLevelItemsDetected,
      0
    ),
    minItemsRequired: args.minItems,
    written,
    suspiciousCount,
    skipped,
    results,
    suspicious: results.filter((result) => result.suspicious),
  };

  fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2), "utf8");

  console.log(
    `[download] Summary: sections=${sectionSummaries.length}, detected=${report.totalItemsDetected}, written=${written}, suspicious=${suspiciousCount}, skipped=${skipped}`
  );
  console.log(`[download] Report written to: ${REPORT_PATH}`);

  if (report.totalItemsDetected < args.minItems) {
    console.error(
      `[download] ERROR: Only ${report.totalItemsDetected} items detected, below minimum ${args.minItems}`
    );
    process.exit(1);
  }

  if (suspiciousCount > 0 && !args.allowSuspicious) {
    console.error(
      `[download] ERROR: ${suspiciousCount} suspicious items found (use --allow-suspicious to bypass)`
    );
    process.exit(1);
  }
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`[download] FATAL: ${msg}`);
  process.exit(1);
});
