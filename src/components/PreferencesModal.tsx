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
} from 'lucide-react';
import { AppSettings, AuthState, ConnectionTestResult, NetworkShareRow } from '../types';
import { invokeRpc, isDevMode } from '../bridge';
import { FossCreditsContent } from './AboutCreditsModal';

const COMING_SOON_TOOLTIP =
  'Coming soon — rTunes is currently focused on direct network shares, local media, and USB/MTP ePod syncing.';

interface PreferencesModalProps {
  settings: AppSettings;
  authState: AuthState;
  onClose: () => void;
  onSaved: (updated: AppSettings) => void;
  onAuthChanged: (auth: AuthState) => void;
}

export const PreferencesModal: React.FC<PreferencesModalProps> = ({
  settings,
  authState,
  onClose,
  onSaved,
  onAuthChanged,
}) => {
  const [tab, setTab] = useState<'paths' | 'shares' | 'devices' | 'cache' | 'auth' | 'apis' | 'about'>('paths');
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
    host: '192.168.1.100',
    base_path: '/Media',
    username: '',
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

  const isDev = isDevMode();
  const [autoOpenOnMtp, setAutoOpenOnMtp] = React.useState(false);

  React.useEffect(() => {
    void loadShares();
    invokeRpc<boolean>('devices:getAutoOpenOnMtp')
      .then((v) => setAutoOpenOnMtp(Boolean(v)))
      .catch(() => {});
  }, []);

  const updateField = <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }));
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
      onSaved(updated);
      setStatusBanner('Preferences saved to SQLite & macOS Keychain.');
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
        style={{ width: 780, maxWidth: '94vw' }}
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
            gap: 12,
            background: 'linear-gradient(180deg, #d7dde6 0%, #c1c9d6 100%)',
            borderBottom: '1px solid #8a94a4',
            padding: '8px 16px',
          }}
        >
          {[
            { id: 'paths', label: 'Paths & Backend', icon: <FolderOpen size={18} /> },
            { id: 'shares', label: 'NFS / SMB Shares', icon: <HardDrive size={18} /> },
            { id: 'devices', label: 'Devices', icon: <Usb size={18} /> },
            { id: 'cache', label: 'Cache & Transcoder', icon: <HardDrive size={18} /> },
            { id: 'auth', label: isDev ? 'Authentik SSO [DEV]' : 'Authentik SSO', icon: <ShieldCheck size={18} /> },
            { id: 'apis', label: 'Store & API Keys', icon: <KeyRound size={18} /> },
            { id: 'about', label: 'About & Credits', icon: <Info size={18} /> },
          ].map((item) => (
            <button
              key={item.id}
              onClick={() => setTab(item.id as any)}
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
              {/* Priority 3: Backend Architecture Mode (Standalone vs Remote Docker Server) */}
              <div className="epod-capacity-card">
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                  <strong>
                    Backend Architecture Mode (MediaDatabaseProvider & FileTransportProvider)
                  </strong>
                  {isDev ? (
                    <span className="aqua-dev-badge">[DEV PREVIEW]</span>
                  ) : (
                    <span className="aqua-coming-soon-pill" title={COMING_SOON_TOOLTIP}>
                      rTunes-Server: Coming Soon
                    </span>
                  )}
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                  <div>
                    <label style={{ display: 'block', fontSize: 11, fontWeight: 600, marginBottom: 4 }}>
                      Active Provider Mode:
                    </label>
                    <select
                      className="aqua-input"
                      style={{ width: '100%' }}
                      value={isDev ? form.backendMode || 'standalone' : 'standalone'}
                      onChange={(e) => updateField('backendMode', e.target.value as any)}
                    >
                      <option value="standalone">
                        Standalone / Direct Share Mode (Local SQLite + Mounted NFS/SMB)
                      </option>
                      <option value="docker_server" disabled={!isDev}>
                        {isDev
                          ? 'Remote Docker Server Mode (rTunes-Server + Authentik OIDC JWT) [DEV PREVIEW]'
                          : 'Remote Docker Server Mode (rTunes-Server) — Coming Soon'}
                      </option>
                    </select>
                  </div>
                  <div className={!isDev ? 'aqua-gated-disabled' : ''} title={!isDev ? COMING_SOON_TOOLTIP : undefined}>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, fontWeight: 600, marginBottom: 4 }}>
                      <span>rTunes-Server Companion URL:</span>
                      {!isDev && <span className="aqua-coming-soon-pill">Coming Soon</span>}
                    </label>
                    <input
                      className="aqua-input"
                      style={{ width: '100%' }}
                      disabled={!isDev}
                      placeholder="https://rtunes-server.yourdomain.com"
                      value={form.dockerServerUrl || ''}
                      onChange={(e) => updateField('dockerServerUrl', e.target.value)}
                    />
                  </div>
                </div>
              </div>

              <div className="epod-capacity-card">
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                  <strong>Master Media Share & Local Directory Paths</strong>
                  <button className="aqua-btn" onClick={() => runTest('paths')}>
                    <Activity size={13} /> Test Directory Access
                  </button>
                </div>

                {[
                  {
                    key: 'nfsSharePath' as const,
                    label: 'NFS / SMB Master Share Root:',
                    placeholder: '/Volumes/MediaShare or /mnt/nfs/media',
                  },
                  {
                    key: 'musicRootPath' as const,
                    label: 'Music Library Root (FLAC/MP3/M4A):',
                    placeholder: '/Volumes/MediaShare/Music',
                  },
                  {
                    key: 'videoRootPath' as const,
                    label: 'Movies Library Root:',
                    placeholder: '/Volumes/MediaShare/Movies',
                  },
                  {
                    key: 'tvRootPath' as const,
                    label: 'TV Shows Library Root:',
                    placeholder: '/Volumes/MediaShare/TV Shows',
                  },
                  {
                    key: 'musicVideosRootPath' as const,
                    label: 'Music Videos Library Root:',
                    placeholder: '/Volumes/MediaShare/Music Videos',
                  },
                  {
                    key: 'booksRootPath' as const,
                    label: 'Books (eBooks) Library Root (EPUB/PDF/CBZ):',
                    placeholder: '/Volumes/MediaShare/Books',
                  },
                  {
                    key: 'audiobooksRootPath' as const,
                    label: 'Audiobooks Library Root (M4B/MP3):',
                    placeholder: '/Volumes/MediaShare/Audiobooks',
                  },
                  {
                    key: 'photosRootPath' as const,
                    label: 'Photos / Immich Library Root:',
                    placeholder: '/Volumes/MediaShare/Photos',
                  },
                  {
                    key: 'localCachePath' as const,
                    label: 'Local Pre-Cache Directory:',
                    placeholder: '~/Library/Caches/RetroTunes',
                  },
                ].map((row) => (
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
                        SMB Password (macOS Keychain):
                      </label>
                      <input
                        type="password"
                        className="aqua-input"
                        style={{ width: '100%' }}
                        placeholder="Stored securely in macOS Keychain"
                        value={shareDraft.password}
                        onChange={(e) => setShareDraft((p) => ({ ...p, password: e.target.value }))}
                      />
                    </div>
                  </div>
                )}

                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                  <strong style={{ fontSize: 11.5 }}>Per-Media-Type Subfolder Mapping:</strong>
                  <button
                    className="aqua-btn"
                    style={{ fontSize: 11 }}
                    onClick={async () => {
                      const detected = await invokeRpc<Record<string, string>>(
                        'shares:autoDetect',
                        shareDraft.base_path.startsWith('/') && shareDraft.base_path.includes('Volumes')
                          ? shareDraft.base_path
                          : form.nfsSharePath || shareDraft.base_path
                      );
                      setShareDraft((p) => ({
                        ...p,
                        folder_map: { ...p.folder_map, ...detected },
                      }));
                      setStatusBanner('Auto-detected media subdirectories from share root.');
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
                    No managed NFS/SMB shares saved yet. Add one above to mount automatically into{' '}
                    <code>~/Library/Application Support/RetroTunes/mounts/</code>.
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
              <strong style={{ display: 'block', marginBottom: 12 }}>
                Local SSD Pre-Cache Quota & Hardware Acceleration (Section 3)
              </strong>

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
                  <option value="auto">Auto-Detect (VideoToolbox / NVENC / QSV)</option>
                  <option value="vt_h264">macOS ARM64 VideoToolbox (h264_videotoolbox)</option>
                  <option value="nvenc">NVIDIA NVENC (h264_nvenc)</option>
                  <option value="qsv">Intel QuickSync (h264_qsv)</option>
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
            <div
              className={`epod-capacity-card ${!isDev ? 'aqua-gated-disabled' : ''}`}
              title={!isDev ? COMING_SOON_TOOLTIP : undefined}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <strong>Authentik OIDC / OAuth2 PKCE Single Sign-On</strong>
                  {isDev ? (
                    <span className="aqua-dev-badge">[DEV PREVIEW]</span>
                  ) : (
                    <span className="aqua-coming-soon-pill" title={COMING_SOON_TOOLTIP}>
                      Coming Soon
                    </span>
                  )}
                </div>
                <button className="aqua-btn" disabled={!isDev} onClick={() => runTest('authentik')}>
                  <Activity size={13} /> Test OIDC Discovery
                </button>
              </div>

              {!isDev && (
                <div
                  style={{
                    marginBottom: 12,
                    padding: '8px 10px',
                    borderRadius: 6,
                    background: '#f1f5f9',
                    border: '1px solid #cbd5e1',
                    fontSize: 11,
                    color: '#475569',
                  }}
                >
                  {COMING_SOON_TOOLTIP}
                </div>
              )}

              <div style={{ marginBottom: 12 }}>
                <label style={{ display: 'block', fontWeight: 600, marginBottom: 4 }}>Authentication Mode:</label>
                <select
                  className="aqua-input"
                  style={{ width: '100%' }}
                  disabled={!isDev}
                  value={isDev ? form.authMode : 'standalone'}
                  onChange={(e) => updateField('authMode', e.target.value as any)}
                >
                  <option value="standalone">Standalone Mode (Direct *arr & NFS/SMB connections)</option>
                  <option value="authentik" disabled={!isDev}>
                    Authentik SSO + Homelab Gateway Mode (OAuth2 PKCE)
                  </option>
                </select>
              </div>

              <div style={{ marginBottom: 10 }}>
                <label style={{ display: 'block', fontWeight: 600, marginBottom: 4 }}>
                  Authentik OIDC Issuer URL:
                </label>
                <input
                  className="aqua-input"
                  style={{ width: '100%' }}
                  disabled={!isDev}
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
                    disabled={!isDev}
                    value={form.authentikClientId}
                    onChange={(e) => updateField('authentikClientId', e.target.value)}
                  />
                </div>
                <div>
                  <label style={{ display: 'block', fontWeight: 600, marginBottom: 4 }}>Loopback Redirect URI:</label>
                  <input
                    className="aqua-input"
                    style={{ width: '100%' }}
                    disabled={!isDev}
                    value={form.authentikRedirectUri}
                    onChange={(e) => updateField('authentikRedirectUri', e.target.value)}
                  />
                </div>
              </div>

              <div style={{ marginBottom: 12 }}>
                <label style={{ display: 'block', fontWeight: 600, marginBottom: 4 }}>
                  Companion Homelab Gateway URL (FastAPI/Go Proxy for Non-Admin Store Requests):
                </label>
                <input
                  className="aqua-input"
                  style={{ width: '100%' }}
                  disabled={!isDev}
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
                  {authState.authenticated && authState.user && isDev ? (
                    <span style={{ color: '#15803d', fontWeight: 700 }}>
                      Signed in via SSO as {authState.user.name} (@{authState.user.username})
                    </span>
                  ) : (
                    <span style={{ color: '#475569' }}>
                      {isDev
                        ? 'Not currently signed in to Authentik SSO.'
                        : 'SSO is disabled in production builds (Standalone mode active).'}
                    </span>
                  )}
                </div>
                {authState.authenticated && isDev ? (
                  <button
                    className="aqua-btn"
                    disabled={!isDev}
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
                    disabled={!isDev}
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
            </div>
          )}

          {tab === 'apis' && (
            <>
              {/* ListenBrainz */}
              <div className="epod-capacity-card">
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                  <strong>ListenBrainz (Popularity Normalization & Two-Way Loved Feedback)</strong>
                  <button className="aqua-btn" onClick={() => runTest('listenbrainz')}>
                    <Activity size={13} /> Test Token
                  </button>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 10 }}>
                  <div>
                    <label style={{ display: 'block', fontSize: 11, fontWeight: 600, marginBottom: 3 }}>
                      User Token (Saved in macOS Keychain):
                    </label>
                    <input
                      type="password"
                      className="aqua-input"
                      style={{ width: '100%' }}
                      placeholder="UUID Token from listenbrainz.org/settings"
                      value={form.listenbrainzToken}
                      onChange={(e) => updateField('listenbrainzToken', e.target.value)}
                    />
                  </div>
                  <div>
                    <label style={{ display: 'block', fontSize: 11, fontWeight: 600, marginBottom: 3 }}>
                      Username:
                    </label>
                    <input
                      className="aqua-input"
                      style={{ width: '100%' }}
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
