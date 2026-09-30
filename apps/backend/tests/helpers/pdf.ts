/**
 * Builds a real, minimal PDF containing the given lines of text.
 *
 * Why hand-build one rather than commit a binary fixture: it keeps the text of every
 * fixture readable and reviewable in the test file itself, and it exercises the actual
 * extraction path — pdfjs, our y-coordinate line reconstruction, everything — rather
 * than stubbing `extractPdfText` out. The whole risk in this feature is that what comes
 * out of the PDF is not what a human sees on the page, so a test that skips extraction
 * would skip the part most likely to be wrong.
 *
 * The output is a single page, Helvetica, one `Tj` per line, laid out top to bottom with
 * a 14pt leading. That is deliberately close to how a printed report reaches us.
 */

/** Escape the three characters that are special inside a PDF literal string. */
function escapeText(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

const PAGE_HEIGHT = 792;
const START_Y = 750;
const LEADING = 14;

/** Wrap content-stream operators in a real, single-page PDF with a correct xref table. */
function assemblePdf(content: string): Buffer {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 ${PAGE_HEIGHT}] ` +
      '/Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`,
  ];

  // Assemble with real byte offsets — pdfjs will reconstruct a broken xref table, but a
  // fixture that only works because of the recovery path is not a fixture worth having.
  const header = '%PDF-1.4\n';
  let body = '';
  const offsets: number[] = [];

  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(header + body, 'latin1'));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });

  const xrefOffset = Buffer.byteLength(header + body, 'latin1');
  const xref = [
    'xref',
    `0 ${objects.length + 1}`,
    '0000000000 65535 f ',
    ...offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n `),
    'trailer',
    `<< /Size ${objects.length + 1} /Root 1 0 R >>`,
    'startxref',
    String(xrefOffset),
    '%%EOF',
    '',
  ].join('\n');

  return Buffer.from(header + body + xref, 'latin1');
}

export function buildTextPdf(lines: string[]): Buffer {
  const content = [
    'BT',
    '/F1 10 Tf',
    `50 ${START_Y} Td`,
    `${LEADING} TL`,
    ...lines.flatMap((line) => [`(${escapeText(line)}) Tj`, 'T*']),
    'ET',
  ].join('\n');

  return assemblePdf(content);
}

/**
 * A valid PDF with a page, ink on it, and no text layer — what a scan of a report is.
 *
 * This is the case the text-only parser cannot serve, and the one most likely to arrive in
 * real life: a station prints the shift report, runs it through the office scanner, and
 * uploads the scan. It is a well-formed file, not a corrupt one, which is exactly why it
 * needs its own fixture — a corrupt-file test proves the error is caught, not that a
 * *legitimate* unreadable document is reported as what it is.
 *
 * The page draws two filled rectangles inside a `q`/`Q` save-restore, so pdfjs sees real
 * graphics operators and genuinely zero text items.
 */
export function buildImageOnlyPdf(): Buffer {
  const content = ['q', '0.2 0.2 0.2 rg', '50 700 500 60 re', 'f', '50 80 500 40 re', 'f', 'Q'].join(
    '\n'
  );

  return assemblePdf(content);
}
