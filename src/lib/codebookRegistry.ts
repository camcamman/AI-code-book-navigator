// src/lib/codebookRegistry.ts

export type CodebookDef = {
  id: string;
  label: string;
  isAmendment?: boolean;
  baseCodebookId?: string; // if this is an amendment for a base codebook
};

/**
 * Central registry of all codebooks the system knows about.
 *
 * Add new base codebooks here as you index them, e.g.:
 *  - "ibc-utah-2021"
 *  - "city-slc-building-2024"
 */
export const CODEBOOKS: CodebookDef[] = [
  {
    id: "irc-utah-2021",
    label: "IRC Utah Code 2021",
    isAmendment: false,
  },
  {
    id: "utah-amendments",
    label: "Utah Amendments",
    isAmendment: true,
    baseCodebookId: "irc-utah-2021",
  },
  // Later:
  // { id: "ibc-utah-2021", label: "IBC Utah 2021" },
  // { id: "city-xyz-building-2024", label: "City XYZ Building Code 2024" },
];

/**
 * Convenience list: only base codebooks (what the user should pick in the UI).
 */
export const BASE_CODEBOOKS: CodebookDef[] = CODEBOOKS.filter(
  (c) => !c.isAmendment
);

/**
 * Map base codebook -> its amendment codebook (if any).
 * Used by /api/ask to automatically pull amendments.
 */
export const AMENDMENT_MAP: Record<string, string> = (() => {
  const map: Record<string, string> = {};
  for (const def of CODEBOOKS) {
    if (def.isAmendment && def.baseCodebookId) {
      map[def.baseCodebookId] = def.id;
    }
  }
  return map;
})();

/**
 * Helper to look up a codebook definition by id.
 */
export function getCodebookDef(id: string): CodebookDef | undefined {
  return CODEBOOKS.find((c) => c.id === id);
}
