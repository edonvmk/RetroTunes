import React, { useEffect, useMemo, useState } from 'react';
import {
  Check,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Columns,
  Database,
  Disc,
  Film,
  HardDrive,
  KeyRound,
  Layers,
  Lock,
  Plus,
  RefreshCw,
  Shield,
  Sparkles,
  Trash2,
  Upload,
  UserPlus,
  X,
  XCircle,
} from 'lucide-react';
import { invokeRpc } from '../bridge';
import {
  CallerMeResponse,
  PendingApprovalsPayload,
  PendingStoreRequestRow,
  PendingUploadRow,
  RolePermissions,
  RoleRecord,
  UserRecord,
} from '../types';

export type UacViewSelection =
  | { kind: 'uac_role'; roleId: number }
  | { kind: 'uac_all_users' }
  | { kind: 'uac_approvals' };

export type UacExternalModalTrigger = {
  kind: 'new_user' | 'new_role' | 'reset_code' | 'inspect_user';
  userId?: number;
  nonce: number;
};

interface UacWorkspaceViewProps {
  selection: UacViewSelection;
  roles: RoleRecord[];
  users: UserRecord[];
  approvals: PendingApprovalsPayload;
  callerMe: CallerMeResponse;
  searchQuery?: string;
  onSelectView: (next: UacViewSelection) => void;
  onRefreshData: () => Promise<void>;
  onOpenContextMenu?: (
    e: React.MouseEvent,
    kind: 'uac_user' | 'uac_role_member',
    user: UserRecord,
    roleId?: number
  ) => void;
  externalTrigger?: UacExternalModalTrigger | null;
}

type PermissionKey = keyof RolePermissions;
type CategoryId = 'libraries' | 'discovery' | 'devices_cache' | 'ingest_store' | 'approvals' | 'admin';

interface PermissionFieldDef {
  key: PermissionKey;
  category: CategoryId;
  label: string;
  description: string;
  kind: 'levels' | 'number';
  options?: { value: number; label: string }[];
  unit?: string;
}

interface PolicyCardDef {
  id: CategoryId;
  title: string;
  subtitle: string;
  accentGradient: string;
  icon: 'libraries' | 'discovery' | 'cache' | 'ingest' | 'approvals' | 'admin';
}

const POLICY_CARDS: PolicyCardDef[] = [
  {
    id: 'libraries',
    title: 'Media Libraries',
    subtitle: 'Access & metadata editing per library',
    accentGradient: 'linear-gradient(135deg, #27539c 0%, #4d88e5 100%)',
    icon: 'libraries',
  },
  {
    id: 'discovery',
    title: 'Music Discovery & AI',
    subtitle: 'eGenius Mixes & Genre Map tuning',
    accentGradient: 'linear-gradient(135deg, #4f3b8c 0%, #8367d6 100%)',
    icon: 'discovery',
  },
  {
    id: 'devices_cache',
    title: 'Devices & Local Cache',
    subtitle: 'ePod sync & SSD pre-cache quotas',
    accentGradient: 'linear-gradient(135deg, #1b6978 0%, #3aa3b6 100%)',
    icon: 'cache',
  },
  {
    id: 'ingest_store',
    title: 'Uploads, Store & Playlists',
    subtitle: 'Smart Upload, *arr requests & shared lists',
    accentGradient: 'linear-gradient(135deg, #8b4a1f 0%, #cc7b37 100%)',
    icon: 'ingest',
  },
  {
    id: 'approvals',
    title: 'Approvals & Moderation',
    subtitle: 'Review staged uploads & *arr queue items',
    accentGradient: 'linear-gradient(135deg, #1c6b42 0%, #37a46b 100%)',
    icon: 'approvals',
  },
  {
    id: 'admin',
    title: 'Server Administration',
    subtitle: 'Library indexing, keys, logs & UAC',
    accentGradient: 'linear-gradient(135deg, #4b5563 0%, #7c8798 100%)',
    icon: 'admin',
  },
];

const LIB_OPTIONS = [
  { value: 0, label: 'Hidden' },
  { value: 1, label: 'Read-Only' },
  { value: 2, label: 'Full Edit' },
];

const SWITCH_OPTIONS = [
  { value: 0, label: 'Disabled' },
  { value: 1, label: 'Enabled' },
];

const PERMISSION_FIELDS: PermissionFieldDef[] = [
  { key: 'libMusic', category: 'libraries', label: 'Music Library', description: 'Playback, Browse, and Track Metadata Hydration', kind: 'levels', options: LIB_OPTIONS },
  { key: 'libMovies', category: 'libraries', label: 'Movies', description: 'Movie Streaming & Artwork/Metadata Editing', kind: 'levels', options: LIB_OPTIONS },
  { key: 'libTvShows', category: 'libraries', label: 'TV Shows', description: 'Series/Episode Playback & Artwork Updates', kind: 'levels', options: LIB_OPTIONS },
  { key: 'libMusicVideos', category: 'libraries', label: 'Music Videos', description: 'Music Video Access & Tag Edits', kind: 'levels', options: LIB_OPTIONS },
  { key: 'libBooks', category: 'libraries', label: 'Books', description: 'PDF/EPUB Library Reading & Metadata', kind: 'levels', options: LIB_OPTIONS },
  { key: 'libAudiobooks', category: 'libraries', label: 'Audiobooks', description: 'Audiobook Progress Sync & Management', kind: 'levels', options: LIB_OPTIONS },
  { key: 'libPhotos', category: 'libraries', label: 'Photos', description: 'Photo Gallery Browsing & Indexing', kind: 'levels', options: LIB_OPTIONS },

  {
    key: 'featEgenius',
    category: 'discovery',
    label: 'eGenius Mixes',
    description: 'AI & Affinity-Powered Smart Mix Generation',
    kind: 'levels',
    options: [
      { value: 0, label: 'Hidden' },
      { value: 1, label: 'Generate Temporary' },
      { value: 2, label: 'Save & Refresh' },
    ],
  },
  {
    key: 'featGenreMap',
    category: 'discovery',
    label: 'Genre Map Matrix',
    description: 'Subgenre Adjacency Heatmap & Scene Tester',
    kind: 'levels',
    options: [
      { value: 0, label: 'Hidden' },
      { value: 1, label: 'View Only' },
      { value: 2, label: 'Edit & Rebuild' },
    ],
  },

  { key: 'featDevicesSync', category: 'devices_cache', label: 'Portable Devices (ePod / MTP)', description: 'Show Devices in sidebar and allow USB sync', kind: 'levels', options: SWITCH_OPTIONS },
  {
    key: 'localCacheTier',
    category: 'devices_cache',
    label: 'Local Pre-Cache Tier',
    description: 'Pin tracks/videos locally for offline desktop playback',
    kind: 'levels',
    options: [
      { value: 0, label: 'Stream Only' },
      { value: 1, label: 'Capped Quota' },
      { value: 2, label: 'Unlimited' },
    ],
  },
  {
    key: 'localCacheLimitMb',
    category: 'devices_cache',
    label: 'Quota Limit (MB)',
    description: 'Maximum local cache allowance when Capped Quota is active',
    kind: 'number',
    unit: 'MB',
  },

  {
    key: 'mediaUpload',
    category: 'ingest_store',
    label: 'Smart Media Upload',
    description: 'Upload Wizard access & immediate import vs Label review',
    kind: 'levels',
    options: [
      { value: 0, label: 'Disabled' },
      { value: 1, label: 'Approval Queue' },
      { value: 2, label: 'Direct Import' },
    ],
  },
  {
    key: 'storeRequest',
    category: 'ingest_store',
    label: 'rTunes Store (*arr)',
    description: 'Browse Top Charts and request via Lidarr/Radarr/Sonarr',
    kind: 'levels',
    options: [
      { value: 0, label: 'Hidden' },
      { value: 1, label: 'Approval Queue' },
      { value: 2, label: 'Direct Request' },
    ],
  },
  {
    key: 'playlists',
    category: 'ingest_store',
    label: 'Playlists',
    description: 'Create personal playlists or collaborate on shared server lists',
    kind: 'levels',
    options: [
      { value: 0, label: 'Read-Only' },
      { value: 1, label: 'Personal' },
      { value: 2, label: 'Shared & Full' },
    ],
  },

  { key: 'approveUploads', category: 'approvals', label: 'Approve Media Uploads', description: 'Inspect, commit, or reject staged Smart Uploads', kind: 'levels', options: SWITCH_OPTIONS },
  { key: 'approveStore', category: 'approvals', label: 'Approve Store Requests', description: 'Approve or reject queued Lidarr/Radarr/Sonarr requests', kind: 'levels', options: SWITCH_OPTIONS },

  { key: 'rescanLibrary', category: 'admin', label: 'Rescan Media Library', description: 'Trigger incremental background indexer scans', kind: 'levels', options: SWITCH_OPTIONS },
  { key: 'rebuildDb', category: 'admin', label: 'Rebuild Database', description: 'Reconstruct FTS5 & domain library indexes', kind: 'levels', options: SWITCH_OPTIONS },
  { key: 'manageApiKeys', category: 'admin', label: 'Manage API Keys & *arr', description: 'View/edit Store & Third-Party API keys tab', kind: 'levels', options: SWITCH_OPTIONS },
  { key: 'viewServerLogs', category: 'admin', label: 'View Server Diagnostics', description: 'Open Diagnostics logs viewer and JSON export', kind: 'levels', options: SWITCH_OPTIONS },
  { key: 'manageUac', category: 'admin', label: 'Manage Users & Roles', description: 'Full Access Control admin (Users, Roles, Auth Gate)', kind: 'levels', options: SWITCH_OPTIONS },
];

type AllUserColKey = 'username' | 'displayName' | 'roles' | 'status' | 'authSource' | 'email' | 'listenbrainz' | 'lastSeen';

const ALL_USER_COLUMNS: { key: AllUserColKey; label: string; width: number }[] = [
  { key: 'username', label: 'Username', width: 130 },
  { key: 'displayName', label: 'Display Name', width: 155 },
  { key: 'roles', label: 'Assigned Roles', width: 210 },
  { key: 'status', label: 'Status', width: 92 },
  { key: 'authSource', label: 'Auth Source', width: 105 },
  { key: 'email', label: 'Email', width: 170 },
  { key: 'listenbrainz', label: 'ListenBrainz', width: 120 },
  { key: 'lastSeen', label: 'Last Seen', width: 135 },
];

function renderCardIcon(icon: PolicyCardDef['icon']) {
  switch (icon) {
    case 'libraries':
      return <Film size={30} color="#ffffff" />;
    case 'discovery':
      return <Sparkles size={30} color="#ffffff" />;
    case 'cache':
      return <HardDrive size={30} color="#ffffff" />;
    case 'ingest':
      return <Upload size={30} color="#ffffff" />;
    case 'approvals':
      return <CheckCircle2 size={30} color="#ffffff" />;
    case 'admin':
      return <Database size={30} color="#ffffff" />;
  }
}

function summarizeCardPermissions(cardId: CategoryId, perms: RolePermissions): string[] {
  const fields = PERMISSION_FIELDS.filter((f) => f.category === cardId);
  return fields.slice(0, 4).map((f) => {
    const val = perms[f.key];
    if (f.kind === 'number') {
      return `${f.label}: ${perms.localCacheTier === 1 ? `${val} MB` : perms.localCacheTier === 2 ? 'Unlimited' : 'N/A'}`;
    }
    const opt = f.options?.find((o) => o.value === Number(val));
    return `${f.label}: ${opt?.label || String(val)}`;
  });
}

function describePermissionOrigin(
  key: PermissionKey,
  user: UserRecord
): { label: string; isOverride: boolean; effectiveVal: number } {
  const effectiveVal = Number(user.effectivePermissions[key] ?? 0);
  if (user.roles.some((r) => r.isSuperAdmin)) {
    return { label: 'Label (Super Admin)', isOverride: false, effectiveVal };
  }
  const hasOverride = user.overrides && user.overrides[key] !== undefined;
  const maxRoleVal = user.roles.reduce(
    (max, r) => Math.max(max, Number(r.permissions[key] ?? 0)),
    0
  );
  if (hasOverride && Number(user.overrides?.[key]) >= maxRoleVal) {
    return { label: 'Direct Override', isOverride: true, effectiveVal };
  }
  const winningRoles = user.roles.filter((r) => Number(r.permissions[key] ?? 0) === effectiveVal);
  if (winningRoles.length > 0) {
    return {
      label: `Role: ${winningRoles.map((r) => r.name).join(' + ')}`,
      isOverride: Boolean(hasOverride),
      effectiveVal,
    };
  }
  return { label: 'Default Baseline', isOverride: Boolean(hasOverride), effectiveVal };
}

function parseStagedFiles(row: PendingUploadRow): {
  formattedPaths: string[];
  matchTitle: string;
  targetRootDir: string;
} {
  try {
    const parsed = JSON.parse(row.staged_payload_json || '{}') as {
      plan?: { targetRootDir?: string; items?: { formattedRelativePath?: string; destinationPath?: string }[] };
      match?: { title?: string; subtitle?: string };
    };
    const items = parsed?.plan?.items || [];
    return {
      formattedPaths: items.map((it) => it.formattedRelativePath || it.destinationPath || ''),
      matchTitle: parsed?.match?.title || row.title,
      targetRootDir: parsed?.plan?.targetRootDir || row.destination_path,
    };
  } catch {
    return { formattedPaths: [], matchTitle: row.title, targetRootDir: row.destination_path };
  }
}

export const UacWorkspaceView: React.FC<UacWorkspaceViewProps> = ({
  selection,
  roles,
  users,
  approvals,
  callerMe,
  searchQuery = '',
  onSelectView,
  onRefreshData,
  onOpenContextMenu,
  externalTrigger,
}) => {
  const canManageUac = callerMe.isSuperAdmin || callerMe.permissions.manageUac >= 1;
  const canApproveUploads = callerMe.isSuperAdmin || callerMe.permissions.approveUploads >= 1;
  const canApproveStore = callerMe.isSuperAdmin || callerMe.permissions.approveStore >= 1;

  const [roleViewMode, setRoleViewMode] = useState<'coverflow' | 'browser'>('coverflow');
  const [selectedCardIdx, setSelectedCardIdx] = useState<number>(0);
  const [roleQuotaDraft, setRoleQuotaDraft] = useState<string>('2048');
  const [userQuotaDraft, setUserQuotaDraft] = useState<string>('2048');
  const [statusBanner, setStatusBanner] = useState<{ ok: boolean; text: string } | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [addMemberUserId, setAddMemberUserId] = useState<string>('');

  // All Users state
  const [selectedUserId, setSelectedUserId] = useState<number | null>(null);
  const [visibleUserCols, setVisibleUserCols] = useState<Set<AllUserColKey>>(
    () => new Set(['username', 'displayName', 'roles', 'status', 'authSource', 'lastSeen'])
  );
  const [showColPicker, setShowColPicker] = useState(false);

  // Approvals state
  const [approvalFilter, setApprovalFilter] = useState<'all' | 'uploads' | 'store'>('all');
  const [selectedApproval, setSelectedApproval] = useState<{ kind: 'upload' | 'store'; id: number } | null>(null);
  const [rejectionReason, setRejectionReason] = useState('');

  // Modals
  const [showNewUserModal, setShowNewUserModal] = useState(false);
  const [newUserForm, setNewUserForm] = useState({
    username: '',
    displayName: '',
    email: '',
    phone: '',
    password: '',
    roleId: '',
  });

  const [showNewRoleModal, setShowNewRoleModal] = useState(false);
  const [newRoleForm, setNewRoleForm] = useState({
    name: '',
    description: '',
    color: '#5a8dee',
    basePreset: 'roadie' as 'roadie' | 'band',
  });

  const [resetCodeModal, setResetCodeModal] = useState<{
    username: string;
    code: string;
    expiresAt: string;
  } | null>(null);

  const activeRole = useMemo(() => {
    if (selection.kind !== 'uac_role') return roles[0] || null;
    return roles.find((r) => r.id === selection.roleId) || roles[0] || null;
  }, [selection, roles]);

  useEffect(() => {
    if (activeRole) {
      setRoleQuotaDraft(String(activeRole.permissions.localCacheLimitMb ?? 0));
    }
  }, [activeRole?.id, activeRole?.permissions.localCacheLimitMb]);

  useEffect(() => {
    if (users.length === 0) {
      setSelectedUserId(null);
      return;
    }
    if (!selectedUserId || !users.some((u) => u.id === selectedUserId)) {
      setSelectedUserId(users[0].id);
    }
  }, [users, selectedUserId]);

  useEffect(() => {
    if (!externalTrigger) return;
    if (externalTrigger.kind === 'new_user') {
      setShowNewUserModal(true);
    } else if (externalTrigger.kind === 'new_role') {
      setShowNewRoleModal(true);
    } else if (externalTrigger.kind === 'inspect_user' && externalTrigger.userId) {
      onSelectView({ kind: 'uac_all_users' });
      setSelectedUserId(externalTrigger.userId);
    } else if (externalTrigger.kind === 'reset_code' && externalTrigger.userId) {
      const targetUser = users.find((u) => u.id === externalTrigger.userId);
      if (targetUser) {
        void handleGenerateResetCode(targetUser);
      }
    }
  }, [externalTrigger]);

  const queryLower = searchQuery.trim().toLowerCase();

  const filteredUsers = useMemo(() => {
    if (!queryLower) return users;
    return users.filter(
      (u) =>
        u.username.toLowerCase().includes(queryLower) ||
        u.displayName.toLowerCase().includes(queryLower) ||
        u.email.toLowerCase().includes(queryLower) ||
        u.roles.some((r) => r.name.toLowerCase().includes(queryLower))
    );
  }, [users, queryLower]);

  const roleMembers = useMemo(() => {
    if (!activeRole) return [];
    return filteredUsers.filter((u) => u.roles.some((r) => r.id === activeRole.id));
  }, [filteredUsers, activeRole]);

  const nonRoleMembers = useMemo(() => {
    if (!activeRole) return [];
    return users.filter((u) => !u.roles.some((r) => r.id === activeRole.id));
  }, [users, activeRole]);

  const selectedUser = useMemo(
    () => users.find((u) => u.id === selectedUserId) || users[0] || null,
    [users, selectedUserId]
  );

  useEffect(() => {
    if (selectedUser) {
      setUserQuotaDraft(String(selectedUser.effectivePermissions.localCacheLimitMb ?? 0));
    }
  }, [selectedUser?.id, selectedUser?.effectivePermissions.localCacheLimitMb]);

  const visibleUploads = useMemo(() => {
    if (!canApproveUploads && !canManageUac) return [];
    if (approvalFilter === 'store') return [];
    return approvals.uploads;
  }, [approvals.uploads, approvalFilter, canApproveUploads, canManageUac]);

  const visibleStoreReqs = useMemo(() => {
    if (!canApproveStore && !canManageUac) return [];
    if (approvalFilter === 'uploads') return [];
    return approvals.storeRequests;
  }, [approvals.storeRequests, approvalFilter, canApproveStore, canManageUac]);

  const totalPendingCount = approvals.uploads.length + approvals.storeRequests.length;

  const activeApprovalItem = useMemo(():
    | { kind: 'upload'; item: PendingUploadRow }
    | { kind: 'store'; item: PendingStoreRequestRow }
    | null => {
    if (selectedApproval) {
      if (selectedApproval.kind === 'upload') {
        const found = visibleUploads.find((u) => u.id === selectedApproval.id);
        if (found) return { kind: 'upload', item: found };
      } else {
        const found = visibleStoreReqs.find((s) => s.id === selectedApproval.id);
        if (found) return { kind: 'store', item: found };
      }
    }
    if (visibleUploads.length > 0) return { kind: 'upload', item: visibleUploads[0] };
    if (visibleStoreReqs.length > 0) return { kind: 'store', item: visibleStoreReqs[0] };
    return null;
  }, [selectedApproval, visibleUploads, visibleStoreReqs]);

  const activeCard = POLICY_CARDS[selectedCardIdx] || POLICY_CARDS[0];
  const activeCardFields = useMemo(
    () => PERMISSION_FIELDS.filter((f) => f.category === activeCard.id),
    [activeCard.id]
  );

  const flashBanner = (ok: boolean, text: string) => {
    setStatusBanner({ ok, text });
  };

  const handleUpdateRolePermission = async (role: RoleRecord, key: PermissionKey, value: number) => {
    if (role.isSuperAdmin || !canManageUac) return;
    setBusyKey(`role-perm-${key}`);
    try {
      await invokeRpc('uac:updateRole', role.id, {
        permissions: { [key]: value },
      });
      await onRefreshData();
      flashBanner(true, `Updated "${role.name}" (${key} -> ${value}).`);
    } catch (err) {
      flashBanner(false, err instanceof Error ? err.message : String(err));
    } finally {
      setBusyKey(null);
    }
  };

  const handleDeleteRole = async (role: RoleRecord) => {
    if (role.isSystem) return;
    setBusyKey(`del-role-${role.id}`);
    try {
      await invokeRpc('uac:deleteRole', role.id);
      await onRefreshData();
      onSelectView({ kind: 'uac_all_users' });
      flashBanner(true, `Deleted role "${role.name}".`);
    } catch (err) {
      flashBanner(false, err instanceof Error ? err.message : String(err));
    } finally {
      setBusyKey(null);
    }
  };

  const handleAddUserToActiveRole = async () => {
    if (!activeRole || !addMemberUserId) return;
    const uid = Number(addMemberUserId);
    const target = users.find((u) => u.id === uid);
    if (!target) return;
    setBusyKey('add-member');
    try {
      const nextRoleIds = Array.from(new Set([...target.roles.map((r) => r.id), activeRole.id]));
      await invokeRpc('uac:setUserRoles', uid, nextRoleIds);
      setAddMemberUserId('');
      await onRefreshData();
      flashBanner(true, `Added ${target.username} to ${activeRole.name}.`);
    } catch (err) {
      flashBanner(false, err instanceof Error ? err.message : String(err));
    } finally {
      setBusyKey(null);
    }
  };

  const handleRemoveUserFromRole = async (user: UserRecord, roleId: number) => {
    setBusyKey(`rm-member-${user.id}`);
    try {
      const nextRoleIds = user.roles.filter((r) => r.id !== roleId).map((r) => r.id);
      await invokeRpc('uac:setUserRoles', user.id, nextRoleIds);
      await onRefreshData();
      flashBanner(true, `Removed ${user.username} from role.`);
    } catch (err) {
      flashBanner(false, err instanceof Error ? err.message : String(err));
    } finally {
      setBusyKey(null);
    }
  };

  const handleToggleUserRole = async (user: UserRecord, roleId: number, checked: boolean) => {
    setBusyKey(`user-role-${user.id}-${roleId}`);
    try {
      const currentIds = user.roles.map((r) => r.id);
      const nextIds = checked
        ? Array.from(new Set([...currentIds, roleId]))
        : currentIds.filter((id) => id !== roleId);
      await invokeRpc('uac:setUserRoles', user.id, nextIds);
      await onRefreshData();
      flashBanner(true, `Updated roles for ${user.username}.`);
    } catch (err) {
      flashBanner(false, err instanceof Error ? err.message : String(err));
    } finally {
      setBusyKey(null);
    }
  };

  const handleToggleUserStatus = async (user: UserRecord) => {
    const nextStatus = user.status === 'active' ? 'suspended' : 'active';
    setBusyKey(`user-status-${user.id}`);
    try {
      await invokeRpc('uac:updateUser', user.id, { status: nextStatus });
      await onRefreshData();
      flashBanner(true, `${user.username} is now ${nextStatus}.`);
    } catch (err) {
      flashBanner(false, err instanceof Error ? err.message : String(err));
    } finally {
      setBusyKey(null);
    }
  };

  const handleSetUserOverride = async (user: UserRecord, key: PermissionKey, value: number | null) => {
    if (!canManageUac || user.roles.some((r) => r.isSuperAdmin)) return;
    setBusyKey(`user-ovr-${key}`);
    try {
      const nextOverrides: Record<string, number> = { ...(user.overrides || {}) };
      if (value === null) {
        delete nextOverrides[key];
      } else {
        nextOverrides[key] = value;
      }
      await invokeRpc(
        'uac:setUserOverrides',
        user.id,
        Object.keys(nextOverrides).length > 0 ? nextOverrides : null
      );
      await onRefreshData();
      flashBanner(
        true,
        value === null ? `Cleared override for ${key}.` : `Saved override ${key} -> ${value}.`
      );
    } catch (err) {
      flashBanner(false, err instanceof Error ? err.message : String(err));
    } finally {
      setBusyKey(null);
    }
  };

  const handleGenerateResetCode = async (user: UserRecord) => {
    setBusyKey(`reset-${user.id}`);
    try {
      const res = await invokeRpc<{ ok: boolean; code: string; expiresAt: string }>(
        'uac:generateResetCode',
        user.id
      );
      setResetCodeModal({
        username: user.username,
        code: res.code,
        expiresAt: res.expiresAt,
      });
    } catch (err) {
      flashBanner(false, err instanceof Error ? err.message : String(err));
    } finally {
      setBusyKey(null);
    }
  };

  const handleDeleteUser = async (user: UserRecord) => {
    setBusyKey(`del-user-${user.id}`);
    try {
      await invokeRpc('uac:deleteUser', user.id);
      await onRefreshData();
      flashBanner(true, `Deleted user "${user.username}".`);
    } catch (err) {
      flashBanner(false, err instanceof Error ? err.message : String(err));
    } finally {
      setBusyKey(null);
    }
  };

  const handleCreateUserSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusyKey('create-user');
    try {
      const roleIds = newUserForm.roleId ? [Number(newUserForm.roleId)] : [];
      const created = await invokeRpc<UserRecord>('uac:createUser', {
        username: newUserForm.username.trim(),
        displayName: newUserForm.displayName.trim() || newUserForm.username.trim(),
        email: newUserForm.email.trim(),
        phone: newUserForm.phone.trim(),
        password: newUserForm.password,
        roleIds,
      });
      setShowNewUserModal(false);
      setNewUserForm({ username: '', displayName: '', email: '', phone: '', password: '', roleId: '' });
      await onRefreshData();
      onSelectView({ kind: 'uac_all_users' });
      setSelectedUserId(created.id);
      flashBanner(true, `Created user "${created.username}".`);
    } catch (err) {
      flashBanner(false, err instanceof Error ? err.message : String(err));
    } finally {
      setBusyKey(null);
    }
  };

  const handleCreateRoleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusyKey('create-role');
    try {
      const baseRole = roles.find((r) => r.name.toLowerCase() === newRoleForm.basePreset);
      const created = await invokeRpc<RoleRecord>('uac:createRole', {
        name: newRoleForm.name.trim(),
        description: newRoleForm.description.trim(),
        color: newRoleForm.color,
        permissions: baseRole?.permissions,
      });
      setShowNewRoleModal(false);
      setNewRoleForm({ name: '', description: '', color: '#5a8dee', basePreset: 'roadie' });
      await onRefreshData();
      onSelectView({ kind: 'uac_role', roleId: created.id });
      flashBanner(true, `Created custom role "${created.name}".`);
    } catch (err) {
      flashBanner(false, err instanceof Error ? err.message : String(err));
    } finally {
      setBusyKey(null);
    }
  };

  const handleApproveReject = async (action: 'approve' | 'reject') => {
    if (!activeApprovalItem) return;
    setBusyKey(`${action}-${activeApprovalItem.kind}-${activeApprovalItem.item.id}`);
    try {
      if (action === 'approve') {
        await invokeRpc('uac:approvePendingItem', activeApprovalItem.kind, activeApprovalItem.item.id);
        flashBanner(
          true,
          `Approved ${activeApprovalItem.kind} "${activeApprovalItem.item.title}".`
        );
      } else {
        await invokeRpc(
          'uac:rejectPendingItem',
          activeApprovalItem.kind,
          activeApprovalItem.item.id,
          rejectionReason.trim() || undefined
        );
        flashBanner(
          true,
          `Rejected ${activeApprovalItem.kind} "${activeApprovalItem.item.title}".`
        );
      }
      setRejectionReason('');
      setSelectedApproval(null);
      await onRefreshData();
    } catch (err) {
      flashBanner(false, err instanceof Error ? err.message : String(err));
    } finally {
      setBusyKey(null);
    }
  };

  const handleToggleUserCol = (col: AllUserColKey) => {
    setVisibleUserCols((prev) => {
      const next = new Set(prev);
      if (next.has(col)) {
        if (next.size > 1) next.delete(col);
      } else {
        next.add(col);
      }
      return next;
    });
  };

  const renderPermissionFieldRow = (
    field: PermissionFieldDef,
    currentValue: number,
    locked: boolean,
    onChangeValue: (val: number) => void,
    quotaCfg?: {
      draftValue: string;
      onDraftChange: (v: string) => void;
      numberDisabled?: boolean;
    },
    extraBadge?: React.ReactNode
  ) => {
    const isNumDisabled = locked || Boolean(quotaCfg?.numberDisabled);
    const numValue = quotaCfg?.draftValue ?? String(currentValue);
    return (
      <div
        key={field.key}
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
          padding: '7px 10px',
          borderBottom: '1px solid #e2e7ef',
          background: '#ffffff',
        }}
      >
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            <span style={{ fontWeight: 700, fontSize: 11.5, color: '#1f2937' }}>{field.label}</span>
            {extraBadge}
          </div>
          <div style={{ fontSize: 10.5, color: '#64748b' }}>{field.description}</div>
        </div>

        {field.kind === 'number' ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <input
              type="number"
              min={0}
              step={128}
              disabled={isNumDisabled}
              value={numValue}
              onChange={(e) => quotaCfg?.onDraftChange(e.target.value)}
              onBlur={() => {
                const parsed = Math.max(0, Math.round(Number(numValue) || 0));
                if (parsed !== currentValue) onChangeValue(parsed);
              }}
              style={{
                width: 84,
                padding: '3px 6px',
                fontSize: 11.5,
                borderRadius: 4,
                border: '1px solid #9ba4b2',
                background: isNumDisabled ? '#eef1f5' : '#ffffff',
              }}
            />
            <span style={{ fontSize: 11, color: '#475569' }}>{field.unit || 'MB'}</span>
          </div>
        ) : (
          <div className="segmented-group" style={{ flexShrink: 0 }}>
            {(field.options || []).map((opt) => {
              const isActive = Number(currentValue) === opt.value;
              return (
                <button
                  key={opt.value}
                  type="button"
                  disabled={locked || busyKey !== null}
                  onClick={() => onChangeValue(opt.value)}
                  className={`segmented-btn ${isActive ? 'active' : ''}`}
                  style={{
                    padding: '3px 8px',
                    fontSize: 10.5,
                    opacity: locked ? 0.65 : 1,
                    cursor: locked ? 'not-allowed' : 'pointer',
                  }}
                >
                  {opt.label}
                </button>
              );
            })}
          </div>
        )}
      </div>
    );
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, background: '#eef1f5' }}>
      {/* Brushed-Metal Header Bar matching Music Library */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '6px 12px',
          background: 'linear-gradient(180deg, #e7eaef 0%, #cfd5de 100%)',
          borderBottom: '1px solid #96a0ae',
          gap: 10,
          flexWrap: 'wrap',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <Shield size={16} color="#26549a" />
          <div>
            <div style={{ fontSize: 12.5, fontWeight: 700, color: '#1e242d' }}>
              {selection.kind === 'uac_role' && activeRole
                ? `Role Policy — ${activeRole.name}`
                : selection.kind === 'uac_approvals'
                  ? 'Pending Approvals Queue'
                  : 'All Users & Effective Access'}
            </div>
            <div style={{ fontSize: 10.5, color: '#4c5563' }}>
              {selection.kind === 'uac_role' && activeRole
                ? activeRole.description || 'Scaled RBAC Role Policy'
                : selection.kind === 'uac_approvals'
                  ? `${totalPendingCount} awaiting Label / Moderator review`
                  : `${users.length} local & SSO account(s) · Highest Access Wins`}
            </div>
          </div>

          {canManageUac && (
            <div className="segmented-group" style={{ marginLeft: 8 }}>
              <button
                type="button"
                className={`segmented-btn ${selection.kind === 'uac_role' ? 'active' : ''}`}
                onClick={() =>
                  onSelectView({
                    kind: 'uac_role',
                    roleId: activeRole?.id || roles[0]?.id || 1,
                  })
                }
              >
                Roles
              </button>
              <button
                type="button"
                className={`segmented-btn ${selection.kind === 'uac_all_users' ? 'active' : ''}`}
                onClick={() => onSelectView({ kind: 'uac_all_users' })}
              >
                All Users
              </button>
              <button
                type="button"
                className={`segmented-btn ${selection.kind === 'uac_approvals' ? 'active' : ''}`}
                onClick={() => onSelectView({ kind: 'uac_approvals' })}
              >
                Pending Approvals{totalPendingCount > 0 ? ` (${totalPendingCount})` : ''}
              </button>
            </div>
          )}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          {selection.kind === 'uac_role' && (
            <div className="segmented-group">
              <button
                type="button"
                className={`segmented-btn ${roleViewMode === 'coverflow' ? 'active' : ''}`}
                onClick={() => setRoleViewMode('coverflow')}
                title="3D Policy Card Flow"
              >
                <Layers size={11} /> Card Flow
              </button>
              <button
                type="button"
                className={`segmented-btn ${roleViewMode === 'browser' ? 'active' : ''}`}
                onClick={() => setRoleViewMode('browser')}
                title="Classic Category Column Browser"
              >
                <Columns size={11} /> Category Browser
              </button>
            </div>
          )}

          {canManageUac && (
            <>
              <button
                type="button"
                className="aqua-btn"
                onClick={() => setShowNewRoleModal(true)}
              >
                <Plus size={12} /> New Role...
              </button>
              <button
                type="button"
                className="aqua-btn primary"
                onClick={() => setShowNewUserModal(true)}
              >
                <UserPlus size={12} /> New User...
              </button>
            </>
          )}

          <button
            type="button"
            className="aqua-btn"
            onClick={() => void onRefreshData()}
            title="Refresh users, roles, and pending queue"
          >
            <RefreshCw size={12} />
          </button>
        </div>
      </div>

      {statusBanner && (
        <div
          style={{
            padding: '5px 12px',
            fontSize: 11,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            background: statusBanner.ok ? '#ecfdf5' : '#fef2f2',
            borderBottom: `1px solid ${statusBanner.ok ? '#86efac' : '#fca5a5'}`,
            color: statusBanner.ok ? '#166534' : '#991b1b',
          }}
        >
          <span>{statusBanner.text}</span>
          <button
            type="button"
            onClick={() => setStatusBanner(null)}
            style={{ border: 'none', background: 'transparent', cursor: 'pointer', color: 'inherit' }}
          >
            <X size={12} />
          </button>
        </div>
      )}

      {/* VIEW 1: ROLE POLICY + MEMBERS */}
      {selection.kind === 'uac_role' && activeRole && (
        <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          {/* Role strip */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '5px 12px',
              background: '#f5f7fa',
              borderBottom: '1px solid #c3cbd7',
              gap: 8,
              flexWrap: 'wrap',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
              {roles.map((r) => {
                const isSelected = r.id === activeRole.id;
                return (
                  <button
                    key={r.id}
                    type="button"
                    onClick={() => onSelectView({ kind: 'uac_role', roleId: r.id })}
                    className={`aqua-btn ${isSelected ? 'primary' : ''}`}
                    style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}
                  >
                    <span
                      style={{
                        width: 8,
                        height: 8,
                        borderRadius: '50%',
                        background: r.color || '#5a8dee',
                        border: '1px solid rgba(0,0,0,0.25)',
                      }}
                    />
                    {r.name}
                    {r.isSuperAdmin && <Lock size={10} />}
                  </button>
                );
              })}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              {activeRole.isSuperAdmin ? (
                <span
                  style={{
                    fontSize: 10.5,
                    fontWeight: 700,
                    color: '#92400e',
                    background: '#fef3c7',
                    border: '1px solid #fcd34d',
                    borderRadius: 10,
                    padding: '2px 8px',
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 4,
                  }}
                >
                  <Lock size={11} /> Locked Super-Admin Policy
                </span>
              ) : (
                !activeRole.isSystem &&
                canManageUac && (
                  <button
                    type="button"
                    className="aqua-btn"
                    onClick={() => void handleDeleteRole(activeRole)}
                    style={{ color: '#991b1b' }}
                  >
                    <Trash2 size={11} /> Delete Role
                  </button>
                )
              )}
            </div>
          </div>

          {/* Card Flow Stage */}
          {roleViewMode === 'coverflow' ? (
            <div style={{ display: 'flex', flexDirection: 'column', borderBottom: '1px solid #9da6b4' }}>
              <div className="coverflow-stage" style={{ height: 215, minHeight: 215, padding: '10px 20px 8px' }}>
                <div className="coverflow-3d-viewport" style={{ height: 145 }}>
                  {POLICY_CARDS.map((card, idx) => {
                    const offset = idx - selectedCardIdx;
                    const absOff = Math.abs(offset);
                    const translateX = offset * 135;
                    const translateZ = offset === 0 ? 45 : -absOff * 65;
                    const rotateY = offset === 0 ? 0 : offset < 0 ? 42 : -42;
                    const zIndex = 40 - absOff;
                    const summary = summarizeCardPermissions(card.id, activeRole.permissions);
                    return (
                      <div
                        key={card.id}
                        className="coverflow-card"
                        onClick={() => setSelectedCardIdx(idx)}
                        style={{
                          width: 170,
                          height: 126,
                          padding: 10,
                          flexDirection: 'column',
                          justifyContent: 'space-between',
                          alignItems: 'flex-start',
                          background: card.accentGradient,
                          transform: `translateX(${translateX}px) translateZ(${translateZ}px) rotateY(${rotateY}deg)`,
                          opacity: absOff > 3 ? 0 : 1,
                          zIndex,
                          transition: 'transform 0.24s ease, opacity 0.24s ease',
                        }}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%' }}>
                          {renderCardIcon(card.icon)}
                          <div style={{ color: '#fff', fontWeight: 700, fontSize: 11.5, textShadow: '0 1px 2px rgba(0,0,0,0.45)' }}>
                            {card.title}
                          </div>
                        </div>
                        <div style={{ width: '100%', fontSize: 9.5, color: 'rgba(255,255,255,0.92)', lineHeight: 1.35 }}>
                          {summary.map((line, i) => (
                            <div
                              key={i}
                              style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}
                            >
                              {line}
                            </div>
                          ))}
                        </div>
                      </div>
                    );
                  })}
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: 10, zIndex: 25 }}>
                  <button
                    type="button"
                    className="aqua-btn"
                    disabled={selectedCardIdx <= 0}
                    onClick={() => setSelectedCardIdx((i) => Math.max(0, i - 1))}
                    style={{ padding: '2px 6px' }}
                  >
                    <ChevronLeft size={12} />
                  </button>
                  <div className="coverflow-caption" style={{ marginTop: 0, minWidth: 230 }}>
                    <div className="coverflow-caption-title">{activeCard.title}</div>
                    <div className="coverflow-caption-artist">{activeCard.subtitle}</div>
                  </div>
                  <button
                    type="button"
                    className="aqua-btn"
                    disabled={selectedCardIdx >= POLICY_CARDS.length - 1}
                    onClick={() => setSelectedCardIdx((i) => Math.min(POLICY_CARDS.length - 1, i + 1))}
                    style={{ padding: '2px 6px' }}
                  >
                    <ChevronRight size={12} />
                  </button>
                </div>

                <input
                  type="range"
                  min={0}
                  max={POLICY_CARDS.length - 1}
                  value={selectedCardIdx}
                  onChange={(e) => setSelectedCardIdx(Number(e.target.value))}
                  className="aqua-slider coverflow-scrollbar"
                />
              </div>

              {/* Active Card Policy Controls */}
              <div style={{ maxHeight: 225, overflowY: 'auto', background: '#ffffff' }}>
                {activeCardFields.map((field) =>
                  renderPermissionFieldRow(
                    field,
                    Number(activeRole.permissions[field.key] ?? 0),
                    activeRole.isSuperAdmin || !canManageUac,
                    (val) => void handleUpdateRolePermission(activeRole, field.key, val),
                    {
                      draftValue: roleQuotaDraft,
                      onDraftChange: setRoleQuotaDraft,
                      numberDisabled: activeRole.permissions.localCacheTier !== 1,
                    }
                  )
                )}
              </div>
            </div>
          ) : (
            /* Category Column Browser */
            <div
              className="column-browser"
              style={{
                height: 295,
                minHeight: 295,
                gridTemplateColumns: '220px 1fr',
              }}
            >
              <div className="column-pane">
                <div className="column-pane-header">Permission Category</div>
                <div className="column-pane-list">
                  {POLICY_CARDS.map((card, idx) => (
                    <div
                      key={card.id}
                      className={`column-pane-item ${idx === selectedCardIdx ? 'selected' : ''}`}
                      onClick={() => setSelectedCardIdx(idx)}
                    >
                      {card.title}
                    </div>
                  ))}
                </div>
              </div>
              <div className="column-pane" style={{ borderRight: 'none' }}>
                <div className="column-pane-header">{activeCard.title} — Permissions</div>
                <div className="column-pane-list">
                  {activeCardFields.map((field) =>
                    renderPermissionFieldRow(
                      field,
                      Number(activeRole.permissions[field.key] ?? 0),
                      activeRole.isSuperAdmin || !canManageUac,
                      (val) => void handleUpdateRolePermission(activeRole, field.key, val),
                      {
                        draftValue: roleQuotaDraft,
                        onDraftChange: setRoleQuotaDraft,
                        numberDisabled: activeRole.permissions.localCacheTier !== 1,
                      }
                    )
                  )}
                </div>
              </div>
            </div>
          )}

          {/* Bottom Striped Role Members Table */}
          <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '6px 12px',
                background: 'linear-gradient(180deg, #f3f5f8 0%, #dde2ea 100%)',
                borderBottom: '1px solid #a8b1be',
              }}
            >
              <span style={{ fontWeight: 700, fontSize: 11.5, color: '#2b3340' }}>
                Members in "{activeRole.name}" ({roleMembers.length})
              </span>
              {canManageUac && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <select
                    value={addMemberUserId}
                    onChange={(e) => setAddMemberUserId(e.target.value)}
                    style={{
                      fontSize: 11,
                      padding: '2px 6px',
                      borderRadius: 4,
                      border: '1px solid #8b95a4',
                      background: '#ffffff',
                    }}
                  >
                    <option value="">Select user to add...</option>
                    {nonRoleMembers.map((u) => (
                      <option key={u.id} value={u.id}>
                        {u.displayName} (@{u.username})
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    className="aqua-btn primary"
                    disabled={!addMemberUserId || busyKey !== null}
                    onClick={() => void handleAddUserToActiveRole()}
                  >
                    <Plus size={11} /> Add User to Role
                  </button>
                </div>
              )}
            </div>

            <div className="rtunes-table-container">
              <table className="rtunes-table">
                <thead>
                  <tr>
                    <th style={{ width: 150 }}>Username</th>
                    <th style={{ width: 180 }}>Display Name</th>
                    <th style={{ width: 190 }}>Email</th>
                    <th style={{ width: 95 }}>Status</th>
                    <th style={{ width: 120 }}>Auth Source</th>
                    <th style={{ width: 145 }}>Last Seen</th>
                    <th style={{ width: 115 }}>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {roleMembers.length === 0 ? (
                    <tr>
                      <td colSpan={7} style={{ textAlign: 'center', padding: 18, color: '#64748b' }}>
                        No users assigned to "{activeRole.name}" yet. Drag any user here or use "Add User to Role".
                      </td>
                    </tr>
                  ) : (
                    roleMembers.map((u) => (
                      <tr
                        key={u.id}
                        draggable={canManageUac}
                        onDragStart={(e) => {
                          e.dataTransfer.setData('application/x-rtunes-uac-user', String(u.id));
                        }}
                        onContextMenu={(e) => onOpenContextMenu?.(e, 'uac_role_member', u, activeRole.id)}
                      >
                        <td>@{u.username}</td>
                        <td>{u.displayName}</td>
                        <td>{u.email || '—'}</td>
                        <td>
                          <span
                            style={{
                              color: u.status === 'active' ? '#15803d' : '#b91c1c',
                              fontWeight: 700,
                            }}
                          >
                            {u.status === 'active' ? 'Active' : 'Suspended'}
                          </span>
                        </td>
                        <td>{u.authentikSub ? 'Authentik SSO' : 'Local Account'}</td>
                        <td>{u.lastSeenAt || 'Never'}</td>
                        <td>
                          <div style={{ display: 'flex', gap: 4 }}>
                            <button
                              type="button"
                              className="aqua-btn"
                              style={{ padding: '1px 6px', fontSize: 10 }}
                              onClick={() => {
                                setSelectedUserId(u.id);
                                onSelectView({ kind: 'uac_all_users' });
                              }}
                            >
                              Inspect
                            </button>
                            {canManageUac && (
                              <button
                                type="button"
                                className="aqua-btn"
                                style={{ padding: '1px 6px', fontSize: 10, color: '#991b1b' }}
                                onClick={() => void handleRemoveUserFromRole(u, activeRole.id)}
                              >
                                Remove
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* VIEW 2: ALL USERS & EFFECTIVE ACCESS INSPECTOR */}
      {selection.kind === 'uac_all_users' && (
        <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          {/* Top Effective Access Inspector */}
          {selectedUser ? (
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: '320px 1fr',
                borderBottom: '1px solid #9da6b4',
                background: '#f7f9fc',
                maxHeight: 330,
                minHeight: 270,
              }}
            >
              {/* User Identity & Role Assignment Pane */}
              <div
                style={{
                  borderRight: '1px solid #b8c0cc',
                  padding: '10px 12px',
                  overflowY: 'auto',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 8,
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 700, color: '#1e293b' }}>
                      {selectedUser.displayName}
                    </div>
                    <div style={{ fontSize: 11, color: '#475569' }}>
                      @{selectedUser.username} · {selectedUser.authentikSub ? 'SSO' : 'Local'}
                    </div>
                  </div>
                  <button
                    type="button"
                    className="aqua-btn"
                    disabled={!canManageUac || busyKey !== null}
                    onClick={() => void handleToggleUserStatus(selectedUser)}
                    style={{
                      color: selectedUser.status === 'active' ? '#15803d' : '#b91c1c',
                      fontWeight: 700,
                    }}
                  >
                    {selectedUser.status === 'active' ? 'Active' : 'Suspended'}
                  </button>
                </div>

                <div style={{ fontSize: 11, color: '#334155' }}>
                  <div>
                    <strong>Email:</strong> {selectedUser.email || '—'}
                  </div>
                  <div>
                    <strong>Phone:</strong> {selectedUser.phone || '—'}
                  </div>
                </div>

                <div style={{ borderTop: '1px solid #dce2ec', paddingTop: 6 }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: '#334155', marginBottom: 4 }}>
                    Assigned Roles (Highest Access Wins)
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    {roles.map((r) => {
                      const hasRole = selectedUser.roles.some((ur) => ur.id === r.id);
                      return (
                        <label
                          key={r.id}
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 6,
                            fontSize: 11.5,
                            cursor: canManageUac ? 'pointer' : 'default',
                          }}
                        >
                          <input
                            type="checkbox"
                            checked={hasRole}
                            disabled={!canManageUac || busyKey !== null}
                            onChange={(e) => void handleToggleUserRole(selectedUser, r.id, e.target.checked)}
                          />
                          <span
                            style={{
                              width: 8,
                              height: 8,
                              borderRadius: '50%',
                              background: r.color || '#5a8dee',
                            }}
                          />
                          <span style={{ fontWeight: hasRole ? 700 : 400 }}>{r.name}</span>
                        </label>
                      );
                    })}
                  </div>
                </div>

                {canManageUac && (
                  <div
                    style={{
                      display: 'flex',
                      flexWrap: 'wrap',
                      gap: 6,
                      borderTop: '1px solid #dce2ec',
                      paddingTop: 8,
                      marginTop: 'auto',
                    }}
                  >
                    <button
                      type="button"
                      className="aqua-btn"
                      onClick={() => void handleGenerateResetCode(selectedUser)}
                    >
                      <KeyRound size={11} /> Generate Reset Code
                    </button>
                    {selectedUser.id !== callerMe.user?.id && (
                      <button
                        type="button"
                        className="aqua-btn"
                        style={{ color: '#991b1b' }}
                        onClick={() => void handleDeleteUser(selectedUser)}
                      >
                        <Trash2 size={11} /> Delete User
                      </button>
                    )}
                  </div>
                )}
              </div>

              {/* Direct Overrides + Effective Sources Grid */}
              <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}>
                <div className="column-pane-header" style={{ justifyContent: 'space-between' }}>
                  <span>
                    Effective Permissions & Direct Overrides — @{selectedUser.username}
                  </span>
                  {selectedUser.roles.some((r) => r.isSuperAdmin) && (
                    <span style={{ color: '#92400e', fontSize: 10 }}>
                      <Lock size={10} /> Full Label Super-Admin Access
                    </span>
                  )}
                </div>
                <div style={{ flex: 1, overflowY: 'auto', background: '#ffffff' }}>
                  {PERMISSION_FIELDS.map((field) => {
                    const origin = describePermissionOrigin(field.key, selectedUser);
                    const isLocked =
                      !canManageUac || selectedUser.roles.some((r) => r.isSuperAdmin);
                    return renderPermissionFieldRow(
                      field,
                      origin.effectiveVal,
                      isLocked,
                      (val) => void handleSetUserOverride(selectedUser, field.key, val),
                      {
                        draftValue: userQuotaDraft,
                        onDraftChange: setUserQuotaDraft,
                        numberDisabled: selectedUser.effectivePermissions.localCacheTier !== 1,
                      },
                      <>
                        <span
                          style={{
                            fontSize: 9.5,
                            fontWeight: 700,
                            padding: '1px 6px',
                            borderRadius: 9,
                            background: origin.isOverride ? '#dbeafe' : '#e2e8f0',
                            color: origin.isOverride ? '#1e40af' : '#334155',
                          }}
                        >
                          {origin.label}
                        </span>
                        {origin.isOverride && !isLocked && (
                          <button
                            type="button"
                            className="aqua-btn"
                            style={{ padding: '0px 5px', fontSize: 9.5 }}
                            onClick={() => void handleSetUserOverride(selectedUser, field.key, null)}
                          >
                            Clear Override
                          </button>
                        )}
                      </>
                    );
                  })}
                </div>
              </div>
            </div>
          ) : null}

          {/* Bottom Striped All Users Table */}
          <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '5px 12px',
                background: 'linear-gradient(180deg, #f3f5f8 0%, #dde2ea 100%)',
                borderBottom: '1px solid #a8b1be',
                position: 'relative',
              }}
            >
              <span style={{ fontWeight: 700, fontSize: 11.5, color: '#2b3340' }}>
                Users Directory ({filteredUsers.length}) · Drag a user row onto a Role in the sidebar to assign
              </span>
              <div style={{ position: 'relative' }}>
                <button
                  type="button"
                  className="aqua-btn"
                  onClick={() => setShowColPicker((s) => !s)}
                >
                  <Columns size={11} /> Columns
                </button>
                {showColPicker && (
                  <div
                    className="aqua-window"
                    style={{
                      position: 'absolute',
                      right: 0,
                      top: '100%',
                      marginTop: 4,
                      zIndex: 40,
                      width: 175,
                      padding: 8,
                    }}
                  >
                    <div style={{ fontSize: 11, fontWeight: 700, marginBottom: 4 }}>Visible Columns</div>
                    {ALL_USER_COLUMNS.map((c) => (
                      <label
                        key={c.key}
                        style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, padding: '2px 0' }}
                      >
                        <input
                          type="checkbox"
                          checked={visibleUserCols.has(c.key)}
                          onChange={() => handleToggleUserCol(c.key)}
                        />
                        {c.label}
                      </label>
                    ))}
                  </div>
                )}
              </div>
            </div>

            <div className="rtunes-table-container">
              <table className="rtunes-table">
                <thead>
                  <tr>
                    {ALL_USER_COLUMNS.filter((c) => visibleUserCols.has(c.key)).map((c) => (
                      <th key={c.key} style={{ width: c.width }}>
                        {c.label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {filteredUsers.map((u) => {
                    const isSelected = selectedUser?.id === u.id;
                    return (
                      <tr
                        key={u.id}
                        className={isSelected ? 'active-row' : undefined}
                        draggable={canManageUac}
                        onDragStart={(e) => {
                          e.dataTransfer.setData('application/x-rtunes-uac-user', String(u.id));
                        }}
                        onClick={() => setSelectedUserId(u.id)}
                        onContextMenu={(e) => onOpenContextMenu?.(e, 'uac_user', u)}
                        style={{ cursor: 'pointer' }}
                      >
                        {visibleUserCols.has('username') && <td>@{u.username}</td>}
                        {visibleUserCols.has('displayName') && <td>{u.displayName}</td>}
                        {visibleUserCols.has('roles') && (
                          <td>{u.roles.map((r) => r.name).join(', ') || 'Roadie'}</td>
                        )}
                        {visibleUserCols.has('status') && (
                          <td style={{ fontWeight: 700, color: u.status === 'active' ? undefined : '#fca5a5' }}>
                            {u.status === 'active' ? 'Active' : 'Suspended'}
                          </td>
                        )}
                        {visibleUserCols.has('authSource') && (
                          <td>{u.authentikSub ? 'Authentik SSO' : 'Local'}</td>
                        )}
                        {visibleUserCols.has('email') && <td>{u.email || '—'}</td>}
                        {visibleUserCols.has('listenbrainz') && (
                          <td>{u.listenbrainzUsername || (u.hasListenbrainzToken ? 'Configured' : '—')}</td>
                        )}
                        {visibleUserCols.has('lastSeen') && <td>{u.lastSeenAt || 'Never'}</td>}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* VIEW 3: PENDING APPROVALS QUEUE */}
      {selection.kind === 'uac_approvals' && (
        <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '6px 12px',
              background: '#f5f7fa',
              borderBottom: '1px solid #c3cbd7',
            }}
          >
            <div className="segmented-group">
              <button
                type="button"
                className={`segmented-btn ${approvalFilter === 'all' ? 'active' : ''}`}
                onClick={() => setApprovalFilter('all')}
              >
                All ({visibleUploads.length + visibleStoreReqs.length})
              </button>
              <button
                type="button"
                className={`segmented-btn ${approvalFilter === 'uploads' ? 'active' : ''}`}
                onClick={() => setApprovalFilter('uploads')}
              >
                Uploads ({approvals.uploads.length})
              </button>
              <button
                type="button"
                className={`segmented-btn ${approvalFilter === 'store' ? 'active' : ''}`}
                onClick={() => setApprovalFilter('store')}
              >
                Store Requests ({approvals.storeRequests.length})
              </button>
            </div>
            <span style={{ fontSize: 11, color: '#475569' }}>
              Review staged uploads & *arr queue requests before committing to storage
            </span>
          </div>

          <div
            style={{
              flex: 1,
              minHeight: 0,
              display: 'grid',
              gridTemplateColumns: '1.2fr 1fr',
              background: '#ffffff',
            }}
          >
            {/* Left Queue Table */}
            <div className="rtunes-table-container" style={{ borderRight: '1px solid #b8c0cc' }}>
              <table className="rtunes-table">
                <thead>
                  <tr>
                    <th style={{ width: 92 }}>Type</th>
                    <th>Title / Release</th>
                    <th style={{ width: 110 }}>Requester</th>
                    <th style={{ width: 90 }}>Details</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleUploads.map((up) => {
                    const isSel =
                      activeApprovalItem?.kind === 'upload' && activeApprovalItem.item.id === up.id;
                    return (
                      <tr
                        key={`upload-${up.id}`}
                        className={isSel ? 'active-row' : undefined}
                        onClick={() => setSelectedApproval({ kind: 'upload', id: up.id })}
                        style={{ cursor: 'pointer' }}
                      >
                        <td>Upload · {up.media_type}</td>
                        <td>{up.title}</td>
                        <td>@{up.requested_by_username}</td>
                        <td>{up.file_count} file(s)</td>
                      </tr>
                    );
                  })}
                  {visibleStoreReqs.map((sr) => {
                    const isSel =
                      activeApprovalItem?.kind === 'store' && activeApprovalItem.item.id === sr.id;
                    return (
                      <tr
                        key={`store-${sr.id}`}
                        className={isSel ? 'active-row' : undefined}
                        onClick={() => setSelectedApproval({ kind: 'store', id: sr.id })}
                        style={{ cursor: 'pointer' }}
                      >
                        <td>Store · {sr.service}</td>
                        <td>{sr.title}</td>
                        <td>@{sr.requested_by_username}</td>
                        <td>{sr.media_type}</td>
                      </tr>
                    );
                  })}
                  {visibleUploads.length === 0 && visibleStoreReqs.length === 0 && (
                    <tr>
                      <td colSpan={4} style={{ textAlign: 'center', padding: 28, color: '#64748b' }}>
                        All caught up — no pending uploads or Store requests awaiting approval.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            {/* Right Preview & Action Card */}
            <div style={{ padding: 14, overflowY: 'auto', background: '#eef2f7' }}>
              {activeApprovalItem ? (
                <div className="epod-capacity-card" style={{ background: '#ffffff' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                    {activeApprovalItem.kind === 'upload' ? (
                      <Upload size={18} color="#26549a" />
                    ) : (
                      <Disc size={18} color="#26549a" />
                    )}
                    <div>
                      <div style={{ fontWeight: 700, fontSize: 13, color: '#1e293b' }}>
                        {activeApprovalItem.item.title}
                      </div>
                      <div style={{ fontSize: 11, color: '#64748b' }}>
                        Requested by @{activeApprovalItem.item.requested_by_username}
                      </div>
                    </div>
                  </div>

                  {activeApprovalItem.kind === 'upload' ? (
                    (() => {
                      const details = parseStagedFiles(activeApprovalItem.item);
                      return (
                        <div style={{ fontSize: 11.5, color: '#334155', lineHeight: 1.55 }}>
                          <div>
                            <strong>Media Type:</strong> {activeApprovalItem.item.media_type}
                          </div>
                          <div>
                            <strong>Target Folder:</strong>{' '}
                            <code>{activeApprovalItem.item.destination_path}</code>
                          </div>
                          <div>
                            <strong>Staged Files ({activeApprovalItem.item.file_count}):</strong>
                          </div>
                          <div
                            style={{
                              maxHeight: 130,
                              overflowY: 'auto',
                              background: '#f8fafc',
                              border: '1px solid #cbd5e1',
                              borderRadius: 4,
                              padding: 6,
                              marginTop: 4,
                              fontFamily: 'monospace',
                              fontSize: 10.5,
                            }}
                          >
                            {details.formattedPaths.length > 0
                              ? details.formattedPaths.map((p, idx) => <div key={idx}>{p}</div>)
                              : activeApprovalItem.item.destination_path}
                          </div>
                        </div>
                      );
                    })()
                  ) : (
                    <div style={{ fontSize: 11.5, color: '#334155', lineHeight: 1.55 }}>
                      <div>
                        <strong>Subtitle / Artist:</strong> {activeApprovalItem.item.subtitle || '—'}
                      </div>
                      <div>
                        <strong>Target *arr Service:</strong>{' '}
                        <span style={{ textTransform: 'uppercase', fontWeight: 700 }}>
                          {activeApprovalItem.item.service}
                        </span>
                      </div>
                      <div>
                        <strong>Media Type:</strong> {activeApprovalItem.item.media_type}
                      </div>
                      <div>
                        <strong>Foreign ID:</strong>{' '}
                        <code>{activeApprovalItem.item.foreign_id || '—'}</code>
                      </div>
                    </div>
                  )}

                  <div style={{ marginTop: 12 }}>
                    <label
                      style={{
                        display: 'block',
                        fontSize: 11,
                        fontWeight: 700,
                        color: '#334155',
                        marginBottom: 4,
                      }}
                    >
                      Rejection Reason (optional)
                    </label>
                    <input
                      type="text"
                      value={rejectionReason}
                      onChange={(e) => setRejectionReason(e.target.value)}
                      placeholder="e.g. Duplicate release or wrong bitrate..."
                      style={{
                        width: '100%',
                        padding: '5px 8px',
                        fontSize: 11.5,
                        border: '1px solid #9ba4b2',
                        borderRadius: 4,
                      }}
                    />
                  </div>

                  <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 12 }}>
                    <button
                      type="button"
                      className="aqua-btn"
                      disabled={busyKey !== null}
                      style={{ color: '#991b1b' }}
                      onClick={() => void handleApproveReject('reject')}
                    >
                      <XCircle size={12} /> Reject
                    </button>
                    <button
                      type="button"
                      className="aqua-btn primary"
                      disabled={busyKey !== null}
                      onClick={() => void handleApproveReject('approve')}
                    >
                      <Check size={12} />{' '}
                      {activeApprovalItem.kind === 'upload'
                        ? 'Approve & Commit Files'
                        : 'Approve & Send to *arr'}
                    </button>
                  </div>
                </div>
              ) : (
                <div style={{ fontSize: 12, color: '#64748b', textAlign: 'center', marginTop: 40 }}>
                  Select a pending item on the left to inspect its details.
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* MODAL: + New User */}
      {showNewUserModal && (
        <div className="aqua-modal-backdrop" onClick={() => setShowNewUserModal(false)}>
          <form
            className="aqua-window"
            style={{ width: 420 }}
            onClick={(e) => e.stopPropagation()}
            onSubmit={handleCreateUserSubmit}
          >
            <div className="aqua-window-titlebar">
              <span>Create New Server User</span>
              <button type="button" className="aqua-btn" onClick={() => setShowNewUserModal(false)}>
                <X size={12} />
              </button>
            </div>
            <div style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 9 }}>
              <label style={{ fontSize: 11.5 }}>
                <strong>Username</strong>
                <input
                  required
                  value={newUserForm.username}
                  onChange={(e) => setNewUserForm((f) => ({ ...f, username: e.target.value }))}
                  style={{ width: '100%', padding: '4px 6px', marginTop: 2 }}
                />
              </label>
              <label style={{ fontSize: 11.5 }}>
                <strong>Display Name</strong>
                <input
                  value={newUserForm.displayName}
                  onChange={(e) => setNewUserForm((f) => ({ ...f, displayName: e.target.value }))}
                  style={{ width: '100%', padding: '4px 6px', marginTop: 2 }}
                />
              </label>
              <label style={{ fontSize: 11.5 }}>
                <strong>Password (min 4 chars)</strong>
                <input
                  type="password"
                  required
                  minLength={4}
                  value={newUserForm.password}
                  onChange={(e) => setNewUserForm((f) => ({ ...f, password: e.target.value }))}
                  style={{ width: '100%', padding: '4px 6px', marginTop: 2 }}
                />
              </label>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                <label style={{ fontSize: 11.5 }}>
                  <strong>Email</strong>
                  <input
                    type="email"
                    value={newUserForm.email}
                    onChange={(e) => setNewUserForm((f) => ({ ...f, email: e.target.value }))}
                    style={{ width: '100%', padding: '4px 6px', marginTop: 2 }}
                  />
                </label>
                <label style={{ fontSize: 11.5 }}>
                  <strong>Initial Role</strong>
                  <select
                    value={newUserForm.roleId}
                    onChange={(e) => setNewUserForm((f) => ({ ...f, roleId: e.target.value }))}
                    style={{ width: '100%', padding: '4px 6px', marginTop: 2 }}
                  >
                    <option value="">Default (Roadie)</option>
                    {roles.map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.name}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 6 }}>
                <button type="button" className="aqua-btn" onClick={() => setShowNewUserModal(false)}>
                  Cancel
                </button>
                <button type="submit" className="aqua-btn primary" disabled={busyKey === 'create-user'}>
                  Create User
                </button>
              </div>
            </div>
          </form>
        </div>
      )}

      {/* MODAL: + New Role */}
      {showNewRoleModal && (
        <div className="aqua-modal-backdrop" onClick={() => setShowNewRoleModal(false)}>
          <form
            className="aqua-window"
            style={{ width: 410 }}
            onClick={(e) => e.stopPropagation()}
            onSubmit={handleCreateRoleSubmit}
          >
            <div className="aqua-window-titlebar">
              <span>Create Custom RBAC Role</span>
              <button type="button" className="aqua-btn" onClick={() => setShowNewRoleModal(false)}>
                <X size={12} />
              </button>
            </div>
            <div style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 9 }}>
              <label style={{ fontSize: 11.5 }}>
                <strong>Role Name</strong>
                <input
                  required
                  placeholder="e.g. DjBooth, SoundEngineer, GuestKids"
                  value={newRoleForm.name}
                  onChange={(e) => setNewRoleForm((f) => ({ ...f, name: e.target.value }))}
                  style={{ width: '100%', padding: '4px 6px', marginTop: 2 }}
                />
              </label>
              <label style={{ fontSize: 11.5 }}>
                <strong>Description</strong>
                <input
                  value={newRoleForm.description}
                  onChange={(e) => setNewRoleForm((f) => ({ ...f, description: e.target.value }))}
                  style={{ width: '100%', padding: '4px 6px', marginTop: 2 }}
                />
              </label>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                <label style={{ fontSize: 11.5 }}>
                  <strong>Starting Baseline</strong>
                  <select
                    value={newRoleForm.basePreset}
                    onChange={(e) =>
                      setNewRoleForm((f) => ({ ...f, basePreset: e.target.value as 'roadie' | 'band' }))
                    }
                    style={{ width: '100%', padding: '4px 6px', marginTop: 2 }}
                  >
                    <option value="roadie">Roadie (Minimal)</option>
                    <option value="band">Band (Standard Contributor)</option>
                  </select>
                </label>
                <label style={{ fontSize: 11.5 }}>
                  <strong>Badge Color</strong>
                  <input
                    type="color"
                    value={newRoleForm.color}
                    onChange={(e) => setNewRoleForm((f) => ({ ...f, color: e.target.value }))}
                    style={{ width: '100%', height: 28, marginTop: 2 }}
                  />
                </label>
              </div>
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 6 }}>
                <button type="button" className="aqua-btn" onClick={() => setShowNewRoleModal(false)}>
                  Cancel
                </button>
                <button type="submit" className="aqua-btn primary" disabled={busyKey === 'create-role'}>
                  Create Role
                </button>
              </div>
            </div>
          </form>
        </div>
      )}

      {/* MODAL: One-Time Password Reset Code */}
      {resetCodeModal && (
        <div className="aqua-modal-backdrop" onClick={() => setResetCodeModal(null)}>
          <div
            className="aqua-window"
            style={{ width: 390 }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="aqua-window-titlebar">
              <span>One-Time Password Reset Code</span>
              <button type="button" className="aqua-btn" onClick={() => setResetCodeModal(null)}>
                <X size={12} />
              </button>
            </div>
            <div style={{ padding: 14 }}>
              <p style={{ fontSize: 12, margin: '0 0 8px 0' }}>
                Share this one-time reset code with <strong>@{resetCodeModal.username}</strong> so they can set a new password from the Sign-In dialog:
              </p>
              <div
                style={{
                  fontFamily: 'monospace',
                  fontSize: 18,
                  fontWeight: 700,
                  letterSpacing: 2,
                  textAlign: 'center',
                  padding: '10px 12px',
                  background: '#edf3fe',
                  border: '1px solid #9db8ea',
                  borderRadius: 5,
                  color: '#1e3a8a',
                }}
              >
                {resetCodeModal.code}
              </div>
              <div style={{ fontSize: 10.5, color: '#64748b', marginTop: 6 }}>
                Expires: {resetCodeModal.expiresAt}
              </div>
              <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 12 }}>
                <button type="button" className="aqua-btn primary" onClick={() => setResetCodeModal(null)}>
                  Done
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
