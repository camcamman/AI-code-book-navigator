import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";

const TABLES_ROOT = path.resolve(process.cwd(), "tables");

function getContentType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".pdf") return "application/pdf";
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  return "application/octet-stream";
}

export function GET(request: NextRequest) {
  const relativePath = request.nextUrl.searchParams.get("path");
  if (!relativePath) {
    return NextResponse.json(
      { ok: false, error: "Missing 'path' query parameter." },
      { status: 400 }
    );
  }

  const normalizedRelative = path.normalize(relativePath).replace(/^(\.\.(\/|\\|$))+/, "");
  const resolved = path.resolve(process.cwd(), normalizedRelative);

  if (!resolved.startsWith(TABLES_ROOT + path.sep) && resolved !== TABLES_ROOT) {
    return NextResponse.json(
      { ok: false, error: "Requested asset is outside the tables directory." },
      { status: 403 }
    );
  }

  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    return NextResponse.json(
      { ok: false, error: "Table asset not found." },
      { status: 404 }
    );
  }

  const contentType = getContentType(resolved);
  const data = fs.readFileSync(resolved);

  return new NextResponse(data, {
    status: 200,
    headers: {
      "Content-Type": contentType,
      "Cache-Control": "public, max-age=3600",
      "Content-Disposition": `inline; filename="${path.basename(resolved)}"`,
    },
  });
}
