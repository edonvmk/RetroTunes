import crypto from 'crypto';
import { getUsersDb } from '../db';
import { logger } from '../logger';
import { getSettings } from '../settings';
import { encryptSecret, decryptSecret, isEncryptedSecret } from './secretVault';
import {
  BAND_PERMISSIONS,
  CallerContext,
  ForbiddenError,
  LABEL_PERMISSIONS,
  ROADIE_PERMISSIONS,
  RolePermissions,
  UnauthorizedError,
} from './callerContext';

export interface RoleRecord {
  id: number;
  name: string;
  description: string;
  color: string;
  isSystem: boolean;
  isSuperAdmin: boolean;
  permissions: RolePermissions;
  createdAt: string;
}

export interface UserRecord {
  id: number;
  username: string;
  displayName: string;
  email: string;
  phone: string;
  authentikSub: string | null;
  listenbrainzUsername: string;
  hasListenbrainzToken: boolean;
  status: 'active' | 'suspended';
  createdAt: string;
  lastSeenAt: string | null;
  roles: RoleRecord[];
  overrides: Partial<RolePermissions> | null;
  effectivePermissions: RolePermissions;
}

const ZERO_PERMISSIONS: RolePermissions = {
  libMusic: 0,
  libMovies: 0,
  libTvShows: 0,
  libMusicVideos: 0,
  libBooks: 0,
  libAudiobooks: 0,
  libPhotos: 0,
  featEgenius: 0,
  featGenreMap: 0,
  featDevicesSync: 0,
  localCacheTier: 0,
  localCacheLimitMb: 0,
  mediaUpload: 0,
  storeRequest: 0,
  playlists: 0,
  approveUploads: 0,
  approveStore: 0,
  rescanLibrary: 0,
  rebuildDb: 0,
  manageApiKeys: 0,
  viewServerLogs: 0,
  manageUac: 0,
};

const PERMISSION_KEYS = Object.keys(ZERO_PERMISSIONS) as (keyof RolePermissions)[];
const SCRYPT_PARAMS = { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 };

export function normalizePermissions(
  input?: Partial<RolePermissions> | null,
  fallback: RolePermissions = ROADIE_PERMISSIONS
): RolePermissions {
  const result = { ...fallback };
  if (!input) return result;
  for (const key of PERMISSION_KEYS) {
    const val = input[key];
    if (typeof val === 'number' && Number.isFinite(val)) {
      (result as Record<string, number>)[key] = Math.max(0, Math.round(val));
    }
  }
  return result;
}

export function mergePermissions(
  base: RolePermissions,
  addition?: Partial<RolePermissions> | null
): RolePermissions {
  const next = { ...base };
  if (!addition) return next;
  for (const key of PERMISSION_KEYS) {
    const incoming = addition[key];
    if (typeof incoming === 'number' && Number.isFinite(incoming)) {
      (next as Record<string, number>)[key] = Math.max(next[key], incoming);
    }
  }
  return next;
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const derived = await new Promise<Buffer>((resolve, reject) => {
    crypto.scrypt(password, salt, 32, SCRYPT_PARAMS, (err, buf) => {
      if (err) reject(err);
      else resolve(buf);
    });
  });
  return `${salt.toString('hex')}:${derived.toString('hex')}`;
}

export async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  const [saltHex, expectedHex] = (storedHash || '').split(':');
  if (!saltHex || !expectedHex) return false;
  const salt = Buffer.from(saltHex, 'hex');
  const expectedBuf = Buffer.from(expectedHex, 'hex');
  const actualBuf = await new Promise<Buffer>((resolve, reject) => {
    crypto.scrypt(password, salt, expectedBuf.length, SCRYPT_PARAMS, (err, buf) => {
      if (err) reject(err);
      else resolve(buf);
    });
  });
  if (actualBuf.length !== expectedBuf.length) return false;
  return crypto.timingSafeEqual(actualBuf, expectedBuf);
}

export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function mapRoleRow(row: any): RoleRecord {
  let parsed: Partial<RolePermissions> = {};
  try {
    parsed = JSON.parse(row.permissions_json || '{}');
  } catch {
    parsed = {};
  }
  const fallback = row.is_super_admin ? LABEL_PERMISSIONS : ZERO_PERMISSIONS;
  return {
    id: Number(row.id),
    name: String(row.name),
    description: String(row.description || ''),
    color: String(row.color || '#5a8dee'),
    isSystem: Boolean(row.is_system),
    isSuperAdmin: Boolean(row.is_super_admin),
    permissions: row.is_super_admin
      ? { ...LABEL_PERMISSIONS }
      : normalizePermissions(parsed, fallback),
    createdAt: String(row.created_at || ''),
  };
}

export function ensureRbacSeeded(): void {
  const db = getUsersDb();
  const upsert = db.prepare(`
    INSERT INTO roles (name, description, color, is_system, is_super_admin, permissions_json)
    VALUES (?, ?, ?, 1, ?, ?)
    ON CONFLICT(name) DO UPDATE SET
      is_system = 1,
      is_super_admin = excluded.is_super_admin
  `);

  db.transaction(() => {
    upsert.run(
      'Roadie',
      'Standard listener with stream/playback access and capped local cache.',
      '#64748b',
      0,
      JSON.stringify(ROADIE_PERMISSIONS)
    );
    upsert.run(
      'Band',
      'Trusted household/band contributor with metadata editing, unlimited cache, and approval-staged uploads/requests.',
      '#2563eb',
      0,
      JSON.stringify(BAND_PERMISSIONS)
    );
    upsert.run(
      'Label',
      'Super-admin server owner with full control over libraries, approvals, API keys, and user access control.',
      '#d97706',
      1,
      JSON.stringify(LABEL_PERMISSIONS)
    );

    const plainUsers = db
      .prepare("SELECT id, listenbrainz_token FROM users WHERE listenbrainz_token IS NOT NULL AND listenbrainz_token != ''")
      .all() as { id: number; listenbrainz_token: string }[];
    const updToken = db.prepare('UPDATE users SET listenbrainz_token = ? WHERE id = ?');
    for (const u of plainUsers) {
      if (!isEncryptedSecret(u.listenbrainz_token)) {
        updToken.run(encryptSecret(u.listenbrainz_token), u.id);
      }
    }
  })();
}

export function getUserCount(): number {
  const row = getUsersDb()
    .prepare('SELECT COUNT(*) as c FROM users')
    .get() as { c: number };
  return Number(row?.c || 0);
}

function getRolesForUser(userId: number): RoleRecord[] {
  const rows = getUsersDb()
    .prepare(
      `SELECT r.* FROM roles r
       INNER JOIN user_roles ur ON ur.role_id = r.id
       WHERE ur.user_id = ?
       ORDER BY r.is_super_admin DESC, r.id ASC`
    )
    .all(userId);
  return rows.map(mapRoleRow);
}

function getOverridesForUser(userId: number): Partial<RolePermissions> | null {
  const row = getUsersDb()
    .prepare('SELECT permissions_json FROM user_permission_overrides WHERE user_id = ?')
    .get(userId) as { permissions_json: string } | undefined;
  if (!row) return null;
  try {
    return JSON.parse(row.permissions_json) as Partial<RolePermissions>;
  } catch {
    return null;
  }
}

export function computeEffectivePermissions(userId: number): {
  roles: RoleRecord[];
  isSuperAdmin: boolean;
  overrides: Partial<RolePermissions> | null;
  permissions: RolePermissions;
} {
  const roles = getRolesForUser(userId);
  const overrides = getOverridesForUser(userId);
  const isSuperAdmin = roles.some((r) => r.isSuperAdmin);
  if (isSuperAdmin) {
    return { roles, isSuperAdmin: true, overrides, permissions: { ...LABEL_PERMISSIONS } };
  }
  let merged = roles.length > 0 ? { ...ZERO_PERMISSIONS } : { ...ROADIE_PERMISSIONS };
  for (const role of roles) {
    merged = mergePermissions(merged, role.permissions);
  }
  merged = mergePermissions(merged, overrides);
  return { roles, isSuperAdmin: false, overrides, permissions: merged };
}

function mapUserRow(row: any): UserRecord {
  const userId = Number(row.id);
  const { roles, overrides, permissions } = computeEffectivePermissions(userId);
  return {
    id: userId,
    username: String(row.username),
    displayName: String(row.display_name || row.username),
    email: String(row.email || ''),
    phone: String(row.phone || ''),
    authentikSub: row.authentik_sub ? String(row.authentik_sub) : null,
    listenbrainzUsername: String(row.listenbrainz_username || ''),
    hasListenbrainzToken: Boolean(row.listenbrainz_token),
    status: row.status === 'suspended' ? 'suspended' : 'active',
    createdAt: String(row.created_at || ''),
    lastSeenAt: row.last_seen_at ? String(row.last_seen_at) : null,
    roles,
    overrides,
    effectivePermissions: permissions,
  };
}

function countActiveSuperAdminUsers(excludeUserId?: number): number {
  const db = getUsersDb();
  const row = db
    .prepare(
      `SELECT COUNT(DISTINCT u.id) as c
       FROM users u
       INNER JOIN user_roles ur ON ur.user_id = u.id
       INNER JOIN roles r ON r.id = ur.role_id
       WHERE u.status = 'active' AND r.is_super_admin = 1 AND (? IS NULL OR u.id != ?)`
    )
    .get(excludeUserId ?? null, excludeUserId ?? null) as { c: number };
  return Number(row?.c || 0);
}

function isUserSuperAdmin(userId: number): boolean {
  const row = getUsersDb()
    .prepare(
      `SELECT 1 as ok FROM user_roles ur
       INNER JOIN roles r ON r.id = ur.role_id
       WHERE ur.user_id = ? AND r.is_super_admin = 1
       LIMIT 1`
    )
    .get(userId);
  return Boolean(row);
}

export function listRoles(): RoleRecord[] {
  ensureRbacSeeded();
  const rows = getUsersDb()
    .prepare('SELECT * FROM roles ORDER BY is_super_admin DESC, is_system DESC, id ASC')
    .all();
  return rows.map(mapRoleRow);
}

export function createRole(input: {
  name: string;
  description?: string;
  color?: string;
  permissions?: Partial<RolePermissions>;
}): RoleRecord {
  ensureRbacSeeded();
  const name = input.name.trim();
  if (!name) throw new Error('Role name is required.');
  const perms = normalizePermissions(input.permissions, ROADIE_PERMISSIONS);
  const info = getUsersDb()
    .prepare(
      'INSERT INTO roles (name, description, color, is_system, is_super_admin, permissions_json) VALUES (?, ?, ?, 0, 0, ?)'
    )
    .run(name, input.description?.trim() || '', input.color || '#5a8dee', JSON.stringify(perms));
  const row = getUsersDb().prepare('SELECT * FROM roles WHERE id = ?').get(info.lastInsertRowid);
  return mapRoleRow(row);
}

export function updateRole(
  roleId: number,
  patch: {
    name?: string;
    description?: string;
    color?: string;
    permissions?: Partial<RolePermissions>;
  }
): RoleRecord {
  const db = getUsersDb();
  const existingRow = db.prepare('SELECT * FROM roles WHERE id = ?').get(roleId) as any;
  if (!existingRow) throw new Error(`Role #${roleId} not found.`);
  const existing = mapRoleRow(existingRow);

  if (existing.isSuperAdmin) {
    if (patch.permissions) {
      for (const key of PERMISSION_KEYS) {
        const nextVal = patch.permissions[key];
        if (typeof nextVal === 'number' && nextVal < LABEL_PERMISSIONS[key]) {
          throw new ForbiddenError('Cannot strip permissions from the super-admin Label role.');
        }
      }
    }
    if (patch.name && patch.name.trim().toLowerCase() !== 'label') {
      throw new ForbiddenError('Cannot rename the system Label role.');
    }
  }

  if (existing.isSystem && patch.name && patch.name.trim().toLowerCase() !== existing.name.toLowerCase()) {
    throw new ForbiddenError('Cannot rename a built-in system role.');
  }

  const nextName = existing.isSystem ? existing.name : patch.name?.trim() || existing.name;
  const nextDesc = patch.description !== undefined ? patch.description.trim() : existing.description;
  const nextColor = patch.color || existing.color;
  const nextPerms = existing.isSuperAdmin
    ? { ...LABEL_PERMISSIONS }
    : normalizePermissions(patch.permissions ? { ...existing.permissions, ...patch.permissions } : existing.permissions, existing.permissions);

  db.prepare(
    'UPDATE roles SET name = ?, description = ?, color = ?, permissions_json = ? WHERE id = ?'
  ).run(nextName, nextDesc, nextColor, JSON.stringify(nextPerms), roleId);

  return mapRoleRow(db.prepare('SELECT * FROM roles WHERE id = ?').get(roleId));
}

export function deleteRole(roleId: number): { ok: boolean } {
  const db = getUsersDb();
  const existingRow = db.prepare('SELECT * FROM roles WHERE id = ?').get(roleId) as any;
  if (!existingRow) throw new Error(`Role #${roleId} not found.`);
  if (existingRow.is_system) {
    throw new ForbiddenError('Built-in system roles (Roadie, Band, Label) cannot be deleted.');
  }
  db.prepare('DELETE FROM roles WHERE id = ?').run(roleId);
  return { ok: true };
}

export function listUsers(): UserRecord[] {
  ensureRbacSeeded();
  const rows = getUsersDb()
    .prepare('SELECT * FROM users ORDER BY id ASC')
    .all();
  return rows.map(mapUserRow);
}

export function getUserById(userId: number): UserRecord | null {
  const row = getUsersDb().prepare('SELECT * FROM users WHERE id = ?').get(userId);
  return row ? mapUserRow(row) : null;
}

export function getUserPersonalSecrets(userId: number): {
  listenbrainzToken: string;
  listenbrainzUsername: string;
} {
  ensureRbacSeeded();
  const row = getUsersDb()
    .prepare('SELECT listenbrainz_token, listenbrainz_username FROM users WHERE id = ?')
    .get(userId) as { listenbrainz_token?: string; listenbrainz_username?: string } | undefined;
  return {
    listenbrainzToken: decryptSecret(String(row?.listenbrainz_token || '')),
    listenbrainzUsername: String(row?.listenbrainz_username || ''),
  };
}

export function resolvePersonalListenBrainzCredentials(caller?: CallerContext | null): {
  token: string;
  username: string;
} {
  if (!caller || caller.isGuest || caller.authSource === 'guest' || caller.authSource === 'local-pin') {
    return { token: '', username: '' };
  }
  if (caller.userId !== null && caller.userId > 0) {
    const personal = getUserPersonalSecrets(caller.userId);
    return {
      token: personal.listenbrainzToken.trim(),
      username: personal.listenbrainzUsername.trim(),
    };
  }
  if (caller.userId === null && caller.authSource === 'local-owner') {
    const settings = getSettings();
    return {
      token: (settings.personalListenbrainzToken || '').trim(),
      username: (settings.personalListenbrainzUsername || '').trim(),
    };
  }
  return { token: '', username: '' };
}

export async function createUser(input: {
  username: string;
  displayName?: string;
  email?: string;
  phone?: string;
  password?: string;
  roleIds?: number[];
  roleNames?: string[];
  authentikSub?: string | null;
  status?: 'active' | 'suspended';
}): Promise<UserRecord> {
  ensureRbacSeeded();
  const db = getUsersDb();
  const username = input.username.trim();
  if (!username) throw new Error('Username is required.');
  const displayName = (input.displayName || username).trim();
  const passwordHash = input.password ? await hashPassword(input.password) : '';

  let targetRoleIds = Array.isArray(input.roleIds) ? [...input.roleIds] : [];
  if (targetRoleIds.length === 0 && Array.isArray(input.roleNames) && input.roleNames.length > 0) {
    const placeholders = input.roleNames.map(() => '?').join(', ');
    const found = db
      .prepare(`SELECT id FROM roles WHERE name IN (${placeholders})`)
      .all(...input.roleNames) as { id: number }[];
    targetRoleIds = found.map((r) => r.id);
  }
  if (targetRoleIds.length === 0) {
    const roadie = db.prepare("SELECT id FROM roles WHERE name = 'Roadie'").get() as { id: number };
    targetRoleIds = [roadie.id];
  }

  let newId = 0;
  db.transaction(() => {
    const res = db
      .prepare(
        `INSERT INTO users (username, display_name, email, phone, password_hash, authentik_sub, status)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        username,
        displayName,
        input.email?.trim() || '',
        input.phone?.trim() || '',
        passwordHash,
        input.authentikSub || null,
        input.status === 'suspended' ? 'suspended' : 'active'
      );
    newId = Number(res.lastInsertRowid);
    const insRole = db.prepare('INSERT OR IGNORE INTO user_roles (user_id, role_id) VALUES (?, ?)');
    for (const rid of targetRoleIds) {
      insRole.run(newId, rid);
    }
  })();

  logger.info('AUTH_OIDC', `Created user account "${username}" (id=${newId})`, { roleIds: targetRoleIds });
  return getUserById(newId)!;
}

export async function updateUser(
  userId: number,
  patch: {
    displayName?: string;
    email?: string;
    phone?: string;
    status?: 'active' | 'suspended';
    password?: string;
    listenbrainzToken?: string;
    listenbrainzUsername?: string;
  }
): Promise<UserRecord> {
  const db = getUsersDb();
  const existing = db.prepare('SELECT * FROM users WHERE id = ?').get(userId) as any;
  if (!existing) throw new Error(`User #${userId} not found.`);

  if (patch.status === 'suspended' && existing.status === 'active' && isUserSuperAdmin(userId)) {
    if (countActiveSuperAdminUsers(userId) === 0) {
      throw new ForbiddenError('Cannot suspend the last active Label super-admin user.');
    }
  }

  const passwordHash =
    patch.password && patch.password.trim().length > 0
      ? await hashPassword(patch.password)
      : existing.password_hash;

  db.prepare(
    `UPDATE users SET
       display_name = ?,
       email = ?,
       phone = ?,
       status = ?,
       password_hash = ?,
       listenbrainz_token = ?,
       listenbrainz_username = ?
     WHERE id = ?`
  ).run(
    patch.displayName !== undefined ? patch.displayName.trim() : existing.display_name,
    patch.email !== undefined ? patch.email.trim() : existing.email,
    patch.phone !== undefined ? patch.phone.trim() : existing.phone,
    patch.status !== undefined ? patch.status : existing.status,
    passwordHash,
    patch.listenbrainzToken !== undefined
      ? patch.listenbrainzToken.trim()
        ? encryptSecret(patch.listenbrainzToken.trim())
        : ''
      : existing.listenbrainz_token,
    patch.listenbrainzUsername !== undefined ? patch.listenbrainzUsername.trim() : existing.listenbrainz_username,
    userId
  );

  if (patch.status === 'suspended') {
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
  }
  return getUserById(userId)!;
}

export function deleteUser(userId: number): { ok: boolean } {
  const db = getUsersDb();
  const existing = db.prepare('SELECT * FROM users WHERE id = ?').get(userId) as any;
  if (!existing) throw new Error(`User #${userId} not found.`);
  if (existing.status === 'active' && isUserSuperAdmin(userId) && countActiveSuperAdminUsers(userId) === 0) {
    throw new ForbiddenError('Cannot delete the last active Label super-admin user.');
  }
  db.transaction(() => {
    db.prepare('DELETE FROM user_play_history WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM users WHERE id = ?').run(userId);
  })();
  return { ok: true };
}

export function setUserRoles(userId: number, roleIds: number[]): UserRecord {
  const db = getUsersDb();
  const existing = db.prepare('SELECT * FROM users WHERE id = ?').get(userId) as any;
  if (!existing) throw new Error(`User #${userId} not found.`);
  if (!Array.isArray(roleIds) || roleIds.length === 0) {
    throw new Error('A user must have at least one assigned role.');
  }

  const superAdminPlaceholders = roleIds.map(() => '?').join(', ');
  const keepsSuperAdmin = Boolean(
    db
      .prepare(`SELECT 1 FROM roles WHERE is_super_admin = 1 AND id IN (${superAdminPlaceholders}) LIMIT 1`)
      .get(...roleIds)
  );
  if (
    existing.status === 'active' &&
    isUserSuperAdmin(userId) &&
    !keepsSuperAdmin &&
    countActiveSuperAdminUsers(userId) === 0
  ) {
    throw new ForbiddenError('Cannot remove the Label role from the last active super-admin user.');
  }

  db.transaction(() => {
    db.prepare('DELETE FROM user_roles WHERE user_id = ?').run(userId);
    const ins = db.prepare('INSERT OR IGNORE INTO user_roles (user_id, role_id) VALUES (?, ?)');
    for (const rid of roleIds) {
      ins.run(userId, rid);
    }
  })();

  return getUserById(userId)!;
}

export function setUserOverrides(
  userId: number,
  overrides: Partial<RolePermissions> | null
): UserRecord {
  const db = getUsersDb();
  const existing = db.prepare('SELECT id FROM users WHERE id = ?').get(userId);
  if (!existing) throw new Error(`User #${userId} not found.`);
  if (!overrides || Object.keys(overrides).length === 0) {
    db.prepare('DELETE FROM user_permission_overrides WHERE user_id = ?').run(userId);
    return getUserById(userId)!;
  }
  db.prepare(
    `INSERT INTO user_permission_overrides (user_id, permissions_json)
     VALUES (?, ?)
     ON CONFLICT(user_id) DO UPDATE SET permissions_json = excluded.permissions_json`
  ).run(userId, JSON.stringify(overrides));
  return getUserById(userId)!;
}

export async function changeUserPassword(
  userId: number,
  currentPassword: string,
  newPassword: string
): Promise<{ ok: boolean }> {
  const db = getUsersDb();
  const row = db.prepare('SELECT id, password_hash FROM users WHERE id = ?').get(userId) as
    | { id: number; password_hash: string }
    | undefined;
  if (!row) throw new Error('User not found.');
  if (row.password_hash) {
    const valid = await verifyPassword(currentPassword, row.password_hash);
    if (!valid) throw new UnauthorizedError('Current password is incorrect.');
  }
  if (!newPassword || newPassword.length < 4) {
    throw new Error('New password must be at least 4 characters.');
  }
  const nextHash = await hashPassword(newPassword);
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(nextHash, userId);
  return { ok: true };
}

export async function resetUserPasswordDirect(
  username: string,
  newPassword: string
): Promise<UserRecord> {
  const db = getUsersDb();
  const row = db
    .prepare('SELECT id FROM users WHERE username = ? COLLATE NOCASE')
    .get(username.trim()) as { id: number } | undefined;
  if (!row) throw new Error(`User "${username}" not found.`);
  const nextHash = await hashPassword(newPassword);
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(nextHash, row.id);
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(row.id);
  return getUserById(row.id)!;
}

export function generateResetCode(userId: number): { code: string; expiresAt: number } {
  const db = getUsersDb();
  const user = db.prepare('SELECT id FROM users WHERE id = ?').get(userId);
  if (!user) throw new Error(`User #${userId} not found.`);
  const code = crypto.randomBytes(6).toString('hex').toUpperCase();
  const expiresAt = Date.now() + 30 * 60 * 1000;
  db.prepare('DELETE FROM password_reset_tokens WHERE user_id = ? OR expires_at <= ?').run(
    userId,
    Date.now()
  );
  db.prepare(
    'INSERT INTO password_reset_tokens (token_hash, user_id, expires_at, used) VALUES (?, ?, ?, 0)'
  ).run(hashToken(code), userId, expiresAt);
  return { code, expiresAt };
}

export function generateResetCodeForUsername(username: string): {
  username: string;
  code: string;
  expiresAt: number;
} {
  const row = getUsersDb()
    .prepare('SELECT id, username FROM users WHERE username = ? COLLATE NOCASE')
    .get(username.trim()) as { id: number; username: string } | undefined;
  if (!row) throw new Error(`User "${username}" not found.`);
  return { username: row.username, ...generateResetCode(row.id) };
}

export async function consumeResetCode(
  username: string,
  code: string,
  newPassword: string
): Promise<{ ok: boolean; user: UserRecord }> {
  const db = getUsersDb();
  const tokenHash = hashToken(code.trim().toUpperCase());
  const row = db
    .prepare(
      `SELECT prt.token_hash, prt.user_id, prt.expires_at, prt.used, u.username
       FROM password_reset_tokens prt
       INNER JOIN users u ON u.id = prt.user_id
       WHERE prt.token_hash = ?`
    )
    .get(tokenHash) as
    | { token_hash: string; user_id: number; expires_at: number; used: number; username: string }
    | undefined;

  if (!row || row.used || row.expires_at <= Date.now()) {
    throw new UnauthorizedError('Invalid or expired password reset code.');
  }
  if (username.trim() && row.username.toLowerCase() !== username.trim().toLowerCase()) {
    throw new UnauthorizedError('Reset code does not match that username.');
  }
  if (!newPassword || newPassword.length < 4) {
    throw new Error('New password must be at least 4 characters.');
  }

  const nextHash = await hashPassword(newPassword);
  db.transaction(() => {
    db.prepare('UPDATE password_reset_tokens SET used = 1 WHERE token_hash = ?').run(tokenHash);
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(nextHash, row.user_id);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(row.user_id);
  })();
  return { ok: true, user: getUserById(row.user_id)! };
}

export function createSession(
  userId: number,
  authSource: 'local' | 'authentik' | 'proxy-headers' | 'local-pin' = 'local',
  ttlDays = 30
): { token: string; expiresAt: number } {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = Date.now() + ttlDays * 86_400_000;
  const db = getUsersDb();
  db.prepare(
    'INSERT INTO sessions (token_hash, user_id, auth_source, expires_at) VALUES (?, ?, ?, ?)'
  ).run(hashToken(token), userId, authSource, expiresAt);
  db.prepare("UPDATE users SET last_seen_at = datetime('now') WHERE id = ?").run(userId);
  return { token, expiresAt };
}

export function revokeSessionToken(rawToken: string): void {
  if (!rawToken) return;
  getUsersDb().prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(rawToken));
}

export function buildCallerContextForUser(
  userId: number,
  authSource: CallerContext['authSource']
): CallerContext | null {
  const db = getUsersDb();
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(userId) as any;
  if (!row || row.status === 'suspended') return null;
  const { roles, isSuperAdmin, permissions } = computeEffectivePermissions(userId);
  return {
    userId,
    username: String(row.username),
    displayName: String(row.display_name || row.username),
    roles: roles.map((r) => r.name),
    isSuperAdmin,
    isGuest: false,
    authSource,
    permissions,
  };
}

export function resolveSessionToken(rawToken: string): CallerContext | null {
  if (!rawToken) return null;
  const db = getUsersDb();
  const tokenHash = hashToken(rawToken);
  const sess = db
    .prepare('SELECT user_id, auth_source, expires_at FROM sessions WHERE token_hash = ?')
    .get(tokenHash) as { user_id: number; auth_source: string; expires_at: number } | undefined;
  if (!sess) return null;
  if (sess.expires_at <= Date.now()) {
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
    return null;
  }
  const authSource =
    sess.auth_source === 'authentik' || sess.auth_source === 'proxy-headers'
      ? sess.auth_source
      : 'local';
  const ctx = buildCallerContextForUser(sess.user_id, authSource);
  if (!ctx) return null;
  db.prepare("UPDATE users SET last_seen_at = datetime('now') WHERE id = ?").run(sess.user_id);
  return ctx;
}

export async function authenticateLocalUser(
  username: string,
  password: string
): Promise<{ user: UserRecord; token: string; expiresAt: number } | null> {
  const db = getUsersDb();
  const row = db
    .prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE')
    .get(username.trim()) as any;
  if (!row || row.status === 'suspended' || !row.password_hash) return null;
  const valid = await verifyPassword(password, String(row.password_hash));
  if (!valid) return null;
  const { token, expiresAt } = createSession(Number(row.id), 'local');
  const user = getUserById(Number(row.id))!;
  return { user, token, expiresAt };
}

export function provisionExternalUser(input: {
  username: string;
  displayName?: string;
  email?: string;
  authentikSub?: string | null;
  isAdmin?: boolean;
  authSource: 'authentik' | 'proxy-headers';
}): CallerContext | null {
  ensureRbacSeeded();
  const db = getUsersDb();
  const cleanUsername = input.username.trim();
  if (!cleanUsername) return null;

  let row: any = null;
  if (input.authentikSub) {
    row = db
      .prepare('SELECT * FROM users WHERE authentik_sub = ?')
      .get(input.authentikSub);
  }
  if (!row) {
    row = db
      .prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE')
      .get(cleanUsername);
  }

  if (row) {
    if (row.status === 'suspended') return null;
    db.prepare(
      `UPDATE users SET
         display_name = CASE WHEN display_name = '' THEN ? ELSE display_name END,
         email = CASE WHEN email = '' THEN ? ELSE email END,
         authentik_sub = COALESCE(authentik_sub, ?),
         last_seen_at = datetime('now')
       WHERE id = ?`
    ).run(
      input.displayName || cleanUsername,
      input.email || '',
      input.authentikSub || null,
      row.id
    );
    return buildCallerContextForUser(Number(row.id), input.authSource);
  }

  const isFirstUser = getUserCount() === 0;
  const roleName = isFirstUser || input.isAdmin ? 'Label' : 'Roadie';
  const roleRow = db.prepare('SELECT id FROM roles WHERE name = ?').get(roleName) as { id: number };
  let userId = 0;
  db.transaction(() => {
    const res = db
      .prepare(
        `INSERT INTO users (username, display_name, email, authentik_sub, status, last_seen_at)
         VALUES (?, ?, ?, ?, 'active', datetime('now'))`
      )
      .run(
        cleanUsername,
        input.displayName || cleanUsername,
        input.email || '',
        input.authentikSub || null
      );
    userId = Number(res.lastInsertRowid);
    db.prepare('INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)').run(userId, roleRow.id);
  })();

  logger.info('AUTH_OIDC', `Auto-provisioned external user "${cleanUsername}" with role ${roleName}`);
  return buildCallerContextForUser(userId, input.authSource);
}

export async function bootstrapEnvAdminIfNeeded(): Promise<boolean> {
  ensureRbacSeeded();
  if (getUserCount() > 0) return false;
  const adminUser = process.env.RTUNES_ADMIN_USER?.trim();
  const adminPass = process.env.RTUNES_ADMIN_PASS;
  if (!adminUser || !adminPass) return false;

  await createUser({
    username: adminUser,
    displayName: adminUser,
    email: process.env.RTUNES_ADMIN_EMAIL?.trim() || '',
    password: adminPass,
    roleNames: ['Label'],
  });
  logger.info('SYSTEM', `Bootstrapped master Label account "${adminUser}" from RTUNES_ADMIN_USER.`);
  return true;
}
