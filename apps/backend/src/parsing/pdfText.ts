/**
 * PDF -> text extraction.
 *
 * Isolated behind one function on purpose: the parser is a pure function of report text,
 * so all the PDF-library coupling lives here and the parsing rules stay unit-testable
 * against plain strings.
 *
 * Text is reconstructed line by line from the glyph positions rather than read in
 * content-stream order, because a printed report lays out label and figure as separate
 * text runs on the same visual line and those two must end up on the same line of
 * output for the label-anchored rules to find them.
 */

interface PdfTextItem {
  str?: string;
  transform?: number[];
}

interface PdfTextContent {
  items: PdfTextItem[];
}

interface PdfPage {
  getTextContent(): Promise<PdfTextContent>;
  cleanup(): void;
}

interface PdfDocument {
  numPages: number;
  getPage(pageNumber: number): Promise<PdfPage>;
  destroy(): Promise<void>;
}

interface PdfJsModule {
  getDocument(options: Record<string, unknown>): { promise: Promise<PdfDocument> };
}

let pdfjsPromise: Promise<PdfJsModule> | null = null;

/**
 * Loaded lazily and cached: the legacy build is large, and the frontend-only paths
 * (health checks, auth) should never pay for it.
 */
function loadPdfjs(): Promise<PdfJsModule> {
  pdfjsPromise ??= import('pdfjs-dist/legacy/build/pdf.mjs') as unknown as Promise<PdfJsModule>;
  return pdfjsPromise;
}

/** Group glyphs into visual lines, then order lines top-to-bottom and words left-to-right. */
function renderPageText(items: PdfTextItem[]): string {
  const lines = new Map<number, { x: number; str: string }[]>();

  for (const item of items) {
    const str = item.str;
    if (typeof str !== 'string' || str.trim() === '') {
      continue;
    }
    const transform = item.transform ?? [];
    const x = typeof transform[4] === 'number' ? transform[4] : 0;
    const rawY = typeof transform[5] === 'number' ? transform[5] : 0;
    // Round to 2pt buckets: sub-pixel baseline jitter within one printed line should not
    // split it into several lines.
    const y = Math.round(rawY / 2) * 2;

    const bucket = lines.get(y);
    if (bucket) {
      bucket.push({ x, str });
    } else {
      lines.set(y, [{ x, str }]);
    }
  }

  return [...lines.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([, parts]) =>
      parts
        .sort((a, b) => a.x - b.x)
        .map((part) => part.str)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim()
    )
    .filter((line) => line.length > 0)
    .join('\n');
}

/** Extract the full text of a PDF. Returns '' for a PDF with no text layer (e.g. a scan). */
export async function extractPdfText(data: Buffer): Promise<string> {
  const pdfjs = await loadPdfjs();

  const document = await pdfjs.getDocument({
    // pdfjs reads the array in place and detaches it, so hand it a copy of the buffer.
    data: new Uint8Array(data),
    isEvalSupported: false,
    useSystemFonts: false,
    useWorkerFetch: false,
    disableFontFace: true,
    verbosity: 0,
  }).promise;

  try {
    const pages: string[] = [];
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      try {
        pages.push(renderPageText((await page.getTextContent()).items));
      } finally {
        page.cleanup();
      }
    }
    return pages.join('\n');
  } finally {
    await document.destroy();
  }
}
