import React, { useState } from 'react';
import {
  FolderOpen,
  HardDrive,
  ShieldCheck,
  KeyRound,
  Activity,
  CheckCircle2,
  Info,
  X,
  RefreshCw,
  Usb,
  Grid,
} from 'lucide-react';
import {
  AppProfile,
  AppSettings,
  AuthMode,
  AuthState,
  CallerMeResponse,
  ConnectionTestResult,
  DEFAULT_LOCAL_OWNER_PERMISSIONS,
  NetworkShareRow,
  RemoteAuthInfo,
  RolePermissions,
  RuntimeModeInfo,
  ScrobbleQueueStats,
  ServerSidebarVisibility,
} from '../types';
import {
  invokeRpc,
  loginWithPin,
  logoutServerSession,
  probeRemoteServerAuth,
  resetSharedEventSource,
  setConfiguredRemoteServerUrl,
  setStoredAuthToken,
} from '../bridge';
import { FossCreditsContent } from './AboutCreditsModal';
import { GenreMapTab } from './GenreMapTab';

interface PreferencesModalProps {
  settings: AppSettings;
  authState: AuthState;
  callerMe?: CallerMeResponse | null;
  effectivePermissions?: RolePermissions;
  isServerContext?: boolean;
  onClose: () => void;
  onSaved: (updated: AppSettings) => void;
  onAuthChanged: (auth: AuthState) => void;
  onOpenUpload?: () => void;
  onOpenDiagnostics?: () => void;
  onOpenAbout?: () => void;
  onOpenNewPlaylist?: () => void;
  onOpenNewSmartPlaylist?: () => void;
  onRescanLibrary?: () => void;
  onDevicesChanged?: () => void;
  onOpenUac?: () => void;
  onProfileUpdated?: () => void;
  onSignedOut?: () => void;
  initialTab?: 'paths' | 'shares' | 'devices' | 'cache' | 'auth' | 'apis' | 'genreMap' | 'actions' | 'about';
}

export const PreferencesModal: React.FC<PreferencesModalProps> = ({
  settings,
  authState,
  callerMe,
  effectivePermissions,
  isServerContext = false,
  onClose,
  onSaved,
  onAuthChanged,
  onOpenUpload,
  onOpenDiagnostics,
  onOpenAbout,
  onOpenNewPlaylist,
  onOpenNewSmartPlaylist,
  onRescanLibrary,
  onDevicesChanged,
  onOpenUac,
  onProfileUpdated,
  onSignedOut,
  initialTab,
}) => {
  const [tab, setTab] = useState<'paths' | 'shares' | 'devices' | 'cache' | 'auth' | 'apis' | 'genreMap' | 'actions' | 'about'>(initialTab || 'paths');
  const [registeredDevices, setRegisteredDevices] = useState<any[]>([]);
  const [binaryStatus, setBinaryStatus] = useState<any>(null);
  const [checkingBinaries, setCheckingBinaries] = useState(false);
  const [form, setForm] = useState<AppSettings>({ ...settings });
  const [saving, setSaving] = useState(false);
  const [testingTarget, setTestingTarget] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, ConnectionTestResult>>({});
  const [statusBanner, setStatusBanner] = useState<string | null>(null);

  // Priority 2: Network Shares State
  const [shares, setShares] = useState<
    (NetworkShareRow & { folder_map?: Record<string, string> })[]
  >([]);
  const [shareDraft, setShareDraft] = useState<{
    id?: number;
    name: string;
    protocol: 'nfs' | 'smb';
    host: string;
    base_path: string;
    username: string;
    password: string;
    auto_connect: boolean;
    folder_map: Record<string, string>;
  }>({
    name: 'Homelab Media NAS',
    protocol: 'smb',
    host: '192.168.1.9',
    base_path: '/PVE-Media',
    username: 'shares',
    password: '',
    auto_connect: true,
    folder_map: {
      music: 'Music',
      movies: 'Movies',
      tvShows: 'TV Shows',
      musicVideos: 'Music Videos',
      books: 'Books',
      audiobooks: 'Audiobooks',
      photos: 'Photos',
    },
  });

  const loadShares = async () => {
    try {
      const list = await invokeRpc<
        (NetworkShareRow & { folder_map?: Record<string, string> })[]
      >('shares:list');
      setShares(list);
    } catch {
      // ignore
    }
  };

  const [autoOpenOnMtp, setAutoOpenOnMtp] = React.useState(false);
  const [credentialStoreLabel, setCredentialStoreLabel] = React.useState('OS Credential Store');
  const [runtimeInfo, setRuntimeInfo] = React.useState<RuntimeModeInfo | null>(null);
  const [remoteProbe, setRemoteProbe] = React.useState<{
    loading: boolean;
    info: RemoteAuthInfo | null;
    error: string | null;
  }>({ loading: false, info: null, error: null });
  const [remotePinInput, setRemotePinInput] = React.useState('');
  const [remotePinStatus, setRemotePinStatus] = React.useState<string | null>(null);

  const [profileDisplayName, setProfileDisplayName] = useState(callerMe?.user?.displayName || '');
  const [profileEmail, setProfileEmail] = useState(callerMe?.user?.email || '');
  const [profilePhone, setProfilePhone] = useState(callerMe?.user?.phone || '');
  const [myListenbrainzToken, setMyListenbrainzToken] = useState('');
  const [myListenbrainzUsername, setMyListenbrainzUsername] = useState(
    callerMe?.personalListenbrainzUsername ||
      callerMe?.user?.listenbrainzUsername ||
      settings.personalListenbrainzUsername ||
      ''
  );
  const [hasSavedPersonalLbToken, setHasSavedPersonalLbToken] = useState(
    Boolean(
      callerMe?.hasPersonalListenbrainzToken ||
        callerMe?.user?.hasListenbrainzToken ||
        settings.personalListenbrainzToken
    )
  );
  const [testingPersonalLb, setTestingPersonalLb] = useState(false);
  const [personalLbTestResult, setPersonalLbTestResult] = useState<{
    ok: boolean;
    message: string;
    latencyMs: number;
  } | null>(null);
  const [scrobbleQueueStats, setScrobbleQueueStats] = useState<ScrobbleQueueStats>({
    pendingCount: 0,
    oldestPendingAt: null,
    totalLogged: 0,
  });
  const [syncingScrobbles, setSyncingScrobbles] = useState(false);
  const [curPassword, setCurPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [profileBusy, setProfileBusy] = useState(false);

  const loadScrobbleQueueStats = async () => {
    try {
      const stats = await invokeRpc<ScrobbleQueueStats>('uac:getScrobbleQueueStats');
      if (stats && typeof stats.pendingCount === 'number') {
        setScrobbleQueueStats(stats);
      }
    } catch {
      // ignore
    }
  };

  React.useEffect(() => {
    if (callerMe?.user) {
      setProfileDisplayName(callerMe.user.displayName || '');
      setProfileEmail(callerMe.user.email || '');
      setProfilePhone(callerMe.user.phone || '');
    }
    const nextUser =
      callerMe?.personalListenbrainzUsername ||
      callerMe?.user?.listenbrainzUsername ||
      settings.personalListenbrainzUsername ||
      '';
    if (nextUser) {
      setMyListenbrainzUsername(nextUser);
    }
    setHasSavedPersonalLbToken(
      Boolean(
        callerMe?.hasPersonalListenbrainzToken ||
          callerMe?.user?.hasListenbrainzToken ||
          settings.personalListenbrainzToken
      )
    );
  }, [
    callerMe?.user?.id,
    callerMe?.user?.displayName,
    callerMe?.user?.email,
    callerMe?.user?.phone,
    callerMe?.user?.listenbrainzUsername,
    callerMe?. user?.hasListenbrainzToken,
    callerMe?.personalListenbrainzUsername,
    callerMe?.hasPersonalListenbrainzToken,
    settings.personalListenbrainzUsername,
    settings.personalListenbrainzToken,
  ]);

  React.useEffect(() => {
    void loadShares();
    void loadScrobbleQueueStats();
    invokeRpc<CallerMeResponse>('uac:getMe')
      .then((me) => {
        if (!me) return;
        const uname = me.personalListenbrainzUsername || me.user?.listenbrainzUsername || '';
        if (uname) setMyListenbrainzUsername(uname);
        setHasSavedPersonalLbToken(
          Boolean(me.hasPersonalListenbrainzToken || me.user?.hasListenbrainzToken)
        );
      })
      .catch(() => {});
    invokeRpc<RuntimeModeInfo>('system:runtimeInfo')
      .then((rt) => setRuntimeInfo(rt))
      .catch(() => {});
    invokeRpc<boolean>('devices:getAutoOpenOnMtp')
      .then((v) => setAutoOpenOnMtp(Boolean(v)))
      .catch(() => {});
    invokeRpc<string>('system:credentialStoreLabel')
      .then((lbl) => { if (lbl) setCredentialStoreLabel(lbl); })
      .catch(() => {});
    invokeRpc<any[]>('devices:list')
      .then((list) => setRegisteredDevices(Array.isArray(list) ? list : []))
      .catch(() => {});
    invokeRpc<any>('transcoder:getBinaryStatus')
      .then((st) => setBinaryStatus(st))
      .catch(() => {});
  }, []);

  const effectiveAppMode: AppProfile = runtimeInfo?.isModeLocked
    ? runtimeInfo.appMode
    : form.appMode || 'client';
  const isServerRole =
    effectiveAppMode === 'desktop-server' || effectiveAppMode === 'headless-server';
  const isHeadlessServer = effectiveAppMode === 'headless-server';
  const isClientRole = !isServerRole;
  const isRemoteClient = isClientRole && form.clientSource === 'remote';
  const perms = effectivePermissions || DEFAULT_LOCAL_OWNER_PERMISSIONS;
  const canManageUac = Boolean(callerMe?.isSuperAdmin || perms.manageUac >= 1);

  const visibleTabs = [
    { id: 'paths' as const, label: 'Profile & Paths', icon: <FolderOpen size={18} /> },
    ...(!isRemoteClient && !(isHeadlessServer && form.serverSidebarVisibility?.networkShares === false)
      ? [{ id: 'shares' as const, label: 'NFS / SMB Shares', icon: <HardDrive size={18} /> }]
      : []),
    ...(!(isHeadlessServer && form.serverSidebarVisibility?.devices === false) &&
    !(isServerContext && perms.featDevicesSync === 0)
      ? [{ id: 'devices' as const, label: 'Devices', icon: <Usb size={18} /> }]
      : []),
    ...(!(isServerContext && perms.localCacheTier === 0)
      ? [{ id: 'cache' as const, label: 'Cache & Transcoder', icon: <HardDrive size={18} /> }]
      : []),
    {
      id: 'auth' as const,
      label: isServerRole || isRemoteClient || isServerContext ? 'Auth & Profile' : 'Profile & ListenBrainz',
      icon: <ShieldCheck size={18} />,
    },
    ...(!(isServerContext && perms.manageApiKeys === 0)
      ? [{ id: 'apis' as const, label: 'Store & API Keys', icon: <KeyRound size={18} /> }]
      : []),
    ...(!(isServerRole && form.serverSidebarVisibility?.genreMap === false) &&
    !(isServerContext && perms.featGenreMap === 0)
      ? [{ id: 'genreMap' as const, label: 'Genre Map', icon: <Grid size={18} /> }]
      : []),
    { id: 'actions' as const, label: 'Actions & Help', icon: <Activity size={18} /> },
    { id: 'about' as const, label: 'About & Credits', icon: <Info size={18} /> },
  ];

  React.useEffect(() => {
    if (!visibleTabs.some((item) => item.id === tab)) {
      setTab('paths');
    }
  }, [
    isServerRole,
    isHeadlessServer,
    isRemoteClient,
    isServerContext,
    perms.featDevicesSync,
    perms.localCacheTier,
    perms.manageApiKeys,
    perms.featGenreMap,
    form.serverSidebarVisibility,
    tab,
  ]);

  const updateField = <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  const toggleSidebarVisibility = (key: keyof ServerSidebarVisibility, value: boolean) => {
    setForm((prev) => ({
      ...prev,
      serverSidebarVisibility: {
        ...prev.serverSidebarVisibility,
        [key]: value,
      },
    }));
  };

  const handleProbeRemoteServer = async (urlOverride?: string) => {
    const targetUrl = (urlOverride ?? form.dockerServerUrl ?? '').trim().replace(/\/+$/, '');
    if (!targetUrl) {
      setRemoteProbe({ loading: false, info: null, error: 'Enter a server URL first.' });
      return;
    }
    setRemoteProbe({ loading: true, info: null, error: null });
    setRemotePinStatus(null);
    try {
      let info: RemoteAuthInfo;
      if (window.rtunesElectron?.invoke) {
        const res = await invokeRpc<{ ok: boolean; info?: RemoteAuthInfo; error?: string }>(
          'auth:probeRemoteServer',
          targetUrl
        );
        if (!res.ok || !res.info) {
          throw new Error(res.error || 'Server probe failed');
        }
        info = res.info;
      } else {
        info = await probeRemoteServerAuth(targetUrl);
      }
      setRemoteProbe({ loading: false, info, error: null });
      setForm((prev) => ({
        ...prev,
        authMode: info.authMode || 'standalone',
        authentikIssuerUrl: info.authentikIssuerUrl || prev.authentikIssuerUrl,
        authentikClientId: info.authentikClientId || prev.authentikClientId,
        authentikRedirectUri: info.authentikRedirectUri || prev.authentikRedirectUri,
        trustedProxyHeader: info.trustedProxyHeader || prev.trustedProxyHeader,
      }));
    } catch (err) {
      setRemoteProbe({
        loading: false,
        info: null,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const browseDirectory = async (field: keyof AppSettings, title: string) => {
    const selected = await invokeRpc<string | null>('dialog:selectDirectory', title);
    if (selected) {
      updateField(field, selected as any);
    }
  };

  const browseFile = async (field: keyof AppSettings, title: string) => {
    const selected = await invokeRpc<string | null>('dialog:selectFile', title);
    if (selected) {
      updateField(field, selected as any);
    }
  };

  const runTest = async (
    target:
      | 'paths'
      | 'binaries'
      | 'listenbrainz'
      | 'lidarr'
      | 'radarr'
      | 'sonarr'
      | 'tmdb'
      | 'tvdb'
      | 'authentik'
  ) => {
    setTestingTarget(target);
    try {
      const res = await invokeRpc<ConnectionTestResult>('settings:testConnection', target, form);
      setTestResults((prev) => ({ ...prev, [target]: res }));
    } catch (err) {
      setTestResults((prev) => ({
        ...prev,
        [target]: {
          ok: false,
          target,
          message: err instanceof Error ? err.message : String(err),
          latencyMs: 0,
        },
      }));
    } finally {
      setTestingTarget(null);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const updated = await invokeRpc<AppSettings>('settings:save', form);
      setForm({ ...updated, localPinPlaintext: '' });
      if (
        (updated.appMode === 'client' || updated.appMode === 'headless-client') &&
        updated.clientSource === 'remote' &&
        updated.dockerServerUrl
      ) {
        setConfiguredRemoteServerUrl(updated.dockerServerUrl);
      } else {
        setConfiguredRemoteServerUrl(null);
      }
      resetSharedEventSource();
      onSaved(updated);
      setStatusBanner(`Preferences saved to SQLite & ${credentialStoreLabel}.`);
      setTimeout(() => setStatusBanner(null), 3000);
    } finally {
      setSaving(false);
    }
  };

  const renderTestBadge = (target: string) => {
    const res = testResults[target];
    if (testingTarget === target) {
      return (
        <span style={{ fontSize: 11, color: '#2563eb', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          <RefreshCw size={12} /> Testing...
        </span>
      );
    }
    if (!res) {
      return (
        <span style={{ fontSize: 11, color: '#64748b', display: 'inline-flex', alignItems: 'center', gap: 5 }}>
          <span className="status-dot gray" /> Untested
        </span>
      );
    }
    return (
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          fontSize: 11,
          color: res.ok ? '#15803d' : '#b91c1c',
          marginTop: 4,
        }}
      >
        <span className={`status-dot ${res.ok ? 'green' : 'red'}`} />
        <span>
          {res.message} ({res.latencyMs}ms)
        </span>
      </div>
    );
  };

  return (
    <div className="aqua-modal-backdrop" onClick={onClose}>
      <div
        className="aqua-window"
        style={{ width: 860, maxWidth: '95vw' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="aqua-window-titlebar">
          <span>RetroTunes Preferences</span>
          <button className="aqua-btn" onClick={onClose} style={{ padding: '1px 6px' }}>
            <X size={13} />
          </button>
        </div>

        {/* OS X Aqua Toolbar Tabs */}
        <div
          style={{
            display: 'flex',
            justifyContent: 'center',
            gap: 8,
            flexWrap: 'wrap',
            background: 'linear-gradient(180deg, #d7dde6 0%, #c1c9d6 100%)',
            borderBottom: '1px solid #8a94a4',
            padding: '8px 14px',
          }}
        >
          {visibleTabs.map((item) => (
            <button
              key={item.id}
              onClick={() => setTab(item.id)}
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: 4,
                padding: '6px 16px',
                borderRadius: 6,
                border: tab === item.id ? '1px solid #7c8798' : '1px solid transparent',
                background:
                  tab === item.id
                    ? 'linear-gradient(180deg, rgba(255,255,255,0.75) 0%, rgba(190,202,220,0.65) 100%)'
                    : 'transparent',
                cursor: 'pointer',
                fontWeight: 600,
                fontSize: 11,
                color: '#1e2530',
              }}
            >
              {item.icon}
              <span>{item.label}</span>
            </button>
          ))}
        </div>

        {/* Body */}
        <div style={{ padding: 20, overflowY: 'auto', maxHeight: '66vh', display: 'flex', flexDirection: 'column', gap: 16 }}>
          {tab === 'paths' && (
            <>
              {/* Application Profile & Role */}
              <div className="epod-capacity-card">
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
                  <strong>Application Profile &amp; Role</strong>
                  {runtimeInfo?.isModeLocked ? (
                    <span
                      style={{
                        fontSize: 10.5,
                        fontWeight: 700,
                        padding: '2px 8px',
                        borderRadius: 10,
                        background: '#dbeafe',
                        color: '#1e40af',
                        border: '1px solid #93c5fd',
                      }}
                    >
                      Locked by {runtimeInfo.lockReason === 'docker' ? 'Docker Container' : 'CLI Flag'} ({effectiveAppMode})
                    </span>
                  ) : (
                    <span style={{ fontSize: 11, color: '#475569' }}>
                      Desktop GUI Profile
                    </span>
                  )}
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: isClientRole ? '1fr 1fr' : '1fr', gap: 10 }}>
                  <div>
                    <label style={{ display: 'block', fontSize: 11, fontWeight: 600, marginBottom: 4 }}>
                      Application Profile:
                    </label>
                    <select
                      className="aqua-input"
                      style={{ width: '100%' }}
                      disabled={Boolean(runtimeInfo?.isModeLocked)}
                      value={effectiveAppMode}
                      onChange={(e) => updateField('appMode', e.target.value as AppProfile)}
                    >
                      {runtimeInfo?.isModeLocked ? (
                        <option value={effectiveAppMode}>
                          {effectiveAppMode === 'headless-server'
                            ? 'Headless Server (Authoritative HTTP Server & Web UI)'
                            : 'Headless Client (Local HTTP Client Web UI)'}
                        </option>
                      ) : (
                        <>
                          <option value="client">Client Mode (Standalone Desktop Player or Remote Client)</option>
                          <option value="headless-client">
                            Headless Client Mode (Background Local Daemon + Default Web Browser UI)
                          </option>
                          <option value="desktop-server">
                            Desktop Server Mode (GUI + LAN Web UI &amp; Media Streaming Host)
                          </option>
                          <option value="headless-server">
                            Headless Server Mode (Background Authoritative Server + Default Web Browser UI)
                          </option>
                        </>
                      )}
                    </select>
                  </div>

                  {isClientRole && (
                    <div>
                      <label style={{ display: 'block', fontSize: 11, fontWeight: 600, marginBottom: 4 }}>
                        Library Source:
                      </label>
                      <select
                        className="aqua-input"
                        style={{ width: '100%' }}
                        value={form.clientSource || 'local'}
                        onChange={(e) => updateField('clientSource', e.target.value as 'local' | 'remote')}
                      >
                        <option value="local">Local Library (Direct Disk / Mounted NAS Shares)</option>
                        <option value="remote">Remote rTunes-Server (LAN / HTTPS Companion)</option>
                      </select>
                    </div>
                  )}
                </div>

                {(effectiveAppMode === 'headless-client' || effectiveAppMode === 'headless-server') && (
                  <div
                    style={{
                      marginTop: 12,
                      padding: '8px 10px',
                      borderRadius: 6,
                      background: '#f8fafc',
                      border: '1px solid #cbd5e1',
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      gap: 12,
                      flexWrap: 'wrap',
                    }}
                  >
                    <label
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 8,
                        fontSize: 11.5,
                        fontWeight: 600,
                        cursor: 'pointer',
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={form.headlessAutoOpenBrowser !== false}
                        onChange={(e) => updateField('headlessAutoOpenBrowser', e.target.checked)}
                      />
                      <span>
                        Auto-open default web browser on desktop when launching Headless Mode (
                        <code>--open-browser</code> / <code>--no-open-browser</code>)
                      </span>
                    </label>
                    <button
                      type="button"
                      className="aqua-btn primary"
                      onClick={async () => {
                        try {
                          await invokeRpc('settings:save', form);
                          const res = await invokeRpc<{ ok: boolean; url: string }>('system:openWebUi');
                          setStatusBanner(
                            res.ok
                              ? `Launched Headless Web UI at ${res.url}`
                              : `Headless Web UI active at ${res.url}`
                          );
                        } catch (err) {
                          setStatusBanner(err instanceof Error ? err.message : String(err));
                        }
                      }}
                    >
                      Launch Web UI Now
                    </button>
                  </div>
                )}

                {isRemoteClient && (
                  <div
                    style={{
                      marginTop: 12,
                      paddingTop: 12,
                      borderTop: '1px solid #d5dce6',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 10,
                    }}
                  >
                    <div>
                      <label style={{ display: 'block', fontSize: 11, fontWeight: 600, marginBottom: 4 }}>
                        Remote rTunes-Server URL:
                      </label>
                      <div style={{ display: 'flex', gap: 8 }}>
                        <input
                          className="aqua-input"
                          style={{ flex: 1 }}
                          placeholder="http://192.168.1.10:3000 or https://rtunes.yourdomain.com"
                          value={form.dockerServerUrl || ''}
                          onChange={(e) => updateField('dockerServerUrl', e.target.value)}
                        />
                        <button
                          type="button"
                          className="aqua-btn primary"
                          disabled={remoteProbe.loading}
                          onClick={() => void handleProbeRemoteServer()}
                        >
                          {remoteProbe.loading ? 'Detecting...' : 'Detect Server'}
                        </button>
                      </div>
                    </div>

                    {remoteProbe.error && (
                      <div style={{ fontSize: 11, color: '#b91c1c', fontWeight: 600 }}>
                        Probe error: {remoteProbe.error}
                      </div>
                    )}

                    {remoteProbe.info && (
                      <div
                        style={{
                          padding: 10,
                          borderRadius: 6,
                          background: '#f8fafc',
                          border: '1px solid #cbd5e1',
                          display: 'flex',
                          flexDirection: 'column',
                          gap: 8,
                        }}
                      >
                        <div style={{ fontSize: 11.5, fontWeight: 700, color: '#0f172a' }}>
                          Detected: {remoteProbe.info.serverName} ({remoteProbe.info.appMode}) •{' '}
                          {!remoteProbe.info.authGateEnabled || remoteProbe.info.authMode === 'standalone'
                            ? 'Direct Server (Open Access)'
                            : remoteProbe.info.authMode === 'local-pin'
                            ? 'PIN Unlock Required'
                            : remoteProbe.info.authMode === 'authentik'
                            ? 'Authentik SSO Mode'
                            : 'Reverse Proxy Header Auth'}
                        </div>

                        {remoteProbe.info.authGateEnabled && remoteProbe.info.authMode === 'local-pin' && (
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                            <input
                              type="password"
                              className="aqua-input"
                              style={{ flex: 1 }}
                              placeholder="Enter server access PIN..."
                              value={remotePinInput}
                              onChange={(e) => setRemotePinInput(e.target.value)}
                            />
                            <button
                              type="button"
                              className="aqua-btn primary"
                              onClick={async () => {
                                setRemotePinStatus(null);
                                try {
                                  const targetUrl = (form.dockerServerUrl || '').trim();
                                  const res = window.rtunesElectron?.invoke
                                    ? await invokeRpc<{ ok: boolean; token?: string; error?: string }>(
                                        'auth:pinLogin',
                                        remotePinInput,
                                        targetUrl
                                      )
                                    : await loginWithPin(remotePinInput, targetUrl);
                                  if (!res.ok || !res.token) {
                                    setRemotePinStatus(res.error || 'PIN unlock failed.');
                                    return;
                                  }
                                  setStoredAuthToken(res.token);
                                  resetSharedEventSource();
                                  setRemotePinInput('');
                                  setRemotePinStatus('PIN verified — bearer token stored.');
                                } catch (err) {
                                  setRemotePinStatus(err instanceof Error ? err.message : String(err));
                                }
                              }}
                            >
                              Unlock
                            </button>
                          </div>
                        )}

                        {remotePinStatus && (
                          <div style={{ fontSize: 11, color: '#15803d', fontWeight: 600 }}>
                            {remotePinStatus}
                          </div>
                        )}

                        {remoteProbe.info.authGateEnabled && remoteProbe.info.authMode === 'authentik' && (
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                            <div style={{ fontSize: 11, color: '#334155' }}>
                              Issuer: <code>{remoteProbe.info.authentikIssuerUrl || 'Configured on server'}</code>{' '}
                              • Client ID: <code>{remoteProbe.info.authentikClientId || 'retrotunes-desktop'}</code>
                            </div>
                            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                              <button
                                type="button"
                                className="aqua-btn primary"
                                onClick={async () => {
                                  await invokeRpc('settings:save', form);
                                  const next = await invokeRpc<AuthState>('auth:login');
                                  onAuthChanged(next);
                                }}
                              >
                                Sign In with Authentik SSO
                              </button>
                            </div>
                            <details style={{ fontSize: 11, color: '#475569' }}>
                              <summary style={{ cursor: 'pointer', fontWeight: 600 }}>
                                Advanced SSO Override
                              </summary>
                              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginTop: 8 }}>
                                <input
                                  className="aqua-input"
                                  placeholder="Authentik Issuer URL"
                                  value={form.authentikIssuerUrl}
                                  onChange={(e) => updateField('authentikIssuerUrl', e.target.value)}
                                />
                                <input
                                  className="aqua-input"
                                  placeholder="OAuth2 Client ID"
                                  value={form.authentikClientId}
                                  onChange={(e) => updateField('authentikClientId', e.target.value)}
                                />
                              </div>
                            </details>
                          </div>
                        )}

                        {remoteProbe.info.authGateEnabled && remoteProbe.info.authMode === 'proxy-headers' && (
                          <div style={{ fontSize: 11, color: '#334155' }}>
                            Authenticated via reverse proxy trusted header:{' '}
                            <code>{remoteProbe.info.trustedProxyHeader || 'X-authentik-username'}</code>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )}

                {isServerRole && (
                  <div
                    style={{
                      marginTop: 12,
                      paddingTop: 12,
                      borderTop: '1px solid #d5dce6',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 12,
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
                      <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11.5, fontWeight: 600, cursor: 'pointer' }}>
                        <input
                          type="checkbox"
                          checked={form.backgroundWatchers !== false}
                          onChange={(e) => updateField('backgroundWatchers', e.target.checked)}
                        />
                        <span>Enable background filesystem watchers &amp; hourly library scan</span>
                      </label>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <label style={{ fontSize: 11, fontWeight: 600 }}>HTTP Port:</label>
                        <input
                          type="number"
                          min={1024}
                          max={65535}
                          className="aqua-input"
                          style={{ width: 84 }}
                          value={form.lanServerPort ?? 3000}
                          onChange={(e) => updateField('lanServerPort', Number(e.target.value) || 3000)}
                        />
                      </div>
                    </div>

                    {effectiveAppMode === 'desktop-server' && (
                      <div
                        style={{
                          padding: '8px 10px',
                          borderRadius: 6,
                          background: '#f8fafc',
                          border: '1px solid #cbd5e1',
                          display: 'flex',
                          justifyContent: 'space-between',
                          alignItems: 'center',
                          gap: 12,
                          flexWrap: 'wrap',
                        }}
                      >
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11.5, fontWeight: 600, cursor: 'pointer' }}>
                            <input
                              type="checkbox"
                              checked={form.desktopServerWebUiEnabled !== false}
                              onChange={(e) => updateField('desktopServerWebUiEnabled', e.target.checked)}
                            />
                            <span>Enable Desktop Server Web UI on port {form.lanServerPort ?? 3000}</span>
                          </label>
                          <label
                            style={{
                              display: 'flex',
                              alignItems: 'center',
                              gap: 8,
                              fontSize: 11,
                              fontWeight: 600,
                              color: form.desktopServerWebUiEnabled === false ? '#94a3b8' : '#334155',
                              cursor: form.desktopServerWebUiEnabled === false ? 'not-allowed' : 'pointer',
                            }}
                          >
                            <input
                              type="checkbox"
                              disabled={form.desktopServerWebUiEnabled === false}
                              checked={Boolean(form.desktopServerAutoOpenWebUi)}
                              onChange={(e) => updateField('desktopServerAutoOpenWebUi', e.target.checked)}
                            />
                            <span>Auto-launch Web UI in default browser when Desktop Server starts</span>
                          </label>
                        </div>
                        <button
                          type="button"
                          className="aqua-btn primary"
                          disabled={form.desktopServerWebUiEnabled === false}
                          onClick={async () => {
                            try {
                              await invokeRpc('settings:save', form);
                              const res = await invokeRpc<{ ok: boolean; url: string }>('system:openWebUi');
                              setStatusBanner(
                                res.ok
                                  ? `Launched Web UI at ${res.url}`
                                  : `Web UI active at ${res.url} (open in your browser)`
                              );
                            } catch (err) {
                              setStatusBanner(err instanceof Error ? err.message : String(err));
                            }
                          }}
                        >
                          Launch Web UI Now
                        </button>
                      </div>
                    )}

                    <div>
                      <strong style={{ display: 'block', fontSize: 11.5, marginBottom: 6 }}>
                        Server UI &amp; Web Client Sidebar Visibility
                      </strong>
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 6 }}>
                        {(
                          [
                            ['music', 'Music'],
                            ['movies', 'Movies'],
                            ['tvShows', 'TV Shows'],
                            ['musicVideos', 'Music Videos'],
                            ['audiobooks', 'Audiobooks'],
                            ['books', 'Books'],
                            ['photos', 'Photos'],
                            ['store', 'Store'],
                            ['devices', 'Devices'],
                            ['networkShares', 'Network Shares'],
                            ['genreMap', 'Genre Map'],
                          ] as [keyof ServerSidebarVisibility, string][]
                        ).map(([key, label]) => (
                          <label
                            key={key}
                            style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, cursor: 'pointer' }}
                          >
                            <input
                              type="checkbox"
                              checked={form.serverSidebarVisibility?.[key] !== false}
                              onChange={(e) => toggleSidebarVisibility(key, e.target.checked)}
                            />
                            <span>{label}</span>
                          </label>
                        ))}
                      </div>
                    </div>
                  </div>
                )}
              </div>

              {!isRemoteClient && (
              <div className="epod-capacity-card">
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                  <strong>Master Media Share & Local Directory Paths</strong>
                  <button className="aqua-btn" onClick={() => runTest('paths')}>
                    <Activity size={13} /> Test Directory Access
                  </button>
                </div>

                {(() => {
                  const hostPlatform = window.electronAPI?.platform || 'win32';
                  const isWin = hostPlatform === 'win32';
                  const isMac = hostPlatform === 'darwin';
                  const shareRootPlaceholder = isWin
                    ? '\\\\NAS-SERVER\\MediaShare or Z:\\MediaShare'
                    : isMac
                    ? '/Volumes/MediaShare'
                    : '/mnt/nfs/media';
                  const sep = isWin ? '\\' : '/';
                  const sub = (folder: string) =>
                    isWin ? `Z:\\MediaShare\\${folder}` : isMac ? `/Volumes/MediaShare/${folder}` : `/mnt/nfs/media/${folder}`;
                  const cachePlaceholder = isWin
                    ? 'C:\\Users\\<username>\\AppData\\Local\\RetroTunes\\Cache'
                    : isMac
                    ? '~/Library/Caches/RetroTunes'
                    : '~/.cache/RetroTunes';
                  return [
                    {
                      key: 'nfsSharePath' as const,
                      label: 'NFS / SMB Master Share Root:',
                      placeholder: shareRootPlaceholder,
                    },
                    {
                      key: 'musicRootPath' as const,
                      label: 'Music Library Root (FLAC/MP3/M4A):',
                      placeholder: sub('Music'),
                    },
                    {
                      key: 'videoRootPath' as const,
                      label: 'Movies Library Root:',
                      placeholder: sub('Movies'),
                    },
                    {
                      key: 'tvRootPath' as const,
                      label: 'TV Shows Library Root:',
                      placeholder: sub(`TV Shows${sep ? '' : ''}`),
                    },
                    {
                      key: 'musicVideosRootPath' as const,
                      label: 'Music Videos Library Root:',
                      placeholder: sub('Music Videos'),
                    },
                    {
                      key: 'booksRootPath' as const,
                      label: 'Books (eBooks) Library Root (EPUB/PDF/CBZ):',
                      placeholder: sub('Books'),
                    },
                    {
                      key: 'audiobooksRootPath' as const,
                      label: 'Audiobooks Library Root (M4B/MP3):',
                      placeholder: sub('Audiobooks'),
                    },
                    {
                      key: 'photosRootPath' as const,
                      label: 'Photos / Immich Library Root:',
                      placeholder: sub('Photos'),
                    },
                    {
                      key: 'localCachePath' as const,
                      label: 'Local Pre-Cache Directory:',
                      placeholder: cachePlaceholder,
                    },
                  ];
                })().map((row) => (
                  <div key={row.key} style={{ marginBottom: 10 }}>
                    <label style={{ display: 'block', fontWeight: 600, marginBottom: 4 }}>{row.label}</label>
                    <div style={{ display: 'flex', gap: 6 }}>
                      <input
                        className="aqua-input"
                        style={{ flex: 1 }}
                        value={(form[row.key] as string) || ''}
                        placeholder={row.placeholder}
                        onChange={(e) => updateField(row.key, e.target.value as any)}
                      />
                      <button
                        className="aqua-btn"
                        onClick={() => browseDirectory(row.key, `Select ${row.label}`)}
                      >
                        Browse...
                      </button>
                    </div>
                  </div>
                ))}
                {renderTestBadge('paths')}
              </div>
              )}

              <div className="epod-capacity-card">
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                  <strong>Transcoding Sidecar Binaries (FFmpeg & HandBrakeCLI)</strong>
                  <button className="aqua-btn" onClick={() => runTest('binaries')}>
                    <Activity size={13} /> Test Transcoder & Hardware Encoders
                  </button>
                </div>

                {[
                  { key: 'ffmpegBinaryPath' as const, label: 'FFmpeg Binary Path (Bundled sidecar pre-configured):' },
                  { key: 'ffprobeBinaryPath' as const, label: 'FFprobe Binary Path:' },
                  { key: 'handbrakeBinaryPath' as const, label: 'HandBrakeCLI Binary Path (Optional):' },
                ].map((row) => (
                  <div key={row.key} style={{ marginBottom: 10 }}>
                    <label style={{ display: 'block', fontWeight: 600, marginBottom: 4 }}>{row.label}</label>
                    <div style={{ display: 'flex', gap: 6 }}>
                      <input
                        className="aqua-input"
                        style={{ flex: 1 }}
                        value={form[row.key]}
                        onChange={(e) => updateField(row.key, e.target.value)}
                      />
                      <button className="aqua-btn" onClick={() => browseFile(row.key, `Select ${row.label}`)}>
                        Browse...
                      </button>
                    </div>
                  </div>
                ))}
                {renderTestBadge('binaries')}
              </div>
            </>
          )}

          {tab === 'shares' && (
            <>
              <div className="epod-capacity-card">
                <strong style={{ display: 'block', marginBottom: 8 }}>
                  Direct NFS / SMB Network Share & Per-Media-Type Folder Mapping
                </strong>
                <div style={{ display: 'grid', gridTemplateColumns: '1.2fr 0.7fr 1.2fr 1.2fr', gap: 8, marginBottom: 10 }}>
                  <div>
                    <label style={{ display: 'block', fontSize: 11, fontWeight: 600 }}>Connection Name:</label>
                    <input
                      className="aqua-input"
                      style={{ width: '100%' }}
                      value={shareDraft.name}
                      onChange={(e) => setShareDraft((p) => ({ ...p, name: e.target.value }))}
                    />
                  </div>
                  <div>
                    <label style={{ display: 'block', fontSize: 11, fontWeight: 600 }}>Protocol:</label>
                    <select
                      className="aqua-input"
                      style={{ width: '100%' }}
                      value={shareDraft.protocol}
                      onChange={(e) =>
                        setShareDraft((p) => ({ ...p, protocol: e.target.value as 'nfs' | 'smb' }))
                      }
                    >
                      <option value="smb">SMB / CIFS</option>
                      <option value="nfs">NFSv3 / NFSv4</option>
                    </select>
                  </div>
                  <div>
                    <label style={{ display: 'block', fontSize: 11, fontWeight: 600 }}>Host / IP:</label>
                    <input
                      className="aqua-input"
                      style={{ width: '100%' }}
                      placeholder="192.168.1.50 or nas.local"
                      value={shareDraft.host}
                      onChange={(e) => setShareDraft((p) => ({ ...p, host: e.target.value }))}
                    />
                  </div>
                  <div>
                    <label style={{ display: 'block', fontSize: 11, fontWeight: 600 }}>Base Share / Export:</label>
                    <input
                      className="aqua-input"
                      style={{ width: '100%' }}
                      placeholder="/mnt/pool/media or /Volumes/Media"
                      value={shareDraft.base_path}
                      onChange={(e) => setShareDraft((p) => ({ ...p, base_path: e.target.value }))}
                    />
                  </div>
                </div>

                {shareDraft.protocol === 'smb' && (
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 10 }}>
                    <div>
                      <label style={{ display: 'block', fontSize: 11, fontWeight: 600 }}>SMB Username:</label>
                      <input
                        className="aqua-input"
                        style={{ width: '100%' }}
                        value={shareDraft.username}
                        onChange={(e) => setShareDraft((p) => ({ ...p, username: e.target.value }))}
                      />
                    </div>
                    <div>
                      <label style={{ display: 'block', fontSize: 11, fontWeight: 600 }}>
                        Password:
                      </label>
                      <input
                        type="password"
                        className="aqua-input"
                        style={{ width: '100%' }}
                        placeholder="Password"
                        value={shareDraft.password}
                        onChange={(e) => setShareDraft((p) => ({ ...p, password: e.target.value }))}
                      />
                    </div>
                  </div>
                )}

                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                  <strong style={{ fontSize: 11.5 }}>Media Folders:</strong>
                  <button
                    className="aqua-btn"
                    style={{ fontSize: 11 }}
                    onClick={async () => {
                      const disc = await invokeRpc<{
                        shares: string[];
                        existingMount: string | null;
                        folderMap: Record<string, string>;
                      }>('shares:discover', {
                        protocol: shareDraft.protocol,
                        host: shareDraft.host,
                        username: shareDraft.username,
                        password: shareDraft.password,
                      });
                      const nextBase =
                        disc.shares.length > 0
                          ? disc.shares[0].startsWith('/')
                            ? disc.shares[0]
                            : `/${disc.shares[0]}`
                          : shareDraft.base_path;
                      const detected =
                        Object.keys(disc.folderMap || {}).length > 0
                          ? disc.folderMap
                          : await invokeRpc<Record<string, string>>(
                              'shares:autoDetect',
                              disc.existingMount || form.nfsSharePath || nextBase
                            );
                      setShareDraft((p) => ({
                        ...p,
                        base_path: nextBase,
                        folder_map: { ...p.folder_map, ...detected },
                      }));
                      setStatusBanner(
                        disc.shares.length > 0
                          ? `Detected share ${nextBase} on ${shareDraft.host}.`
                          : 'Detected media folders.'
                      );
                    }}
                  >
                    Auto-Detect Folders
                  </button>
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8, marginBottom: 12 }}>
                  {[
                    { k: 'music', label: 'Music Subfolder' },
                    { k: 'movies', label: 'Movies Subfolder' },
                    { k: 'tvShows', label: 'TV Shows Subfolder' },
                    { k: 'musicVideos', label: 'Music Videos' },
                    { k: 'books', label: 'Books (eBooks)' },
                    { k: 'audiobooks', label: 'Audiobooks' },
                    { k: 'photos', label: 'Photos / Immich' },
                    { k: 'transcodeCache', label: '360p Cache' },
                  ].map((f) => (
                    <div key={f.k}>
                      <label style={{ display: 'block', fontSize: 10.5, fontWeight: 600 }}>{f.label}:</label>
                      <input
                        className="aqua-input"
                        style={{ width: '100%' }}
                        value={shareDraft.folder_map[f.k] || ''}
                        onChange={(e) =>
                          setShareDraft((p) => ({
                            ...p,
                            folder_map: { ...p.folder_map, [f.k]: e.target.value },
                          }))
                        }
                      />
                    </div>
                  ))}
                </div>

                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5, fontWeight: 600 }}>
                    <input
                      type="checkbox"
                      checked={shareDraft.auto_connect}
                      onChange={(e) =>
                        setShareDraft((p) => ({ ...p, auto_connect: e.target.checked }))
                      }
                    />
                    Auto-Connect & Mount Share on rTunes Launch
                  </label>
                  <button
                    className="aqua-btn primary"
                    onClick={async () => {
                      const saved = await invokeRpc<NetworkShareRow>('shares:save', shareDraft);
                      const mRes = await invokeRpc<{ ok: boolean; message: string }>(
                        'shares:mount',
                        saved.id
                      );
                      setStatusBanner(mRes.message);
                      await loadShares();
                      const freshSettings = await invokeRpc<AppSettings>('settings:get');
                      setForm(freshSettings);
                      onSaved(freshSettings);
                    }}
                  >
                    Save & Mount Share
                  </button>
                </div>
              </div>

              {/* Configured Shares List */}
              <div className="epod-capacity-card">
                <strong style={{ display: 'block', marginBottom: 8 }}>Configured Network Shares</strong>
                {shares.length === 0 ? (
                  <div style={{ fontSize: 11.5, color: '#64748b' }}>
                    No network shares configured.
                  </div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {shares.map((sh) => (
                      <div
                        key={sh.id}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          padding: '8px 10px',
                          background: '#fff',
                          border: '1px solid #cbd5e1',
                          borderRadius: 6,
                        }}
                      >
                        <div>
                          <strong>
                            {sh.name} ({sh.protocol.toUpperCase()})
                          </strong>{' '}
                          <span style={{ fontSize: 11, color: '#475569' }}>
                            {sh.host}:{sh.base_path} → <code>{sh.mount_point}</code>
                          </span>
                          <div style={{ fontSize: 10.5, color: sh.is_mounted ? '#15803d' : '#64748b', fontWeight: 600 }}>
                            {sh.is_mounted ? '● Mounted & Mapped' : '○ Unmounted'}
                          </div>
                        </div>
                        <div style={{ display: 'flex', gap: 6 }}>
                          <button
                            className="aqua-btn"
                            onClick={async () => {
                              const res = await invokeRpc<{ ok: boolean; message: string }>(
                                sh.is_mounted ? 'shares:unmount' : 'shares:mount',
                                sh.id
                              );
                              setStatusBanner(res.message);
                              await loadShares();
                            }}
                          >
                            {sh.is_mounted ? 'Unmount' : 'Mount'}
                          </button>
                          <button
                            className="aqua-btn"
                            onClick={async () => {
                              await invokeRpc('shares:delete', sh.id);
                              await loadShares();
                            }}
                          >
                            Remove
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </>
          )}

          {tab === 'cache' && (
            <div className="epod-capacity-card">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12, gap: 8, flexWrap: 'wrap' }}>
                <strong>
                  Local SSD Pre-Cache Quota &amp; Hardware Acceleration (Section 3)
                </strong>
                {isServerContext && perms.localCacheTier === 1 && (
                  <span
                    style={{
                      fontSize: 10.5,
                      fontWeight: 700,
                      color: '#92400e',
                      background: '#fef3c7',
                      border: '1px solid #fcd34d',
                      borderRadius: 10,
                      padding: '2px 8px',
                    }}
                  >
                    Role Cache Quota: Capped at {perms.localCacheLimitMb} MB
                  </span>
                )}
              </div>

              <div style={{ marginBottom: 16 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                  <span style={{ fontWeight: 600 }}>Maximum Local Cache Quota:</span>
                  <span style={{ fontWeight: 700, color: '#1d4ed8' }}>{form.cacheMaxSizeGb} GB</span>
                </div>
                <input
                  type="range"
                  min={10}
                  max={500}
                  step={5}
                  value={form.cacheMaxSizeGb}
                  onChange={(e) => updateField('cacheMaxSizeGb', Number(e.target.value))}
                  style={{ width: '100%' }}
                />
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: '#555' }}>
                  <span>10 GB</span>
                  <span>100 GB</span>
                  <span>250 GB</span>
                  <span>500 GB</span>
                </div>
              </div>

              <div style={{ marginBottom: 14, display: 'flex', flexDirection: 'column', gap: 8 }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 600, cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={form.autoCachePlayback !== false}
                    onChange={(e) => updateField('autoCachePlayback', e.target.checked)}
                  />
                  Auto-Cache Played Media Locally (Reduces NAS streaming & speeds up future ePod syncs)
                </label>

                <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 600, cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={form.autoEvictLru}
                    onChange={(e) => updateField('autoEvictLru', e.target.checked)}
                  />
                  Enable Automatic LRU Eviction when cache exceeds quota
                </label>

                {isClientRole && (
                  <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 600, cursor: 'pointer' }}>
                    <input
                      type="checkbox"
                      checked={Boolean(form.enableClientLocalTranscoding)}
                      onChange={(e) => updateField('enableClientLocalTranscoding', e.target.checked)}
                    />
                    Enable Client Local Video Transcoding (Sync 360p ePod MP4 locally on this device)
                  </label>
                )}
              </div>

              <div style={{ marginBottom: 16 }}>
                <label style={{ display: 'block', fontWeight: 600, marginBottom: 4 }}>
                  Library Import & Metadata Loading Strategy:
                </label>
                <select
                  className="aqua-input"
                  style={{ width: '100%', marginBottom: 12 }}
                  value={form.metadataHydrationMode || 'hybrid'}
                  onChange={(e) => updateField('metadataHydrationMode', e.target.value as any)}
                >
                  <option value="hybrid">
                    Hybrid (Recommended): Phased Directory Import + Instant On-Demand & Gentle Background Tagging
                  </option>
                  <option value="on_demand">
                    On-Demand Only: Phased Directory Import + Load Tags/Covers Only When Viewing or Playing
                  </option>
                </select>

                <label style={{ display: 'block', fontWeight: 600, marginBottom: 4 }}>
                  360p ePod Video Hardware Acceleration Engine:
                </label>
                <select
                  className="aqua-input"
                  style={{ width: '100%' }}
                  value={form.hardwareAccelMode}
                  onChange={(e) => updateField('hardwareAccelMode', e.target.value as any)}
                >
                  <option value="auto">Auto-Detect (VideoToolbox / NVENC / QSV / VA-API)</option>
                  <option value="vt_h264">macOS ARM64 VideoToolbox (h264_videotoolbox)</option>
                  <option value="nvenc">NVIDIA NVENC (h264_nvenc)</option>
                  <option value="qsv">Intel QuickSync (h264_qsv)</option>
                  <option value="vaapi">Linux VA-API Hardware Encoder (h264_vaapi)</option>
                  <option value="software">Software CPU x264 (libx264)</option>
                </select>
                <p style={{ fontSize: 11, color: '#475569', marginTop: 6 }}>
                  Target ePod Output: Max 480×360 (4:3), 30fps cap, H.264 Main Profile, AAC 128kbps Stereo, +faststart MP4 atom.
                </p>
              </div>

              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                <button
                  className="aqua-btn primary"
                  onClick={async () => {
                    await invokeRpc('cache:precacheAllPlaylists');
                    setStatusBanner('Queued all playlist tracks for local SSD caching.');
                  }}
                >
                  Pre-Cache All Playlists Now
                </button>
                <button
                  className="aqua-btn"
                  onClick={async () => {
                    const res = await invokeRpc<{ deletedFiles: number }>('cache:clear');
                    setStatusBanner(`Cleared ${res.deletedFiles} cached files.`);
                  }}
                >
                  Clear Local Cache
                </button>
              </div>

              <div
                style={{
                  marginTop: 16,
                  paddingTop: 14,
                  borderTop: '1px solid #cbd5e1',
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8, gap: 8, flexWrap: 'wrap' }}>
                  <strong>Transcoder Binaries (FFmpeg, FFprobe &amp; HandBrakeCLI)</strong>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <select
                      className="aqua-input"
                      value={form.transcoderUpdateSchedule || 'weekly'}
                      onChange={(e) => updateField('transcoderUpdateSchedule', e.target.value as any)}
                      title="Startup Transcoder Binary Update Schedule"
                    >
                      <option value="off">Auto-Check: Off</option>
                      <option value="daily">Auto-Check: Daily</option>
                      <option value="weekly">Auto-Check: Weekly</option>
                    </select>
                    <button
                      className="aqua-btn"
                      disabled={checkingBinaries}
                      onClick={async () => {
                        setCheckingBinaries(true);
                        setStatusBanner('Checking transcoder binary updates...');
                        try {
                          const res = await invokeRpc<any>('transcoder:checkUpdates');
                          setBinaryStatus(res);
                          updateField('lastTranscoderUpdateCheckAt', Date.now());
                          setStatusBanner('Transcoder update check complete.');
                        } catch (err) {
                          setStatusBanner(`Binary check failed: ${String(err)}`);
                        } finally {
                          setCheckingBinaries(false);
                        }
                      }}
                    >
                      {checkingBinaries ? 'Checking...' : 'Check Now'}
                    </button>
                    <button
                      className="aqua-btn primary"
                      disabled={checkingBinaries}
                      onClick={async () => {
                        setCheckingBinaries(true);
                        setStatusBanner('Checking / updating FFmpeg & HandBrakeCLI...');
                        try {
                          const res = await invokeRpc<any>('transcoder:checkUpdateBinaries', {
                            forceDownload: true,
                            autoDownload: true,
                          });
                          setBinaryStatus(res);
                          updateField('lastTranscoderUpdateCheckAt', Date.now());
                          setStatusBanner('Transcoder binaries checked & updated.');
                        } catch (err) {
                          setStatusBanner(`Binary check failed: ${String(err)}`);
                        } finally {
                          setCheckingBinaries(false);
                        }
                      }}
                    >
                      {checkingBinaries ? 'Downloading...' : 'Force Re-Download Binaries'}
                    </button>
                  </div>
                </div>
                <div style={{ fontSize: 11, color: '#334155', display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <div>
                    <strong>FFmpeg:</strong>{' '}
                    {binaryStatus?.ffmpeg?.present
                      ? `${binaryStatus.ffmpeg.version || 'Installed'} (${binaryStatus.ffmpeg.path})`
                      : 'Not found — click Check Now to auto-install'}
                  </div>
                  <div>
                    <strong>FFprobe:</strong>{' '}
                    {binaryStatus?.ffprobe?.present
                      ? `${binaryStatus.ffprobe.version || 'Installed'} (${binaryStatus.ffprobe.path})`
                      : 'Not found — click Check Now to auto-install'}
                  </div>
                  <div>
                    <strong>HandBrakeCLI:</strong>{' '}
                    {binaryStatus?.handbrake?.present
                      ? `${binaryStatus.handbrake.version || 'Installed'} (${binaryStatus.handbrake.path})`
                      : 'Not found — optional fallback'}
                  </div>
                  <div style={{ color: '#64748b' }}>
                    <strong>Last Startup/Manual Check:</strong>{' '}
                    {form.lastTranscoderUpdateCheckAt
                      ? new Date(form.lastTranscoderUpdateCheckAt).toLocaleString()
                      : 'Never'}
                  </div>
                </div>
              </div>

              <div
                style={{
                  marginTop: 16,
                  paddingTop: 14,
                  borderTop: '1px solid #cbd5e1',
                }}
              >
                <strong style={{ display: 'block', marginBottom: 6 }}>
                  One-Click Library Title & Metadata Maintenance
                </strong>
                <p style={{ fontSize: 11, color: '#475569', marginTop: 0, marginBottom: 10 }}>
                  Strips repeated artist/album/track-number prefixes from song titles (e.g.{' '}
                  <code>Artist - Album - 01 - Title</code>), removes Sonarr/release group suffixes from TV episodes (e.g.{' '}
                  <code>-iVy</code>, <code>-PSA</code>), reclassifies TV Specials/Extras folders into TV Shows, and queues
                  background tag & duration hydration.
                </p>
                <button
                  className="aqua-btn primary"
                  onClick={async () => {
                    setStatusBanner('Cleaning library filenames & queuing tag hydration...');
                    const res = await invokeRpc<{
                      tracksCleaned: number;
                      videosCleaned: number;
                      tvReclassified: number;
                    }>('indexer:cleanAllTitles', true);
                    setStatusBanner(
                      `Cleaned ${res.tracksCleaned} song titles, ${res.videosCleaned} video titles (${res.tvReclassified} TV specials reclassified), and started background tag hydration.`
                    );
                  }}
                >
                  <RefreshCw size={13} /> Clean All Library Titles & Hydrate Metadata Now
                </button>
              </div>
            </div>
          )}

          {tab === 'auth' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              {/* My Account, ListenBrainz & Password */}
              <div className="epod-capacity-card">
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10, gap: 8, flexWrap: 'wrap' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <strong>My Account &amp; Profile</strong>
                    {(callerMe?.roles || []).map((r) => (
                      <span
                        key={r}
                        style={{
                          fontSize: 10,
                          fontWeight: 700,
                          padding: '1px 7px',
                          borderRadius: 9,
                          background: '#dbeafe',
                          color: '#1e40af',
                        }}
                      >
                        {r}
                      </span>
                    ))}
                  </div>
                  {isServerContext && callerMe?.authSource !== 'local-owner' && (
                    <button
                      type="button"
                      className="aqua-btn"
                      style={{ color: '#991b1b' }}
                      onClick={async () => {
                        await logoutServerSession(form.dockerServerUrl || undefined);
                        onSignedOut?.();
                        onClose();
                      }}
                    >
                      Sign Out
                    </button>
                  )}
                </div>

                {callerMe?.user ? (
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10, marginBottom: 12 }}>
                    <div>
                      <label style={{ display: 'block', fontSize: 11, fontWeight: 600, marginBottom: 3 }}>
                        Display Name (@{callerMe.username}):
                      </label>
                      <input
                        className="aqua-input"
                        style={{ width: '100%' }}
                        value={profileDisplayName}
                        onChange={(e) => setProfileDisplayName(e.target.value)}
                      />
                    </div>
                    <div>
                      <label style={{ display: 'block', fontSize: 11, fontWeight: 600, marginBottom: 3 }}>
                        Email:
                      </label>
                      <input
                        type="email"
                        className="aqua-input"
                        style={{ width: '100%' }}
                        value={profileEmail}
                        onChange={(e) => setProfileEmail(e.target.value)}
                      />
                    </div>
                    <div>
                      <label style={{ display: 'block', fontSize: 11, fontWeight: 600, marginBottom: 3 }}>
                        Phone:
                      </label>
                      <input
                        className="aqua-input"
                        style={{ width: '100%' }}
                        value={profilePhone}
                        onChange={(e) => setProfilePhone(e.target.value)}
                      />
                    </div>
                  </div>
                ) : (
                  <div style={{ fontSize: 11.5, color: '#475569', marginBottom: 10 }}>
                    Signed in as <strong>{callerMe?.displayName || 'Local Owner'}</strong> ({callerMe?.authSource || 'local-owner'}).
                  </div>
                )}

                {/* Per-User ListenBrainz Credentials */}
                <div style={{ paddingTop: 10, borderTop: '1px solid #dce2ec', marginBottom: 10 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                    <strong style={{ fontSize: 12 }}>
                      ListenBrainz (Personal Scrobbling &amp; Two-Way Loved Feedback)
                    </strong>
                    <button
                      type="button"
                      className="aqua-btn"
                      disabled={testingPersonalLb}
                      onClick={async () => {
                        setTestingPersonalLb(true);
                        try {
                          const res = await invokeRpc<{
                            ok: boolean;
                            valid?: boolean;
                            username?: string;
                            message: string;
                            latencyMs: number;
                          }>('uac:testMyListenBrainzToken', myListenbrainzToken);
                          setPersonalLbTestResult({
                            ok: Boolean(res.ok),
                            message: res.message,
                            latencyMs: res.latencyMs || 0,
                          });
                          if (res.ok && res.username) {
                            setMyListenbrainzUsername(res.username);
                          }
                        } catch (err) {
                          setPersonalLbTestResult({
                            ok: false,
                            message: err instanceof Error ? err.message : String(err),
                            latencyMs: 0,
                          });
                        } finally {
                          setTestingPersonalLb(false);
                        }
                      }}
                    >
                      <Activity size={13} /> {testingPersonalLb ? 'Testing...' : 'Test Token'}
                    </button>
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 10 }}>
                    <div>
                      <label style={{ display: 'block', fontSize: 11, fontWeight: 600, marginBottom: 3 }}>
                        Personal User Token (Saved {callerMe?.user ? 'to your profile' : `in ${credentialStoreLabel}`}):
                      </label>
                      <input
                        type="password"
                        className="aqua-input"
                        style={{ width: '100%' }}
                        placeholder={
                          hasSavedPersonalLbToken
                            ? 'Personal token saved — enter a new UUID to replace'
                            : 'UUID Token from listenbrainz.org/settings'
                        }
                        value={myListenbrainzToken}
                        onChange={(e) => setMyListenbrainzToken(e.target.value)}
                      />
                    </div>
                    <div>
                      <label style={{ display: 'block', fontSize: 11, fontWeight: 600, marginBottom: 3 }}>
                        Username:
                      </label>
                      <input
                        className="aqua-input"
                        style={{ width: '100%' }}
                        value={myListenbrainzUsername}
                        onChange={(e) => setMyListenbrainzUsername(e.target.value)}
                      />
                    </div>
                  </div>
                  {personalLbTestResult ? (
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 6,
                        fontSize: 11,
                        color: personalLbTestResult.ok ? '#15803d' : '#b91c1c',
                        marginTop: 4,
                      }}
                    >
                      <span className={`status-dot ${personalLbTestResult.ok ? 'green' : 'red'}`} />
                      <span>
                        {personalLbTestResult.message} ({personalLbTestResult.latencyMs}ms)
                      </span>
                    </div>
                  ) : (
                    <span style={{ fontSize: 11, color: '#64748b', display: 'inline-flex', alignItems: 'center', gap: 5, marginTop: 4 }}>
                      <span className={`status-dot ${hasSavedPersonalLbToken ? 'green' : 'gray'}`} />{' '}
                      {hasSavedPersonalLbToken ? 'Personal token stored (encrypted at rest)' : 'Untested'}
                    </span>
                  )}

                  {/* Local Play History & Scrobble Queue */}
                  <div
                    style={{
                      marginTop: 10,
                      padding: '8px 10px',
                      borderRadius: 6,
                      background: '#f8fafc',
                      border: '1px solid #cbd5e1',
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      gap: 10,
                      flexWrap: 'wrap',
                    }}
                  >
                    <div style={{ fontSize: 11, color: '#334155' }}>
                      <strong>Local Play History &amp; Scrobble Queue:</strong>{' '}
                      <span style={{ fontWeight: 700, color: scrobbleQueueStats.pendingCount > 0 ? '#1d4ed8' : '#15803d' }}>
                        {scrobbleQueueStats.pendingCount}
                      </span>{' '}
                      queued plays pending sync •{' '}
                      <span style={{ fontWeight: 600 }}>{scrobbleQueueStats.totalLogged}</span> total plays logged
                    </div>
                    <button
                      type="button"
                      className="aqua-btn"
                      disabled={
                        syncingScrobbles ||
                        scrobbleQueueStats.pendingCount <= 0 ||
                        (!hasSavedPersonalLbToken && !myListenbrainzToken.trim())
                      }
                      onClick={async () => {
                        setSyncingScrobbles(true);
                        try {
                          if (myListenbrainzToken.trim()) {
                            await invokeRpc('uac:updateMyProfile', {
                              listenbrainzToken: myListenbrainzToken.trim(),
                              listenbrainzUsername: myListenbrainzUsername.trim(),
                            });
                            setHasSavedPersonalLbToken(true);
                            setMyListenbrainzToken('');
                          }
                          const res = await invokeRpc<{
                            ok: boolean;
                            submitted: number;
                            remaining: number;
                            errors: string[];
                          }>('uac:syncPendingScrobbles');
                          await loadScrobbleQueueStats();
                          if (res.ok) {
                            setStatusBanner(
                              `Synced ${res.submitted} queued plays to ListenBrainz (${res.remaining} remaining).`
                            );
                          } else {
                            setStatusBanner(
                              `Submitted ${res.submitted} plays (${res.remaining} remaining): ${res.errors.join('; ')}`
                            );
                          }
                        } catch (err) {
                          setStatusBanner(err instanceof Error ? err.message : String(err));
                        } finally {
                          setSyncingScrobbles(false);
                        }
                      }}
                    >
                      <RefreshCw size={12} />{' '}
                      {syncingScrobbles ? 'Syncing...' : 'Sync Queued Plays to ListenBrainz'}
                    </button>
                  </div>
                </div>

                <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: callerMe?.user ? 10 : 0 }}>
                  <button
                    type="button"
                    className="aqua-btn primary"
                    disabled={profileBusy}
                    onClick={async () => {
                      setProfileBusy(true);
                      try {
                        await invokeRpc('uac:updateMyProfile', {
                          ...(callerMe?.user
                            ? {
                                displayName: profileDisplayName.trim(),
                                email: profileEmail.trim(),
                                phone: profilePhone.trim(),
                              }
                            : {}),
                          listenbrainzUsername: myListenbrainzUsername.trim(),
                          ...(myListenbrainzToken.trim()
                            ? { listenbrainzToken: myListenbrainzToken.trim() }
                            : {}),
                        });
                        if (myListenbrainzToken.trim()) {
                          setHasSavedPersonalLbToken(true);
                          setMyListenbrainzToken('');
                        }
                        await loadScrobbleQueueStats();
                        onProfileUpdated?.();
                        setStatusBanner('Saved your account profile and personal ListenBrainz settings.');
                      } catch (err) {
                        setStatusBanner(err instanceof Error ? err.message : String(err));
                      } finally {
                        setProfileBusy(false);
                      }
                    }}
                  >
                    Save Profile &amp; ListenBrainz
                  </button>
                </div>

                {callerMe?.user && (
                  <div style={{ paddingTop: 10, borderTop: '1px solid #dce2ec' }}>
                    {callerMe.user.authentikSub ? (
                      <div style={{ fontSize: 11.5, color: '#475569' }}>
                        <strong>Password &amp; MFA:</strong> Managed externally via Authentik SSO (@{callerMe.username}).
                      </div>
                    ) : (
                      <div>
                        <strong style={{ display: 'block', fontSize: 12, marginBottom: 8 }}>
                          Change Password
                        </strong>
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr auto', gap: 8, alignItems: 'end' }}>
                          <div>
                            <label style={{ display: 'block', fontSize: 10.5, fontWeight: 600, marginBottom: 2 }}>
                              Current Password
                            </label>
                            <input
                              type="password"
                              className="aqua-input"
                              style={{ width: '100%' }}
                              value={curPassword}
                              onChange={(e) => setCurPassword(e.target.value)}
                            />
                          </div>
                          <div>
                            <label style={{ display: 'block', fontSize: 10.5, fontWeight: 600, marginBottom: 2 }}>
                              New Password
                            </label>
                            <input
                              type="password"
                              className="aqua-input"
                              style={{ width: '100%' }}
                              value={newPassword}
                              onChange={(e) => setNewPassword(e.target.value)}
                            />
                          </div>
                          <div>
                            <label style={{ display: 'block', fontSize: 10.5, fontWeight: 600, marginBottom: 2 }}>
                              Confirm New
                            </label>
                            <input
                              type="password"
                              className="aqua-input"
                              style={{ width: '100%' }}
                              value={confirmPassword}
                              onChange={(e) => setConfirmPassword(e.target.value)}
                            />
                          </div>
                          <button
                            type="button"
                            className="aqua-btn"
                            disabled={profileBusy || !curPassword || newPassword.length < 4}
                            onClick={async () => {
                              if (newPassword !== confirmPassword) {
                                setStatusBanner('New passwords do not match.');
                                return;
                              }
                              setProfileBusy(true);
                              try {
                                await invokeRpc('uac:changeMyPassword', curPassword, newPassword);
                                setCurPassword('');
                                setNewPassword('');
                                setConfirmPassword('');
                                setStatusBanner('Password updated successfully.');
                              } catch (err) {
                                setStatusBanner(err instanceof Error ? err.message : String(err));
                              } finally {
                                setProfileBusy(false);
                              }
                            }}
                          >
                            Update Password
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>

              {((isServerRole && canManageUac) || isRemoteClient) && (
                <div className="epod-capacity-card">
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12, gap: 8, flexWrap: 'wrap' }}>
                    <strong>Server Authentication &amp; Security Gate</strong>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                      {isServerContext && canManageUac && onOpenUac && (
                        <button
                          type="button"
                          className="aqua-btn primary"
                          onClick={() => onOpenUac()}
                        >
                          Manage Users, Roles &amp; Approvals...
                        </button>
                      )}
                      {form.authMode === 'authentik' && (
                        <button className="aqua-btn" onClick={() => runTest('authentik')}>
                          <Activity size={13} /> Test OIDC Discovery
                        </button>
                      )}
                    </div>
                  </div>

                  {isServerRole && canManageUac && (
                    <div style={{ marginBottom: 12, paddingBottom: 10, borderBottom: '1px solid #d5dce6' }}>
                      <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, fontWeight: 700, cursor: 'pointer' }}>
                        <input
                          type="checkbox"
                          checked={Boolean(form.authGateEnabled)}
                          onChange={(e) => updateField('authGateEnabled', e.target.checked)}
                        />
                        <span>Enable Authentication Gate on Server HTTP API, SSE &amp; Media Endpoints</span>
                      </label>
                      <div style={{ fontSize: 11, color: '#475569', marginTop: 4, marginLeft: 22 }}>
                        When enabled (and Auth Mode is not Standalone), `/rpc`, `/events`, and `/track` / `/video` / `/artwork` require valid credentials. `/api/health`, `/api/auth/info`, and `/api/auth/pin-login` remain reachable for client discovery and unlock.
                      </div>
                    </div>
                  )}

                  {isServerRole && canManageUac && (
                    <>
                      <div style={{ marginBottom: 12 }}>
                        <label style={{ display: 'block', fontWeight: 600, marginBottom: 4 }}>Authentication Mode:</label>
                        <select
                          className="aqua-input"
                          style={{ width: '100%' }}
                          value={form.authMode || 'standalone'}
                          onChange={(e) => updateField('authMode', e.target.value as AuthMode)}
                        >
                          <option value="standalone">Standalone / Open (No login gate)</option>
                          <option value="local-accounts">Multi-User Local Accounts (Label / Band / Roadie + Roles)</option>
                          <option value="local-pin">Local Access PIN (Salted scrypt + Bearer Token)</option>
                          <option value="authentik">Authentik SSO + Homelab Gateway (OAuth2 PKCE JWT)</option>
                          <option value="proxy-headers">Reverse Proxy Trusted Header (Traefik / Nginx / Authentik ForwardAuth)</option>
                        </select>
                      </div>

                      <div style={{ marginBottom: 12 }}>
                        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11.5, fontWeight: 600, cursor: 'pointer' }}>
                          <input
                            type="checkbox"
                            checked={Boolean(form.allowGuestRoadie)}
                            onChange={(e) => updateField('allowGuestRoadie', e.target.checked)}
                          />
                          <span>Allow unauthenticated Guest LAN playback with Roadie (read-only) permissions</span>
                        </label>
                      </div>
                    </>
                  )}

              {form.authMode === 'local-pin' && (
                <div style={{ marginBottom: 12, padding: 10, borderRadius: 6, background: '#f8fafc', border: '1px solid #cbd5e1' }}>
                  <label style={{ display: 'block', fontWeight: 600, marginBottom: 4 }}>
                    {form.hasLocalPin ? 'Update Local Access PIN (leave blank to keep existing PIN):' : 'Set Local Access PIN:'}
                  </label>
                  <input
                    type="password"
                    className="aqua-input"
                    style={{ width: '100%' }}
                    placeholder={form.hasLocalPin ? 'PIN is set — enter a new PIN to replace it' : 'Enter access PIN...'}
                    value={form.localPinPlaintext || ''}
                    onChange={(e) => updateField('localPinPlaintext', e.target.value)}
                  />
                  <div style={{ fontSize: 11, color: '#64748b', marginTop: 4 }}>
                    {form.hasLocalPin
                      ? 'An active salted scrypt PIN hash is stored in SQLite. Click Save Preferences after entering a new PIN.'
                      : 'Enter a PIN and click Save Preferences to hash and persist it.'}
                  </div>
                </div>
              )}

              {form.authMode === 'proxy-headers' && (
                <div style={{ marginBottom: 12, padding: 10, borderRadius: 6, background: '#f8fafc', border: '1px solid #cbd5e1' }}>
                  <label style={{ display: 'block', fontWeight: 600, marginBottom: 4 }}>
                    Trusted Proxy Username Header:
                  </label>
                  <input
                    className="aqua-input"
                    style={{ width: '100%' }}
                    placeholder="X-authentik-username"
                    value={form.trustedProxyHeader || 'X-authentik-username'}
                    onChange={(e) => updateField('trustedProxyHeader', e.target.value)}
                  />
                  <div style={{ fontSize: 11, color: '#64748b', marginTop: 4 }}>
                    Server allows requests carrying a non-empty value for this HTTP header injected by your reverse proxy.
                  </div>
                </div>
              )}

              {form.authMode === 'authentik' && (
                <>
                  <div style={{ marginBottom: 10 }}>
                    <label style={{ display: 'block', fontWeight: 600, marginBottom: 4 }}>
                      Authentik OIDC Issuer URL:
                    </label>
                    <input
                      className="aqua-input"
                      style={{ width: '100%' }}
                      placeholder="https://auth.yourdomain.com/application/o/retrotunes/"
                      value={form.authentikIssuerUrl}
                      onChange={(e) => updateField('authentikIssuerUrl', e.target.value)}
                    />
                  </div>

                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 10 }}>
                    <div>
                      <label style={{ display: 'block', fontWeight: 600, marginBottom: 4 }}>OAuth2 Client ID:</label>
                      <input
                        className="aqua-input"
                        style={{ width: '100%' }}
                        value={form.authentikClientId}
                        onChange={(e) => updateField('authentikClientId', e.target.value)}
                      />
                    </div>
                    <div>
                      <label style={{ display: 'block', fontWeight: 600, marginBottom: 4 }}>Loopback Redirect URI:</label>
                      <input
                        className="aqua-input"
                        style={{ width: '100%' }}
                        value={form.authentikRedirectUri}
                        onChange={(e) => updateField('authentikRedirectUri', e.target.value)}
                      />
                    </div>
                  </div>

                  <div style={{ marginBottom: 12 }}>
                    <label style={{ display: 'block', fontWeight: 600, marginBottom: 4 }}>
                      Companion Homelab Gateway URL (Proxy for Store Requests):
                    </label>
                    <input
                      className="aqua-input"
                      style={{ width: '100%' }}
                      placeholder="https://gateway.yourdomain.com"
                      value={form.homelabGatewayUrl}
                      onChange={(e) => updateField('homelabGatewayUrl', e.target.value)}
                    />
                  </div>

                  {renderTestBadge('authentik')}

                  <div
                    style={{
                      marginTop: 14,
                      paddingTop: 12,
                      borderTop: '1px solid #cbd5e1',
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                    }}
                  >
                    <div>
                      {authState.authenticated && authState.user ? (
                        <span style={{ color: '#15803d', fontWeight: 700 }}>
                          Signed in via SSO as {authState.user.name} (@{authState.user.username})
                        </span>
                      ) : (
                        <span style={{ color: '#475569' }}>
                          Not currently signed in to Authentik SSO.
                        </span>
                      )}
                    </div>
                    {authState.authenticated ? (
                      <button
                        className="aqua-btn"
                        onClick={async () => {
                          const next = await invokeRpc<AuthState>('auth:logout');
                          onAuthChanged(next);
                        }}
                      >
                        Logout SSO
                      </button>
                    ) : (
                      <button
                        className="aqua-btn primary"
                        onClick={async () => {
                          await invokeRpc('settings:save', form);
                          const next = await invokeRpc<AuthState>('auth:login');
                          onAuthChanged(next);
                        }}
                      >
                        Sign In with Authentik (PKCE)
                      </button>
                    )}
                  </div>
                </>
              )}
                </div>
              )}
            </div>
          )}

          {tab === 'apis' && (
            <>
              {/* Server Catalog Hydration ListenBrainz Key */}
              <div className="epod-capacity-card">
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                  <strong>ListenBrainz &amp; MusicBrainz (Server Catalog Hydration)</strong>
                  <button type="button" className="aqua-btn" onClick={() => runTest('listenbrainz')}>
                    <Activity size={13} /> Test Connection
                  </button>
                </div>
                <p style={{ margin: '0 0 8px', fontSize: 11, color: '#475569' }}>
                  Server-wide key for global popularity &amp; metadata hydration only. Never used for personal play scrobbling.
                </p>
                <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 10 }}>
                  <div>
                    <label style={{ display: 'block', fontSize: 11, fontWeight: 600, marginBottom: 3 }}>
                      Server Hydration Token (Encrypted at rest):
                    </label>
                    <input
                      type="password"
                      className="aqua-input"
                      style={{ width: '100%' }}
                      placeholder="ListenBrainz Token for Global Popularity Hydration"
                      value={form.listenbrainzToken}
                      onChange={(e) => updateField('listenbrainzToken', e.target.value)}
                    />
                  </div>
                  <div>
                    <label style={{ display: 'block', fontSize: 11, fontWeight: 600, marginBottom: 3 }}>
                      Hydration Account Label (Optional):
                    </label>
                    <input
                      className="aqua-input"
                      style={{ width: '100%' }}
                      placeholder="server-hydration"
                      value={form.listenbrainzUsername}
                      onChange={(e) => updateField('listenbrainzUsername', e.target.value)}
                    />
                  </div>
                </div>
                {renderTestBadge('listenbrainz')}
              </div>

              {/* Lidarr, Radarr, Sonarr */}
              {[
                {
                  id: 'lidarr' as const,
                  title: 'Lidarr (Music Store Request Gateway)',
                  urlKey: 'lidarrUrl' as const,
                  apiKey: 'lidarrApiKey' as const,
                  profileKey: 'lidarrQualityProfileId' as const,
                  rootKey: 'lidarrRootFolderPath' as const,
                },
                {
                  id: 'radarr' as const,
                  title: 'Radarr (Movie Store Request Gateway)',
                  urlKey: 'radarrUrl' as const,
                  apiKey: 'radarrApiKey' as const,
                  profileKey: 'radarrQualityProfileId' as const,
                  rootKey: 'radarrRootFolderPath' as const,
                },
                {
                  id: 'sonarr' as const,
                  title: 'Sonarr (TV Series Store Request Gateway)',
                  urlKey: 'sonarrUrl' as const,
                  apiKey: 'sonarrApiKey' as const,
                  profileKey: 'sonarrQualityProfileId' as const,
                  rootKey: 'sonarrRootFolderPath' as const,
                },
              ].map((srv) => (
                <div key={srv.id} className="epod-capacity-card">
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                    <strong>{srv.title}</strong>
                    <button className="aqua-btn" onClick={() => runTest(srv.id)}>
                      <Activity size={13} /> Test Connection
                    </button>
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1.3fr 1.3fr 0.6fr 1fr', gap: 8 }}>
                    <div>
                      <label style={{ display: 'block', fontSize: 11, fontWeight: 600 }}>Server URL:</label>
                      <input
                        className="aqua-input"
                        style={{ width: '100%' }}
                        value={form[srv.urlKey]}
                        onChange={(e) => updateField(srv.urlKey, e.target.value)}
                      />
                    </div>
                    <div>
                      <label style={{ display: 'block', fontSize: 11, fontWeight: 600 }}>API Key:</label>
                      <input
                        type="password"
                        className="aqua-input"
                        style={{ width: '100%' }}
                        value={form[srv.apiKey]}
                        onChange={(e) => updateField(srv.apiKey, e.target.value)}
                      />
                    </div>
                    <div>
                      <label style={{ display: 'block', fontSize: 11, fontWeight: 600 }}>Quality ID:</label>
                      <input
                        type="number"
                        className="aqua-input"
                        style={{ width: '100%' }}
                        value={form[srv.profileKey]}
                        onChange={(e) => updateField(srv.profileKey, Number(e.target.value))}
                      />
                    </div>
                    <div>
                      <label style={{ display: 'block', fontSize: 11, fontWeight: 600 }}>Root Folder:</label>
                      <input
                        className="aqua-input"
                        style={{ width: '100%' }}
                        placeholder="Auto-detected"
                        value={form[srv.rootKey]}
                        onChange={(e) => updateField(srv.rootKey, e.target.value)}
                      />
                    </div>
                  </div>
                  {renderTestBadge(srv.id)}
                </div>
              ))}

              {/* TMDB, TVDB, Last.fm & TheAudioDB */}
              <div className="epod-capacity-card">
                <strong style={{ display: 'block', marginBottom: 8 }}>
                  Chart & Discovery APIs (TMDB, TVDB, Last.fm, TheAudioDB)
                </strong>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 10 }}>
                  <div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                      <label style={{ fontSize: 11, fontWeight: 600 }}>TMDB API Key:</label>
                      <button className="aqua-btn" style={{ padding: '1px 6px' }} onClick={() => runTest('tmdb')}>
                        Test TMDB
                      </button>
                    </div>
                    <input
                      type="password"
                      className="aqua-input"
                      style={{ width: '100%' }}
                      value={form.tmdbApiKey}
                      onChange={(e) => updateField('tmdbApiKey', e.target.value)}
                    />
                    {renderTestBadge('tmdb')}
                  </div>
                  <div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                      <label style={{ fontSize: 11, fontWeight: 600 }}>TVDB v4 API Key:</label>
                      <button className="aqua-btn" style={{ padding: '1px 6px' }} onClick={() => runTest('tvdb')}>
                        Test TVDB
                      </button>
                    </div>
                    <input
                      type="password"
                      className="aqua-input"
                      style={{ width: '100%' }}
                      value={form.tvdbApiKey}
                      onChange={(e) => updateField('tvdbApiKey', e.target.value)}
                    />
                    {renderTestBadge('tvdb')}
                  </div>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                  <div>
                    <label style={{ display: 'block', fontSize: 11, fontWeight: 600, marginBottom: 4 }}>
                      Last.fm API Key (Multi-Source Charts & Play Counts):
                    </label>
                    <input
                      type="password"
                      className="aqua-input"
                      style={{ width: '100%' }}
                      value={form.lastfmApiKey || ''}
                      onChange={(e) => updateField('lastfmApiKey', e.target.value)}
                    />
                  </div>
                  <div>
                    <label style={{ display: 'block', fontSize: 11, fontWeight: 600, marginBottom: 4 }}>
                      TheAudioDB API Key (Default public tier: 2):
                    </label>
                    <input
                      className="aqua-input"
                      style={{ width: '100%' }}
                      value={form.theAudioDbApiKey || '2'}
                      onChange={(e) => updateField('theAudioDbApiKey', e.target.value)}
                    />
                  </div>
                </div>
              </div>

              {/* Priority 6 & 7: Plex, Audiobookshelf, Chaptarr, Immich */}
              <div className="epod-capacity-card">
                <strong style={{ display: 'block', marginBottom: 8 }}>
                  Homelab Media Servers (Plex, Audiobookshelf, Chaptarr, Immich)
                </strong>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                  <div>
                    <label style={{ display: 'block', fontSize: 11, fontWeight: 600 }}>Plex Server URL:</label>
                    <input
                      className="aqua-input"
                      style={{ width: '100%' }}
                      placeholder="http://192.168.1.50:32400"
                      value={form.plexUrl || ''}
                      onChange={(e) => updateField('plexUrl', e.target.value)}
                    />
                  </div>
                  <div>
                    <label style={{ display: 'block', fontSize: 11, fontWeight: 600 }}>Plex X-Plex-Token:</label>
                    <input
                      type="password"
                      className="aqua-input"
                      style={{ width: '100%' }}
                      value={form.plexToken || ''}
                      onChange={(e) => updateField('plexToken', e.target.value)}
                    />
                  </div>
                  <div>
                    <label style={{ display: 'block', fontSize: 11, fontWeight: 600 }}>Audiobookshelf URL:</label>
                    <input
                      className="aqua-input"
                      style={{ width: '100%' }}
                      placeholder="http://192.168.1.50:13378"
                      value={form.audiobookshelfUrl || ''}
                      onChange={(e) => updateField('audiobookshelfUrl', e.target.value)}
                    />
                  </div>
                  <div>
                    <label style={{ display: 'block', fontSize: 11, fontWeight: 600 }}>Audiobookshelf API Token:</label>
                    <input
                      type="password"
                      className="aqua-input"
                      style={{ width: '100%' }}
                      value={form.audiobookshelfToken || ''}
                      onChange={(e) => updateField('audiobookshelfToken', e.target.value)}
                    />
                  </div>
                  <div>
                    <label style={{ display: 'block', fontSize: 11, fontWeight: 600 }}>Chaptarr / eBooks URL:</label>
                    <input
                      className="aqua-input"
                      style={{ width: '100%' }}
                      placeholder="http://192.168.1.50:8787"
                      value={form.chaptarrUrl || ''}
                      onChange={(e) => updateField('chaptarrUrl', e.target.value)}
                    />
                  </div>
                  <div>
                    <label style={{ display: 'block', fontSize: 11, fontWeight: 600 }}>Chaptarr API Key:</label>
                    <input
                      type="password"
                      className="aqua-input"
                      style={{ width: '100%' }}
                      value={form.chaptarrApiKey || ''}
                      onChange={(e) => updateField('chaptarrApiKey', e.target.value)}
                    />
                  </div>
                  <div>
                    <label style={{ display: 'block', fontSize: 11, fontWeight: 600 }}>Immich Server URL:</label>
                    <input
                      className="aqua-input"
                      style={{ width: '100%' }}
                      placeholder="http://192.168.1.50:2283"
                      value={form.immichUrl || ''}
                      onChange={(e) => updateField('immichUrl', e.target.value)}
                    />
                  </div>
                  <div>
                    <label style={{ display: 'block', fontSize: 11, fontWeight: 600 }}>Immich API Key:</label>
                    <input
                      type="password"
                      className="aqua-input"
                      style={{ width: '100%' }}
                      value={form.immichApiKey || ''}
                      onChange={(e) => updateField('immichApiKey', e.target.value)}
                    />
                  </div>
                </div>
              </div>
            </>
          )}

          {tab === 'about' && <FossCreditsContent />}

          {tab === 'devices' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <div className="epod-capacity-card">
                <strong style={{ display: 'block', marginBottom: 8 }}>
                  Sidebar Presence & Device Disconnect Behavior
                </strong>
                <p style={{ margin: '0 0 12px', fontSize: 11.5, color: '#475569', lineHeight: 1.5 }}>
                  By default, rTunes hides portable ePod and MTP devices from the sidebar as soon as they are unplugged or safely ejected, while keeping their UUID, sync rules, and playlists saved in the database.
                </p>
                <label
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    fontSize: 12,
                    fontWeight: 600,
                    color: '#1e293b',
                    cursor: 'pointer',
                  }}
                >
                  <input
                    type="checkbox"
                    checked={Boolean(form.showOfflineDevices)}
                    onChange={(e) => updateField('showOfflineDevices', e.target.checked)}
                  />
                  <span>Keep disconnected devices visible in sidebar</span>
                </label>
                <div style={{ marginTop: 6, marginLeft: 22, fontSize: 11, color: '#64748b' }}>
                  When enabled, offline devices remain listed with a dimmed icon and a <strong>Not Connected</strong> status badge.
                </div>

                <div style={{ marginTop: 14, paddingTop: 12, borderTop: '1px solid #e2e8f0' }}>
                  <label
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      fontSize: 12,
                      fontWeight: 600,
                      color: '#1e293b',
                      cursor: 'pointer',
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={autoOpenOnMtp}
                      onChange={async (e) => {
                        const next = e.target.checked;
                        const res = await invokeRpc<{ ok: boolean; message: string }>(
                          'devices:setAutoOpenOnMtp',
                          next
                        );
                        if (res.ok) setAutoOpenOnMtp(next);
                        setStatusBanner(res.message);
                      }}
                    />
                    <span>Auto-open RetroTunes when an MTP device is connected (Windows AutoPlay)</span>
                  </label>
                  <div style={{ marginTop: 6, marginLeft: 22, fontSize: 11, color: '#64748b' }}>
                    Registers RetroTunes as a Windows AutoPlay handler for MTP media players so connecting your ePod/Y2 can launch rTunes automatically.
                  </div>
                </div>
              </div>

              <div className="epod-capacity-card">
                <strong style={{ display: 'block', marginBottom: 8 }}>
                  Known &amp; Registered Devices ({registeredDevices.length})
                </strong>
                <p style={{ margin: '0 0 10px', fontSize: 11.5, color: '#475569' }}>
                  Manage saved ePod / MTP device profiles stored in SQLite. Deleting a device removes its saved sync rules and play-state history from this PC (it does not erase media on the device).
                </p>
                {registeredDevices.length === 0 ? (
                  <div style={{ fontSize: 11.5, color: '#64748b', fontStyle: 'italic' }}>
                    No registered devices found.
                  </div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {registeredDevices.map((dev) => (
                      <div
                        key={dev.uuid}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          padding: '8px 10px',
                          borderRadius: 6,
                          border: '1px solid #cbd5e1',
                          background: '#f8fafc',
                        }}
                      >
                        <div style={{ minWidth: 0 }}>
                          <div style={{ fontWeight: 700, fontSize: 12, color: '#0f172a' }}>
                            {dev.name}{' '}
                            <span style={{ fontWeight: 500, fontSize: 10.5, color: '#64748b' }}>
                              ({(dev.transport_mode || dev.profile?.transportMode || 'ums').toUpperCase()})
                            </span>
                          </div>
                          <div style={{ fontSize: 10.5, color: '#64748b', fontFamily: 'var(--font-mono)' }}>
                            UUID: {dev.uuid}{' '}
                            {(dev.mtp_serial || dev.profile?.mtpSerial)
                              ? `• Serial: ${dev.mtp_serial || dev.profile?.mtpSerial}`
                              : ''}
                          </div>
                        </div>
                        <button
                          className="aqua-btn"
                          style={{ color: '#b91c1c', borderColor: '#fca5a5' }}
                          onClick={async () => {
                            if (
                              !window.confirm(
                                `Forget "${dev.name}" (${dev.uuid}) from RetroTunes? This removes its saved profile and play-state history from SQLite.`
                              )
                            ) {
                              return;
                            }
                            const res = await invokeRpc<{ ok: boolean; message: string }>(
                              'devices:delete',
                              dev.uuid
                            );
                            if (res.ok) {
                              const next = await invokeRpc<any[]>('devices:list');
                              setRegisteredDevices(next);
                              onDevicesChanged?.();
                            }
                            setStatusBanner(res.message);
                          }}
                        >
                          Delete / Forget
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}

          {tab === 'genreMap' && <GenreMapTab />}

          {tab === 'actions' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <div className="epod-capacity-card">
                <strong style={{ display: 'block', marginBottom: 8 }}>
                  LCD Display Click Behavior
                </strong>
                <label style={{ display: 'block', fontSize: 11.5, fontWeight: 600, marginBottom: 4 }}>
                  When clicking the Artist name in the top LCD display:
                </label>
                <select
                  className="aqua-input"
                  style={{ width: '100%' }}
                  value={form.lcdArtistClickBehavior || 'jump'}
                  onChange={(e) =>
                    updateField('lcdArtistClickBehavior', e.target.value as 'jump' | 'filter')
                  }
                >
                  <option value="jump">Jump to Artist's First Song in Library (Default)</option>
                  <option value="filter">Auto-Filter Library View to Artist</option>
                </select>
              </div>

              <div className="epod-capacity-card">
                <strong style={{ display: 'block', marginBottom: 8 }}>
                  Library, Playlists &amp; App Actions
                </strong>
                <p style={{ margin: '0 0 12px', fontSize: 11.5, color: '#475569' }}>
                  Quick access to RetroTunes library, playlist, diagnostics, and help commands.
                </p>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(210px, 1fr))', gap: 10 }}>
                  {!(isServerContext && perms.mediaUpload === 0) && (
                    <button className="aqua-btn primary" onClick={() => onOpenUpload?.()}>
                      Import / Upload Media...
                    </button>
                  )}
                  {!(isServerContext && perms.rescanLibrary === 0) && (
                    <button
                      className="aqua-btn"
                      onClick={() => {
                        onRescanLibrary?.();
                        setStatusBanner('Background library scan triggered.');
                      }}
                    >
                      Rescan Library Now
                    </button>
                  )}
                  {!(isServerContext && perms.rebuildDb === 0) && (
                    <button
                      className="aqua-btn"
                      style={{ color: '#b91c1c' }}
                      onClick={async () => {
                        if (
                          !window.confirm(
                            'Rebuild Media Database? This clears all indexed tracks, videos, books, photos, and FTS5 caches, then re-scans your configured folders from scratch. Settings, shares, devices, and playlists are preserved.'
                          )
                        ) {
                          return;
                        }
                        await invokeRpc('db:rebuild');
                        setStatusBanner('Database rebuilt and full background re-scan started.');
                      }}
                    >
                      Rebuild Media Database...
                    </button>
                  )}
                  {!(isServerContext && perms.playlists === 0) && (
                    <>
                      <button className="aqua-btn" onClick={() => onOpenNewPlaylist?.()}>
                        New Playlist...
                      </button>
                      <button className="aqua-btn" onClick={() => onOpenNewSmartPlaylist?.()}>
                        New Smart Playlist...
                      </button>
                    </>
                  )}
                  {!(isServerContext && perms.viewServerLogs === 0) && (
                    <button className="aqua-btn" onClick={() => onOpenDiagnostics?.()}>
                      Open Live Logs &amp; Diagnostics
                    </button>
                  )}
                  <button className="aqua-btn" onClick={() => onOpenAbout?.()}>
                    About RetroTunes &amp; Credits
                  </button>
                  <button className="aqua-btn" onClick={() => window.location.reload()}>
                    Reload Interface
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div
          style={{
            padding: '10px 18px',
            borderTop: '1px solid #9da6b4',
            background: '#dfe4ec',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
          }}
        >
          <div style={{ fontSize: 11, color: '#15803d', fontWeight: 600 }}>
            {statusBanner && (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                <CheckCircle2 size={14} /> {statusBanner}
              </span>
            )}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="aqua-btn" onClick={onClose}>
              Cancel
            </button>
            <button className="aqua-btn primary" onClick={handleSave} disabled={saving}>
              {saving ? 'Saving...' : 'Save Preferences'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
