export const MIN_PASSWORD_LENGTH = 10;
export const MAX_PASSWORD_LENGTH = 128;

// Common breached/weak passwords blocklist (case-insensitive)
const COMMON_PASSWORDS = new Set([
  '1234567890',
  '12345678901',
  '123456789012',
  'password123',
  'password1234',
  'password12345',
  'qwertyuiop',
  'qwertyuiop1',
  'admin123456',
  'administrator',
  'streamlite123',
  'netflix1234',
  'welcome1234',
  'welcome12345',
  'iloveyou123',
  'changeme123',
  'passcode1234',
  'trustnoone1',
  'monkey12345',
  'dragon12345',
  'master12345',
  'sunshine123',
  'princess123',
  'football123',
  'charlie1234',
  'donald12345',
]);

export function isCommonPassword(password: string): boolean {
  return COMMON_PASSWORDS.has(password.trim().toLowerCase());
}
