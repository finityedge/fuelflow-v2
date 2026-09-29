import { useEffect, useState } from 'react';
import type { ExtractedField } from '@fuelflow/shared';
import { AlertIcon, CloseIcon, PencilIcon } from './icons.js';
import { formatTZS } from '../lib/format.js';

/**
 * Everything one correction needs, passed down as one object.
 *
 * The four cards nest rows three or four levels deep, and threading six separate props
 * through every one of them buries the thing each card is actually about. The page still
 * owns all of the state — this is a bundle, not a store.
 */
export interface CorrectionSession {
  mayCorrect: boolean;
  editingFieldId: string | null;
  savingFieldId: string | null;
  start: (fieldId: string) => void;
  cancel: () => void;
  save: (fieldId: string, value: string) => Promise<void>;
}

interface FieldValueProps {
  field: ExtractedField | null | undefined;
  session: CorrectionSession;
  /**
   * How the figure is written. Defaults to shillings; a tank reading is litres and must not
   * be given a currency symbol it never had.
   */
  format?: (value: number | null | undefined) => string;
  size?: 'sm' | 'md' | 'lg';
  /** Shown when the report has no such field at all, rather than an unexplained dash. */
  absent?: string;
}

const SIZE: Record<'sm' | 'md' | 'lg', string> = {
  sm: 'text-sm',
  md: 'text-base',
  lg: 'text-2xl',
};

/**
 * One figure, with the means to correct it and the evidence behind it.
 *
 * A figure that needs review is rendered in the warning colour and carries a written
 * "Correct" button; every other figure keeps the same button as an icon. That asymmetry is
 * deliberate: on a shift with forty rows only one or two are asking for a person, and the
 * one place the eye needs to land should not look like the other thirty-nine.
 */
export function FieldValue({ field, session, format = formatTZS, size = 'md', absent }: FieldValueProps) {
  const [draft, setDraft] = useState(field?.parsedValue ?? '');
  const isEditing = Boolean(field) && session.editingFieldId === field?.id;

  useEffect(() => {
    setDraft(field?.parsedValue ?? '');
  }, [field?.parsedValue, isEditing]);

  if (!field) {
    return <span className="font-mono text-sm text-muted">{absent ?? '—'}</span>;
  }

  if (isEditing) {
    const isSaving = session.savingFieldId === field.id;
    return (
      <form
        className="flex items-center justify-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void session.save(field.id, draft);
        }}
      >
        <input
          autoFocus
          className="input w-32 py-1.5 text-right font-mono text-sm tabular-nums sm:w-40"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault();
              session.cancel();
            }
          }}
          inputMode="decimal"
          aria-label={`Corrected value for ${field.label}`}
        />
        <button
          type="submit"
          className="btn-primary px-3 py-1.5 text-xs"
          disabled={isSaving || draft.trim().length === 0}
        >
          {isSaving ? 'Saving…' : 'Save'}
        </button>
        <button
          type="button"
          className="btn-ghost px-2 py-1.5"
          onClick={session.cancel}
          aria-label="Cancel"
        >
          <CloseIcon className="h-4 w-4" />
        </button>
      </form>
    );
  }

  const flag = field.needsReview;
  const figure =
    field.amount !== null && field.amount !== undefined
      ? format(field.amount)
      : (field.parsedValue ?? '—');

  return (
    <span className="inline-flex items-center justify-end gap-2">
      <span
        className={`font-mono font-semibold tabular-nums ${SIZE[size]} ${
          flag ? 'text-warning' : 'text-body'
        }`}
      >
        {figure}
      </span>

      {session.mayCorrect &&
        (flag ? (
          <button
            type="button"
            className="btn-secondary px-2.5 py-1 text-xs"
            onClick={() => session.start(field.id)}
          >
            <PencilIcon className="h-3.5 w-3.5" />
            Correct
          </button>
        ) : (
          <button
            type="button"
            className="rounded-lg p-1.5 text-muted transition-colors hover:bg-slate-100 hover:text-primary"
            onClick={() => session.start(field.id)}
            aria-label={`Correct ${field.label}`}
            title={`Correct ${field.label}`}
          >
            <PencilIcon className="h-3.5 w-3.5" />
          </button>
        ))}
    </span>
  );
}

/**
 * Why a row is asking for a person, and what the parser saw.
 *
 * A row can hold several figures — an attendant has three — so this takes the row's fields
 * and reports on whichever of them are flagged, naming the figure when there is more than
 * one so "needs your review" does not leave the manager hunting across the row.
 */
export function RowFlags({ fields }: { fields: (ExtractedField | null | undefined)[] }) {
  const present = fields.filter((field): field is ExtractedField => Boolean(field));
  const flagged = present.filter((field) => field.needsReview);
  const corrected = present.filter((field) => field.correctedAt && !field.needsReview);
  const evidence = flagged.filter((field) => field.regionText);

  if (flagged.length === 0 && corrected.length === 0) {
    return null;
  }

  const nameInRow = (field: ExtractedField) => {
    const [, , ...rest] = field.label.split(' - ');
    return rest.length > 0 ? rest.join(' - ') : field.label;
  };

  return (
    <div className="mt-2 space-y-1.5">
      {flagged.map((field) => (
        <p
          key={field.id}
          className="inline-flex items-center gap-1.5 rounded-full bg-warning px-2.5 py-0.5 text-xs font-bold text-white"
        >
          <AlertIcon className="h-3 w-3" />
          {flagged.length > 1 ? `${nameInRow(field)} needs your review` : 'Needs your review'}
        </p>
      ))}

      {flagged
        .filter((field) => field.reviewNote)
        .map((field) => (
          <p key={field.id} className="text-xs text-warning">
            {field.reviewNote}
          </p>
        ))}

      {corrected.length > 0 && (
        <p className="text-xs text-muted">
          Corrected by you
          {corrected.length > 1 ? ` (${corrected.length} figures)` : ''}
        </p>
      )}

      {evidence.length > 0 && (
        <details>
          <summary className="cursor-pointer text-xs font-semibold text-muted hover:text-body">
            Show what was read from the PDF
          </summary>
          <div className="mt-2 space-y-2">
            {evidence.map((field) => (
              <div key={field.id}>
                {evidence.length > 1 && (
                  <p className="mb-1 text-xs font-semibold text-muted">{field.label}</p>
                )}
                <pre className="overflow-x-auto whitespace-pre-wrap rounded-lg bg-slate-900 p-3 font-mono text-xs leading-relaxed text-slate-200">
                  {field.regionText}
                </pre>
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}
