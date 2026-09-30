import type { UserRole } from '@fuelflow/shared';

export function canUpload(role: UserRole): boolean {
  return role === 'OWNER' || role === 'MANAGER';
}

export function canCorrect(role: UserRole): boolean {
  return role === 'OWNER' || role === 'MANAGER';
}

export function canManageUsers(role: UserRole): boolean {
  return role === 'OWNER';
}

/**
 * Creating, renaming, retiring a station, or moving its variance threshold.
 *
 * Named to match `canAdministerStation` in `routes/stations.ts`, because it gates the same
 * thing: a manager fills in a station's tanks and attendants, but what the station *is* —
 * its name, whether it is trading, what a shift is allowed to be out by — is the owner's
 * call. The two have to agree or the screen offers a button the API refuses.
 */
export function canAdministerStation(role: UserRole): boolean {
  return role === 'OWNER';
}

/**
 * Whether this login works the pumps rather than runs the station.
 *
 * Not a permission, though it reads like one — and the reason it is here rather than inlined is
 * that it would be easy to mistake for the capability predicates above and give it a gate's job.
 * Nothing is withheld from anybody by this test: every role may ask for their own record. It
 * decides a single thing — which screen `/` draws, and therefore what the sidebar calls that row
 * — and it lives here so the two places that ask it ask it the same way.
 */
export function isAttendant(role: UserRole): boolean {
  return role === 'ATTENDANT';
}

/**
 * OWNER -> "Station owner". Written out rather than title-cased from the enum, because
 * lowercasing an acronym gives "Attendant"-style results by accident and "OWNER" -> "Owner"
 * reads like a job title nobody holds at a fuel station.
 */
export function roleLabel(role: UserRole): string {
  switch (role) {
    case 'OWNER':
      return 'Station owner';
    case 'MANAGER':
      return 'Manager';
    case 'ATTENDANT':
      return 'Attendant';
    default:
      return role;
  }
}
