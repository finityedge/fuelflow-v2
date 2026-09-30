import type { StationSummary } from '@fuelflow/shared';
import { BuildingIcon, CalendarIcon } from './icons.js';
import {
  DATE_RANGE_FILTERS,
  STATUS_FILTERS,
  type DateRangeFilter,
  type StatusFilter,
} from '../lib/reportFilters.js';

/**
 * The filter bar above the reports list.
 *
 * Three controls, each narrowing a different thing, and one of them is not in the mock:
 * the mock's status row offers "Balanced", which is a statement about the money standing in
 * for a statement about the report. See `reportFilters.ts` for why it is not here. What is
 * here is the report's own status, which is what a status filter can honestly mean.
 *
 * A note on the counts a filter implies: none of these controls says "12 matches" before you
 * pick it. That would mean a request per option on every keystroke, and a number that is
 * wrong by the time it renders is worse than no number. The count that is true — how many
 * reports the current filter matched — is stated under the list.
 */
export function ReportFilterBar({
  stations,
  stationId,
  status,
  range,
  onStationChange,
  onStatusChange,
  onRangeChange,
  onClear,
}: {
  stations: StationSummary[];
  stationId: string;
  status: StatusFilter;
  range: DateRangeFilter;
  onStationChange: (value: string) => void;
  onStatusChange: (value: StatusFilter) => void;
  onRangeChange: (value: DateRangeFilter) => void;
  onClear: () => void;
}) {
  const isFiltered = stationId !== '' || status !== 'ALL' || range !== 'ALL';

  return (
    <div className="card mb-5 flex flex-col gap-4 p-4 lg:flex-row lg:items-center lg:gap-6">
      {/* Only worth offering with more than one station to choose between. */}
      {stations.length > 1 && (
        <div className="lg:w-64 lg:shrink-0">
          <label htmlFor="report-station" className="label">
            Station
          </label>
          <div className="relative">
            <BuildingIcon className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
            <select
              id="report-station"
              className="input py-2.5 pl-11 pr-8"
              value={stationId}
              onChange={(event) => onStationChange(event.target.value)}
            >
              <option value="">All stations</option>
              {stations.map((station) => (
                <option key={station.id} value={station.id}>
                  {station.name}
                </option>
              ))}
            </select>
          </div>
        </div>
      )}

      <div className="min-w-0 flex-1">
        <p className="label" id="report-status-label">
          Status
        </p>
        <div
          className="inline-flex flex-wrap gap-1 rounded-xl border border-border bg-surface p-1"
          role="group"
          aria-labelledby="report-status-label"
        >
          {STATUS_FILTERS.map((option) => (
            <button
              key={option.value}
              type="button"
              onClick={() => onStatusChange(option.value)}
              aria-pressed={status === option.value}
              className={`whitespace-nowrap rounded-lg px-3 py-1.5 text-sm font-semibold transition-colors ${
                status === option.value ? 'bg-primary text-white' : 'text-muted hover:text-body'
              }`}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>

      <div className="lg:w-44 lg:shrink-0">
        <label htmlFor="report-range" className="label">
          Date range
        </label>
        <div className="relative">
          <CalendarIcon className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
          <select
            id="report-range"
            className="input py-2.5 pl-11 pr-8"
            value={range}
            onChange={(event) => onRangeChange(event.target.value as DateRangeFilter)}
          >
            {DATE_RANGE_FILTERS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Only offered once something is actually filtered: a permanent "Clear filters" on an
          unfiltered list is a button that does nothing. */}
      {isFiltered && (
        <button type="button" onClick={onClear} className="btn-ghost lg:mt-6 lg:shrink-0">
          Clear filters
        </button>
      )}
    </div>
  );
}
