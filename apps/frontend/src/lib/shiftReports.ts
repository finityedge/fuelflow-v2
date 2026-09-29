/**
 * Shift report API calls.
 *
 * Uploads use XMLHttpRequest rather than fetch because this runs on a manager's phone
 * over an inconsistent connection: a real progress percentage is the difference between
 * "wait" and "it has hung, try again". Everything else goes through apiClient so the
 * token refresh applies.
 */

import type {
  ExtractedField,
  ShiftReportDetail,
  ShiftReportListPage,
  ShiftReportState,
} from '@fuelflow/shared';
import { apiClient, getAccessToken } from './api.js';

const API_BASE = import.meta.env.VITE_API_BASE_URL ?? '/api';

export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

async function readError(res: Response, fallback: string): Promise<ApiError> {
  try {
    const body = (await res.json()) as { error?: string };
    return new ApiError(res.status, body.error ?? fallback);
  } catch {
    return new ApiError(res.status, fallback);
  }
}

export interface UploadOptions {
  file: File;
  stationId: string;
  /** 0-100, or null when the browser cannot report progress. */
  onProgress?: (percent: number | null) => void;
  signal?: AbortSignal;
}

export interface UploadResult {
  id: string;
  status: string;
  queueWarning: string | null;
}

/**
 * Upload a PDF and get the report id back.
 *
 * Resolves as soon as the server has stored the file — parsing happens in the
 * background, so this returns long before anything has been read.
 */
export function uploadShiftReport({ file, stationId, onProgress, signal }: UploadOptions): Promise<UploadResult> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open('POST', `${API_BASE}/shift-reports/upload`);

    const accessToken = getAccessToken();
    if (accessToken) {
      request.setRequestHeader('Authorization', `Bearer ${accessToken}`);
    }

    request.upload.addEventListener('progress', (event) => {
      if (!onProgress) {
        return;
      }
      onProgress(event.lengthComputable ? Math.round((event.loaded / event.total) * 100) : null);
    });

    request.addEventListener('load', () => {
      let body: unknown = null;
      try {
        body = JSON.parse(request.responseText) as unknown;
      } catch {
        body = null;
      }

      if (request.status >= 200 && request.status < 300 && body) {
        resolve(body as UploadResult);
        return;
      }

      const message =
        body && typeof body === 'object' && 'error' in body && typeof body.error === 'string'
          ? body.error
          : 'The upload failed. Please check your connection and try again.';
      reject(new ApiError(request.status, message));
    });

    request.addEventListener('error', () => {
      reject(new ApiError(0, 'The upload could not reach the server. Check your connection and try again.'));
    });

    request.addEventListener('abort', () => {
      reject(new ApiError(0, 'Upload cancelled.'));
    });

    if (signal) {
      signal.addEventListener('abort', () => request.abort(), { once: true });
    }

    const form = new FormData();
    form.append('stationId', stationId);
    form.append('file', file, file.name);
    // No Content-Type header: the browser must set it so the multipart boundary matches.
    request.send(form);
  });
}

export async function getShiftReport(id: string): Promise<ShiftReportDetail> {
  const res = await apiClient(`/shift-reports/${encodeURIComponent(id)}`);
  if (!res.ok) {
    throw await readError(res, 'That report could not be loaded.');
  }
  return (await res.json()) as ShiftReportDetail;
}

/** The filters the list understands, matching the backend's query schema. */
export interface ShiftReportListQuery {
  stationId?: string;
  status?: ShiftReportState;
  /** Inclusive UTC ISO days, matched against the report's own date. */
  from?: string;
  to?: string;
  limit?: number;
  /** How many matching reports to skip, for "load more". */
  offset?: number;
}

/**
 * One page of reports, plus how many the filter matched in total.
 *
 * The total is what lets the screen say "showing 25 of 63" instead of stopping at 25 and
 * leaving the manager to conclude the other 38 do not exist.
 */
export async function listShiftReports(
  query: ShiftReportListQuery = {}
): Promise<ShiftReportListPage> {
  const params = new URLSearchParams();
  if (query.stationId) {
    params.set('stationId', query.stationId);
  }
  if (query.status) {
    params.set('status', query.status);
  }
  if (query.from) {
    params.set('from', query.from);
  }
  if (query.to) {
    params.set('to', query.to);
  }
  if (query.limit) {
    params.set('limit', String(query.limit));
  }
  if (query.offset) {
    params.set('offset', String(query.offset));
  }
  const search = params.toString();

  const res = await apiClient(`/shift-reports${search ? `?${search}` : ''}`);
  if (!res.ok) {
    throw await readError(res, 'Reports could not be loaded.');
  }
  return (await res.json()) as ShiftReportListPage;
}

export async function correctField(
  reportId: string,
  fieldId: string,
  parsedValue: string
): Promise<{ field: ExtractedField; status: string }> {
  const res = await apiClient(
    `/shift-reports/${encodeURIComponent(reportId)}/fields/${encodeURIComponent(fieldId)}`,
    {
      method: 'PATCH',
      body: JSON.stringify({ parsedValue }),
    }
  );
  if (!res.ok) {
    throw await readError(res, 'That correction could not be saved.');
  }
  return (await res.json()) as { field: ExtractedField; status: string };
}

export async function reparseShiftReport(id: string): Promise<void> {
  const res = await apiClient(`/shift-reports/${encodeURIComponent(id)}/reparse`, { method: 'POST' });
  if (!res.ok) {
    throw await readError(res, 'The report could not be queued for parsing again.');
  }
}
