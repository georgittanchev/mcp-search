// PDF -> text with poppler's pdftotext (install poppler-utils).
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const PDFTOTEXT = process.env.PDFTOTEXT || "/usr/bin/pdftotext";
const TIMEOUT_MS = 30_000;

export function isPdf(contentType: string, buf: Buffer): boolean {
  return /application\/(x-)?pdf/i.test(contentType) || buf.subarray(0, 5).toString("latin1") === "%PDF-";
}

/** Text of a PDF, pages separated by form feeds turned into "--- page N ---". */
export async function pdfToText(buf: Buffer): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "web-tools-pdf-"));
  const file = path.join(dir, "doc.pdf");
  try {
    await writeFile(file, buf);
    const out = await new Promise<string>((resolve, reject) => {
      execFile(
        PDFTOTEXT,
        ["-layout", "-enc", "UTF-8", "-q", file, "-"],
        { timeout: TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024, encoding: "utf8" },
        (err, stdout) => (err ? reject(new Error(`pdftotext failed: ${err.message}`)) : resolve(stdout))
      );
    });
    const pages = out.split("\f");
    if (pages.length && !pages[pages.length - 1].trim()) pages.pop();
    return pages
      .map((p, i) => (pages.length > 1 ? `--- page ${i + 1} ---\n` : "") + p.replace(/[ \t]+$/gm, "").replace(/\n{3,}/g, "\n\n").trim())
      .join("\n\n");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
