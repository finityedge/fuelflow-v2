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
