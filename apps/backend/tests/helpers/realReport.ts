/**
 * The real shift report, loaded from disk at test time.
 *
 * It is kept out of the repository on purpose: it is one station's actual day shift, with the
 * attendants' and customers' real names and a real bank account number on it, and none of that
 * belongs in a checkout. What the parser has to read is the *text*: the column positions, the
 * seven-figure tank row, the extra attendant column, the arithmetic the report's own figures tie
 * out to. Those live in the sample; the identities on it do not carry any of that.
 *
 * So the sample is a gitignored data file (`tests/fixtures/real-kisemvule-report.txt`) and the
 * assertions about it are committed beside this loader. A checkout without the sample skips those
 * tests rather than failing them, and a checkout with it runs them — which is the same shape as
 * the uploaded-PDF handling: the document stays local, the reasoning about it does not.
 *
 * Read synchronously rather than imported, because an `import` of a file that is deliberately not
 * in the repository is a build error for everyone who does not have it. This returns null instead.
 */
import { readFileSync } from 'node:fs';

const SAMPLE_PATH = new URL('../fixtures/real-kisemvule-report.txt', import.meta.url);

function load(): string | null {
  try {
    return readFileSync(SAMPLE_PATH, 'utf8');
  } catch {
    return null;
  }
}

/** The report's text, or null when the sample is not present on this machine. */
export const realShiftReportSample: string | null = load();

/**
 * True when the sample is absent, so the tests about it should be skipped rather than failed.
 *
 * Named for what it means at the call site — `describe.skipIf(sampleMissing)` — because the bare
 * `realShiftReportSample === null` reads as a condition on the report rather than on the machine.
 */
export const sampleMissing = realShiftReportSample === null;
