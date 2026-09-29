import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { ShiftReportListItem } from '@fuelflow/shared';
import { Layout } from '../components/Layout.js';
import { PageHeading } from '../components/PageHeading.js';
import { AlertIcon, ChevronRightIcon, FileIcon, UploadIcon } from '../components/icons.js';
import { ReportStatusPill } from '../components/ReportStatusPill.js';
import { useAuthStore } from '../stores/authStore.js';
import { canUpload } from '../lib/rbac.js';
import { listShiftReports } from '../lib/shiftReports.js';
import { formatReportDate, formatTimestamp } from '../lib/format.js';

export function ShiftReports() {
  const user = useAuthStore((state) => state.user);
  const [reports, setReports] = useState<ShiftReportListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const next = await listShiftReports({ limit: 50 });
    setReports(next);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    void (async () => {
      try {
        await load();
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Reports could not be loaded.');
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [load]);

  const uploadAllowed = user ? canUpload(user.role) : false;

  return (
    <Layout>
      <div className="mx-auto max-w-4xl">
        <PageHeading
          title="Shift reports"
          description="Everything uploaded for your stations, newest first."
          actions={
            uploadAllowed && (
              <Link to="/upload" className="btn-primary">
                <UploadIcon className="h-4 w-4" />
                Upload report
              </Link>
            )
          }
        />

        <div className="space-y-4">
        {loading && (
          <div className="card p-10 text-center">
            <span className="mx-auto mb-4 block h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
            <p className="text-sm text-muted">Loading reports…</p>
          </div>
        )}

        {!loading && error && (
          <div className="card p-8 text-center">
            <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-error-subtle text-error">
              <AlertIcon className="h-7 w-7" />
            </div>
            <h2 className="text-lg font-bold text-body">Reports unavailable</h2>
            <p className="mt-2 text-sm text-muted">{error}</p>
            <button type="button" className="btn-primary mt-5" onClick={() => void load()}>
              Try again
            </button>
          </div>
        )}

        {!loading && !error && reports.length === 0 && (
          <div className="card p-10 text-center">
            <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-primary-subtle text-primary">
              <FileIcon className="h-7 w-7" />
            </div>
            <h2 className="text-lg font-bold text-body">No shift reports yet</h2>
            <p className="mt-2 text-sm text-muted">
              Upload a shift report PDF and its figures will appear here.
            </p>
            {uploadAllowed && (
              <Link to="/upload" className="btn-primary mt-5">
                <UploadIcon className="h-4 w-4" />
                Upload report
              </Link>
            )}
          </div>
        )}

        {!loading && !error && reports.length > 0 && (
          <div className="card divide-y divide-border overflow-hidden">
            {reports.map((report) => (
              <Link
                key={report.id}
                to={`/shift-reports/${report.id}`}
                className="flex items-center justify-between gap-4 px-6 py-4 transition-colors hover:bg-slate-50"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-3">
                    <p className="truncate text-sm font-semibold text-body">
                      {formatReportDate(report.reportDate)}
                    </p>
                    <ReportStatusPill report={report} />
                  </div>
                  <p className="mt-1 truncate text-xs text-muted">
                    {report.fileName ? `${report.fileName} · ` : ''}
                    {report.stationName ?? 'Station'} · uploaded{' '}
                    {formatTimestamp(report.uploadedAt)}
                  </p>
                  {report.status === 'FAILED' && report.failureReason && (
                    <p className="mt-1 truncate text-xs text-error">{report.failureReason}</p>
                  )}
                </div>
                <ChevronRightIcon className="h-5 w-5 shrink-0 text-muted" />
              </Link>
            ))}
          </div>
        )}
        </div>
      </div>
    </Layout>
  );
}
