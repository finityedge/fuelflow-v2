import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import type {
  AttendantSummary,
  ManagedUser,
  StationDetail,
  StationSummary,
  TankSummary,
} from '@fuelflow/shared';
import { Layout } from '../components/Layout.js';
import { PageHeading } from '../components/PageHeading.js';
import {
  AlertCircleIcon,
  BuildingIcon,
  InfoIcon,
  PencilIcon,
  PlusIcon,
  RefreshIcon,
  SettingsIcon,
  ShieldCheckIcon,
  TankIcon,
  TrashIcon,
  UsersIcon,
} from '../components/icons.js';
import {
  createAttendant,
  createStation,
  createTank,
  getStationDetail,
  linkAttendantAlias,
  listStations,
  unlinkAttendantAlias,
  updateAttendant,
  updateStation,
  updateTank,
} from '../lib/stations.js';
import { canAdministerStation, canManageUsers, canUpload, roleLabel } from '../lib/rbac.js';
import { createUser, listUsers, updateUser, type ProvisionableRole } from '../lib/users.js';
import { useAuthStore } from '../stores/authStore.js';
import { formatLitres, formatTZS } from '../lib/format.js';

/**
 * Station settings: what a station is, and what is set up on it.
 *
 * This is the screen that makes a station's own vocabulary line up with the paper. Every
 * figure in the product is derived from field names the parser writes — `tank:<key>:book_stock`,
 * `attendant:<key>:expected` — and a station that has no record for one of those keys shows
 * the loss in an "unmapped" panel and nowhere else. Settings is where the key is claimed.
 *
 * Three things shape the screen:
 *
 *  - **Two guards, not one.** The server lets a manager fill in a station's tanks and
 *    attendants but reserves the station's own identity — its name, whether it is trading,
 *    what a shift may be out by — for the owner (`canAdministerStation` in `routes/stations.ts`).
 *    The screen mirrors both, because a button that the API is going to refuse is worse than
 *    no button: it turns a permissions boundary into an error message.
 *  - **A name and a key are different fields.** The name is what is printed on the report and
 *    the key is what the parser derives from it. They are usually the same shape and are not
 *    the same thing, so both are shown and both are editable. Renaming without sending the key
 *    re-derives it, which is right for a typo fix and wrong for anything else — so the form
 *    always sends the key it was shown.
 *  - **Nothing here is deleted.** A tank, an attendant and a station are all retired, and an
 *    alias is unlinked. Every one of those is reversible, which is why none of them asks for
 *    confirmation first: the button that undoes it is the button that did it.
 *
 * The station list is loaded with `includeInactive`, alone among the screens, because this is
 * the only place a station that has stopped trading can be seen — and therefore the only place
 * it can be brought back.
 */
export function StationSettings() {
  const user = useAuthStore((state) => state.user);
  const [searchParams] = useSearchParams();

  /** Set by the leakage screen when a report names a tank the station has not set up. */
  const requestedTankSlug = searchParams.get('newTank');

  const [stations, setStations] = useState<StationSummary[]>([]);
  const [stationId, setStationId] = useState('');
  const [detail, setDetail] = useState<StationDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [addingTank, setAddingTank] = useState(requestedTankSlug !== null);
  /**
   * The key the leaked tank was reported under, held apart from the form's open state so it is
   * spent once. Arriving from the leakage screen opens the form on that exact key; switching
   * station or opening the form by hand afterwards must not carry it over, or the next tank
   * added would silently claim a key that belonged to the station just left.
   */
  const [tankPrefill, setTankPrefill] = useState<string | null>(requestedTankSlug);
  const [addingAttendant, setAddingAttendant] = useState(false);

  const canConfigure = user ? canAdministerStation(user.role) : false;
  /**
   * The other of the server's two guards: a manager fills in the station they run. `canUpload`
   * is the same OWNER-or-MANAGER predicate, and it is the same boundary — filling in a
   * station's set-up is the job somebody uploads against it.
   */
  const canManageContents = user ? canUpload(user.role) : false;
  /**
   * The third guard, and the only one that is not mirrored from this screen's own endpoints:
   * provisioning lives on `/users`, where an owner adds logins and moves them between stations.
   */
  const canProvision = user ? canManageUsers(user.role) : false;

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const next = await listStations({ includeInactive: true });
        if (cancelled) {
          return;
        }
        setStations(next);
        // `?stationId=` first, so a link from the leakage screen opens on the station that
        // needed it. Then the first station, which is the only sensible default when there is
        // nothing to go on. A station id that is not in the list is ignored rather than
        // trusted: it would have been refused by the API anyway, and an error page for a
        // stale bookmark is a poor way to learn that.
        const requested = searchParams.get('stationId');
        setStationId((current) => {
          if (current) {
            return current;
          }
          if (requested && next.some((station) => station.id === requested)) {
            return requested;
          }
          return next[0]?.id ?? '';
        });
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Your stations could not be loaded.');
          setLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [searchParams]);

  const load = useCallback(async () => {
    if (!stationId) {
      setDetail(null);
      setLoading(false);
      return;
    }
    const next = await getStationDetail(stationId);
    setDetail(next);
  }, [stationId]);

  useEffect(() => {
    if (!stationId) {
      return;
    }
    let cancelled = false;
    /* The open station is cleared before the next one is fetched, where the other screens in
       this app deliberately keep the old figures up. An edit form is the reason: a form still
       holding one station's tank under another station's name is one keystroke and a save away
       from writing to the wrong forecourt, and a moment of blankness is a small price. */
    setDetail(null);
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        await load();
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'That station could not be loaded.');
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
  }, [load, stationId]);

  /** Re-read the station after a write, so what is on screen is what is stored. */
  const reload = useCallback(async () => {
    try {
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That station could not be reloaded.');
    }
  }, [load]);

  const refreshList = useCallback(async () => {
    try {
      setStations(await listStations({ includeInactive: true }));
    } catch {
      // The list is a picker; the station being edited is already on screen. Failing to
      // refresh it costs nothing that is worth replacing the page with an error for.
    }
  }, []);

  const multiStation = stations.length > 1;
  const showCreateForm = creating || (canConfigure && stations.length === 0);

  const heading = (
    <PageHeading
      title="Station settings"
      description="What each station is, and the tanks and people its reports are read against. A key set up here is what makes a report's own figures count."
      actions={
        <>
          {multiStation && (
            <div className="relative">
              <BuildingIcon className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
              <label htmlFor="settings-station" className="sr-only">
                Station
              </label>
              <select
                id="settings-station"
                className="input w-auto min-w-[12rem] py-2.5 pl-11 pr-8"
                value={stationId}
                onChange={(event) => {
                  setStationId(event.target.value);
                  // Both open forms belong to the station being left. The prefill is cleared
                  // with them — see `tankPrefill`.
                  setAddingTank(false);
                  setAddingAttendant(false);
                  setTankPrefill(null);
                }}
              >
                {stations.map((station) => (
                  <option key={station.id} value={station.id}>
                    {station.name}
                    {station.isActive ? '' : ' (retired)'}
                  </option>
                ))}
              </select>
            </div>
          )}

          {canConfigure && !showCreateForm && (
            <button type="button" className="btn-secondary" onClick={() => setCreating(true)}>
              <PlusIcon className="h-4 w-4" />
              Add station
            </button>
          )}

          {stationId && (
            <button
              type="button"
              className="btn-secondary"
              onClick={() => void reload()}
              disabled={loading}
            >
              <RefreshIcon className="h-4 w-4" />
              Refresh
            </button>
          )}
        </>
      }
    />
  );

  if (showCreateForm) {
    return (
      <Layout>
        <div className="mx-auto max-w-3xl">
          {heading}
          {stations.length === 0 && (
            <div className="mb-4 flex items-start gap-3 rounded-xl border border-border bg-surface px-4 py-3 text-sm text-muted">
              <InfoIcon className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
              <p>
                There is no station yet. Registering set up your organisation and your own
                login, and a station is what everything else hangs off — reports are filed
                against one, and its figures are read against the tanks and people you add
                here.
              </p>
            </div>
          )}
          <StationForm
            onCancel={stations.length > 0 ? () => setCreating(false) : undefined}
            onSaved={async (station) => {
              setCreating(false);
              await refreshList();
              setStationId(station.id);
            }}
          />
        </div>
      </Layout>
    );
  }

  if (!stationId) {
    return (
      <Layout>
        <div className="mx-auto max-w-3xl">
          {heading}
          <div className="card p-10 text-center">
            <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-primary-subtle text-primary">
              <SettingsIcon className="h-7 w-7" />
            </div>
            <h2 className="text-lg font-bold text-body">No station is assigned to you</h2>
            <p className="mx-auto mt-2 max-w-md text-sm text-muted">
              A station&rsquo;s set-up is edited by the people who run it. An owner has to
              assign you to a station before you can change anything on it.
            </p>
          </div>
        </div>
      </Layout>
    );
  }

  if (loading && !detail) {
    return (
      <Layout>
        <div className="mx-auto max-w-4xl">
          {heading}
          <div className="card p-10 text-center">
            <span className="mx-auto mb-4 block h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
            <p className="text-sm text-muted">Loading the station&rsquo;s set-up…</p>
          </div>
        </div>
      </Layout>
    );
  }

  if (error && !detail) {
    return (
      <Layout>
        <div className="mx-auto max-w-4xl">
          {heading}
          <div className="card p-8 text-center">
            <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-error-subtle text-error">
              <AlertCircleIcon className="h-7 w-7" />
            </div>
            <h2 className="text-lg font-bold text-body">Setup unavailable</h2>
            <p className="mt-2 text-sm text-muted">{error}</p>
            <button type="button" className="btn-primary mt-5" onClick={() => void reload()}>
              Try again
            </button>
          </div>
        </div>
      </Layout>
    );
  }

  if (!detail) {
    return null;
  }

  const { station, tanks, attendants, users } = detail;

  return (
    <Layout>
      <div className="mx-auto max-w-4xl space-y-6">
        {heading}

        {error && (
          <div className="flex flex-wrap items-center gap-3 rounded-xl border border-warning/30 bg-warning-subtle px-4 py-3 text-sm text-body">
            <AlertCircleIcon className="h-4 w-4 shrink-0 text-warning" />
            <span>{error}</span>
            <button
              type="button"
              onClick={() => void reload()}
              className="font-semibold text-primary hover:text-primary-dark"
            >
              Try again
            </button>
          </div>
        )}

        {!station.isActive && (
          <div className="flex items-start gap-3 rounded-xl border border-warning/30 bg-warning-subtle px-4 py-3 text-sm text-body">
            <AlertCircleIcon className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
            <p>
              This station is retired. It is hidden from the station pickers and from every
              total, and nothing here is read against a report until it is brought back.
            </p>
          </div>
        )}

        <StationCard
          station={station}
          canConfigure={canConfigure}
          onChanged={async () => {
            await refreshList();
            await reload();
          }}
        />

        <TanksCard
          stationId={station.id}
          tanks={tanks}
          canManage={canManageContents}
          adding={addingTank}
          prefillSlug={tankPrefill}
          onAddingChange={(open) => {
            setAddingTank(open);
            if (!open) {
              setTankPrefill(null);
            }
          }}
          onChanged={reload}
        />

        <AttendantsCard
          stationId={station.id}
          attendants={attendants}
          users={users}
          canManage={canManageContents}
          adding={addingAttendant}
          onAddingChange={setAddingAttendant}
          onChanged={reload}
        />

        <AccessCard
          stationId={station.id}
          users={users}
          canProvision={canProvision}
          onChanged={reload}
        />
      </div>
    </Layout>
  );
}

/** A refusal or a failure, in the server's own words where there are any. */
function InlineError({ message }: { message: string | null }) {
  if (!message) {
    return null;
  }
  return (
    <p className="mt-2 flex items-start gap-2 text-xs text-error">
      <AlertCircleIcon className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      {message}
    </p>
  );
}

/**
 * A whole number of shillings or litres, from a text input.
 *
 * Empty is `null`, not zero, and the difference matters: a tank with no capacity has no
 * fallback threshold and is shown but never alerted on, while a tank with a capacity of zero
 * is a data-entry mistake that would silently divide by nothing. `null` is a real answer here
 * and zero is not, so blank has to survive the trip.
 */
function toOptionalNumber(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed === '') {
    return null;
  }
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

/** `null` -> `''`, so an absent figure shows as an empty box rather than a zero. */
function showNumber(value: number | null): string {
  return value === null ? '' : String(value);
}

/** What a station is: its name, where it is, and what a shift may be out by. */
function StationCard({
  station,
  canConfigure,
  onChanged,
}: {
  station: StationSummary;
  canConfigure: boolean;
  onChanged: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(station.name);
  const [location, setLocation] = useState(station.location ?? '');
  const [threshold, setThreshold] = useState(String(station.varianceThreshold));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reopening after a reload elsewhere should show what is stored, not what was typed and
  // abandoned. Keyed on the values, so an edit made here is not overwritten by its own save.
  useEffect(() => {
    setName(station.name);
    setLocation(station.location ?? '');
    setThreshold(String(station.varianceThreshold));
  }, [station.name, station.location, station.varianceThreshold]);

  async function save() {
    setPending(true);
    setError(null);
    try {
      await updateStation(station.id, {
        name: name.trim(),
        location: location.trim() === '' ? null : location.trim(),
        varianceThreshold: toOptionalNumber(threshold) ?? 0,
      });
      setOpen(false);
      await onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That station could not be saved.');
    } finally {
      setPending(false);
    }
  }

  async function setActive(isActive: boolean) {
    setPending(true);
    setError(null);
    try {
      await updateStation(station.id, { isActive });
      await onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That station could not be changed.');
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="card p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary-subtle text-primary">
            <BuildingIcon className="h-5 w-5" />
          </div>
          <div>
            <h2 className="text-base font-bold text-body">{station.name}</h2>
            <p className="text-xs text-muted">
              {station.location ?? 'No location recorded'}
              {' · '}
              {station.tankCount} tank{station.tankCount === 1 ? '' : 's'}, {station.attendantCount}{' '}
              attendant{station.attendantCount === 1 ? '' : 's'}
            </p>
          </div>
        </div>

        {canConfigure && !open && (
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              className="btn-secondary py-1.5 text-xs"
              onClick={() => setOpen(true)}
            >
              <PencilIcon className="h-3.5 w-3.5" />
              Edit
            </button>
            <button
              type="button"
              className="btn-secondary py-1.5 text-xs"
              disabled={pending}
              onClick={() => void setActive(!station.isActive)}
            >
              {station.isActive ? 'Retire' : 'Bring back'}
            </button>
          </div>
        )}
      </div>

      <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-2 text-xs sm:grid-cols-3">
        <div>
          <dt className="text-muted">Variance threshold</dt>
          <dd className="font-mono font-semibold text-body">{formatTZS(station.varianceThreshold)}</dd>
        </div>
        <div>
          <dt className="text-muted">Trading</dt>
          <dd className="font-semibold text-body">{station.isActive ? 'Yes' : 'Retired'}</dd>
        </div>
      </dl>

      <p className="mt-2 text-xs text-muted">
        A single shift out by at least this much is flagged on the dashboard and on the
        attendant it belongs to.{' '}
        {station.varianceThreshold === 0
          ? 'Set to zero, which flags every shift that does not balance exactly.'
          : 'Zero would flag every shift that does not balance exactly.'}
      </p>

      {!canConfigure && (
        <p className="mt-3 text-xs text-muted">
          Only an owner can change the station itself. Its tanks and attendants are below.
        </p>
      )}

      {open && (
        <div className="mt-4 space-y-3 border-t border-border pt-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Name" hint="As it is written on the report and shown to everyone.">
              <input
                className="input"
                value={name}
                onChange={(event) => setName(event.target.value)}
                maxLength={255}
              />
            </Field>
            <Field label="Location" hint="Free text, for telling two stations apart.">
              <input
                className="input"
                value={location}
                onChange={(event) => setLocation(event.target.value)}
                maxLength={255}
                placeholder="Optional"
              />
            </Field>
            <Field
              label="Variance threshold"
              hint="In shillings. A shift out by this much is flagged."
            >
              <input
                className="input font-mono"
                inputMode="numeric"
                value={threshold}
                onChange={(event) => setThreshold(event.target.value)}
              />
            </Field>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              className="btn-primary py-2 text-sm"
              disabled={pending || name.trim() === ''}
              onClick={() => void save()}
            >
              {pending ? 'Saving…' : 'Save station'}
            </button>
            <button
              type="button"
              className="btn-secondary py-2 text-sm"
              onClick={() => setOpen(false)}
              disabled={pending}
            >
              Cancel
            </button>
          </div>
          <InlineError message={error} />
        </div>
      )}
    </div>
  );
}

/** A labelled control with its explanation attached, so no field needs a legend above it. */
function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-semibold text-body">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-muted">{hint}</span>}
    </label>
  );
}

/**
 * The tanks the station's reports are read against.
 *
 * Every tank here is a key. A report that prints a tank the station has no row for still has
 * its litres counted — the leakage screen will not hide a loss — but there is nothing to hold
 * it to, so it cannot be alerted on. Adding it here is what turns a number into a tank.
 */
function TanksCard({
  stationId,
  tanks,
  canManage,
  adding,
  prefillSlug,
  onAddingChange,
  onChanged,
}: {
  stationId: string;
  tanks: TankSummary[];
  canManage: boolean;
  adding: boolean;
  prefillSlug: string | null;
  onAddingChange: (adding: boolean) => void;
  onChanged: () => Promise<void>;
}) {
  return (
    <div className="card p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary-subtle text-primary">
            <TankIcon className="h-5 w-5" />
          </div>
          <div>
            <h2 className="text-base font-bold text-body">Tanks</h2>
            <p className="text-xs text-muted">
              The keys a report&rsquo;s <span className="font-mono">tank:</span> readings are
              matched against, and the threshold each one is alerted on.
            </p>
          </div>
        </div>

        {canManage && !adding && (
          <button
            type="button"
            className="btn-secondary py-1.5 text-xs"
            onClick={() => onAddingChange(true)}
          >
            <PlusIcon className="h-3.5 w-3.5" />
            Add tank
          </button>
        )}
      </div>

      {adding && (
        <div className="mt-4">
          <TankForm
            stationId={stationId}
            initialSlug={prefillSlug ?? undefined}
            onCancel={() => onAddingChange(false)}
            onSaved={async () => {
              onAddingChange(false);
              await onChanged();
            }}
          />
        </div>
      )}

      {tanks.length === 0 ? (
        <p className="mt-4 text-sm text-muted">
          No tank is set up yet.
          {canManage
            ? ' Until one is, every tank reading on a report is counted but nothing can be alerted on — there is no threshold to hold it to.'
            : ''}
        </p>
      ) : (
        <ul className="mt-4 space-y-3">
          {tanks.map((tank) => (
            <TankRow
              key={tank.id}
              stationId={stationId}
              tank={tank}
              canManage={canManage}
              onChanged={onChanged}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

/** One tank: what it is called, what it is keyed by, and what it is allowed to lose. */
function TankRow({
  stationId,
  tank,
  canManage,
  onChanged,
}: {
  stationId: string;
  tank: TankSummary;
  canManage: boolean;
  onChanged: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function setActive(isActive: boolean) {
    setPending(true);
    setError(null);
    try {
      await updateTank(stationId, tank.id, { isActive });
      await onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That tank could not be changed.');
    } finally {
      setPending(false);
    }
  }

  return (
    <li className={`rounded-xl border border-border px-4 py-3 ${tank.isActive ? '' : 'bg-slate-50'}`}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-body">
            {tank.name}
            <span className="ml-2 font-mono text-xs font-normal text-muted">{tank.slug}</span>
            {!tank.isActive && (
              <span className="ml-2 rounded-md bg-slate-200 px-1.5 py-0.5 text-xs font-medium text-slate-600">
                retired
              </span>
            )}
          </p>
          <p className="text-xs text-muted">
            {tank.product ?? 'No product recorded'}
            {tank.capacityLitres !== null ? ` · ${formatLitres(tank.capacityLitres)} capacity` : ''}
            {' · '}
            {tank.leakThresholdLitres !== null
              ? `${formatLitres(tank.leakThresholdLitres)} shortfall alerts`
              : 'no threshold of its own'}
          </p>
        </div>

        {canManage && (
          <div className="flex flex-wrap items-center gap-2">
            {!open && (
              <button
                type="button"
                className="btn-secondary py-1.5 text-xs"
                onClick={() => setOpen(true)}
              >
                <PencilIcon className="h-3.5 w-3.5" />
                Edit
              </button>
            )}
            <button
              type="button"
              className="btn-secondary py-1.5 text-xs"
              disabled={pending}
              onClick={() => void setActive(!tank.isActive)}
            >
              {tank.isActive ? 'Retire' : 'Bring back'}
            </button>
          </div>
        )}
      </div>

      {tank.leakThresholdLitres === null && tank.capacityLitres === null && (
        // The threshold resolution, stated where the missing figure is. Half a percent of a
        // capacity the station has not recorded is not a fallback, it is a guess, so the
        // server alerts on nothing — and a screen that showed silence without saying why
        // would read as "this tank is fine".
        <p className="mt-2 text-xs text-muted">
          With no threshold and no capacity there is no honest line to draw, so this tank is
          shown with its numbers and never alerted on by itself. Give it either figure to
          change that.
        </p>
      )}

      {open && (
        <div className="mt-3">
          <TankForm
            stationId={stationId}
            tank={tank}
            onCancel={() => setOpen(false)}
            onSaved={async () => {
              setOpen(false);
              await onChanged();
            }}
          />
        </div>
      )}

      <InlineError message={error} />
    </li>
  );
}

/**
 * Add or change a tank.
 *
 * The key is a field of its own and is always sent, not derived from the name at save time.
 * The server derives one from the name when it is not given, which is the right default and
 * the wrong surprise: a rename would re-key the tank and point its history at a spelling no
 * report has ever printed. Showing the key it will be saved under is what makes that visible.
 */
function TankForm({
  stationId,
  tank,
  initialSlug,
  onCancel,
  onSaved,
}: {
  stationId: string;
  tank?: TankSummary;
  initialSlug?: string;
  onCancel: () => void;
  onSaved: () => Promise<void>;
}) {
  const [name, setName] = useState(tank?.name ?? '');
  const [slug, setSlug] = useState(tank?.slug ?? initialSlug ?? '');
  const [product, setProduct] = useState(tank?.product ?? '');
  const [capacity, setCapacity] = useState(showNumber(tank?.capacityLitres ?? null));
  const [threshold, setThreshold] = useState(showNumber(tank?.leakThresholdLitres ?? null));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setPending(true);
    setError(null);
    try {
      const body = {
        name: name.trim(),
        slug: slug.trim() === '' ? undefined : slug.trim().toUpperCase(),
        product: product.trim() === '' ? null : product.trim(),
        capacityLitres: toOptionalNumber(capacity),
        leakThresholdLitres: toOptionalNumber(threshold),
      };
      if (tank) {
        await updateTank(stationId, tank.id, body);
      } else {
        await createTank(stationId, body);
      }
      await onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That tank could not be saved.');
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="rounded-xl border border-border bg-slate-50 p-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Name" hint="The label as the report prints it, e.g. Tank 1.">
          <input
            className="input"
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={255}
            placeholder="Tank 1"
          />
        </Field>
        <Field
          label="Report key"
          hint="What the report's readings are matched on. Uppercase letters, digits and underscores."
        >
          <input
            className="input font-mono uppercase"
            value={slug}
            onChange={(event) => setSlug(event.target.value)}
            maxLength={40}
            placeholder="TANK_1"
          />
        </Field>
        <Field label="Product" hint="Diesel, petrol, kerosene — whatever it holds.">
          <input
            className="input"
            value={product}
            onChange={(event) => setProduct(event.target.value)}
            maxLength={120}
            placeholder="Optional"
          />
        </Field>
        <Field label="Capacity" hint="Litres. Half of one percent of this is the fallback threshold.">
          <input
            className="input font-mono"
            inputMode="numeric"
            value={capacity}
            onChange={(event) => setCapacity(event.target.value)}
            placeholder="Optional"
          />
        </Field>
        <Field
          label="Leak threshold"
          hint="Litres of shortfall on one shift worth alerting on. Overrides the fallback."
        >
          <input
            className="input font-mono"
            inputMode="numeric"
            value={threshold}
            onChange={(event) => setThreshold(event.target.value)}
            placeholder="Optional"
          />
        </Field>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          className="btn-primary py-2 text-sm"
          disabled={pending || name.trim() === ''}
          onClick={() => void save()}
        >
          {pending ? 'Saving…' : tank ? 'Save tank' : 'Add tank'}
        </button>
        <button
          type="button"
          className="btn-secondary py-2 text-sm"
          onClick={onCancel}
          disabled={pending}
        >
          Cancel
        </button>
      </div>
      <InlineError message={error} />
    </div>
  );
}

/** The people whose names appear on the station's reports, and every spelling of them. */
function AttendantsCard({
  stationId,
  attendants,
  users,
  canManage,
  adding,
  onAddingChange,
  onChanged,
}: {
  stationId: string;
  attendants: AttendantSummary[];
  /**
   * The logins assigned to this station.
   *
   * Here for one field: the login a report's name can be joined to. It is the same list the
   * access card below shows, read from the same response, so the two cannot disagree about who
   * can sign in to this station.
   */
  users: StationDetail['users'];
  canManage: boolean;
  adding: boolean;
  onAddingChange: (adding: boolean) => void;
  onChanged: () => Promise<void>;
}) {
  return (
    <div className="card p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary-subtle text-primary">
            <UsersIcon className="h-5 w-5" />
          </div>
          <div>
            <h2 className="text-base font-bold text-body">Attendants</h2>
            <p className="text-xs text-muted">
              The keys a report&rsquo;s <span className="font-mono">attendant:</span> figures are
              matched against, so each person&rsquo;s shift history accumulates against one name.
            </p>
          </div>
        </div>

        {canManage && !adding && (
          <button
            type="button"
            className="btn-secondary py-1.5 text-xs"
            onClick={() => onAddingChange(true)}
          >
            <PlusIcon className="h-3.5 w-3.5" />
            Add attendant
          </button>
        )}
      </div>

      {adding && (
        <div className="mt-4">
          <AttendantForm
            stationId={stationId}
            users={users}
            onCancel={() => onAddingChange(false)}
            onSaved={async () => {
              onAddingChange(false);
              await onChanged();
            }}
          />
        </div>
      )}

      {attendants.length === 0 ? (
        <p className="mt-4 text-sm text-muted">
          Nobody is set up yet.
          {canManage
            ? ' A name on a report that no attendant record answers to still has its figures counted, but it has no one to accumulate against — which is what hides a small shortfall repeated every shift.'
            : ''}
        </p>
      ) : (
        <ul className="mt-4 space-y-3">
          {attendants.map((attendant) => (
            <AttendantRow
              key={attendant.id}
              stationId={stationId}
              attendant={attendant}
              users={users}
              canManage={canManage}
              onChanged={onChanged}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

/** One person: the name on the paper, the key it becomes, and the other spellings joined to it. */
function AttendantRow({
  stationId,
  attendant,
  users,
  canManage,
  onChanged,
}: {
  stationId: string;
  attendant: AttendantSummary;
  users: StationDetail['users'];
  canManage: boolean;
  onChanged: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [aliasOpen, setAliasOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /*
   * The login this record is joined to, when it is one of the station's.
   *
   * `userId` is a plain id, and an id on a screen tells nobody anything — the badge used to read
   * "has a login", which is true of every linked record and identifies none of them. Resolving
   * it against the roster lets the row name the address instead. It can come back null: the link
   * is checked against the tenant, not against this station's assignments, so a record can
   * legitimately point at a login that is not listed here.
   */
  const linkedLogin = attendant.userId
    ? (users.find((user) => user.id === attendant.userId) ?? null)
    : null;

  async function setActive(isActive: boolean) {
    setPending(true);
    setError(null);
    try {
      await updateAttendant(stationId, attendant.id, { isActive });
      await onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That attendant could not be changed.');
    } finally {
      setPending(false);
    }
  }

  async function unlink(slug: string) {
    setPending(true);
    setError(null);
    try {
      await unlinkAttendantAlias(stationId, attendant.id, slug);
      await onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That spelling could not be unlinked.');
    } finally {
      setPending(false);
    }
  }

  return (
    <li
      className={`rounded-xl border border-border px-4 py-3 ${attendant.isActive ? '' : 'bg-slate-50'}`}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-body">
            {attendant.name}
            <span className="ml-2 font-mono text-xs font-normal text-muted">{attendant.slug}</span>
            {!attendant.isActive && (
              <span className="ml-2 rounded-md bg-slate-200 px-1.5 py-0.5 text-xs font-medium text-slate-600">
                retired
              </span>
            )}
            {attendant.userId && (
              <span
                className="ml-2 rounded-md bg-primary-subtle px-1.5 py-0.5 text-xs font-medium text-primary"
                title={
                  linkedLogin
                    ? `This person signs in as ${linkedLogin.email}`
                    : 'This person has a login that is not listed at this station'
                }
              >
                {linkedLogin ? linkedLogin.email : 'has a login'}
              </span>
            )}
          </p>
          <p className="text-xs text-muted">
            {attendant.aliases.length === 0
              ? 'No other spelling is joined to this name.'
              : `${attendant.aliases.length} other spelling${
                  attendant.aliases.length === 1 ? '' : 's'
                } joined to this name.`}
          </p>
        </div>

        {canManage && (
          <div className="flex flex-wrap items-center gap-2">
            {!open && (
              <button
                type="button"
                className="btn-secondary py-1.5 text-xs"
                onClick={() => setOpen(true)}
              >
                <PencilIcon className="h-3.5 w-3.5" />
                Edit
              </button>
            )}
            <button
              type="button"
              className="btn-secondary py-1.5 text-xs"
              disabled={pending}
              onClick={() => void setActive(!attendant.isActive)}
            >
              {attendant.isActive ? 'Retire' : 'Bring back'}
            </button>
          </div>
        )}
      </div>

      {attendant.aliases.length > 0 && (
        <ul className="mt-2 flex flex-wrap gap-2">
          {attendant.aliases.map((slug) => (
            <li
              key={slug}
              className="flex items-center gap-2 rounded-lg border border-border bg-surface px-2 py-1 text-xs"
            >
              <span className="font-mono font-semibold text-body">{slug}</span>
              {canManage && (
                <button
                  type="button"
                  className="text-muted hover:text-error"
                  disabled={pending}
                  aria-label={`Unlink ${slug} from ${attendant.name}`}
                  title="Stop counting shifts under this spelling towards this person"
                  onClick={() => void unlink(slug)}
                >
                  <TrashIcon className="h-3.5 w-3.5" />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {/*
        The identity step, in the one place a station's whole roster is in front of somebody.
        Always visible rather than tucked inside the edit form, because this is what the screen
        is for: a station that has been filing reports for a month is carrying spellings nobody
        has joined, and joining them is bulk work rather than a correction to one row.

        Removing a link touches no report: the shifts filed under that spelling simply stop
        counting towards this person and go back to being an unclaimed name, which is what the
        button's title says.
      */}
      {canManage && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {!aliasOpen ? (
            <button
              type="button"
              className="btn-secondary py-1.5 text-xs"
              onClick={() => setAliasOpen(true)}
            >
              <PlusIcon className="h-3.5 w-3.5" />
              Join a spelling
            </button>
          ) : (
            <AliasForm
              stationId={stationId}
              attendantId={attendant.id}
              onCancel={() => setAliasOpen(false)}
              onLinked={async () => {
                setAliasOpen(false);
                await onChanged();
              }}
            />
          )}
        </div>
      )}

      {open && (
        <div className="mt-3">
          <AttendantForm
            stationId={stationId}
            attendant={attendant}
            users={users}
            onCancel={() => setOpen(false)}
            onSaved={async () => {
              setOpen(false);
              await onChanged();
            }}
          />
        </div>
      )}

      <InlineError message={error} />
    </li>
  );
}

/** Add or change a person named on the reports. */
function AttendantForm({
  stationId,
  attendant,
  users,
  onCancel,
  onSaved,
}: {
  stationId: string;
  attendant?: AttendantSummary;
  users: StationDetail['users'];
  onCancel: () => void;
  onSaved: () => Promise<void>;
}) {
  const [name, setName] = useState(attendant?.name ?? '');
  const [slug, setSlug] = useState(attendant?.slug ?? '');
  const [userId, setUserId] = useState(attendant?.userId ?? '');
  /*
   * Whether the person actually used the login picker.
   *
   * The list we were given is the logins *assigned to this station*, and a link is checked
   * against the tenant rather than against that list — so a record can be joined to a login that
   * is not in it, and the picker cannot represent that link with an address. Sending the empty
   * value back on save would unlink that person silently, which is the same class of defect as a
   * form writing a tank's key onto the wrong station. So the field is only sent when it was
   * touched: `updateAttendant` leaves a field out of the write when it is absent, and the link
   * survives a rename nobody meant as an unlink.
   */
  const [userIdTouched, setUserIdTouched] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Owners and managers have logins too, and neither may be joined to a report's name — the API
  // refuses it, and offering the option would be a button that only ever produces a 400. The
  // screen and the rule have to agree about who is on this list.
  const assignable = users.filter((user) => user.role === 'ATTENDANT');
  const linkedNotListed =
    attendant?.userId !== null &&
    attendant?.userId !== undefined &&
    !assignable.some((user) => user.id === attendant.userId);

  async function save() {
    setPending(true);
    setError(null);
    try {
      const body: { name: string; slug?: string; userId?: string | null } = {
        name: name.trim(),
        slug: slug.trim() === '' ? undefined : slug.trim().toUpperCase(),
      };
      if (userIdTouched) {
        body.userId = userId === '' ? null : userId;
      }

      if (attendant) {
        await updateAttendant(stationId, attendant.id, body);
      } else {
        await createAttendant(stationId, body);
      }
      await onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That attendant could not be saved.');
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="rounded-xl border border-border bg-slate-50 p-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Name" hint="The name as the report prints it.">
          <input
            className="input"
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={255}
            placeholder="John Mwaka"
          />
        </Field>
        <Field
          label="Report key"
          hint="What the report's figures are matched on. Uppercase letters, digits and underscores."
        >
          <input
            className="input font-mono uppercase"
            value={slug}
            onChange={(event) => setSlug(event.target.value)}
            maxLength={40}
            placeholder="JOHN_MWAKA"
          />
        </Field>
      </div>

      {/*
        The other half of the identity: the name on the paper, and the login that is the same
        person. Optional by design — most attendants never sign in, and requiring an account
        would leave out exactly the people whose shortfalls are being tracked, which is why an
        `Attendant` is not a `User` in the schema.

        It is what makes an attendant's own screen possible at all: `/attendants/me` answers
        through this field and nothing else, so until a link exists the person who signs in is
        shown "nobody has linked your record" rather than their figures.
      */}
      <div className="mt-3">
        <Field
          label="Login"
          hint="Only if this person signs in. Most attendants never do, and their shifts are still counted."
        >
          <select
            className="input"
            value={userId}
            onChange={(event) => {
              setUserId(event.target.value);
              setUserIdTouched(true);
            }}
          >
            <option value="">No login — this person has no account</option>
            {linkedNotListed && attendant?.userId && (
              <option value={attendant.userId}>A login not listed at this station</option>
            )}
            {assignable.map((user) => (
              <option key={user.id} value={user.id}>
                {user.email}
                {user.isActive ? '' : ' (deactivated)'}
              </option>
            ))}
          </select>
        </Field>
        {linkedNotListed && (
          <p className="mt-1.5 text-xs text-muted">
            This record is joined to a login that is not assigned to this station, so the address
            is not shown here. Leaving this alone keeps the link; choosing “No login” removes it.
          </p>
        )}
        {assignable.length === 0 && !linkedNotListed && (
          <p className="mt-1.5 text-xs text-muted">
            No attendant login is assigned to this station yet. An owner adds one under{' '}
            <strong>Access</strong> below before it can be joined to a name.
          </p>
        )}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          className="btn-primary py-2 text-sm"
          disabled={pending || name.trim() === ''}
          onClick={() => void save()}
        >
          {pending ? 'Saving…' : attendant ? 'Save attendant' : 'Add attendant'}
        </button>
        <button
          type="button"
          className="btn-secondary py-2 text-sm"
          onClick={onCancel}
          disabled={pending}
        >
          Cancel
        </button>
      </div>
      <InlineError message={error} />
    </div>
  );
}

/** Join one more spelling to a person, by the printed name or by the key itself. */
function AliasForm({
  stationId,
  attendantId,
  onCancel,
  onLinked,
}: {
  stationId: string;
  attendantId: string;
  onCancel: () => void;
  onLinked: () => Promise<void>;
}) {
  const [value, setValue] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function link() {
    setPending(true);
    setError(null);
    try {
      // Sent as a name and not as a key: the server slugifies it, so "J. Mwangi" and
      // "J_MWANGI" land on the same row and neither can produce a key the parser would never
      // write. The refusal worth reading — "that key already belongs to Grace Kimaro" — comes
      // back with the name filled in.
      await linkAttendantAlias(stationId, attendantId, { name: value.trim() });
      await onLinked();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That spelling could not be joined.');
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="mt-3 flex flex-wrap items-start gap-2">
      <label htmlFor={`alias-${attendantId}`} className="sr-only">
        The other spelling to join
      </label>
      <input
        id={`alias-${attendantId}`}
        className="input w-auto min-w-[12rem] py-2 text-sm"
        value={value}
        onChange={(event) => setValue(event.target.value)}
        maxLength={255}
        placeholder="J. Mwangi"
      />
      <button
        type="button"
        className="btn-primary py-2 text-sm"
        disabled={pending || value.trim() === ''}
        onClick={() => void link()}
      >
        {pending ? 'Joining…' : 'Join'}
      </button>
      <button
        type="button"
        className="btn-secondary py-2 text-sm"
        onClick={onCancel}
        disabled={pending}
      >
        Cancel
      </button>
      {error && (
        <p className="flex w-full items-start gap-2 text-xs text-error">
          <AlertCircleIcon className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          {error}
        </p>
      )}
    </div>
  );
}

/**
 * The logins that can reach this station — and, for an owner, the only screen in the product
 * that makes a login at all.
 *
 * ## Why the write side of this had to arrive with the attendant screen
 *
 * `POST /users` and `PATCH /users/:id` have existed since `0.1`, and until now nothing called
 * them. That left the ATTENDANT role reachable only through the API: an owner could link a login
 * to an attendant record (`AttendantForm` below does that), but no screen could produce the login
 * to link, or put it on a station. An attendant-facing screen behind a door nobody can make is
 * not a feature, so the two arrive together.
 *
 * ## Why it sits beside the station rather than in a staff section of its own
 *
 * This is not a company-wide people screen, and deliberately so. What a manager looks at here is
 * the roster of the station they run; what an owner *edits* here is who can get into this station.
 * The one tenant-wide read behind it (`GET /users`) is there because the assignments it returns
 * are not optional: the server replaces the whole list on a write, so an owner who assigned
 * somebody here without knowing about their other stations would quietly remove them from all of
 * them.
 *
 * Attendants remain a separate list, and the separation is the point: an attendant is a *name* on
 * a report and most of them never sign in, while a login is a way in. Collapsing the two would
 * drop every attendant who has no account, which is most of them — and the ones whose shortfalls
 * matter most are exactly the ones a manager files reports for.
 *
 * Two things are left out on purpose. **Role changes** are not offered: this card is about who
 * can reach *this station*, and promoting a manager reads as a staffing decision rather than a
 * station one. **Owners** are listed but not editable here, because the API refuses self-changes
 * and the last active owner cannot be retired — an owner's own account is a different feature.
 */
function AccessCard({
  stationId,
  users,
  canProvision,
  onChanged,
}: {
  stationId: string;
  users: StationDetail['users'];
  canProvision: boolean;
  onChanged: () => Promise<void>;
}) {
  const currentUser = useAuthStore((state) => state.user);

  const [roster, setRoster] = useState<ManagedUser[] | null>(null);
  const [loading, setLoading] = useState(canProvision);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  /** The row whose change is in flight, so the rest of the card stays usable. */
  const [busyId, setBusyId] = useState<string | null>(null);

  const loadRoster = useCallback(async () => {
    if (!canProvision) {
      return;
    }
    setRoster(await listUsers({ includeInactive: true }));
  }, [canProvision]);

  useEffect(() => {
    if (!canProvision) {
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);

    void (async () => {
      try {
        await loadRoster();
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'The list of logins could not be loaded.');
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
  }, [canProvision, loadRoster]);

  /**
   * Reload both lists.
   *
   * The station's own `users` has to be refreshed alongside the roster, because the login picker
   * on the attendant rows below is built from it: a login added here must be choosable there
   * without a page reload.
   */
  const refresh = useCallback(async () => {
    await loadRoster();
    await onChanged();
  }, [loadRoster, onChanged]);

  async function run(row: ManagedUser, change: () => Promise<unknown>) {
    setBusyId(row.id);
    setError(null);
    try {
      await change();
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That change could not be saved.');
    } finally {
      setBusyId(null);
    }
  }

  async function setHere(row: ManagedUser, include: boolean) {
    await run(row, () =>
      updateUser(row.id, {
        // The whole list, because the server replaces rather than merges. Sending this station
        // alone would take the person off every other one they work at.
        stationIds: include
          ? [...row.stationIds, stationId]
          : row.stationIds.filter((id) => id !== stationId),
      })
    );
  }

  const here = roster?.filter((row) => row.stationIds.includes(stationId)) ?? [];
  const elsewhere = roster?.filter((row) => !row.stationIds.includes(stationId)) ?? [];

  return (
    <div className="card p-5">
      <div className="flex items-start gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-slate-100 text-muted">
          <ShieldCheckIcon className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="text-base font-bold text-body">Who can sign in here</h2>
          <p className="text-xs text-muted">
            Logins assigned to this station. A person on this list is not necessarily an
            attendant, and an attendant below need not have a login — the two are set up
            separately.
          </p>

          {/*
            A manager gets the read-only list the station detail already carried. Only an owner
            may provision, and offering the buttons anyway would turn a permissions boundary into
            a 403 in the middle of a form.
          */}
          {!canProvision ? (
            users.length === 0 ? (
              <p className="mt-3 text-sm text-muted">
                Nobody is assigned to this station yet. An owner adds logins.
              </p>
            ) : (
              <ul className="mt-3 divide-y divide-border">
                {users.map((member) => (
                  <li
                    key={member.id}
                    className="flex flex-wrap items-center justify-between gap-2 py-2"
                  >
                    <span className="truncate text-sm text-body">{member.email}</span>
                    <span className="text-xs text-muted">
                      {roleLabel(member.role)}
                      {member.isActive ? '' : ' · retired'}
                    </span>
                  </li>
                ))}
              </ul>
            )
          ) : loading ? (
            <p className="mt-3 text-sm text-muted">Loading the logins…</p>
          ) : (
            <>
              {here.length === 0 ? (
                <p className="mt-3 text-sm text-muted">Nobody is assigned to this station yet.</p>
              ) : (
                <ul className="mt-3 divide-y divide-border">
                  {here.map((row) => {
                    const isSelf = row.id === currentUser?.id;
                    const busy = busyId === row.id;
                    return (
                      <li
                        key={row.id}
                        className="flex flex-wrap items-center justify-between gap-2 py-2"
                      >
                        <span className="min-w-0">
                          <span
                            className={`block truncate text-sm ${
                              row.isActive ? 'text-body' : 'text-muted line-through'
                            }`}
                          >
                            {row.email}
                          </span>
                          <span className="text-xs text-muted">
                            {roleLabel(row.role)}
                            {isSelf && ' · you'}
                            {row.isActive ? '' : ' · retired'}
                          </span>
                        </span>

                        {/* An owner's own row offers nothing: the API refuses a self-change
                            outright, and the button would only ever produce that refusal. */}
                        {!isSelf && (
                          <span className="flex flex-wrap items-center gap-2">
                            <button
                              type="button"
                              className="text-xs font-semibold text-muted hover:text-body"
                              disabled={busy}
                              onClick={() => void setHere(row, false)}
                              title="Take this login off this station. They keep their other stations."
                            >
                              Take off station
                            </button>
                            <button
                              type="button"
                              className="text-xs font-semibold text-primary hover:text-primary-dark"
                              disabled={busy}
                              onClick={() => void run(row, () => updateUser(row.id, { isActive: !row.isActive }))}
                            >
                              {row.isActive ? 'Retire' : 'Bring back'}
                            </button>
                          </span>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}

              {/*
                Someone already on the team, moved onto this station. Kept below the list rather
                than offered as an empty row, because the common case by far is adding a new
                login — and the picker is empty and can be skipped when the tenant has one person.
              */}
              {elsewhere.length > 0 && (
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <label htmlFor="access-assign" className="text-xs font-semibold text-body">
                    Also assign someone already on the team
                  </label>
                  <select
                    id="access-assign"
                    className="input w-auto min-w-[14rem] py-2 text-sm"
                    value=""
                    disabled={busyId !== null}
                    onChange={(event) => {
                      const chosen = roster?.find((row) => row.id === event.target.value);
                      if (chosen) {
                        void setHere(chosen, true);
                      }
                    }}
                  >
                    <option value="">Choose a login…</option>
                    {elsewhere.map((row) => (
                      <option key={row.id} value={row.id}>
                        {row.email} — {roleLabel(row.role)}
                        {row.isActive ? '' : ' (retired)'}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              {adding ? (
                <LoginForm
                  stationId={stationId}
                  onCancel={() => setAdding(false)}
                  onSaved={async () => {
                    setAdding(false);
                    await refresh();
                  }}
                />
              ) : (
                <button
                  type="button"
                  className="btn-secondary mt-3 py-2 text-sm"
                  onClick={() => setAdding(true)}
                >
                  <PlusIcon className="h-4 w-4" />
                  Add a login
                </button>
              )}

              <InlineError message={error} />
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Add a login to the tenant, on this station.
 *
 * The role defaults to ATTENDANT because that is what this card exists for: an attendant login
 * was the one the product could not produce, and the one that makes the attendant-facing screen
 * reachable at all. A manager is one select away.
 *
 * There is no invite by email yet (`0.7`), so the owner types an initial password and hands it
 * over. The floor is the same eight characters `/auth/register` enforces, and it is enforced here
 * too, so the button is never the thing that tells somebody the rule.
 */
function LoginForm({
  stationId,
  onCancel,
  onSaved,
}: {
  stationId: string;
  onCancel: () => void;
  onSaved: () => Promise<void>;
}) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<ProvisionableRole>('ATTENDANT');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());

  async function save() {
    setPending(true);
    setError(null);
    try {
      await createUser({
        email: email.trim(),
        password,
        role,
        // Born on this station: a login created from a station's page that could not reach it
        // would be an odd thing to hand somebody.
        stationIds: [stationId],
      });
      await onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That login could not be created.');
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="mt-3 rounded-xl border border-border bg-slate-50 p-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Email" hint="What they sign in with.">
          <input
            className="input"
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            maxLength={255}
            placeholder="john@station.co.tz"
            autoComplete="off"
          />
        </Field>
        <Field
          label="Initial password"
          hint="At least 8 characters. There is no email invite yet, so you hand this over."
        >
          <input
            className="input"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            maxLength={255}
            autoComplete="new-password"
          />
        </Field>
        <Field
          label="Role"
          hint="An attendant sees only their own shifts. A manager runs this station."
        >
          <select
            className="input"
            value={role}
            onChange={(event) => setRole(event.target.value as ProvisionableRole)}
          >
            <option value="ATTENDANT">Attendant</option>
            <option value="MANAGER">Manager</option>
          </select>
        </Field>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          className="btn-primary py-2 text-sm"
          disabled={pending || !emailOk || password.length < 8}
          onClick={() => void save()}
        >
          {pending ? 'Creating…' : 'Create login'}
        </button>
        <button
          type="button"
          className="btn-secondary py-2 text-sm"
          onClick={onCancel}
          disabled={pending}
        >
          Cancel
        </button>
      </div>
      <InlineError message={error} />
    </div>
  );
}

/**
 * Stand up a station.
 *
 * Registering creates a tenant and an owner and no station at all, so this is the form that
 * makes the first one — and, for an owner, the rest.
 */
function StationForm({
  onCancel,
  onSaved,
}: {
  onCancel?: () => void;
  onSaved: (station: StationSummary) => Promise<void>;
}) {
  const [name, setName] = useState('');
  const [location, setLocation] = useState('');
  const [threshold, setThreshold] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setPending(true);
    setError(null);
    try {
      const station = await createStation({
        name: name.trim(),
        location: location.trim() === '' ? null : location.trim(),
        varianceThreshold: toOptionalNumber(threshold) ?? undefined,
      });
      await onSaved(station);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That station could not be created.');
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="card p-5">
      <h2 className="text-base font-bold text-body">New station</h2>
      <p className="mt-1 text-xs text-muted">
        The variance threshold can be set later, and changed as the station settles. Zero means
        every shift that does not balance exactly is flagged, which is the right place to start
        and the wrong place to stay.
      </p>

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <Field label="Name" hint="As it is written on the report and shown to everyone.">
          <input
            className="input"
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={255}
            placeholder="Main Station"
          />
        </Field>
        <Field label="Location" hint="Free text, for telling two stations apart.">
          <input
            className="input"
            value={location}
            onChange={(event) => setLocation(event.target.value)}
            maxLength={255}
            placeholder="Optional"
          />
        </Field>
        <Field label="Variance threshold" hint="In shillings. Optional, and zero by default.">
          <input
            className="input font-mono"
            inputMode="numeric"
            value={threshold}
            onChange={(event) => setThreshold(event.target.value)}
            placeholder="0"
          />
        </Field>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <button
          type="button"
          className="btn-primary py-2 text-sm"
          disabled={pending || name.trim() === ''}
          onClick={() => void save()}
        >
          {pending ? 'Creating…' : 'Create station'}
        </button>
        {onCancel && (
          <button
            type="button"
            className="btn-secondary py-2 text-sm"
            onClick={onCancel}
            disabled={pending}
          >
            Cancel
          </button>
        )}
      </div>
      <InlineError message={error} />
    </div>
  );
}
