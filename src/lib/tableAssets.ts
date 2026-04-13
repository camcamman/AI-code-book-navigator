import { resolveTableAssetForChunk } from "./tableAssetRegistry";

export function getTableAssetInfoForSource(input: {
  codebookId: string;
  sourcePath: string;
  meta?: Record<string, unknown>;
}): {
  isTable: boolean;
  tableLabel?: string;
  tablePage?: number;
  tablePdfPath?: string;
  tableImagePath?: string;
  tablePdfUrl?: string;
  tableImageUrl?: string;
} | null {
  const match = resolveTableAssetForChunk({
    codebookId: input.codebookId,
    sourcePath: input.sourcePath,
    meta: input.meta,
  });

  if (!match) return null;

  return {
    isTable: true,
    tableLabel: match.tableLabel ?? undefined,
    tablePage: match.tablePage || undefined,
    tablePdfPath: match.tablePdfPath ?? undefined,
    tableImagePath: match.tableImagePath ?? undefined,
    tablePdfUrl: match.tablePdfUrl ?? undefined,
    tableImageUrl: match.tableImageUrl ?? undefined,
  };
}
