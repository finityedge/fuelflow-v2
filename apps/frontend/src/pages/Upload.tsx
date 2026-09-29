import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { ShiftReportListItem } from '@fuelflow/shared';
import { useAuthStore } from '../stores/authStore.js';
import { canUpload } from '../lib/rbac.js';
import { Layout } from '../components/Layout.js';
import { PageHeading } from '../components/PageHeading.js';
import { ReportStatusPill } from '../components/ReportStatusPill.js';
import {
  AlertCircleIcon,
  AlertIcon,
  BuildingIcon,
  CheckCircleIcon,
  ChevronRightIcon,
  CloudUploadIcon,
  CloseIcon,
  FileIcon,
  RefreshIcon,
} from '../components/icons.js';
import { apiClient } from '../lib/api.js';
import {
  ApiError,
  getShiftReport,
  listShiftReports,
  uploadShiftReport,
} from '../lib/shiftReports.js';
import {
  formatFileSize,
  formatRelativeTime,
  formatReportDate,
  formatTimestamp,
} from '../lib/format.js';

interface Station {
  id: string;
  name: string;
  location: string | null;
}

/** Upload -> parse -> review. Only one of these is ever on screen at a time. */
type Stage =
  | { name: 'idle' }
  | { name: 'uploading'; percent: number | null }
  | { name: 'parsing'; reportId: string }
  | { name: 'error'; message: string; retryable: boolean };

/**
 * Must match MAX_UPLOAD_BYTES in apps/backend/src/schemas/shiftReport.schema.ts, which is
 * what actually rejects an oversized upload. Checking here as well is not a substitute for
 * that check — it is so a 40 MB file fails in the browser instead of after a long upload
 * over a phone connection, and so the number in the copy is the same one being enforced.
 */
const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;
const MAX_UPLOAD_LABEL = '15 MB';

/** How long the upload screen waits for parsing before handing over to the review screen. */
const PARSE_WAIT_MS = 30_000;
const POLL_INTERVAL_MS = 1_500;
const RECENT_LIMIT = 5;

export function Upload() {
  const navigate = useNavigate();
  const user = useAuthStore((state) => state.user);
  const allowed = user ? canUpload(user.role) : false;

  const [isDragging, setIsDragging] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [stations, setStations] = useState<Station[]>([]);
  const [stationId, setStationId] = useState<string>('');
  const [stage, setStage] = useState<Stage>({ name: 'idle' });

  const [recent, setRecent] = useState<ShiftReportListItem[]>([]);
  const [recentLoading, setRecentLoading] = useState(true);
  const [recentError, setRecentError] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  /** Set when the user cancels, so the aborted request is not reported back as a failure. */
  const cancelledRef = useRef(false);

  useEffect(() => {
    if (!allowed) {
      return;
    }
    let cancelled = false;

    void (async () => {
      try {
        const res = await apiClient('/stations');
        if (!res.ok) {
          return;
        }
        const body = (await res.json()) as { stations: Station[] };
        if (cancelled) {
          return;
        }
        setStations(body.stations);
        // One station means there is nothing to choose: preselect it.
        if (body.stations.length === 1) {
          setStationId(body.stations[0].id);
        }
      } catch {
        // The picker stays empty and the upload button stays disabled with a message,
        // which is a clearer failure than a silent default station.
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [allowed]);

  const loadRecent = useCallback(async () => {
    setRecentLoading(true);
    setRecentError(null);
    try {
      setRecent(await listShiftReports({ limit: RECENT_LIMIT }));
    } catch (error) {
      setRecentError(
        error instanceof Error ? error.message : 'Recent uploads could not be loaded.'
      );
    } finally {
      setRecentLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!allowed) {
      return;
    }
    void loadRecent();
  }, [allowed, loadRecent]);

  const acceptFile = useCallback((candidate: File | undefined) => {
    if (!candidate) {
      return;
    }

    // Rejecting clears any previously chosen file, so the card on screen and the message
    // in the rail always describe the same file.
    const reject = (message: string) => {
      setFile(null);
      setStage({ name: 'error', message, retryable: false });
    };

    if (candidate.type !== 'application/pdf' && !candidate.name.toLowerCase().endsWith('.pdf')) {
      reject(`${candidate.name} is not a PDF. Shift reports come off the pump as PDFs.`);
      return;
    }
    if (candidate.size > MAX_UPLOAD_BYTES) {
      reject(
        `${candidate.name} is ${formatFileSize(candidate.size)}. The limit is ${MAX_UPLOAD_LABEL}.`
      );
      return;
    }

    setFile(candidate);
    setStage({ name: 'idle' });
  }, []);

  const handleDragOver = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    setIsDragging(false);
  }, []);

  const handleDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault();
      setIsDragging(false);
      acceptFile(event.dataTransfer.files[0]);
    },
    [acceptFile]
  );

  const handleFileInput = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      acceptFile(event.target.files?.[0]);
      // Reset so choosing the same file twice still fires a change event.
      event.target.value = '';
    },
    [acceptFile]
  );

  /**
   * Wait for the parse to finish, then hand over to the review screen.
   *
   * On timeout we navigate anyway rather than showing an error: parsing has not failed,
   * it is just slow, and the review screen shows the report's real state with its own
   * retry. A spinner that gives up is worse than a page that tells the truth.
   */
  const waitForParse = useCallback(
    async (reportId: string) => {
      const deadline = Date.now() + PARSE_WAIT_MS;

      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
        try {
          const detail = await getShiftReport(reportId);
          if (detail.report.status !== 'PENDING') {
            navigate(`/shift-reports/${reportId}`);
            return;
          }
        } catch {
          // A dropped connection mid-poll is expected on a phone; keep trying until the
          // deadline rather than declaring the upload failed.
        }
      }

      navigate(`/shift-reports/${reportId}`);
    },
    [navigate]
  );

  const startUpload = useCallback(async () => {
    if (!file || !stationId) {
      return;
    }

    cancelledRef.current = false;
    const controller = new AbortController();
    abortRef.current = controller;
    setStage({ name: 'uploading', percent: 0 });

    try {
      const result = await uploadShiftReport({
        file,
        stationId,
        onProgress: (percent) => setStage({ name: 'uploading', percent }),
        signal: controller.signal,
      });

      setStage({ name: 'parsing', reportId: result.id });
      await waitForParse(result.id);
    } catch (error) {
      // A cancelled upload is not a failure and has nothing to report: the file is still
      // selected, so the honest thing is to put the screen back the way it was.
      if (cancelledRef.current) {
        setStage({ name: 'idle' });
        return;
      }
      const message =
        error instanceof ApiError ? error.message : 'Something went wrong. Please try again.';
      // A 4xx is about the file or the selection, so re-sending it unchanged will fail
      // the same way — only offer a retry when retrying could actually help.
      const retryable = !(error instanceof ApiError) || error.status === 0 || error.status >= 500;
      setStage({ name: 'error', message, retryable });
    } finally {
      abortRef.current = null;
    }
  }, [file, stationId, waitForParse]);

  const cancelUpload = useCallback(() => {
    cancelledRef.current = true;
    abortRef.current?.abort();
  }, []);

  const clearFile = useCallback(() => {
    setFile(null);
    setStage({ name: 'idle' });
  }, []);

  if (!allowed) {
    return (
      <Layout>
        <div className="mx-auto max-w-3xl">
          <PageHeading title="Upload shift report" />
          <div className="card p-8 text-center">
            <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-error-subtle text-error">
              <AlertIcon className="h-7 w-7" />
            </div>
            <h2 className="text-xl font-bold text-body">Access denied</h2>
            <p className="mt-2 text-muted">
              Only owners and managers can upload shift reports. Contact your station owner if you
              need access.
            </p>
          </div>
        </div>
      </Layout>
    );
  }

  const busy = stage.name === 'uploading' || stage.name === 'parsing';
  const fileRejected = stage.name === 'error' && !stage.retryable;

  /**
   * The rail shows exactly one state, because only one of them is ever true. A mock of this
   * screen stacks "ready", "68% uploaded", "parsing" and "failed" in the same column at the
   * same time, which cannot happen in a real session and would leave a manager unable to
   * tell which file the error belonged to.
   */
  function renderStatus() {
    if (stage.name === 'uploading') {
      return (
        <div aria-live="polite">
          <div className="mb-2 flex items-center justify-between text-xs">
            <span className="font-semibold text-body">Uploading</span>
            <span className="font-mono tabular-nums text-muted">
              {stage.percent === null ? '…' : `${stage.percent}%`}
            </span>
          </div>
          <div className="h-2 w-full overflow-hidden rounded-full bg-slate-200">
            <div
              className={`h-full rounded-full bg-primary transition-all duration-300 ${
                stage.percent === null ? 'w-1/3 animate-pulse' : ''
              }`}
              style={stage.percent === null ? undefined : { width: `${stage.percent}%` }}
            />
          </div>
          <button type="button" onClick={cancelUpload} className="btn-secondary mt-4 w-full">
            Cancel upload
          </button>
        </div>
      );
    }

    if (stage.name === 'parsing') {
      return (
        <>
          <div aria-live="polite" className="rounded-xl bg-primary-subtle p-4">
            <div className="flex items-center gap-3">
              <span className="h-5 w-5 shrink-0 animate-spin rounded-full border-2 border-primary border-t-transparent" />
              <div className="min-w-0">
                <p className="text-sm font-semibold text-primary">Reading your report…</p>
                <p className="text-xs text-primary/80">
                  The file is safely uploaded. We are pulling the figures out of it now.
                </p>
              </div>
            </div>
          </div>
          <button
            type="button"
            onClick={() => navigate(`/shift-reports/${stage.reportId}`)}
            className="btn-secondary w-full"
          >
            Open the report now
          </button>
        </>
      );
    }

    if (stage.name === 'error') {
      return (
        <>
          <div aria-live="assertive" className="rounded-xl bg-error-subtle p-4">
            <div className="flex items-start gap-3">
              <AlertCircleIcon className="h-5 w-5 shrink-0 text-error" />
              <div className="min-w-0">
                <p className="text-sm font-semibold text-error">
                  {stage.retryable ? 'Upload failed' : 'That file can’t be used'}
                </p>
                <p className="mt-0.5 text-sm text-error/90">{stage.message}</p>
              </div>
            </div>
          </div>
          {stage.retryable && (
            <button type="button" onClick={() => void startUpload()} className="btn-primary w-full">
              <RefreshIcon className="h-4 w-4" />
              Try again
            </button>
          )}
        </>
      );
    }

    if (!file) {
      return (
        <div className="rounded-2xl border-2 border-dashed border-primary/30 bg-primary-subtle/50 p-6 text-center">
          <CloudUploadIcon className="mx-auto h-8 w-8 text-primary" />
          <p className="mt-3 text-sm font-semibold text-primary">Ready to receive your file</p>
          <p className="mt-1 text-xs text-primary/80">
            Nothing has been sent yet. Choose a PDF on the left to begin.
          </p>
        </div>
      );
    }

    return (
      <p className="text-xs text-muted">
        Nothing has been sent to the server yet. Press “Upload and read report”.
      </p>
    );
  }

  return (
    <Layout>
      <div className="mx-auto max-w-6xl">
        <PageHeading
          title="Upload shift report"
          description="Add the PDF for one shift. We read the figures out of it, then show you anything that needs a second look."
        />

        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
          <div className="space-y-5">
            <div className="card p-5 sm:p-6">
              {stations.length === 0 ? (
                <div className="flex items-start gap-3 rounded-xl bg-warning-subtle p-4 text-sm text-warning">
                  <AlertIcon className="h-5 w-5 shrink-0" />
                  <span>
                    No station is assigned to your account, so a report cannot be filed yet. Ask
                    your station owner to assign you to one.
                  </span>
                </div>
              ) : stations.length > 1 ? (
                <>
                  <label className="label" htmlFor="station">
                    Select station
                  </label>
                  <div className="relative">
                    <BuildingIcon className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
                    <select
                      id="station"
                      className="input pl-11"
                      value={stationId}
                      disabled={busy}
                      onChange={(event) => setStationId(event.target.value)}
                    >
                      <option value="">Choose a station…</option>
                      {stations.map((station) => (
                        <option key={station.id} value={station.id}>
                          {station.name}
                          {station.location ? ` — ${station.location}` : ''}
                        </option>
                      ))}
                    </select>
                  </div>
                </>
              ) : (
                <>
                  {/* One station is not a choice, so it is not drawn as one: a dropdown with
                      a single option invites a click that cannot change anything. It is also
                      a <p> and not a <label>, because there is no form control here for a
                      label to point at. */}
                  <p className="label">Station</p>
                  <div className="flex items-center gap-3 rounded-xl border border-border bg-background px-4 py-3">
                    <BuildingIcon className="h-4 w-4 shrink-0 text-muted" />
                    <span className="min-w-0 truncate text-sm font-medium text-body">
                      {stations[0].name}
                    </span>
                    <span className="ml-auto shrink-0 text-xs text-muted">
                      Your only assigned station
                    </span>
                  </div>
                </>
              )}

              {/* Drop zone — also the fallback picker, because on a phone a tap is the
                  natural gesture and a drag is not available at all. */}
              <div
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                onDrop={handleDrop}
                onClick={() => !busy && fileInputRef.current?.click()}
                role="button"
                tabIndex={0}
                aria-label="Choose a shift report PDF"
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    if (!busy) fileInputRef.current?.click();
                  }
                }}
                className={`mt-5 rounded-2xl border-2 border-dashed px-6 py-10 text-center transition-colors duration-200 ${
                  isDragging
                    ? 'border-primary bg-primary-subtle'
                    : 'border-border bg-slate-50/60 hover:border-primary/40 hover:bg-primary-subtle/40'
                } ${busy ? 'pointer-events-none opacity-60' : 'cursor-pointer'}`}
              >
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="application/pdf"
                  className="hidden"
                  onChange={handleFileInput}
                />
                <div
                  className={`mx-auto flex h-14 w-14 items-center justify-center rounded-2xl transition-colors ${
                    isDragging ? 'bg-primary text-white' : 'bg-primary-subtle text-primary'
                  }`}
                >
                  <CloudUploadIcon className="h-7 w-7" />
                </div>
                <p className="mt-4 text-base font-semibold text-body">
                  {isDragging ? 'Drop to upload' : 'Drag your PDF here'}
                </p>
                <p className="mt-1 text-sm text-muted">or click to browse your device</p>
                <span className="btn-primary mt-5">
                  {file ? 'Choose a different file' : 'Choose file'}
                </span>
              </div>

              <button
                type="button"
                className="btn-primary mt-5 w-full"
                disabled={!file || !stationId || busy || stations.length === 0}
                onClick={() => void startUpload()}
              >
                {stage.name === 'uploading'
                  ? 'Uploading…'
                  : stage.name === 'parsing'
                    ? 'Reading the report…'
                    : 'Upload and read report'}
              </button>

              <p className="mt-4 flex items-center justify-center gap-1.5 text-xs text-muted">
                <CheckCircleIcon className="h-3.5 w-3.5" />
                Petronite shift report PDFs, up to {MAX_UPLOAD_LABEL}
              </p>
            </div>
          </div>

          <aside>
            <div className="card space-y-4 p-5">
              {file && (
                <div className="flex items-start gap-3">
                  <div
                    className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${
                      fileRejected ? 'bg-error-subtle text-error' : 'bg-primary-subtle text-primary'
                    }`}
                  >
                    <FileIcon className="h-5 w-5" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold text-body" title={file.name}>
                      {file.name}
                    </p>
                    <p className="text-xs text-muted">{formatFileSize(file.size)}</p>
                  </div>
                  {!busy && (
                    <button
                      type="button"
                      onClick={clearFile}
                      aria-label={`Remove ${file.name}`}
                      className="rounded-lg p-1.5 text-muted transition-colors hover:bg-error-subtle hover:text-error"
                    >
                      <CloseIcon className="h-4 w-4" />
                    </button>
                  )}
                </div>
              )}

              {renderStatus()}
            </div>
          </aside>
        </div>

        <RecentUploads
          reports={recent}
          loading={recentLoading}
          error={recentError}
          onRetry={() => void loadRecent()}
        />
      </div>
    </Layout>
  );
}

/**
 * The last few uploads, so the screen answers "did my last one work?" without a trip to
 * another page. File names rather than dates lead the row, because the file name is what a
 * manager recognises their own upload by.
 */
function RecentUploads({
  reports,
  loading,
  error,
  onRetry,
}: {
  reports: ShiftReportListItem[];
  loading: boolean;
  error: string | null;
  onRetry: () => void;
}) {
  return (
    <div className="card mt-6 overflow-hidden">
      <div className="flex items-center justify-between gap-4 border-b border-border px-5 py-4">
        <h2 className="flex items-center gap-2 text-sm font-bold text-body">
          <FileIcon className="h-4 w-4 text-primary" />
          Recent uploads
        </h2>
        <Link
          to="/shift-reports/recent"
          className="text-sm font-semibold text-primary hover:text-primary-dark"
        >
          View all
        </Link>
      </div>

      {loading && (
        <div className="flex items-center gap-3 px-5 py-6 text-sm text-muted">
          <span className="h-4 w-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          Loading recent uploads…
        </div>
      )}

      {!loading && error && (
        <div className="flex items-start gap-3 px-5 py-6">
          <AlertCircleIcon className="h-5 w-5 shrink-0 text-error" />
          <div className="min-w-0">
            <p className="text-sm text-body">{error}</p>
            <button type="button" onClick={onRetry} className="btn-secondary mt-3">
              <RefreshIcon className="h-4 w-4" />
              Try again
            </button>
          </div>
        </div>
      )}

      {!loading && !error && reports.length === 0 && (
        <p className="px-5 py-6 text-sm text-muted">
          No shift reports yet. The first one you upload will appear here.
        </p>
      )}

      {!loading && !error && reports.length > 0 && (
        <>
          <div className="hidden grid-cols-[minmax(0,1fr)_9rem_10rem_1.5rem] gap-4 bg-slate-50 px-5 py-2.5 text-xs font-semibold uppercase tracking-wide text-muted sm:grid">
            <span>File</span>
            <span>Uploaded</span>
            <span>Status</span>
            <span />
          </div>
          <ul className="divide-y divide-border">
            {reports.map((report) => (
              <li key={report.id}>
                <Link
                  to={`/shift-reports/${report.id}`}
                  className="grid grid-cols-1 items-center gap-x-4 gap-y-2 px-5 py-3.5 transition-colors hover:bg-slate-50 sm:grid-cols-[minmax(0,1fr)_9rem_10rem_1.5rem]"
                >
                  <div className="flex min-w-0 items-center gap-3">
                    <FileIcon className="h-4 w-4 shrink-0 text-primary" />
                    <div className="min-w-0">
                      <p
                        className="truncate text-sm font-medium text-body"
                        title={report.fileName ?? undefined}
                      >
                        {report.fileName ?? formatReportDate(report.reportDate)}
                      </p>
                      {report.status === 'FAILED' && report.failureReason && (
                        <p className="truncate text-xs text-error" title={report.failureReason}>
                          {report.failureReason}
                        </p>
                      )}
                    </div>
                  </div>
                  <span
                    className="text-xs text-muted sm:text-sm"
                    title={formatTimestamp(report.uploadedAt)}
                  >
                    {formatRelativeTime(report.uploadedAt)}
                  </span>
                  <div>
                    <ReportStatusPill report={report} />
                  </div>
                  <ChevronRightIcon className="hidden h-4 w-4 justify-self-end text-muted sm:block" />
                </Link>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
