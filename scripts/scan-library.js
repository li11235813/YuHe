import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import * as pdfParse from "pdf-parse";

const LIBRARY_ROOT = process.env.BOOKS_DIR || "D:\\18\\Desktop\\书籍";
const OUTPUT_DIR = path.resolve("data");
const MANIFEST_PATH = path.join(OUTPUT_DIR, "library.json");
const PDF_TEXT_DIR = path.join(OUTPUT_DIR, "pdf-text");
const SUPPORTED_EXTS = new Set([".epub", ".txt", ".pdf"]);

async function main() {
  await fs.mkdir(OUTPUT_DIR, { recursive: true });
  await fs.mkdir(PDF_TEXT_DIR, { recursive: true });

  const files = await walk(LIBRARY_ROOT);
  const books = [];

  for (const filePath of files) {
    const ext = path.extname(filePath).toLowerCase();
    if (!SUPPORTED_EXTS.has(ext)) continue;

    const relativePath = path.relative(LIBRARY_ROOT, filePath);
    const id = createId(relativePath);
    const title = prettifyTitle(path.basename(filePath, ext));
    const stats = await fs.stat(filePath);
    const book = {
      id,
      title,
      ext: ext.slice(1),
      type: ext === ".epub" ? "epub" : "text",
      relativePath,
      size: stats.size,
      updatedAt: stats.mtimeMs,
      hasExtractedText: ext === ".pdf",
    };

    if (ext === ".pdf") {
      const pdfTextPath = path.join(PDF_TEXT_DIR, `${id}.txt`);
      book.textEndpoint = `/api/books/${id}/text`;
      await extractPdfText(filePath, pdfTextPath);
    } else if (ext === ".txt") {
      book.textEndpoint = `/api/books/${id}/text`;
    }

    books.push(book);
  }

  books.sort((a, b) => a.title.localeCompare(b.title, "zh-CN"));
  await fs.writeFile(
    MANIFEST_PATH,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        libraryRoot: LIBRARY_ROOT,
        total: books.length,
        books,
      },
      null,
      2
    ),
    "utf8"
  );

  console.log(`Scanned ${books.length} books into ${MANIFEST_PATH}`);
}

async function walk(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walk(fullPath)));
    } else if (entry.isFile()) {
      files.push(fullPath);
    }
  }

  return files;
}

function createId(input) {
  return crypto.createHash("sha1").update(input).digest("hex").slice(0, 12);
}

function prettifyTitle(filename) {
  return filename
    .replace(/\s*\((z-library|1lib|z-lib)[^)]+\)/gi, "")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function extractPdfText(filePath, outputPath) {
  try {
    const data = await fs.readFile(filePath);
    const pdf = pdfParse.default || pdfParse;
    const parsed = await pdf(data);
    const normalized = parsed.text.replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
    await fs.writeFile(outputPath, normalized, "utf8");
  } catch (error) {
    const message = `PDF text extraction failed for ${filePath}\n\n${String(error)}`;
    await fs.writeFile(outputPath, message, "utf8");
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
