import React, { useEffect, useState } from 'react';
import { Usb, FolderOpen, CheckCircle2, Disc, Smartphone, X } from 'lucide-react';
import { DeviceInfo, MountedVolume } from '../types';
import { formatBytes, invokeRpc } from '../bridge';

interface AddDeviceWizardModalProps {
  onClose: () => void;
  onProvisioned: (device: DeviceInfo) => void;
}

export const AddDeviceWizardModal: React.FC<AddDeviceWizardModalProps> = ({
  onClose,
  onProvisioned,
}) => {
  const [volumes, setVolumes] = useState<MountedVolume[]>([]);
  const [mountPath, setMountPath] = useState('');
  const [deviceName, setDeviceName] = useState('Innioasis Y2 (ePod)');
  const [preset, setPreset] = useState<'epod_y2' | 'classic_dap' | 'phone' | 'custom'>('epod_y2');
  const [videoResolution, setVideoResolution] = useState<'480x360' | '320x240' | '720p' | '1080p' | 'source'>('480x360');
  const [downloadLrc, setDownloadLrc] = useState(true);
  const [sanitizeCoverArt, setSanitizeCoverArt] = useState(true);
  const [cleanMacMetadata, setCleanMacMetadata] = useState(true);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [provisioning, setProvisioning] = useState(false);

  const loadVolumes = async () => {
    const vols = await invokeRpc<MountedVolume[]>('devices:volumes');
    setVolumes(vols);
    if (vols.length > 0 && !mountPath) {
      setMountPath(vols[0].mountPath);
      setDeviceName(vols[0].name || 'Innioasis Y2 (ePod)');
    }
  };

  useEffect(() => {
    void loadVolumes();
  }, []);

  const handlePresetChange = (nextPreset: 'epod_y2' | 'classic_dap' | 'phone' | 'custom') => {
    setPreset(nextPreset);
    if (nextPreset === 'epod_y2') {
      setDeviceName('Innioasis Y2 (ePod)');
      setVideoResolution('480x360');
      setDownloadLrc(true);
      setSanitizeCoverArt(true);
      setCleanMacMetadata(true);
    } else if (nextPreset === 'classic_dap') {
      setDeviceName('Classic Click-Wheel DAP');
      setVideoResolution('320x240');
      setDownloadLrc(true);
      setSanitizeCoverArt(true);
      setCleanMacMetadata(true);
    } else {
      setDeviceName('Custom Portable DAP');
      setVideoResolution('720p');
      setDownloadLrc(false);
      setSanitizeCoverArt(false);
      setCleanMacMetadata(true);
    }
  };

  const handleBrowseFolder = async () => {
    const selected = await invokeRpc<string | null>(
      'dialog:selectDirectory',
      'Select Mounted ePod Volume, SD Card, or Device Folder'
    );
    if (selected) {
      setMountPath(selected);
    }
  };

  const handleProvision = async () => {
    if (!mountPath.trim()) {
      setErrorMsg('Please select a mounted volume or target device directory.');
      return;
    }
    setProvisioning(true);
    setErrorMsg(null);
    try {
      const device = await invokeRpc<DeviceInfo>('devices:provision', mountPath.trim(), {
        name: deviceName.trim() || 'Innioasis Y2 (ePod)',
        deviceType: preset,
        videoResolution,
        downloadLrc,
        sanitizeCoverArt,
        cleanMacMetadata,
      });
      onProvisioned(device);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setProvisioning(false);
    }
  };

  return (
    <div className="aqua-modal-backdrop" onClick={onClose}>
      <div
        className="aqua-window"
        style={{ width: 660, maxWidth: '94vw' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="aqua-window-titlebar">
          <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <Usb size={14} /> Universal "Add Device" — ePod Provisioning Wizard
          </span>
          <button className="aqua-btn" onClick={onClose} style={{ padding: '1px 6px' }}>
            <X size={13} />
          </button>
        </div>

        <div style={{ padding: 18, overflowY: 'auto', maxHeight: '72vh', display: 'flex', flexDirection: 'column', gap: 14 }}>
          {/* Step 1: Volume Selection */}
          <div className="epod-capacity-card">
            <strong style={{ display: 'block', marginBottom: 8 }}>
              1. Select Mounted Volume (/Volumes) or Target Directory
            </strong>
            {volumes.length > 0 ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 10 }}>
                {volumes.map((v) => (
                  <label
                    key={v.mountPath}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      padding: '6px 10px',
                      background: mountPath === v.mountPath ? '#dbeafe' : '#ffffff',
                      border: mountPath === v.mountPath ? '1px solid #2563eb' : '1px solid #cbd5e1',
                      borderRadius: 5,
                      cursor: 'pointer',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <input
                        type="radio"
                        name="vol"
                        checked={mountPath === v.mountPath}
                        onChange={() => {
                          setMountPath(v.mountPath);
                          setDeviceName(v.name);
                        }}
                      />
                      <strong>{v.name}</strong>
                      <span style={{ fontSize: 11, color: '#64748b' }}>({v.mountPath})</span>
                    </div>
                    <span style={{ fontSize: 11, fontWeight: 600 }}>
                      {formatBytes(v.freeBytes)} free of {formatBytes(v.totalBytes)}
                    </span>
                  </label>
                ))}
              </div>
            ) : (
              <p style={{ fontSize: 11, color: '#475569', margin: '0 0 8px 0' }}>
                No external USB/SD volumes currently detected in <code>/Volumes</code>. You can browse to any mounted folder or test directory below:
              </p>
            )}

            <div style={{ display: 'flex', gap: 6 }}>
              <input
                className="aqua-input"
                style={{ flex: 1 }}
                placeholder="/Volumes/EPOD_Y2 or custom directory path"
                value={mountPath}
                onChange={(e) => setMountPath(e.target.value)}
              />
              <button className="aqua-btn" onClick={handleBrowseFolder}>
                <FolderOpen size={13} /> Browse Volume...
              </button>
            </div>
          </div>

          {/* Step 2: Preset Selection */}
          <div className="epod-capacity-card">
            <strong style={{ display: 'block', marginBottom: 8 }}>2. Choose Hardware Preset Profile</strong>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, marginBottom: 12 }}>
              {[
                {
                  id: 'epod_y2' as const,
                  title: 'Innioasis Y2 (ePod)',
                  desc: '480×360 4:3 30fps MP4, AAC 128k, .m3u8, .lrc karaoke, 500×500 JPEG cover art',
                  icon: <Disc size={20} color="#1d4ed8" />,
                },
                {
                  id: 'classic_dap' as const,
                  title: 'Classic Click-Wheel DAP (Rockbox)',
                  desc: '320×240 30fps MP4, .m3u8 relative playlists, 500×500 baseline JPEG cover art',
                  icon: <Disc size={20} color="#475569" />,
                },
                {
                  id: 'custom' as const,
                  title: 'Custom / Smartphone',
                  desc: '720p/1080p/Source video, audio pass-through, custom playlist root paths',
                  icon: <Smartphone size={20} color="#0f766e" />,
                },
              ].map((p) => (
                <div
                  key={p.id}
                  onClick={() => handlePresetChange(p.id)}
                  style={{
                    padding: 10,
                    borderRadius: 6,
                    background: preset === p.id ? '#eff6ff' : '#ffffff',
                    border: preset === p.id ? '2px solid #2563eb' : '1px solid #cbd5e1',
                    cursor: 'pointer',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                    {p.icon}
                    <strong>{p.title}</strong>
                  </div>
                  <div style={{ fontSize: 10.5, color: '#475569', lineHeight: 1.35 }}>{p.desc}</div>
                </div>
              ))}
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 10 }}>
              <div>
                <label style={{ display: 'block', fontSize: 11, fontWeight: 600, marginBottom: 3 }}>
                  Device Display Name:
                </label>
                <input
                  className="aqua-input"
                  style={{ width: '100%' }}
                  value={deviceName}
                  onChange={(e) => setDeviceName(e.target.value)}
                />
              </div>
              <div>
                <label style={{ display: 'block', fontSize: 11, fontWeight: 600, marginBottom: 3 }}>
                  Target Video Profile:
                </label>
                <select
                  className="aqua-input"
                  style={{ width: '100%' }}
                  value={videoResolution}
                  onChange={(e) => setVideoResolution(e.target.value as any)}
                >
                  <option value="480x360">480×360 (4:3 Innioasis Y2 Native @ 30fps)</option>
                  <option value="320x240">320×240 (QVGA Portable Video @ 30fps)</option>
                  <option value="720p">1280×720 (720p HD)</option>
                  <option value="1080p">1920×1080 (1080p Full HD)</option>
                  <option value="source">Direct Source Pass-Through</option>
                </select>
              </div>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 7, fontWeight: 600, cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={downloadLrc}
                  onChange={(e) => setDownloadLrc(e.target.checked)}
                />
                Auto-fetch synchronized karaoke lyrics (.lrc) via LRCLIB API on sync
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 7, fontWeight: 600, cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={sanitizeCoverArt}
                  onChange={(e) => setSanitizeCoverArt(e.target.checked)}
                />
                Downscale & sanitize cover art to 500×500 baseline JPEG (prevents portable DAC UI lag)
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 7, fontWeight: 600, cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={cleanMacMetadata}
                  onChange={(e) => setCleanMacMetadata(e.target.checked)}
                />
                Run dot_clean & remove .DS_Store / ._* hidden metadata files before eject
              </label>
            </div>
          </div>

          {errorMsg && (
            <div style={{ color: '#b91c1c', fontWeight: 600, fontSize: 11.5 }}>{errorMsg}</div>
          )}
        </div>

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
          <span style={{ fontSize: 11, color: '#475569' }}>
            Writes <code>.retrotunes_device.json</code> manifest to device root
          </span>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="aqua-btn" onClick={onClose}>
              Cancel
            </button>
            <button className="aqua-btn primary" onClick={handleProvision} disabled={provisioning}>
              <CheckCircle2 size={13} />
              {provisioning ? 'Provisioning...' : 'Provision ePod Device'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
