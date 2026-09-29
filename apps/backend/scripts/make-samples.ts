/**
 * Writes the sample shift-report PDFs used by the manual walkthrough.
 *
 * The fixtures live in `tests/helpers/fixtures.ts` precisely so a PDF built for a
 * walkthrough is the same document the suite asserts against — if the two drifted apart,
 * a passing walkthrough would tell you nothing about the tests. This script is the missing
 * other half of that intent: it builds the PDFs from those fixtures rather than from a
 * copy of their text.
 *
 * The one thing it changes is the date. The fixtures carry a fixed date so the parser
 * tests are stable, but the dashboard measures its window from the date printed on a
 * report — so a fixture dated months ago uploads fine and then appears nowhere, which
 * looks exactly like the dashboard being broken. Samples are stamped with today.
 *
 *   pnpm --filter backend make:samples [output-directory]
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { buildTextPdf } from '../tests/helpers/pdf.js';
import { PARTIAL_REPORT_LINES, TIDY_REPORT_LINES } from '../tests/helpers/fixtures.js';

/** Rewrites a fixture's `Date:` line to today, in the DD/MM/YYYY the parser reads. */
function stamp(lines: string[]): string[] {
  const now = new Date();
  const date = [
    String(now.getDate()).padStart(2, '0'),
    String(now.getMonth() + 1).padStart(2, '0'),
    now.getFullYear(),
  ].join('/');

  return lines.map((line) => (line.startsWith('Date: ') ? `Date: ${date}` : line));
}

const outDir = path.resolve(process.argv[2] ?? 'sample-reports');
mkdirSync(outDir, { recursive: true });

const samples: { file: string; lines: string[] }[] = [
  { file: 'sample-tidy.pdf', lines: TIDY_REPORT_LINES },
  { file: 'sample-partial.pdf', lines: PARTIAL_REPORT_LINES },
];

for (const sample of samples) {
  const target = path.join(outDir, sample.file);
  writeFileSync(target, buildTextPdf(stamp(sample.lines)));
  console.log(`wrote ${target}`);
}
