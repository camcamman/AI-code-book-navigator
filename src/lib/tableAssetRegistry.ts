import fs from "node:fs";
import path from "node:path";

type ChunkLike = {
  codebookId: string;
  sourcePath: string;
  meta?: Record<string, unknown>;
};

export type TableAssetRecord = {
  codebookId: string;
  page: number;
  label: string | null;
  pdfPath: string;
  imagePath: string | null;
};

export type ResolvedTableAsset = {
  isTable: true;
  tablePage: number;
  tableLabel: string | null;
  tablePdfPath: string | null;
  tableImagePath: string | null;
  tablePdfUrl: string | null;
  tableImageUrl: string | null;
};

const TABLE_EXPORT_FILES: Record<string, string> = {
  "irc-utah-2021": path.join(
    process.cwd(),
    "tables",
    "2024_irc_2nd_printing_tables.json"
  ),
};

const assetCache = new Map<string, TableAssetRecord[]>();
const sourceHeaderCache = new Map<
  string,
  { page: number | null; tableId: string | null; caption: string | null }
>();

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function normalizeTableLabel(text: string | null | undefined): string {
  const raw = normalizeWhitespace(String(text || ""));
  if (!raw) return "";
  return raw
    .replace(/[–—]/g, "-")
    .replace(/\s*-\s*continued$/i, "")
    .toUpperCase();
}

function inferTableIdFromSourcePath(sourcePath: string): string | null {
  const base = path.basename(sourcePath, path.extname(sourcePath));
  const match = base.match(/^table_(.+)$/i);
  return match?.[1] ? match[1] : null;
}

function readSourceHeader(
  sourcePath: string
): { page: number | null; tableId: string | null; caption: string | null } {
  const cached = sourceHeaderCache.get(sourcePath);
  if (cached) return cached;

  const result = {
    page: null as number | null,
    tableId: null as string | null,
    caption: null as string | null,
  };

  const resolved = path.resolve(process.cwd(), sourcePath);
  if (!fs.existsSync(resolved)) {
    sourceHeaderCache.set(sourcePath, result);
    return result;
  }

  const ext = path.extname(resolved).toLowerCase();
  try {
    if (ext === ".txt") {
      const header = fs.readFileSync(resolved, "utf8").split(/\r?\n/).slice(0, 20);
      for (const line of header) {
        const pageMatch = line.match(/^PDF_PAGE:\s*(\d+)/i);
        if (pageMatch && result.page === null) {
          result.page = Number(pageMatch[1]);
        }
        const tableIdMatch = line.match(/^TABLE_ID:\s*(.+)$/i);
        if (tableIdMatch && result.tableId === null) {
          result.tableId = normalizeWhitespace(tableIdMatch[1]);
        }
        const captionMatch = line.match(/^CAPTION:\s*(.+)$/i);
        if (captionMatch && result.caption === null) {
          result.caption = normalizeWhitespace(captionMatch[1]);
        }
      }
    } else if (ext === ".json") {
      const parsed = JSON.parse(fs.readFileSync(resolved, "utf8")) as Record<
        string,
        unknown
      >;
      if (typeof parsed.page === "number" && Number.isFinite(parsed.page)) {
        result.page = parsed.page > 0 ? parsed.page : null;
      } else if (
        Array.isArray(parsed.pdf_pages) &&
        typeof parsed.pdf_pages[0] === "number"
      ) {
        result.page = parsed.pdf_pages[0] > 0 ? parsed.pdf_pages[0] : null;
      }
      if (typeof parsed.table_id === "string") {
        result.tableId = normalizeWhitespace(parsed.table_id);
      }
      if (typeof parsed.caption === "string") {
        result.caption = normalizeWhitespace(parsed.caption);
      }
    }
  } catch {
    // Best-effort enrichment only.
  }

  sourceHeaderCache.set(sourcePath, result);
  return result;
}

function loadTableAssets(codebookId: string): TableAssetRecord[] {
  const cached = assetCache.get(codebookId);
  if (cached) return cached;

  const metadataPath = TABLE_EXPORT_FILES[codebookId];
  if (!metadataPath || !fs.existsSync(metadataPath)) {
    assetCache.set(codebookId, []);
    return [];
  }

  const parsed = JSON.parse(fs.readFileSync(metadataPath, "utf8")) as unknown;
  const rows = Array.isArray(parsed) ? parsed : [];
  const records: TableAssetRecord[] = rows
    .map((row) => {
      if (!row || typeof row !== "object") return null;
      const item = row as Record<string, unknown>;
      const page =
        typeof item.page === "number" && Number.isFinite(item.page) && item.page > 0
          ? item.page
          : null;
      const pdfPath =
        typeof item.pdfPath === "string" ? normalizeWhitespace(item.pdfPath) : "";
      if (!page || !pdfPath) return null;
      return {
        codebookId:
          typeof item.codebookId === "string"
            ? normalizeWhitespace(item.codebookId)
            : codebookId,
        page,
        label:
          typeof item.label === "string" ? normalizeWhitespace(item.label) : null,
        pdfPath,
        imagePath:
          typeof item.imagePath === "string"
            ? normalizeWhitespace(item.imagePath)
            : null,
      };
    })
    .filter((item): item is TableAssetRecord => item !== null);

  assetCache.set(codebookId, records);
  return records;
}

function buildAssetUrl(relativePath: string | null): string | null {
  if (!relativePath) return null;
  return `/api/table-assets?path=${encodeURIComponent(relativePath)}`;
}

export function resolveTableAssetForRef(
  codebookId: string,
  tableRef: string
): ResolvedTableAsset | null {
  const tableAssets = loadTableAssets(codebookId);
  if (tableAssets.length === 0) return null;

  const normalizedTarget = normalizeTableLabel(`Table ${tableRef}`);
  const matches = tableAssets.filter((entry) => {
    const normalizedLabel = normalizeTableLabel(entry.label);
    return normalizedLabel === normalizedTarget;
  });

  const match = matches[0];
  if (!match) return null;

  return {
    isTable: true,
    tablePage: match.page,
    tableLabel: match.label ?? `Table ${tableRef}`,
    tablePdfPath: match.pdfPath,
    tableImagePath: match.imagePath ?? null,
    tablePdfUrl: buildAssetUrl(match.pdfPath),
    tableImageUrl: buildAssetUrl(match.imagePath ?? null),
  };
}

export function resolveTableAssetForChunk(
  chunk: ChunkLike
): ResolvedTableAsset | null {
  const sourcePath = String(chunk.sourcePath || "");
  const meta = (chunk.meta ?? {}) as Record<string, unknown>;

  const sourceLooksLikeTable =
    /(^|\/)table_/i.test(sourcePath) ||
    typeof meta.tableId === "string" ||
    (typeof meta.caption === "string" && /^table\b/i.test(String(meta.caption))) ||
    (typeof meta.sectionLabel === "string" &&
      /^table\b/i.test(String(meta.sectionLabel)));

  if (!sourceLooksLikeTable) return null;

  const header = readSourceHeader(sourcePath);
  const pageFromMeta =
    typeof meta.page === "number" && Number.isFinite(meta.page) && meta.page > 0
      ? meta.page
      : null;
  const tablePage = pageFromMeta ?? header.page;
  const tableId =
    (typeof meta.tableId === "string" && normalizeWhitespace(meta.tableId)) ||
    header.tableId ||
    inferTableIdFromSourcePath(sourcePath);
  const chunkLabel =
    (typeof meta.caption === "string" && normalizeWhitespace(meta.caption)) ||
    (typeof meta.sectionLabel === "string" &&
      normalizeWhitespace(meta.sectionLabel)) ||
    header.caption ||
    (tableId ? `Table ${tableId}` : null);

  const tableAssets = loadTableAssets(chunk.codebookId);
  if (tableAssets.length === 0) {
    return {
      isTable: true,
      tablePage: tablePage ?? 0,
      tableLabel: chunkLabel,
      tablePdfPath: null,
      tableImagePath: null,
      tablePdfUrl: null,
      tableImageUrl: null,
    };
  }

  let match: TableAssetRecord | undefined;
  if (chunkLabel) {
    const normalizedChunkLabel = normalizeTableLabel(chunkLabel);
    match = tableAssets.find(
      (entry) => normalizeTableLabel(entry.label) === normalizedChunkLabel
    );
  }

  if (!match && tableId) {
    const normalizedTableId = normalizeTableLabel(`Table ${tableId}`);
    match = tableAssets.find(
      (entry) => normalizeTableLabel(entry.label) === normalizedTableId
    );
  }

  if (!match && tablePage !== null) {
    match = tableAssets.find((entry) => entry.page === tablePage);
  }

  return {
    isTable: true,
    tablePage: match?.page ?? tablePage ?? 0,
    tableLabel: match?.label ?? chunkLabel,
    tablePdfPath: match?.pdfPath ?? null,
    tableImagePath: match?.imagePath ?? null,
    tablePdfUrl: buildAssetUrl(match?.pdfPath ?? null),
    tableImageUrl: buildAssetUrl(match?.imagePath ?? null),
  };
}
