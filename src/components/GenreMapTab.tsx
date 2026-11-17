import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Grid,
  Lock,
  Maximize2,
  RefreshCw,
  RotateCcw,
  Search,
  Sliders,
  Users,
  X,
} from 'lucide-react';
import { invokeRpc } from '../bridge';

interface MatrixGenreSummary {
  genre: string;
  artistCount: number;
  totalWeight: number;
}

interface MatrixCell {
  genreX: string;
  genreY: string;
  similarity: number;
  isUserLocked: boolean;
  updatedAt: number;
}

interface GenreMatrixPayload {
  genres: MatrixGenreSummary[];
  cells: MatrixCell[];
  totalArtistsWeighted: number;
  totalLibraryArtists: number;
  totalGenresIndexed: number;
  totalCellsStored: number;
  hasLastfmApiKey: boolean;
  genreMapUseLastfm: boolean;
  genreMapLastfmWeight: number;
}

interface ArtistSceneScoreResult {
  artistName: string;
  artistKey: string;
  targetGenre: string;
  score: number;
  topTags: { tag: string; weight: number; matrixSim: number; contribution: number }[];
}

interface ArtistSliceEntry {
  artistKey: string;
  artistName: string;
  sceneScore: number;
  topTags: { tag: string; weight: number }[];
}

interface ArtistSimilaritySlicePayload {
  targetGenre: string;
  minThreshold: number;
  effectiveLastfmWeight: number;
  hasLastfmApiKey: boolean;
  totalMatchedArtists: number;
  artists: ArtistSliceEntry[];
  localMatrix: number[][];
  lastfmMatrix: number[][];
  combinedMatrix: number[][];
  elapsedMs: number;
}

function getHeatColor(sim: number, isDiagonal: boolean): { bg: string; fg: string } {
  if (isDiagonal) return { bg: '#1d4ed8', fg: '#ffffff' };
  if (sim >= 0.85) return { bg: '#0f766e', fg: '#ffffff' };
  if (sim >= 0.7) return { bg: '#0284c7', fg: '#ffffff' };
  if (sim >= 0.5) return { bg: '#60a5fa', fg: '#0f172a' };
  if (sim >= 0.25) return { bg: '#bae6fd', fg: '#0c4a6e' };
  if (sim >= 0.05) return { bg: '#e2e8f0', fg: '#334155' };
  return { bg: '#f8fafc', fg: '#94a3b8' };
}

const CELL_W = 74;
const CELL_H = 26;
const ROW_HEADER_W = 165;
const COL_HEADER_H = 28;

export const GenreMapTab: React.FC = () => {
  const [matrix, setMatrix] = useState<GenreMatrixPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [rebuilding, setRebuilding] = useState(false);
  const [banner, setBanner] = useState<string | null>(null);

  // Two-Method Blend Controls
  const [useLastfm, setUseLastfm] = useState(false);
  const [lastfmWeight, setLastfmWeight] = useState(20);

  // Full-Screen Pop-Out State
  const [showFullScreen, setShowFullScreen] = useState(false);
  const [fullMode, setFullMode] = useState<'genre' | 'artist'>('genre');
  const [genreSearch, setGenreSearch] = useState('');

  // Subgenre Map ECU Cell Editor
  const [selectedCell, setSelectedCell] = useState<{
    genreX: string;
    genreY: string;
    similarity: number;
    isUserLocked: boolean;
  } | null>(null);
  const [trimInput, setTrimInput] = useState('0.550');
  const [lockInput, setLockInput] = useState(true);

  // Read-Only Artist Map Slice State
  const [artistMapGenre, setArtistMapGenre] = useState('emo');
  const [artistMapMin, setArtistMapMin] = useState(0.55);
  const [artistMapFilter, setArtistMapFilter] = useState('');
  const [artistSlice, setArtistSlice] = useState<ArtistSimilaritySlicePayload | null>(null);
  const [loadingSlice, setLoadingSlice] = useState(false);
  const [inspectedArtistCell, setInspectedArtistCell] = useState<{
    artistX: string;
    artistY: string;
    combined: number;
    localSim: number;
    lastfmSim: number;
  } | null>(null);

  // Virtualized 2D viewport tracking for Full-Screen Matrix
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const [viewportScroll, setViewportScroll] = useState({ top: 0, left: 0, width: 1100, height: 620 });

  // In-Prefs Live Artist Scene Tester
  const [testGenre, setTestGenre] = useState('emo');
  const [artistQuery, setArtistQuery] = useState('');
  const [testResults, setTestResults] = useState<ArtistSceneScoreResult[]>([]);
  const [testingArtists, setTestingArtists] = useState(false);

  const loadMatrix = async () => {
    setLoading(true);
    try {
      const data = await invokeRpc<GenreMatrixPayload>('genreMatrix:get', {
        search: '',
        limit: 0,
      });
      setMatrix(data);
      setUseLastfm(data.hasLastfmApiKey ? data.genreMapUseLastfm : false);
      setLastfmWeight(data.hasLastfmApiKey ? data.genreMapLastfmWeight ?? 20 : 0);
      if (data.genres.length > 0 && !data.genres.some((g) => g.genre === artistMapGenre)) {
        setArtistMapGenre(data.genres[0].genre);
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadMatrix();
  }, []);

  const runArtistTest = async () => {
    if (!testGenre.trim()) return;
    setTestingArtists(true);
    try {
      const rows = await invokeRpc<ArtistSceneScoreResult[]>('genreMatrix:testArtists', {
        targetGenre: testGenre.trim(),
        artistQuery: artistQuery.trim(),
        minScore: artistQuery.trim() ? 0 : 0.25,
        limit: 30,
      });
      setTestResults(Array.isArray(rows) ? rows : []);
    } finally {
      setTestingArtists(false);
    }
  };

  useEffect(() => {
    const t = setTimeout(() => {
      void runArtistTest();
    }, 120);
    return () => clearTimeout(t);
  }, [testGenre, artistQuery]);

  const loadArtistSlice = async () => {
    if (!artistMapGenre.trim()) return;
    setLoadingSlice(true);
    try {
      const data = await invokeRpc<ArtistSimilaritySlicePayload>('genreMatrix:getArtistSlice', {
        targetGenre: artistMapGenre.trim(),
        minThreshold: artistMapMin,
        artistFilter: artistMapFilter.trim(),
        useLastfm: matrix?.hasLastfmApiKey ? useLastfm : false,
        lastfmWeight: matrix?.hasLastfmApiKey ? lastfmWeight : 0,
        maxArtists: 140,
      });
      setArtistSlice(data);
      setInspectedArtistCell(null);
    } finally {
      setLoadingSlice(false);
    }
  };

  useEffect(() => {
    if (!showFullScreen || fullMode !== 'artist') return;
    const t = setTimeout(() => {
      void loadArtistSlice();
    }, 100);
    return () => clearTimeout(t);
  }, [showFullScreen, fullMode, artistMapGenre, artistMapMin, artistMapFilter, useLastfm, lastfmWeight]);

  useEffect(() => {
    if (!showFullScreen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setShowFullScreen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [showFullScreen]);

  useEffect(() => {
    if (!showFullScreen) return;
    const el = scrollContainerRef.current;
    if (!el) return;
    const updateSize = () => {
      setViewportScroll({
        top: el.scrollTop,
        left: el.scrollLeft,
        width: el.clientWidth || 1100,
        height: el.clientHeight || 620,
      });
    };
    updateSize();
    window.addEventListener('resize', updateSize);
    return () => window.removeEventListener('resize', updateSize);
  }, [showFullScreen, fullMode]);

  const cellLookup = useMemo(() => {
    const map = new Map<string, MatrixCell>();
    for (const c of matrix?.cells || []) {
      map.set(`${c.genreX}|||${c.genreY}`, c);
    }
    return map;
  }, [matrix]);

  const filteredGenres = useMemo(() => {
    const all = matrix?.genres || [];
    const q = genreSearch.trim().toLowerCase();
    if (!q) return all;
    return all.filter((g) => g.genre.toLowerCase().includes(q));
  }, [matrix, genreSearch]);

  const handleRebuild = async () => {
    setRebuilding(true);
    try {
      const hasKey = Boolean(matrix?.hasLastfmApiKey);
      const res = await invokeRpc<{
        artistsWeighted: number;
        totalLibraryArtists: number;
        genresIndexed: number;
        cellsStored: number;
        lockedCellsPreserved: number;
        effectiveLastfmWeight: number;
        elapsedMs: number;
      }>('genreMatrix:rebuild', {
        useLastfm: hasKey ? useLastfm : false,
        lastfmWeight: hasKey ? lastfmWeight : 0,
      });
      setBanner(
        `Indexed ${res.totalLibraryArtists.toLocaleString()} library artists & ${res.genresIndexed.toLocaleString()} genres (${res.cellsStored.toLocaleString()} cells, Last.fm ${Math.round(res.effectiveLastfmWeight * 100)}%, ${res.lockedCellsPreserved} locked preserved) in ${res.elapsedMs}ms.`
      );
      await loadMatrix();
      await runArtistTest();
      if (showFullScreen && fullMode === 'artist') {
        await loadArtistSlice();
      }
    } finally {
      setRebuilding(false);
    }
  };

  const handleApplyCell = async () => {
    if (!selectedCell) return;
    const val = Math.max(0, Math.min(1, Number(trimInput) || 0));
    await invokeRpc('genreMatrix:setCell', {
      genreX: selectedCell.genreX,
      genreY: selectedCell.genreY,
      similarity: val,
      isLocked: lockInput,
    });
    setBanner(
      `Trimmed "${selectedCell.genreX}" ↔ "${selectedCell.genreY}" = ${val.toFixed(3)}${lockInput ? ' [LOCKED]' : ''}.`
    );
    setSelectedCell({ ...selectedCell, similarity: val, isUserLocked: lockInput });
    await loadMatrix();
    await runArtistTest();
  };

  const handleResetCell = async () => {
    if (!selectedCell) return;
    await invokeRpc('genreMatrix:resetCell', {
      genreX: selectedCell.genreX,
      genreY: selectedCell.genreY,
    });
    setBanner(`Unlocked & recalculated "${selectedCell.genreX}" ↔ "${selectedCell.genreY}".`);
    setSelectedCell(null);
    await loadMatrix();
    await runArtistTest();
  };

  const hasLastfmKey = Boolean(matrix?.hasLastfmApiKey);

  // Compute virtualized visible window for active axis list
  const axisItems =
    fullMode === 'genre'
      ? filteredGenres.map((g) => ({
          key: g.genre,
          label: g.genre,
          subtitle: `${g.artistCount} artists`,
        }))
      : (artistSlice?.artists || []).map((a) => ({
          key: a.artistKey,
          label: a.artistName,
          subtitle: `Score ${a.sceneScore.toFixed(3)}`,
        }));

  const axisCount = axisItems.length;
  const visibleRowStart = Math.max(0, Math.floor(viewportScroll.top / CELL_H) - 3);
  const visibleRowEnd = Math.min(
    axisCount,
    Math.ceil((viewportScroll.top + viewportScroll.height) / CELL_H) + 4
  );
  const visibleColStart = Math.max(0, Math.floor(viewportScroll.left / CELL_W) - 2);
  const visibleColEnd = Math.min(
    axisCount,
    Math.ceil((viewportScroll.left + viewportScroll.width) / CELL_W) + 3
  );

  const visibleRowIndices: number[] = [];
  for (let r = visibleRowStart; r < visibleRowEnd; r++) visibleRowIndices.push(r);
  const visibleColIndices: number[] = [];
  for (let c = visibleColStart; c < visibleColEnd; c++) visibleColIndices.push(c);

  const fullScreenOverlay =
    showFullScreen &&
    createPortal(
      <div
        style={{
          position: 'fixed',
          inset: 0,
          width: '100vw',
          height: '100vh',
          zIndex: 9999,
          background: '#cfd6e2',
          display: 'flex',
          flexDirection: 'column',
          fontFamily: 'var(--font-sans, "Lucida Grande", sans-serif)',
        }}
      >
        {/* Brushed Metal Full-Screen Header */}
        <div
          style={{
            background: 'linear-gradient(180deg, #e5eaf1 0%, #bcc5d4 100%)',
            borderBottom: '1px solid #7d8796',
            padding: '10px 18px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            flexWrap: 'wrap',
            gap: 12,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <strong style={{ fontSize: 13.5, color: '#0f172a', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <Grid size={15} color="#1d4ed8" />
              Full-Screen Similarity Matrix
            </strong>

            <div style={{ display: 'inline-flex', background: '#cbd5e1', borderRadius: 6, padding: 2, gap: 2 }}>
              <button
                className={`aqua-btn ${fullMode === 'genre' ? 'primary' : ''}`}
                style={{ padding: '3px 10px', fontSize: 11.5 }}
                onClick={() => {
                  setFullMode('genre');
                  if (scrollContainerRef.current) {
                    scrollContainerRef.current.scrollTop = 0;
                    scrollContainerRef.current.scrollLeft = 0;
                  }
                }}
              >
                <Grid size={12} /> Subgenre Map ({matrix?.totalGenresIndexed ?? 0} × {matrix?.totalGenresIndexed ?? 0})
              </button>
              <button
                className={`aqua-btn ${fullMode === 'artist' ? 'primary' : ''}`}
                style={{ padding: '3px 10px', fontSize: 11.5 }}
                onClick={() => {
                  setFullMode('artist');
                  if (scrollContainerRef.current) {
                    scrollContainerRef.current.scrollTop = 0;
                    scrollContainerRef.current.scrollLeft = 0;
                  }
                }}
              >
                <Users size={12} /> Artist Map (Read-Only)
              </button>
            </div>
          </div>

          {/* Mode-Specific Controls */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            {fullMode === 'genre' ? (
              <>
                <div style={{ position: 'relative' }}>
                  <Search size={12} style={{ position: 'absolute', left: 8, top: 7, color: '#64748b' }} />
                  <input
                    className="aqua-input"
                    style={{ width: 210, paddingLeft: 25 }}
                    placeholder="Filter Genres..."
                    value={genreSearch}
                    onChange={(e) => {
                      setGenreSearch(e.target.value);
                      if (scrollContainerRef.current) {
                        scrollContainerRef.current.scrollTop = 0;
                        scrollContainerRef.current.scrollLeft = 0;
                      }
                    }}
                  />
                </div>
                <span style={{ fontSize: 11, color: '#334155', fontWeight: 600 }}>
                  Showing {filteredGenres.length} of {matrix?.totalGenresIndexed ?? 0} genres
                </span>
              </>
            ) : (
              <>
                <label style={{ fontSize: 11, fontWeight: 600 }}>Genre:</label>
                <select
                  className="aqua-input"
                  style={{ width: 170 }}
                  value={artistMapGenre}
                  onChange={(e) => setArtistMapGenre(e.target.value)}
                >
                  {(matrix?.genres || []).map((g) => (
                    <option key={g.genre} value={g.genre}>
                      {g.genre} ({g.artistCount})
                    </option>
                  ))}
                </select>
                <label style={{ fontSize: 11, fontWeight: 600 }}>
                  Min Scene: <code>{artistMapMin.toFixed(3)}</code>
                </label>
                <input
                  type="range"
                  min={0.1}
                  max={0.95}
                  step={0.05}
                  value={artistMapMin}
                  onChange={(e) => setArtistMapMin(Number(e.target.value))}
                  style={{ width: 110 }}
                />
                <div style={{ position: 'relative' }}>
                  <Search size={12} style={{ position: 'absolute', left: 8, top: 7, color: '#64748b' }} />
                  <input
                    className="aqua-input"
                    style={{ width: 165, paddingLeft: 25 }}
                    placeholder="Filter Artists..."
                    value={artistMapFilter}
                    onChange={(e) => setArtistMapFilter(e.target.value)}
                  />
                </div>
                <span style={{ fontSize: 11, color: '#334155', fontWeight: 600 }}>
                  {artistSlice
                    ? `${artistSlice.artists.length} / ${artistSlice.totalMatchedArtists} artists (${artistSlice.elapsedMs}ms)`
                    : 'Computing...'}
                </span>
              </>
            )}

            <button className="aqua-btn primary" onClick={handleRebuild} disabled={rebuilding}>
              <RefreshCw size={12} /> {rebuilding ? 'Rebuilding...' : 'Rebuild Matrix'}
            </button>
            <button className="aqua-btn" onClick={() => setShowFullScreen(false)}>
              <X size={13} /> Close Map
            </button>
          </div>
        </div>

        {/* Subgenre Trim Bar OR Read-Only Artist Inspector Bar */}
        <div
          style={{
            background: '#edf2f7',
            borderBottom: '1px solid #9da6b4',
            padding: '7px 18px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            minHeight: 38,
            gap: 10,
            flexWrap: 'wrap',
          }}
        >
          {fullMode === 'genre' ? (
            selectedCell ? (
              <>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 12 }}>
                  <Sliders size={13} color="#1d4ed8" />
                  <strong>
                    {selectedCell.genreX} ↔ {selectedCell.genreY}
                  </strong>
                  <span style={{ color: '#475569' }}>
                    Current: <code>{selectedCell.similarity.toFixed(3)}</code>
                  </span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <label style={{ fontSize: 11.5, fontWeight: 600 }}>Trim (0.000–1.000):</label>
                  <input
                    type="number"
                    min={0}
                    max={1}
                    step={0.005}
                    className="aqua-input"
                    style={{ width: 84, fontFamily: 'var(--font-mono)' }}
                    value={trimInput}
                    disabled={selectedCell.genreX === selectedCell.genreY}
                    onChange={(e) => setTrimInput(e.target.value)}
                  />
                  <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11.5 }}>
                    <input
                      type="checkbox"
                      checked={lockInput}
                      disabled={selectedCell.genreX === selectedCell.genreY}
                      onChange={(e) => setLockInput(e.target.checked)}
                    />
                    <Lock size={11} /> Lock Cell
                  </label>
                  <button
                    className="aqua-btn primary"
                    disabled={selectedCell.genreX === selectedCell.genreY}
                    onClick={handleApplyCell}
                  >
                    Apply Cell
                  </button>
                  {selectedCell.isUserLocked && selectedCell.genreX !== selectedCell.genreY && (
                    <button className="aqua-btn" onClick={handleResetCell}>
                      <RotateCcw size={11} /> Reset to Auto
                    </button>
                  )}
                </div>
              </>
            ) : (
              <div style={{ fontSize: 11.5, color: '#475569' }}>
                Click any subgenre cell below to edit its <code>0.000–1.000</code> weight, toggle <strong>Lock Cell</strong>, or <strong>Reset to Auto</strong>. Press <code>Esc</code> to close.
              </div>
            )
          ) : inspectedArtistCell ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 16, fontSize: 12, color: '#0f172a' }}>
              <span className="aqua-coming-soon-pill" style={{ background: '#e2e8f0', color: '#334155' }}>
                READ-ONLY ARTIST MATRIX
              </span>
              <strong>
                {inspectedArtistCell.artistX} ↔ {inspectedArtistCell.artistY}
              </strong>
              <span>
                Combined Similarity: <code>{inspectedArtistCell.combined.toFixed(3)}</code>
              </span>
              <span>
                Genre Bridge Score ({Math.round((1 - (artistSlice?.effectiveLastfmWeight || 0)) * 100)}%):{' '}
                <code>{inspectedArtistCell.localSim.toFixed(3)}</code>
              </span>
              <span>
                Last.fm Graph Score ({Math.round((artistSlice?.effectiveLastfmWeight || 0) * 100)}%):{' '}
                <code>{inspectedArtistCell.lastfmSim.toFixed(3)}</code>
              </span>
            </div>
          ) : (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 11.5, color: '#475569' }}>
              <span className="aqua-coming-soon-pill" style={{ background: '#e2e8f0', color: '#334155' }}>
                READ-ONLY
              </span>
              <span>
                Computed in memory for <strong>{artistMapGenre}</strong> (threshold ≥ {artistMapMin.toFixed(3)}, Last.fm weight {Math.round((artistSlice?.effectiveLastfmWeight || 0) * 100)}%). Click or hover any cell to inspect its Genre Bridge vs. Last.fm breakdown.
              </span>
            </div>
          )}
        </div>

        {/* 2D Virtualized Full-Viewport Heatmap Grid */}
        <div
          ref={scrollContainerRef}
          onScroll={(e) => {
            const el = e.currentTarget;
            setViewportScroll({
              top: el.scrollTop,
              left: el.scrollLeft,
              width: el.clientWidth,
              height: el.clientHeight,
            });
          }}
          style={{
            flex: 1,
            overflow: 'auto',
            position: 'relative',
            background: '#f8fafc',
          }}
        >
          {fullMode === 'artist' && loadingSlice && !artistSlice ? (
            <div style={{ padding: 40, textAlign: 'center', color: '#475569', fontSize: 13 }}>
              Computing on-the-fly artist similarity matrix for &ldquo;{artistMapGenre}&rdquo;...
            </div>
          ) : axisCount === 0 ? (
            <div style={{ padding: 40, textAlign: 'center', color: '#64748b', fontSize: 13 }}>
              No matching {fullMode === 'genre' ? 'genres' : 'artists at this threshold'} found.
            </div>
          ) : (
            <div
              style={{
                width: ROW_HEADER_W + axisCount * CELL_W,
                height: COL_HEADER_H + axisCount * CELL_H,
                position: 'relative',
              }}
            >
              {/* Sticky Top Column Header Bar */}
              <div
                style={{
                  position: 'sticky',
                  top: 0,
                  left: 0,
                  width: ROW_HEADER_W + axisCount * CELL_W,
                  height: COL_HEADER_H,
                  zIndex: 25,
                }}
              >
                <div
                  style={{
                    position: 'sticky',
                    left: 0,
                    width: ROW_HEADER_W,
                    height: COL_HEADER_H,
                    zIndex: 30,
                    background: '#cbd5e1',
                    borderRight: '1px solid #94a3b8',
                    borderBottom: '1px solid #94a3b8',
                    display: 'flex',
                    alignItems: 'center',
                    padding: '0 8px',
                    fontSize: 10.5,
                    fontWeight: 700,
                    color: '#1e293b',
                    boxSizing: 'border-box',
                  }}
                >
                  {fullMode === 'genre' ? 'Subgenre Y \\ X' : 'Artist Y \\ X'}
                </div>

                {visibleColIndices.map((ci) => {
                  const item = axisItems[ci];
                  return (
                    <div
                      key={`col-${item.key}`}
                      title={`${item.label} (${item.subtitle})`}
                      style={{
                        position: 'absolute',
                        top: 0,
                        left: ROW_HEADER_W + ci * CELL_W,
                        width: CELL_W,
                        height: COL_HEADER_H,
                        background:
                          fullMode === 'genre' && testGenre === item.key ? '#bfdbfe' : '#e2e8f0',
                        borderRight: '1px solid #cbd5e1',
                        borderBottom: '1px solid #94a3b8',
                        padding: '0 4px',
                        fontSize: 10,
                        fontWeight: 700,
                        color: '#1e293b',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                        boxSizing: 'border-box',
                      }}
                    >
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{item.label}</span>
                    </div>
                  );
                })}
              </div>

              {/* Virtualized Rows with Sticky Left Row Header */}
              {visibleRowIndices.map((ri) => {
                const rowItem = axisItems[ri];
                const topPx = COL_HEADER_H + ri * CELL_H;
                return (
                  <div
                    key={`row-${rowItem.key}`}
                    style={{
                      position: 'absolute',
                      top: topPx,
                      left: 0,
                      width: ROW_HEADER_W + axisCount * CELL_W,
                      height: CELL_H,
                    }}
                  >
                    <div
                      title={`${rowItem.label} (${rowItem.subtitle})`}
                      style={{
                        position: 'sticky',
                        left: 0,
                        width: ROW_HEADER_W,
                        height: CELL_H,
                        zIndex: 15,
                        background:
                          fullMode === 'genre' && testGenre === rowItem.key ? '#bfdbfe' : '#e2e8f0',
                        borderRight: '1px solid #94a3b8',
                        borderBottom: '1px solid #cbd5e1',
                        padding: '0 8px',
                        fontSize: 10.5,
                        fontWeight: 600,
                        color: '#0f172a',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        gap: 4,
                        boxSizing: 'border-box',
                      }}
                    >
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {rowItem.label}
                      </span>
                      <span style={{ fontSize: 9, color: '#64748b', flexShrink: 0 }}>
                        {fullMode === 'artist' ? rowItem.subtitle.replace('Score ', '') : ''}
                      </span>
                    </div>

                    {visibleColIndices.map((ci) => {
                      const colItem = axisItems[ci];
                      const isDiag = ri === ci;
                      let sim = 0;
                      let locked = false;
                      let localVal = 0;
                      let lastfmVal = 0;

                      if (fullMode === 'genre') {
                        const cell = cellLookup.get(`${colItem.key}|||${rowItem.key}`);
                        sim = isDiag ? 1.0 : cell ? cell.similarity : 0;
                        locked = cell?.isUserLocked || false;
                      } else if (artistSlice) {
                        sim = artistSlice.combinedMatrix[ri]?.[ci] ?? (isDiag ? 1 : 0);
                        localVal = artistSlice.localMatrix[ri]?.[ci] ?? (isDiag ? 1 : 0);
                        lastfmVal = artistSlice.lastfmMatrix[ri]?.[ci] ?? (isDiag ? 1 : 0);
                      }

                      const colors = getHeatColor(sim, isDiag);
                      const isSelected =
                        fullMode === 'genre' &&
                        selectedCell &&
                        ((selectedCell.genreX === colItem.key && selectedCell.genreY === rowItem.key) ||
                          (selectedCell.genreX === rowItem.key && selectedCell.genreY === colItem.key));

                      return (
                        <div
                          key={`c-${ri}-${ci}`}
                          title={
                            fullMode === 'genre'
                              ? `${rowItem.label} ↔ ${colItem.label}: ${sim.toFixed(3)}${locked ? ' [LOCKED]' : ''}`
                              : `${rowItem.label} ↔ ${colItem.label} | Combined: ${sim.toFixed(3)} | Genre Bridge: ${localVal.toFixed(3)} | Last.fm: ${lastfmVal.toFixed(3)}`
                          }
                          onClick={() => {
                            if (fullMode === 'genre') {
                              setSelectedCell({
                                genreX: colItem.key,
                                genreY: rowItem.key,
                                similarity: sim,
                                isUserLocked: locked,
                              });
                              setTrimInput(sim.toFixed(3));
                              setLockInput(true);
                              setTestGenre(rowItem.key);
                            } else {
                              setInspectedArtistCell({
                                artistX: rowItem.label,
                                artistY: colItem.label,
                                combined: sim,
                                localSim: localVal,
                                lastfmSim: lastfmVal,
                              });
                            }
                          }}
                          onMouseEnter={() => {
                            if (fullMode === 'artist') {
                              setInspectedArtistCell({
                                artistX: rowItem.label,
                                artistY: colItem.label,
                                combined: sim,
                                localSim: localVal,
                                lastfmSim: lastfmVal,
                              });
                            }
                          }}
                          style={{
                            position: 'absolute',
                            top: 0,
                            left: ROW_HEADER_W + ci * CELL_W,
                            width: CELL_W - 1,
                            height: CELL_H - 1,
                            background: colors.bg,
                            color: colors.fg,
                            fontFamily: 'var(--font-mono)',
                            fontSize: 10.5,
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            cursor: 'pointer',
                            outline: isSelected ? '2px solid #f59e0b' : undefined,
                            boxSizing: 'border-box',
                            userSelect: 'none',
                          }}
                        >
                          {sim.toFixed(3)}
                          {locked && !isDiag && (
                            <span
                              style={{
                                position: 'absolute',
                                top: 2,
                                right: 2,
                                width: 5,
                                height: 5,
                                borderRadius: '50%',
                                background: '#f59e0b',
                              }}
                            />
                          )}
                        </div>
                      );
                    })}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>,
      document.body
    );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {/* Prefs -> Genre & Artist Map Summary + Pop-Out Button */}
      <div className="epod-capacity-card">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10 }}>
          <div>
            <strong style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <Grid size={14} color="#1d4ed8" />
              Full-Library Self-Tuning Genre Map &amp; Artist Similarity Engine
            </strong>
            <div style={{ fontSize: 11.5, color: '#334155', marginTop: 4, display: 'flex', gap: 14, flexWrap: 'wrap' }}>
              <span>
                <strong>Artists Indexed:</strong>{' '}
                {matrix ? `${matrix.totalArtistsWeighted.toLocaleString()} / ${matrix.totalLibraryArtists.toLocaleString()}` : '—'}
              </span>
              <span>
                <strong>Total Library Genres (N × N):</strong>{' '}
                {matrix ? matrix.totalGenresIndexed.toLocaleString() : '—'}
              </span>
              <span>
                <strong>Stored Genre Cells:</strong>{' '}
                {matrix ? matrix.totalCellsStored.toLocaleString() : '—'}
              </span>
            </div>
          </div>

          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <button
              className="aqua-btn primary"
              onClick={() => {
                setFullMode('genre');
                setShowFullScreen(true);
              }}
              disabled={loading && !matrix}
            >
              <Maximize2 size={12} /> Open Full-Screen Similarity Map
            </button>
            <button className="aqua-btn" onClick={handleRebuild} disabled={rebuilding}>
              <RefreshCw size={12} /> {rebuilding ? 'Rebuilding...' : 'Rebuild Matrix'}
            </button>
          </div>
        </div>

        {/* Two-Method Tuning Controls */}
        <div
          style={{
            marginTop: 12,
            paddingTop: 10,
            borderTop: '1px solid #e2e8f0',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            flexWrap: 'wrap',
            gap: 10,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <label
              title={!hasLastfmKey ? 'Requires Last.fm API Key in Store & API Keys' : undefined}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                fontSize: 11.5,
                fontWeight: 600,
                color: hasLastfmKey ? '#1e293b' : '#94a3b8',
                cursor: hasLastfmKey ? 'pointer' : 'not-allowed',
              }}
            >
              <input
                type="checkbox"
                checked={hasLastfmKey ? useLastfm : false}
                disabled={!hasLastfmKey}
                onChange={(e) => setUseLastfm(e.target.checked)}
              />
              Include Last.fm Similar Artist Graph
            </label>

            <div
              title={!hasLastfmKey ? 'Requires Last.fm API Key in Store & API Keys' : undefined}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                opacity: hasLastfmKey && useLastfm ? 1 : 0.5,
              }}
            >
              <span style={{ fontSize: 11, fontWeight: 600 }}>Last.fm Weight:</span>
              <input
                type="range"
                min={0}
                max={100}
                step={5}
                disabled={!hasLastfmKey || !useLastfm}
                value={hasLastfmKey ? lastfmWeight : 0}
                onChange={(e) => setLastfmWeight(Number(e.target.value))}
                style={{ width: 95 }}
              />
              <input
                type="number"
                min={0}
                max={100}
                className="aqua-input"
                style={{ width: 52, fontFamily: 'var(--font-mono)' }}
                disabled={!hasLastfmKey || !useLastfm}
                value={hasLastfmKey ? lastfmWeight : 0}
                onChange={(e) => setLastfmWeight(Math.max(0, Math.min(100, Number(e.target.value) || 0)))}
              />
              <span style={{ fontSize: 11 }}>%</span>
              <button
                className="aqua-btn"
                style={{ padding: '2px 7px', fontSize: 10.5 }}
                disabled={!hasLastfmKey}
                onClick={() => {
                  setUseLastfm(true);
                  setLastfmWeight(100);
                }}
              >
                100% Standalone
              </button>
            </div>
          </div>

          {!hasLastfmKey && (
            <span
              className="aqua-coming-soon-pill"
              title="Add your Last.fm API Key in Prefs -> Store & API Keys to unlock the Last.fm similarity graph modifier."
            >
              Requires Last.fm API Key in Store &amp; API Keys (Running 100% Local Method 1)
            </span>
          )}
        </div>

        {banner && (
          <div style={{ marginTop: 8, fontSize: 11, color: '#15803d', fontWeight: 600 }}>
            {banner}
          </div>
        )}
      </div>

      {/* Live Artist Scene Tester (kept directly in Prefs) */}
      <div className="epod-capacity-card">
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            flexWrap: 'wrap',
            gap: 8,
            marginBottom: 8,
          }}
        >
          <strong>Live Artist Scene Tester</strong>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            <label style={{ fontSize: 11 }}>Target Genre:</label>
            <input
              className="aqua-input"
              style={{ width: 130 }}
              value={testGenre}
              onChange={(e) => setTestGenre(e.target.value)}
              placeholder="e.g. emo, punk, rap..."
            />
            <label style={{ fontSize: 11 }}>Artist Filter:</label>
            <input
              className="aqua-input"
              style={{ width: 165 }}
              value={artistQuery}
              onChange={(e) => setArtistQuery(e.target.value)}
              placeholder="Test Artist against Genre..."
            />
            <button className="aqua-btn" onClick={runArtistTest} disabled={testingArtists}>
              {testingArtists ? 'Scoring...' : 'Score'}
            </button>
            <button
              className="aqua-btn"
              onClick={() => {
                if (testGenre.trim()) setArtistMapGenre(testGenre.trim().toLowerCase());
                setFullMode('artist');
                setShowFullScreen(true);
              }}
            >
              <Users size={11} /> View Artist Map
            </button>
          </div>
        </div>

        <div
          style={{
            maxHeight: 240,
            overflowY: 'auto',
            border: '1px solid #cbd5e1',
            borderRadius: 4,
            background: '#fff',
          }}
        >
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
            <thead>
              <tr style={{ background: '#f1f5f9', borderBottom: '1px solid #cbd5e1', textAlign: 'left' }}>
                <th style={{ padding: '5px 8px' }}>Artist</th>
                <th style={{ padding: '5px 8px', width: 95 }}>Scene Score</th>
                <th style={{ padding: '5px 8px' }}>Artist-Level Tag Bridges</th>
              </tr>
            </thead>
            <tbody>
              {testResults.length === 0 ? (
                <tr>
                  <td colSpan={3} style={{ padding: 12, textAlign: 'center', color: '#64748b' }}>
                    No artists matched for &ldquo;{testGenre}&rdquo;.
                  </td>
                </tr>
              ) : (
                testResults.map((r) => (
                  <tr key={r.artistKey} style={{ borderBottom: '1px solid #f1f5f9' }}>
                    <td style={{ padding: '5px 8px', fontWeight: 600 }}>{r.artistName}</td>
                    <td
                      style={{
                        padding: '5px 8px',
                        fontFamily: 'var(--font-mono)',
                        fontWeight: 700,
                        color: r.score >= 0.55 ? '#15803d' : r.score >= 0.25 ? '#0369a1' : '#64748b',
                      }}
                    >
                      {r.score.toFixed(3)}
                    </td>
                    <td style={{ padding: '5px 8px', color: '#475569', fontSize: 10.5 }}>
                      {r.topTags.length === 0
                        ? 'No hydrated genre tags'
                        : r.topTags
                            .slice(0, 4)
                            .map((t) => `${t.tag} (${t.weight.toFixed(2)}×${t.matrixSim.toFixed(2)})`)
                            .join(' • ')}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {fullScreenOverlay}
    </div>
  );
};
