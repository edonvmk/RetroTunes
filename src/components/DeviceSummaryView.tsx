import React, { useMemo, useState } from 'react';
import {
  Disc,
  RefreshCw,
  LogOut,
  CheckCircle2,
  Music,
  Film,
  Tv,
  Sparkles,
  FileCode,
  ChevronDown,
  ChevronRight,
} from 'lucide-react';
import {
  DeviceInfo,
  DeviceProfile,
  PlaylistRow,
  SyncProgress,
  VideoRow,
} from '../types';
import { formatBytes, invokeRpc } from '../bridge';

interface DeviceSummaryViewProps {
  device: DeviceInfo;
  playlists: PlaylistRow[];
  videos: VideoRow[];
  syncProgress: SyncProgress;
  onDeviceUpdated: (devices: DeviceInfo[]) => void;
  onEjected: () => void;
}

export const DeviceSummaryView: React.FC<DeviceSummaryViewProps> = ({
  device,
  playlists,
  videos,
  syncProgress,
  onDeviceUpdated,
  onEjected,
}) => {
  const [profile, setProfile] = useState<DeviceProfile>({ ...device.profile });
  const [nameDraft, setNameDraft] = useState<string>(device.profile.name);
  const [editingName, setEditingName] = useState(false);
  const [activeTab, setActiveTab] = useState<'summary' | 'music' | 'tv' | 'movies' | 'photos' | 'manifest'>('summary');
  const [expandedShow, setExpandedShow] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);

  React.useEffect(() => {
    setProfile({ ...device.profile });
    setNameDraft(device.profile.name);
  }, [device.uuid, device.profile]);

  const handleMigrateToMtp = async (targetStorageId?: string) => {
    const res = await invokeRpc<{ ok: boolean; message: string }>(
      'devices:migrateToMtp',
      device.uuid,
      targetStorageId
    );
    setStatusMessage(res.message);
    const updatedList = await invokeRpc<DeviceInfo[]>('devices:list');
    onDeviceUpdated(updatedList);
  };

  const movieVideos = useMemo(() => videos.filter((v) => v.type === 'movie'), [videos]);
  const tvShowsTree = useMemo(() => {
    const map = new Map<string, Map<number, VideoRow[]>>();
    for (const v of videos) {
      if (v.type !== 'tv') continue;
      const showName = (v.show_name || 'Unknown Show').replace(/^Star Wars\s*-\s*/i, '').trim();
      if (!map.has(showName)) map.set(showName, new Map());
      const seasonsMap = map.get(showName)!;
      const seasonNum = v.season !== null && v.season !== undefined ? v.season : 1;
      if (!seasonsMap.has(seasonNum)) seasonsMap.set(seasonNum, []);
      seasonsMap.get(seasonNum)!.push(v);
    }
    return Array.from(map.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([showName, seasonsMap]) => {
        const seasons = Array.from(seasonsMap.entries())
          .sort((a, b) => a[0] - b[0])
          .map(([seasonNum, eps]) => ({
            seasonNum,
            episodes: eps.sort((a, b) => (a.episode || 0) - (b.episode || 0)),
          }));
        const allEpisodeIds = seasons.flatMap((s) => s.episodes.map((e) => e.id));
        return { showName, seasons, allEpisodeIds };
      });
  }, [videos]);

  const storage = device.storage;
  const total = Math.max(1, storage.totalBytes);
  const audioPct = Math.max(storage.audioBytes > 0 ? 2 : 0, (storage.audioBytes / total) * 100);
  const videoPct = Math.max(storage.videoBytes > 0 ? 2 : 0, (storage.videoBytes / total) * 100);
  const otherPct = Math.max(storage.otherBytes > 0 ? 2 : 0, (storage.otherBytes / total) * 100);

  const saveProfileChanges = async (nextProfile: DeviceProfile, customMsg?: string) => {
    setProfile(nextProfile);
    const updatedList = await invokeRpc<DeviceInfo[]>('devices:updateProfile', device.uuid, nextProfile);
    onDeviceUpdated(updatedList);
    setStatusMessage(customMsg || 'Updated .retrotunes_device.json manifest on device.');
    setTimeout(() => setStatusMessage(null), 3500);
  };

  const handleRenameDevice = async () => {
    const clean = nameDraft.trim();
    if (!clean) return;
    setEditingName(false);
    await saveProfileChanges(
      { ...profile, name: clean },
      `Renamed ePod & mounted drive volume to "${clean}".`
    );
  };

  const handleRunTwoWaySync = async () => {
    setSyncing(true);
    setStatusMessage('Background ePod sync started — you can continue browsing while syncing.');
    try {
      await invokeRpc<SyncProgress>('devices:sync', device.uuid);
      const updatedList = await invokeRpc<DeviceInfo[]>('devices:list');
      onDeviceUpdated(updatedList);
    } catch (err) {
      setStatusMessage(`Sync Error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSyncing(false);
    }
  };

  const handleCancelSync = async () => {
    await invokeRpc('devices:cancelSync');
    setStatusMessage('Stopping background sync after current file finishes...');
  };

  const handleEject = async () => {
    const res = await invokeRpc<{ ok: boolean; message: string }>('devices:eject', device.uuid);
    setStatusMessage(res.message);
    if (res.ok) {
      setTimeout(() => onEjected(), 1000);
    }
  };

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', background: '#e5eaf2', overflow: 'hidden' }}>
      {/* Top ePod Sub-Navigation Bar */}
      <div
        style={{
          height: 36,
          background: 'linear-gradient(180deg, #eef1f6 0%, #cfd6e2 100%)',
          borderBottom: '1px solid #919baa',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 6,
        }}
      >
        {[
          { id: 'summary', label: 'Summary' },
          { id: 'music', label: 'Music & Playlists' },
          { id: 'tv', label: `TV Shows (${tvShowsTree.length})` },
          { id: 'movies', label: `Movies (${movieVideos.length})` },
          { id: 'photos', label: 'Photos (Pictures)' },
          { id: 'manifest', label: '.retrotunes_device.json' },
        ].map((t) => (
          <button
            key={t.id}
            className={`segmented-btn ${activeTab === t.id ? 'active' : ''}`}
            style={{ borderRadius: 12, padding: '3px 14px', border: '1px solid #6e7785' }}
            onClick={() => setActiveTab(t.id as any)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Main Content Scroll */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '20px 28px', display: 'flex', flexDirection: 'column', gap: 18 }}>
        {activeTab === 'summary' && (
          <>
            {/* Classic ePod Summary Hero Box */}
            <div className="epod-capacity-card" style={{ display: 'flex', gap: 24, alignItems: 'center' }}>
              <div
                style={{
                  width: 96,
                  height: 140,
                  borderRadius: 12,
                  background: 'linear-gradient(135deg, #f1f5f9 0%, #cbd5e1 50%, #94a3b8 100%)',
                  border: '2px solid #475569',
                  boxShadow: '0 6px 14px rgba(0,0,0,0.22), inset 0 1px 1px #fff',
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: 8,
                  flexShrink: 0,
                }}
              >
                {/* ePod 4:3 screen */}
                <div
                  style={{
                    width: '100%',
                    height: 52,
                    background: 'linear-gradient(180deg, #1e3a8a 0%, #0f172a 100%)',
                    borderRadius: 4,
                    border: '1px solid #334155',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    color: '#93c5fd',
                    fontSize: 9,
                    fontWeight: 700,
                    textAlign: 'center',
                  }}
                >
                  ePod Y2
                  <br />
                  480×360
                </div>
                {/* Click wheel */}
                <div
                  style={{
                    width: 54,
                    height: 54,
                    borderRadius: '50%',
                    background: '#ffffff',
                    border: '1px solid #94a3b8',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  <div
                    style={{
                      width: 20,
                      height: 20,
                      borderRadius: '50%',
                      background: '#cbd5e1',
                      border: '1px solid #94a3b8',
                    }}
                  />
                </div>
              </div>

              <div style={{ flex: 1 }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                  <div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                      {editingName ? (
                        <>
                          <input
                            className="aqua-input"
                            style={{ fontSize: 15, fontWeight: 700, width: 220 }}
                            value={nameDraft}
                            onChange={(e) => setNameDraft(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') void handleRenameDevice();
                              if (e.key === 'Escape') {
                                setNameDraft(profile.name);
                                setEditingName(false);
                              }
                            }}
                            autoFocus
                          />
                          <button className="aqua-btn primary" onClick={() => void handleRenameDevice()}>
                            Save & Rename Drive
                          </button>
                          <button
                            className="aqua-btn"
                            onClick={() => {
                              setNameDraft(profile.name);
                              setEditingName(false);
                            }}
                          >
                            Cancel
                          </button>
                        </>
                      ) : (
                        <>
                          <h2 style={{ margin: 0, fontSize: 18 }}>{profile.name}</h2>
                          <button
                            className="aqua-btn"
                            style={{ fontSize: 10.5, padding: '2px 8px' }}
                            onClick={() => {
                              setNameDraft(profile.name);
                              setEditingName(true);
                            }}
                          >
                            Rename ePod & Drive...
                          </button>
                        </>
                      )}
                    </div>
                    <div style={{ fontSize: 11.5, color: '#475569', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                      <span
                        style={{
                          padding: '1px 7px',
                          borderRadius: 4,
                          fontWeight: 700,
                          fontSize: 10.5,
                          background:
                            device.transport_mode === 'mtp' || profile.transportMode === 'mtp'
                              ? '#dbeafe'
                              : '#f1f5f9',
                          color:
                            device.transport_mode === 'mtp' || profile.transportMode === 'mtp'
                              ? '#1d4ed8'
                              : '#334155',
                          border: '1px solid #93c5fd',
                        }}
                      >
                        {device.transport_mode === 'mtp' || profile.transportMode === 'mtp'
                          ? 'MTP (Y2 Reborn USB)'
                          : 'UMS (/Volumes)'}
                      </span>
                      <span>
                        Path: <code>{device.mount_path}</code> • UUID: <code>{device.uuid}</code>
                      </span>
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    {device.mtp_connected &&
                      (device.transport_mode !== 'mtp' || !storage.mounted) && (
                        <button
                          className="aqua-btn primary"
                          onClick={() => void handleMigrateToMtp(profile.selectedStorageId)}
                          title="Bind this ePod profile to the currently connected Y2 Reborn MTP device without losing any settings"
                        >
                          Link / Migrate to Connected MTP Device
                        </button>
                      )}
                    <button className="aqua-btn" onClick={handleEject}>
                      <LogOut size={13} /> Eject Device
                    </button>
                    {syncProgress.running ? (
                      <button className="aqua-btn" onClick={handleCancelSync} style={{ color: '#b91c1c' }}>
                        Stop Sync
                      </button>
                    ) : null}
                    <button
                      className="aqua-btn primary"
                      onClick={handleRunTwoWaySync}
                      disabled={syncing || syncProgress.running}
                    >
                      <RefreshCw size={13} />
                      {syncProgress.running ? 'Syncing in Background...' : 'Sync ePod Now'}
                    </button>
                  </div>
                </div>

                {/* USB MTP Interface Lock Warning */}
                {device.mtp_busy_warning && (
                  <div
                    style={{
                      marginTop: 10,
                      padding: '8px 12px',
                      background: '#fef2f2',
                      border: '1px solid #f87171',
                      borderRadius: 6,
                      color: '#991b1b',
                      fontSize: 11.5,
                      fontWeight: 600,
                    }}
                  >
                    ⚠️ USB MTP Interface Locked: {device.mtp_busy_warning}
                  </div>
                )}

                {/* MTP Storage Selector (Internal Storage vs. MicroSD Card) */}
                {device.mtp_storages && device.mtp_storages.length > 0 && (
                  <div
                    style={{
                      marginTop: 12,
                      padding: '8px 12px',
                      background: '#f8fafc',
                      border: '1px solid #cbd5e1',
                      borderRadius: 6,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: 12,
                    }}
                  >
                    <span style={{ fontSize: 11.5, fontWeight: 700, color: '#1e3a8a' }}>
                      Target MTP Storage Pool (Internal vs. MicroSD):
                    </span>
                    <div style={{ display: 'flex', gap: 6 }}>
                      {device.mtp_storages.map((pool) => {
                        const isSelected =
                          (profile.selectedStorageId || '0xffff0002') === pool.storageId;
                        return (
                          <button
                            key={pool.storageId}
                            className={`aqua-btn ${isSelected ? 'primary' : ''}`}
                            style={{ fontSize: 11, padding: '3px 10px' }}
                            onClick={() =>
                              void saveProfileChanges(
                                {
                                  ...profile,
                                  transportMode: 'mtp',
                                  selectedStorageId: pool.storageId,
                                },
                                `Switched active MTP storage pool to ${pool.description} (${formatBytes(pool.freeSpaceInBytes)} free).`
                              )
                            }
                          >
                            {pool.description} ({formatBytes(pool.freeSpaceInBytes)} free /{' '}
                            {formatBytes(pool.maxCapacity)})
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}

                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(3, 1fr)',
                    gap: 10,
                    marginTop: 14,
                    paddingTop: 12,
                    borderTop: '1px solid #cbd5e1',
                    fontSize: 11.5,
                  }}
                >
                  <div>
                    <strong>Device Preset:</strong> {profile.deviceType.toUpperCase()}
                  </div>
                  <div>
                    <strong>Video Target:</strong> {profile.videoResolution} @ {profile.videoFps}fps
                  </div>
                  <div>
                    <strong>Audio Mode:</strong>{' '}
                    {profile.audioPassthrough
                      ? 'Original Format Passthrough'
                      : `${(profile.audioTranscodeFormat || 'mp3').toUpperCase()} @ ${profile.audioBitrateKbps || 256}kbps`}
                  </div>
                  <div>
                    <strong>Status:</strong>{' '}
                    <span style={{ color: storage.mounted ? '#15803d' : '#b91c1c', fontWeight: 700 }}>
                      {storage.mounted ? 'Mounted & Ready' : 'Disconnected'}
                    </span>
                  </div>
                  <div>
                    <strong>Last Connected:</strong> {device.last_connected || 'Just now'}
                  </div>
                  <div>
                    <strong>Last Synced:</strong> {device.last_synced || 'Never'}
                  </div>
                </div>
              </div>
            </div>

            {/* Music & Video Transcode Settings Box */}
            <div className="epod-capacity-card">
              <strong style={{ display: 'block', marginBottom: 10 }}>
                ePod Music & Video Transcode Settings
              </strong>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
                <div>
                  <label style={{ display: 'block', fontSize: 11, fontWeight: 600, marginBottom: 4 }}>
                    Music Audio Conversion Mode:
                  </label>
                  <select
                    className="aqua-input"
                    style={{ width: '100%', marginBottom: 8 }}
                    value={
                      profile.audioPassthrough
                        ? 'passthrough'
                        : profile.audioTranscodeFormat === 'aac'
                        ? 'aac'
                        : 'mp3'
                    }
                    onChange={(e) => {
                      const val = e.target.value;
                      if (val === 'passthrough') {
                        void saveProfileChanges({
                          ...profile,
                          audioPassthrough: true,
                        });
                      } else {
                        void saveProfileChanges({
                          ...profile,
                          audioPassthrough: false,
                          audioTranscodeFormat: val as 'mp3' | 'aac',
                          audioBitrateKbps: profile.audioBitrateKbps || 256,
                        });
                      }
                    }}
                  >
                    <option value="passthrough">
                      Passthrough Original Files (FLAC / MP3 / M4A Direct Copy)
                    </option>
                    <option value="mp3">Convert Music to MP3 (libmp3lame) on Sync</option>
                    <option value="aac">Convert Music to AAC (.m4a) on Sync</option>
                  </select>

                  {!profile.audioPassthrough && (
                    <div>
                      <label style={{ display: 'block', fontSize: 11, fontWeight: 600, marginBottom: 4 }}>
                        Target Audio Bitrate:
                      </label>
                      <select
                        className="aqua-input"
                        style={{ width: '100%' }}
                        value={profile.audioBitrateKbps || 256}
                        onChange={(e) =>
                          void saveProfileChanges({
                            ...profile,
                            audioBitrateKbps: Number(e.target.value),
                          })
                        }
                      >
                        <option value={128}>128 kbps (Compact Space Saver)</option>
                        <option value={160}>160 kbps (Standard Portable)</option>
                        <option value={192}>192 kbps (High Quality)</option>
                        <option value={256}>256 kbps (Near-Transparent)</option>
                        <option value={320}>320 kbps (Maximum CBR Quality)</option>
                      </select>
                    </div>
                  )}
                </div>

                <div>
                  <label style={{ display: 'block', fontSize: 11, fontWeight: 600, marginBottom: 4 }}>
                    Video Target Resolution & Profile:
                  </label>
                  <select
                    className="aqua-input"
                    style={{ width: '100%', marginBottom: 8 }}
                    value={profile.videoResolution}
                    onChange={(e) =>
                      void saveProfileChanges({
                        ...profile,
                        videoResolution: e.target.value as any,
                      })
                    }
                  >
                    <option value="480x360">480×360 (Innioasis Y2 / ePod 4:3 H.264 + AAC)</option>
                    <option value="320x240">320×240 (Classic QVGA 4:3)</option>
                    <option value="720p">1280×720 (720p HD Portable)</option>
                    <option value="1080p">1920×1080 (1080p Full HD)</option>
                    <option value="source">Original Source Resolution (Direct Copy)</option>
                  </select>

                  <label style={{ display: 'block', fontSize: 11, fontWeight: 600, marginBottom: 4 }}>
                    Video Frame Rate Cap:
                  </label>
                  <select
                    className="aqua-input"
                    style={{ width: '100%' }}
                    value={profile.videoFps}
                    onChange={(e) =>
                      void saveProfileChanges({
                        ...profile,
                        videoFps: Number(e.target.value) as 24 | 30,
                      })
                    }
                  >
                    <option value={30}>30 fps (Smooth Standard)</option>
                    <option value={24}>24 fps (Cinema Film Rate)</option>
                  </select>
                </div>
              </div>

              <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid #cbd5e1' }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontWeight: 600 }}>
                  <input
                    type="checkbox"
                    checked={Boolean(profile.includeTrackNumberInFilename)}
                    onChange={(e) =>
                      void saveProfileChanges({
                        ...profile,
                        includeTrackNumberInFilename: e.target.checked,
                      })
                    }
                  />
                  Include track number prefix in synced song filenames (e.g. <code>01 - Wasteland.mp3</code> instead of{' '}
                  <code>Wasteland.mp3</code>)
                </label>
              </div>
            </div>

            {/* Options Box */}
            <div className="epod-capacity-card">
              <strong style={{ display: 'block', marginBottom: 10 }}>
                Two-Way Synchronization & Hardware Optimization Options (Section 6)
              </strong>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontWeight: 600 }}>
                  <input
                    type="checkbox"
                    checked={profile.downloadLrc}
                    onChange={(e) =>
                      void saveProfileChanges({ ...profile, downloadLrc: e.target.checked })
                    }
                  />
                  Automatically fetch synchronized karaoke lyrics (.lrc) via LRCLIB API and place adjacent to audio files
                </label>

                <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontWeight: 600 }}>
                  <input
                    type="checkbox"
                    checked={profile.sanitizeCoverArt}
                    onChange={(e) =>
                      void saveProfileChanges({ ...profile, sanitizeCoverArt: e.target.checked })
                    }
                  />
                  Downscale & sanitize album cover art to 500×500 baseline JPEG on device copy (eliminates portable DAC UI lag)
                </label>

                <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontWeight: 600 }}>
                  <input
                    type="checkbox"
                    checked={profile.cleanMacMetadata}
                    onChange={(e) =>
                      void saveProfileChanges({ ...profile, cleanMacMetadata: e.target.checked })
                    }
                  />
                  Clean OS metadata files (dot_clean, .DS_Store, and ._* hidden files) automatically on sync & eject
                </label>
              </div>

              <div
                style={{
                  marginTop: 12,
                  padding: '8px 12px',
                  background: '#eff6ff',
                  border: '1px solid #bfdbfe',
                  borderRadius: 6,
                  fontSize: 11,
                  color: '#1e3a8a',
                }}
              >
                <strong>Two-Way Ratings & ListenBrainz Pipeline:</strong> On connection/sync, rTunes parses{' '}
                <code>Favorites.m3u</code>, <code>My Favorite.m3u</code> (Innioasis Y2 stock / Y2Reborn / Y2Player) and{' '}
                <code>.jj_ratings.json</code> (JJ Launcher Classic), marks matching tracks as Loved / 5-Stars in local SQLite,
                pushes <code>score: 1</code> feedback to ListenBrainz, and exports updated <code>Favorites.m3u8</code> back to the device.
              </div>
            </div>
          </>
        )}

        {activeTab === 'music' && (
          <div className="epod-capacity-card">
            <strong style={{ display: 'block', marginBottom: 10 }}>
              <Music size={14} style={{ verticalAlign: 'middle', marginRight: 6 }} />
              Music & Smart Playlist Sync Selection
            </strong>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 12 }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 600, cursor: 'pointer' }}>
                <input
                  type="radio"
                  checked={profile.syncAllMusic}
                  onChange={() => void saveProfileChanges({ ...profile, syncAllMusic: true })}
                />
                Sync Entire Music Library & All Playlists
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 600, cursor: 'pointer' }}>
                <input
                  type="radio"
                  checked={!profile.syncAllMusic}
                  onChange={() => void saveProfileChanges({ ...profile, syncAllMusic: false })}
                />
                Sync Selected Playlists Only:
              </label>
            </div>

            {!profile.syncAllMusic && (
              <div
                style={{
                  background: '#ffffff',
                  border: '1px solid #cbd5e1',
                  borderRadius: 6,
                  padding: 10,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 6,
                }}
              >
                {playlists.map((pl) => {
                  const checked = profile.syncPlaylistIds.includes(pl.id);
                  return (
                    <label
                      key={pl.id}
                      style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', cursor: 'pointer' }}
                    >
                      <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={(e) => {
                            const nextIds = e.target.checked
                              ? [...profile.syncPlaylistIds, pl.id]
                              : profile.syncPlaylistIds.filter((id) => id !== pl.id);
                            void saveProfileChanges({ ...profile, syncPlaylistIds: nextIds });
                          }}
                        />
                        {pl.is_smart ? <Sparkles size={13} color="#6d28d9" /> : <Music size={13} />}
                        <strong>{pl.name}</strong>
                      </span>
                      <span style={{ fontSize: 11, color: '#64748b' }}>{pl.trackCount ?? 0} tracks</span>
                    </label>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {activeTab === 'tv' && (
          <div className="epod-capacity-card">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
              <strong>
                <Tv size={14} style={{ verticalAlign: 'middle', marginRight: 6 }} />
                TV Shows Sync Selection (Organized by Show & Season)
              </strong>
              <span style={{ fontSize: 11, color: '#475569' }}>
                Syncs to <code>Videos/TV Shows/Show Name/Season XX/</code>
              </span>
            </div>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '8px 12px',
                background: '#eff6ff',
                border: '1px solid #93c5fd',
                borderRadius: 6,
                marginBottom: 10,
              }}
            >
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 700, fontSize: 11.5, color: '#1e3a8a', cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={Boolean(profile.syncPlexOnDeck)}
                  onChange={(e) =>
                    void saveProfileChanges({
                      ...profile,
                      syncPlexOnDeck: e.target.checked,
                      plexOnDeckLimit: profile.plexOnDeckLimit || 5,
                    })
                  }
                />
                Auto-Sync Plex On Deck (Next N Unwatched Episodes)
              </label>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11 }}>
                <span>Episode Limit:</span>
                <select
                  className="aqua-input"
                  value={profile.plexOnDeckLimit || 5}
                  onChange={(e) =>
                    void saveProfileChanges({
                      ...profile,
                      plexOnDeckLimit: Number(e.target.value),
                    })
                  }
                >
                  <option value={3}>Next 3 Unwatched</option>
                  <option value={5}>Next 5 Unwatched</option>
                  <option value={10}>Next 10 Unwatched</option>
                  <option value={20}>Next 20 Unwatched</option>
                </select>
              </div>
            </div>
            <p style={{ fontSize: 11, color: '#475569', marginTop: 0 }}>
              Check an entire show, a specific season, or individual episodes to sync to your ePod. Checked episodes can also be pre-transcoded to 480×360 @ 30fps H.264 for instant USB transfer.
            </p>
            {tvShowsTree.length === 0 ? (
              <div style={{ padding: 20, textAlign: 'center', color: '#64748b' }}>
                No TV Shows indexed yet. Set your TV Shows folder in Preferences → Paths & Shares and click Rescan Library.
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {tvShowsTree.map((show) => {
                  const selectedInShow = show.allEpisodeIds.filter((id) =>
                    profile.syncVideoIds.includes(id)
                  ).length;
                  const allShowChecked =
                    show.allEpisodeIds.length > 0 && selectedInShow === show.allEpisodeIds.length;
                  const isExpanded = expandedShow === show.showName || tvShowsTree.length <= 5;

                  return (
                    <div
                      key={show.showName}
                      style={{
                        background: '#ffffff',
                        border: '1px solid #cbd5e1',
                        borderRadius: 6,
                        overflow: 'hidden',
                      }}
                    >
                      {/* Show Header */}
                      <div
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          padding: '8px 12px',
                          background: 'linear-gradient(180deg, #f8fafc 0%, #e2e8f0 100%)',
                          borderBottom: isExpanded ? '1px solid #cbd5e1' : 'none',
                        }}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <button
                            onClick={() =>
                              setExpandedShow(isExpanded ? null : show.showName)
                            }
                            style={{
                              background: 'none',
                              border: 'none',
                              cursor: 'pointer',
                              padding: 0,
                              display: 'flex',
                              alignItems: 'center',
                            }}
                          >
                            {isExpanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
                          </button>
                          <input
                            type="checkbox"
                            checked={allShowChecked}
                            onChange={(e) => {
                              const nextSet = new Set(profile.syncVideoIds);
                              if (e.target.checked) {
                                show.allEpisodeIds.forEach((id) => nextSet.add(id));
                              } else {
                                show.allEpisodeIds.forEach((id) => nextSet.delete(id));
                              }
                              void saveProfileChanges({
                                ...profile,
                                syncVideoIds: Array.from(nextSet),
                              });
                            }}
                          />
                          <strong
                            style={{ fontSize: 13, cursor: 'pointer' }}
                            onClick={() => setExpandedShow(isExpanded ? null : show.showName)}
                          >
                            {show.showName}
                          </strong>
                          <span style={{ fontSize: 11, color: '#475569' }}>
                            ({selectedInShow} of {show.allEpisodeIds.length} episodes selected across{' '}
                            {show.seasons.length} {show.seasons.length === 1 ? 'season' : 'seasons'})
                          </span>
                        </div>
                        <button
                          className="aqua-btn"
                          style={{ fontSize: 10.5, padding: '2px 8px' }}
                          onClick={async () => {
                            await invokeRpc('cache:toggleShow', show.showName, true);
                            setStatusMessage(`Queued "${show.showName}" for 360p pre-transcoding.`);
                          }}
                        >
                          Pre-Transcode Show (360p)
                        </button>
                      </div>

                      {/* Seasons & Episodes */}
                      {isExpanded && (
                        <div style={{ padding: '8px 14px', display: 'flex', flexDirection: 'column', gap: 10 }}>
                          {show.seasons.map((sec) => {
                            const secIds = sec.episodes.map((e) => e.id);
                            const secCheckedCount = secIds.filter((id) =>
                              profile.syncVideoIds.includes(id)
                            ).length;
                            const allSecChecked =
                              secIds.length > 0 && secCheckedCount === secIds.length;

                            return (
                              <div key={sec.seasonNum}>
                                <label
                                  style={{
                                    display: 'flex',
                                    alignItems: 'center',
                                    gap: 7,
                                    fontWeight: 700,
                                    fontSize: 11.5,
                                    color: '#1e3a8a',
                                    marginBottom: 4,
                                    cursor: 'pointer',
                                  }}
                                >
                                  <input
                                    type="checkbox"
                                    checked={allSecChecked}
                                    onChange={(e) => {
                                      const nextSet = new Set(profile.syncVideoIds);
                                      if (e.target.checked) {
                                        secIds.forEach((id) => nextSet.add(id));
                                      } else {
                                        secIds.forEach((id) => nextSet.delete(id));
                                      }
                                      void saveProfileChanges({
                                        ...profile,
                                        syncVideoIds: Array.from(nextSet),
                                      });
                                    }}
                                  />
                                  {sec.seasonNum === 0
                                    ? `Specials / Extras (${secCheckedCount}/${sec.episodes.length} items)`
                                    : `Season ${sec.seasonNum} (${secCheckedCount}/${sec.episodes.length} episodes)`}
                                </label>

                                <div
                                  style={{
                                    display: 'grid',
                                    gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))',
                                    gap: 5,
                                    paddingLeft: 18,
                                  }}
                                >
                                  {sec.episodes.map((ep) => {
                                    const checked = profile.syncVideoIds.includes(ep.id);
                                    const epCode =
                                      ep.season === 0
                                        ? ep.episode
                                          ? `S00E${String(ep.episode).padStart(2, '0')}`
                                          : 'Special'
                                        : `S${String(ep.season || 1).padStart(2, '0')}E${String(ep.episode || 1).padStart(2, '0')}`;
                                    return (
                                      <label
                                        key={ep.id}
                                        style={{
                                          display: 'flex',
                                          alignItems: 'center',
                                          justifyContent: 'space-between',
                                          padding: '4px 8px',
                                          borderRadius: 4,
                                          background: checked ? '#eff6ff' : '#f8fafc',
                                          border: checked ? '1px solid #93c5fd' : '1px solid #e2e8f0',
                                          fontSize: 11,
                                          cursor: 'pointer',
                                        }}
                                      >
                                        <span
                                          style={{
                                            display: 'flex',
                                            alignItems: 'center',
                                            gap: 6,
                                            overflow: 'hidden',
                                            textOverflow: 'ellipsis',
                                            whiteSpace: 'nowrap',
                                          }}
                                        >
                                          <input
                                            type="checkbox"
                                            checked={checked}
                                            onChange={(e) => {
                                              const nextIds = e.target.checked
                                                ? [...profile.syncVideoIds, ep.id]
                                                : profile.syncVideoIds.filter((id) => id !== ep.id);
                                              void saveProfileChanges({
                                                ...profile,
                                                syncVideoIds: nextIds,
                                              });
                                            }}
                                          />
                                          <strong style={{ fontFamily: 'var(--font-mono)' }}>{epCode}</strong>
                                          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
                                            {ep.title}
                                          </span>
                                        </span>
                                        <span
                                          style={{
                                            fontSize: 9.5,
                                            fontWeight: 700,
                                            color: ep.is_transcoded ? '#15803d' : '#64748b',
                                            marginLeft: 6,
                                            flexShrink: 0,
                                          }}
                                        >
                                          {ep.is_transcoded ? '360p' : ep.format}
                                        </span>
                                      </label>
                                    );
                                  })}
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {activeTab === 'movies' && (
          <div className="epod-capacity-card">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
              <strong>
                <Film size={14} style={{ verticalAlign: 'middle', marginRight: 6 }} />
                Movies Sync Selection
              </strong>
              <span style={{ fontSize: 11, color: '#475569' }}>
                Syncs to <code>{profile.videoSubdir}/Movies/</code>
              </span>
            </div>
            <p style={{ fontSize: 11, color: '#475569', marginTop: 0 }}>
              Select movies from your library to copy to your ePod. Movies marked "Keep 360p" are pre-transcoded to 480×360 @ 30fps H.264 + AAC 128k in the background.
            </p>
            {movieVideos.length === 0 ? (
              <div style={{ padding: 20, textAlign: 'center', color: '#64748b' }}>
                No movies indexed in your library yet. Configure your Movies Root folder in Preferences → Paths & Shares and click Rescan Library.
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {movieVideos.map((v) => {
                  const checked = profile.syncVideoIds.includes(v.id);
                  return (
                    <label
                      key={v.id}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        background: '#fff',
                        padding: '6px 10px',
                        borderRadius: 4,
                        border: '1px solid #cbd5e1',
                        cursor: 'pointer',
                      }}
                    >
                      <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={(e) => {
                            const nextIds = e.target.checked
                              ? [...profile.syncVideoIds, v.id]
                              : profile.syncVideoIds.filter((id) => id !== v.id);
                            void saveProfileChanges({ ...profile, syncVideoIds: nextIds });
                          }}
                        />
                        <strong>{v.title}</strong>
                        {v.year && <span style={{ fontSize: 11, color: '#64748b' }}>({v.year})</span>}
                      </span>
                      <span
                        style={{
                          fontSize: 10.5,
                          fontWeight: 700,
                          color: v.is_transcoded ? '#15803d' : '#d97706',
                        }}
                      >
                        {v.is_transcoded ? '360p Cached Ready' : 'Source Rip'}
                      </span>
                    </label>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {activeTab === 'photos' && (
          <div className="epod-capacity-card">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
              <strong>Photos & Immich Album Sync (ePod 480×360 JPEG)</strong>
              <span style={{ fontSize: 11, color: '#475569' }}>
                Syncs to <code>Root/Pictures/&lt;Album Name&gt;/&lt;Image&gt;.jpg</code>
              </span>
            </div>
            <label
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                fontWeight: 700,
                fontSize: 12,
                cursor: 'pointer',
                marginBottom: 10,
              }}
            >
              <input
                type="checkbox"
                checked={Boolean(profile.syncPhotos)}
                onChange={(e) =>
                  void saveProfileChanges({ ...profile, syncPhotos: e.target.checked })
                }
              />
              Sync Photos to ePod (Downscales to 480×360 Baseline JPEG for Y2 Reborn / Click-Wheel Photo Viewer)
            </label>
            <label
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                fontWeight: 700,
                fontSize: 12,
                cursor: 'pointer',
              }}
            >
              <input
                type="checkbox"
                checked={profile.syncMusicVideos !== false}
                onChange={(e) =>
                  void saveProfileChanges({ ...profile, syncMusicVideos: e.target.checked })
                }
              />
              Sync Music Videos to <code>Root/Videos/Music Videos/&lt;Artist&gt; - &lt;Title&gt;.mp4</code>
            </label>
          </div>
        )}

        {activeTab === 'manifest' && (
          <div className="epod-capacity-card">
            <strong style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
              <FileCode size={14} /> On-Device Manifest (<code>{device.mount_path}/.retrotunes_device.json</code>)
            </strong>
            <pre
              style={{
                background: '#0f172a',
                color: '#e2e8f0',
                padding: 14,
                borderRadius: 6,
                fontFamily: 'var(--font-mono)',
                fontSize: 11.5,
                overflowX: 'auto',
                margin: 0,
              }}
            >
              {JSON.stringify(profile, null, 2)}
            </pre>
          </div>
        )}

        {/* Live Sync Progress Or Status Banner */}
        {(syncProgress.running || statusMessage) && (
          <div className="epod-capacity-card" style={{ background: '#eff6ff', borderColor: '#60a5fa' }}>
            {syncProgress.running ? (
              <div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 700, marginBottom: 6 }}>
                  <span>{syncProgress.stage}</span>
                  <span>
                    {syncProgress.processed} / {syncProgress.total}
                  </span>
                </div>
                <div
                  style={{
                    height: 10,
                    background: '#cbd5e1',
                    borderRadius: 5,
                    overflow: 'hidden',
                    marginBottom: 6,
                  }}
                >
                  <div
                    style={{
                      width: `${Math.min(100, Math.round((syncProgress.processed / Math.max(1, syncProgress.total)) * 100))}%`,
                      height: '100%',
                      background: 'linear-gradient(90deg, #2563eb, #60a5fa)',
                    }}
                  />
                </div>
                <div style={{ fontSize: 11, color: '#334155' }}>{syncProgress.currentFile}</div>
              </div>
            ) : (
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 600, color: '#1e3a8a' }}>
                <CheckCircle2 size={15} /> {statusMessage}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Bottom Segmented Capacity Bar (Section 7.4: Audio Blue, Video Purple, Other Yellow, Free Gray) */}
      <div
        style={{
          padding: '14px 28px',
          background: 'linear-gradient(180deg, #dce2ec 0%, #c1cad8 100%)',
          borderTop: '1px solid #8c96a5',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
          <strong style={{ fontSize: 12 }}>Capacity: {formatBytes(storage.totalBytes)}</strong>
          <div style={{ display: 'flex', gap: 18, fontSize: 11, fontWeight: 600 }}>
            <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
              <span style={{ width: 10, height: 10, borderRadius: 2, background: '#2563eb', display: 'inline-block' }} />
              Audio: {formatBytes(storage.audioBytes)}
            </span>
            <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
              <span style={{ width: 10, height: 10, borderRadius: 2, background: '#8b5cf6', display: 'inline-block' }} />
              Video: {formatBytes(storage.videoBytes)}
            </span>
            <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
              <span style={{ width: 10, height: 10, borderRadius: 2, background: '#eab308', display: 'inline-block' }} />
              Other: {formatBytes(storage.otherBytes)}
            </span>
            <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
              <span style={{ width: 10, height: 10, borderRadius: 2, background: '#94a3b8', display: 'inline-block' }} />
              Free: {formatBytes(storage.freeBytes)}
            </span>
          </div>
        </div>

        <div className="epod-segmented-bar">
          <div className="seg-audio" style={{ width: `${audioPct}%` }} title={`Audio: ${formatBytes(storage.audioBytes)}`} />
          <div className="seg-video" style={{ width: `${videoPct}%` }} title={`Video: ${formatBytes(storage.videoBytes)}`} />
          <div className="seg-other" style={{ width: `${otherPct}%` }} title={`Other: ${formatBytes(storage.otherBytes)}`} />
          <div className="seg-free" style={{ flex: 1 }} title={`Free: ${formatBytes(storage.freeBytes)}`} />
        </div>
      </div>
    </div>
  );
};
