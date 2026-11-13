import React, { useState } from 'react';
import {
  Upload,
  Search,
  FolderCheck,
  CheckCircle2,
  X,
  FilePlus,
  RefreshCw,
} from 'lucide-react';
import { invokeRpc } from '../bridge';

type UploadMediaType =
  | 'music'
  | 'movie'
  | 'tv'
  | 'music_video'
  | 'book'
  | 'audiobook'
  | 'photo';

interface UploadMetadataMatch {
  id: string;
  title: string;
  subtitle: string;
  year?: number;
  artistOrAuthor?: string;
  albumOrShow?: string;
  season?: number;
  episode?: number;
  coverUrl?: string;
  foreignId?: string;
}

interface UploadPreviewPlan {
  mediaType: UploadMediaType;
  targetRootDir: string;
  namingSchemeSummary: string;
  items: {
    sourcePath: string;
    destinationPath: string;
    formattedRelativePath: string;
  }[];
}

interface UploadMediaWizardModalProps {
  onClose: () => void;
  onUploaded: () => void;
}

export const UploadMediaWizardModal: React.FC<UploadMediaWizardModalProps> = ({
  onClose,
  onUploaded,
}) => {
  const [step, setStep] = useState<1 | 2 | 3 | 4>(1);
  const [mediaType, setMediaType] = useState<UploadMediaType>('music');
  const [filePaths, setFilePaths] = useState<string[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [matches, setMatches] = useState<UploadMetadataMatch[]>([]);
  const [selectedMatch, setSelectedMatch] = useState<UploadMetadataMatch | null>(null);
  const [seasonNum, setSeasonNum] = useState(1);
  const [episodeStart, setEpisodeStart] = useState(1);
  const [previewPlan, setPreviewPlan] = useState<UploadPreviewPlan | null>(null);
  const [executing, setExecuting] = useState(false);
  const [resultSummary, setResultSummary] = useState<{
    ok: boolean;
    copiedCount: number;
    arrTriggered: boolean;
    arrMessage: string;
  } | null>(null);

  const handleSelectFiles = async () => {
    const selected = await invokeRpc<string[]>('dialog:selectFiles', 'Select Media Files to Upload');
    if (selected && selected.length > 0) {
      setFilePaths(selected);
      if (!searchQuery) {
        const firstBase = selected[0].split('/').pop() || '';
        const guess = firstBase.replace(/\.[^/.]+$/, '').replace(/[._-]+/g, ' ');
        setSearchQuery(guess);
      }
    }
  };

  const handleSearchMetadata = async () => {
    if (!searchQuery.trim()) return;
    setSearching(true);
    try {
      const list = await invokeRpc<UploadMetadataMatch[]>(
        'upload:searchMetadata',
        mediaType,
        searchQuery.trim()
      );
      setMatches(list);
      if (list.length > 0) {
        setSelectedMatch(list[0]);
      } else {
        setSelectedMatch({
          id: 'manual',
          title: searchQuery.trim(),
          subtitle: 'Custom / Manual Release Match',
          artistOrAuthor: searchQuery.trim(),
          albumOrShow: searchQuery.trim(),
        });
      }
    } finally {
      setSearching(false);
    }
  };

  const handleBuildPreview = async () => {
    const matchToUse: UploadMetadataMatch = selectedMatch || {
      id: 'manual',
      title: searchQuery.trim() || 'Uploaded Media',
      subtitle: 'Manual Entry',
      artistOrAuthor: searchQuery.trim() || 'Unknown Artist',
      albumOrShow: searchQuery.trim() || 'Uploaded Media',
    };
    setSelectedMatch(matchToUse);
    const plan = await invokeRpc<UploadPreviewPlan>('upload:previewPlan', {
      mediaType,
      filePaths,
      match: matchToUse,
      season: seasonNum,
      episodeStart,
    });
    setPreviewPlan(plan);
    setStep(3);
  };

  const handleExecuteUpload = async () => {
    if (!previewPlan || !selectedMatch) return;
    setExecuting(true);
    try {
      const res = await invokeRpc<{
        ok: boolean;
        copiedCount: number;
        arrTriggered: boolean;
        arrMessage: string;
      }>('upload:execute', {
        plan: previewPlan,
        match: selectedMatch,
        season: seasonNum,
        episodeStart,
      });
      setResultSummary(res);
      setStep(4);
      onUploaded();
    } finally {
      setExecuting(false);
    }
  };

  return (
    <div className="aqua-modal-backdrop" onClick={onClose}>
      <div
        className="aqua-window"
        style={{ width: 720, maxWidth: '94vw' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="aqua-window-titlebar">
          <span>Smart Media Upload Wizard & *arr Auto-Import</span>
          <button className="aqua-btn" onClick={onClose} style={{ padding: '1px 6px' }}>
            <X size={13} />
          </button>
        </div>

        {/* Stepper Header */}
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-around',
            padding: '10px 16px',
            background: 'linear-gradient(180deg, #eef1f6 0%, #cfd6e2 100%)',
            borderBottom: '1px solid #919baa',
            fontSize: 11.5,
            fontWeight: 700,
          }}
        >
          <span style={{ color: step === 1 ? '#1d4ed8' : '#475569' }}>1. Media Type & Files</span>
          <span style={{ color: step === 2 ? '#1d4ed8' : '#475569' }}>2. *arr / Metadata Match</span>
          <span style={{ color: step === 3 ? '#1d4ed8' : '#475569' }}>3. Naming & Folder Preview</span>
          <span style={{ color: step === 4 ? '#15803d' : '#475569' }}>4. Transfer & *arr Check-Off</span>
        </div>

        <div style={{ padding: 20, maxHeight: '64vh', overflowY: 'auto' }}>
          {step === 1 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <div className="epod-capacity-card">
                <label style={{ display: 'block', fontWeight: 700, marginBottom: 8 }}>
                  Select Target Media Type:
                </label>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8 }}>
                  {[
                    { id: 'music', label: 'Music (Lidarr)' },
                    { id: 'movie', label: 'Movie (Radarr)' },
                    { id: 'tv', label: 'TV Show (Sonarr)' },
                    { id: 'music_video', label: 'Music Video' },
                    { id: 'book', label: 'Book (Chaptarr)' },
                    { id: 'audiobook', label: 'Audiobook (ABS)' },
                    { id: 'photo', label: 'Photos (Immich)' },
                  ].map((t) => (
                    <button
                      key={t.id}
                      className={`aqua-btn ${mediaType === t.id ? 'primary' : ''}`}
                      onClick={() => setMediaType(t.id as UploadMediaType)}
                    >
                      {t.label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="epod-capacity-card">
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                  <strong>Selected Local Source Files ({filePaths.length})</strong>
                  <button className="aqua-btn primary" onClick={handleSelectFiles}>
                    <FilePlus size={13} /> Browse Local Files...
                  </button>
                </div>
                {filePaths.length === 0 ? (
                  <div style={{ padding: 18, textAlign: 'center', color: '#64748b', fontSize: 11.5 }}>
                    Click &ldquo;Browse Local Files...&rdquo; to select audio tracks, movies, episodes, books, or photos from your Mac.
                  </div>
                ) : (
                  <div
                    style={{
                      maxHeight: 160,
                      overflowY: 'auto',
                      background: '#fff',
                      border: '1px solid #cbd5e1',
                      borderRadius: 6,
                      padding: 8,
                      fontSize: 11,
                      fontFamily: 'var(--font-mono)',
                    }}
                  >
                    {filePaths.map((fp) => (
                      <div key={fp} style={{ padding: '2px 0' }}>
                        {fp}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}

          {step === 2 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div className="epod-capacity-card">
                <label style={{ display: 'block', fontWeight: 700, marginBottom: 6 }}>
                  Search Official Metadata (*arr / MusicBrainz / TMDB / TVDB / OpenLibrary):
                </label>
                <div style={{ display: 'flex', gap: 8 }}>
                  <input
                    className="aqua-input"
                    style={{ flex: 1 }}
                    value={searchQuery}
                    placeholder="Enter album, movie, series, or book title..."
                    onChange={(e) => setSearchQuery(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void handleSearchMetadata();
                    }}
                  />
                  <button
                    className="aqua-btn primary"
                    onClick={handleSearchMetadata}
                    disabled={searching}
                  >
                    <Search size={13} /> {searching ? 'Searching...' : 'Search Metadata'}
                  </button>
                </div>

                {mediaType === 'tv' && (
                  <div style={{ display: 'flex', gap: 14, marginTop: 10 }}>
                    <div>
                      <label style={{ fontSize: 11, fontWeight: 600, marginRight: 6 }}>Season Number:</label>
                      <input
                        type="number"
                        className="aqua-input"
                        style={{ width: 70 }}
                        value={seasonNum}
                        onChange={(e) => setSeasonNum(Number(e.target.value) || 1)}
                      />
                    </div>
                    <div>
                      <label style={{ fontSize: 11, fontWeight: 600, marginRight: 6 }}>
                        Starting Episode #:
                      </label>
                      <input
                        type="number"
                        className="aqua-input"
                        style={{ width: 70 }}
                        value={episodeStart}
                        onChange={(e) => setEpisodeStart(Number(e.target.value) || 1)}
                      />
                    </div>
                  </div>
                )}
              </div>

              <div className="epod-capacity-card">
                <strong style={{ display: 'block', marginBottom: 8 }}>
                  Select Release Match:
                </strong>
                {matches.length === 0 ? (
                  <div style={{ fontSize: 11.5, color: '#64748b' }}>
                    Click &ldquo;Search Metadata&rdquo; above to match against your *arr service or public catalog, or proceed directly using the title above.
                  </div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 220, overflowY: 'auto' }}>
                    {matches.map((m) => {
                      const active = selectedMatch?.id === m.id;
                      return (
                        <div
                          key={m.id}
                          onClick={() => setSelectedMatch(m)}
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'space-between',
                            padding: '8px 10px',
                            borderRadius: 6,
                            cursor: 'pointer',
                            background: active ? '#dbeafe' : '#ffffff',
                            border: active ? '1px solid #2563eb' : '1px solid #cbd5e1',
                          }}
                        >
                          <div>
                            <div style={{ fontWeight: 700, fontSize: 12.5 }}>{m.title}</div>
                            <div style={{ fontSize: 11, color: '#475569' }}>{m.subtitle}</div>
                          </div>
                          {active && <CheckCircle2 size={16} color="#1d4ed8" />}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          )}

          {step === 3 && previewPlan && (
            <div className="epod-capacity-card">
              <strong style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
                <FolderCheck size={15} /> Dynamic *arr Naming & Destination Preview
              </strong>
              <div style={{ fontSize: 11.5, color: '#1e3a8a', marginBottom: 10 }}>
                <strong>Active Naming Scheme:</strong> {previewPlan.namingSchemeSummary}
                <br />
                <strong>Target Share Root:</strong> <code>{previewPlan.targetRootDir}</code>
              </div>
              <div
                style={{
                  background: '#0f172a',
                  color: '#e2e8f0',
                  padding: 12,
                  borderRadius: 6,
                  fontFamily: 'var(--font-mono)',
                  fontSize: 11,
                  maxHeight: 220,
                  overflowY: 'auto',
                }}
              >
                {previewPlan.items.map((item, idx) => (
                  <div key={idx} style={{ marginBottom: 8 }}>
                    <div style={{ color: '#94a3b8' }}>Source: {item.sourcePath}</div>
                    <div style={{ color: '#4ade80' }}>→ Dest: {item.destinationPath}</div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {step === 4 && resultSummary && (
            <div className="epod-capacity-card" style={{ background: '#f0fdf4', borderColor: '#86efac' }}>
              <h3 style={{ margin: '0 0 8px 0', color: '#15803d', display: 'flex', alignItems: 'center', gap: 8 }}>
                <CheckCircle2 size={18} /> Upload & *arr Check-Off Complete!
              </h3>
              <p style={{ fontSize: 12, color: '#166534', margin: '0 0 6px 0' }}>
                Successfully formatted and copied <strong>{resultSummary.copiedCount}</strong> file(s) to your media share and indexed them in rTunes SQLite.
              </p>
              <p style={{ fontSize: 11.5, color: '#15803d', margin: 0 }}>
                <strong>*arr Status:</strong> {resultSummary.arrMessage}
              </p>
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
          <button className="aqua-btn" onClick={onClose}>
            {step === 4 ? 'Close' : 'Cancel'}
          </button>
          <div style={{ display: 'flex', gap: 8 }}>
            {step > 1 && step < 4 && (
              <button
                className="aqua-btn"
                onClick={() => setStep((s) => (s - 1) as 1 | 2 | 3)}
              >
                Back
              </button>
            )}
            {step === 1 && (
              <button
                className="aqua-btn primary"
                disabled={filePaths.length === 0}
                onClick={() => {
                  setStep(2);
                  void handleSearchMetadata();
                }}
              >
                Next: Match Metadata →
              </button>
            )}
            {step === 2 && (
              <button className="aqua-btn primary" onClick={handleBuildPreview}>
                Next: Preview *arr Naming →
              </button>
            )}
            {step === 3 && (
              <button
                className="aqua-btn primary"
                disabled={executing}
                onClick={handleExecuteUpload}
              >
                {executing ? (
                  <>
                    <RefreshCw size={13} /> Copying & Triggering *arr Scan...
                  </>
                ) : (
                  <>
                    <Upload size={13} /> Upload to Share & Trigger *arr Import
                  </>
                )}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
