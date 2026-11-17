import React, { useEffect, useMemo, useState } from 'react';
import { Grid, Lock, RefreshCw, RotateCcw, Search, Sliders } from 'lucide-react';
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
  totalCellsStored: number;
}

interface ArtistSceneScoreResult {
  artistName: string;
  artistKey: string;
  targetGenre: string;
  score: number;
  topTags: { tag: string; weight: number; matrixSim: number; contribution: number }[];
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

export const GenreMapTab: React.FC = () => {
  const [search, setSearch] = useState('');
  const [axisLimit, setAxisLimit] = useState(14);
  const [matrix, setMatrix] = useState<GenreMatrixPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [rebuilding, setRebuilding] = useState(false);
  const [banner, setBanner] = useState<string | null>(null);

  // Selected ECU cell editor state
  const [selectedCell, setSelectedCell] = useState<{
    genreX: string;
    genreY: string;
    similarity: number;
    isUserLocked: boolean;
  } | null>(null);
  const [trimInput, setTrimInput] = useState('0.550');
  const [lockInput, setLockInput] = useState(true);

  // Live Artist Tester state
  const [testGenre, setTestGenre] = useState('emo');
  const [artistQuery, setArtistQuery] = useState('');
  const [testResults, setTestResults] = useState<ArtistSceneScoreResult[]>([]);
  const [testingArtists, setTestingArtists] = useState(false);

  const loadMatrix = async () => {
    setLoading(true);
    try {
      const data = await invokeRpc<GenreMatrixPayload>('genreMatrix:get', {
        search: search.trim(),
        limit: axisLimit,
      });
      setMatrix(data);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    const t = setTimeout(() => {
      void loadMatrix();
    }, 100);
    return () => clearTimeout(t);
  }, [search, axisLimit]);

  const runArtistTest = async () => {
    if (!testGenre.trim()) return;
    setTestingArtists(true);
    try {
      const rows = await invokeRpc<ArtistSceneScoreResult[]>('genreMatrix:testArtists', {
        targetGenre: testGenre.trim(),
        artistQuery: artistQuery.trim(),
        minScore: artistQuery.trim() ? 0 : 0.25,
        limit: 25,
      });
      setTestResults(Array.isArray(rows) ? rows : []);
    } finally {
      setTestingArtists(false);
    }
  };

  useEffect(() => {
    const t = setTimeout(() => {
      void runArtistTest();
    }, 140);
    return () => clearTimeout(t);
  }, [testGenre, artistQuery]);

  const cellLookup = useMemo(() => {
    const map = new Map<string, MatrixCell>();
    for (const c of matrix?.cells || []) {
      map.set(`${c.genreX}|||${c.genreY}`, c);
    }
    return map;
  }, [matrix]);

  const handleRebuild = async () => {
    setRebuilding(true);
    try {
      const res = await invokeRpc<{
        artistsWeighted: number;
        genresIndexed: number;
        cellsStored: number;
        lockedCellsPreserved: number;
        elapsedMs: number;
      }>('genreMatrix:rebuild');
      setBanner(
        `Rebuilt ${res.genresIndexed}×${res.genresIndexed} Genre Map (${res.cellsStored} cells, ${res.artistsWeighted} artists, ${res.lockedCellsPreserved} locked preserved) in ${res.elapsedMs}ms.`
      );
      await loadMatrix();
      await runArtistTest();
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

  const genres = matrix?.genres || [];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {/* Header Controls */}
      <div className="epod-capacity-card">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
          <div>
            <strong style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <Grid size={14} color="#1d4ed8" />
              2D Subgenre Adjacency Matrix (&ldquo;Genre Map&rdquo;)
            </strong>
            <div style={{ fontSize: 11, color: '#475569', marginTop: 2 }}>
              Artist-level subgenre crossover weights (0.000–1.000).{' '}
              {matrix
                ? `${matrix.totalArtistsWeighted.toLocaleString()} artists indexed • ${matrix.totalCellsStored.toLocaleString()} stored cells`
                : ''}
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <div style={{ position: 'relative' }}>
              <Search size={12} style={{ position: 'absolute', left: 7, top: 7, color: '#64748b' }} />
              <input
                className="aqua-input"
                style={{ width: 155, paddingLeft: 23 }}
                placeholder="Filter subgenres..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
            <select
              className="aqua-input"
              value={axisLimit}
              onChange={(e) => setAxisLimit(Number(e.target.value))}
            >
              <option value={10}>10 × 10 Grid</option>
              <option value={14}>14 × 14 Grid</option>
              <option value={20}>20 × 20 Grid</option>
              <option value={26}>26 × 26 Grid</option>
            </select>
            <button className="aqua-btn primary" onClick={handleRebuild} disabled={rebuilding}>
              <RefreshCw size={12} /> {rebuilding ? 'Rebuilding...' : 'Rebuild Matrix'}
            </button>
          </div>
        </div>

        {banner && (
          <div style={{ marginTop: 8, fontSize: 11, color: '#15803d', fontWeight: 600 }}>
            {banner}
          </div>
        )}
      </div>

      {/* ECU Click-to-Trim & Lock Bar */}
      <div
        className="epod-capacity-card"
        style={{
          background: selectedCell ? '#eef6ff' : '#f8fafc',
          borderColor: selectedCell ? '#60a5fa' : undefined,
        }}
      >
        {selectedCell ? (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11.5 }}>
              <Sliders size={13} color="#1d4ed8" />
              <strong>
                {selectedCell.genreX} ↔ {selectedCell.genreY}
              </strong>
              <span style={{ color: '#475569' }}>
                Current: <code>{selectedCell.similarity.toFixed(3)}</code>
              </span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <label style={{ fontSize: 11, fontWeight: 600 }}>Trim:</label>
              <input
                type="number"
                min={0}
                max={1}
                step={0.005}
                className="aqua-input"
                style={{ width: 78, fontFamily: 'var(--font-mono)' }}
                value={trimInput}
                disabled={selectedCell.genreX === selectedCell.genreY}
                onChange={(e) => setTrimInput(e.target.value)}
              />
              <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11 }}>
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
                  <RotateCcw size={11} /> Reset Lock
                </button>
              )}
            </div>
          </div>
        ) : (
          <div style={{ fontSize: 11, color: '#64748b' }}>
            Click any cell in the 2D heatmap below to inspect, trim (0.000–1.000), or lock its crossover weight against auto-rebuilds.
          </div>
        )}
      </div>

      {/* 2D Heatmap Table */}
      <div
        className="epod-capacity-card"
        style={{ padding: 8, overflowX: 'auto', maxHeight: 280, overflowY: 'auto' }}
      >
        {loading && !matrix ? (
          <div style={{ padding: 20, textAlign: 'center', color: '#64748b', fontSize: 12 }}>
            Loading Genre Map matrix...
          </div>
        ) : genres.length === 0 ? (
          <div style={{ padding: 20, textAlign: 'center', color: '#64748b', fontSize: 12 }}>
            No matching subgenres found. Click &ldquo;Rebuild Matrix&rdquo; or broaden your filter.
          </div>
        ) : (
          <table
            style={{
              borderCollapse: 'separate',
              borderSpacing: 2,
              fontSize: 10,
              fontFamily: 'var(--font-mono)',
            }}
          >
            <thead>
              <tr>
                <th
                  style={{
                    position: 'sticky',
                    left: 0,
                    top: 0,
                    zIndex: 3,
                    background: '#dfe5ee',
                    padding: '4px 6px',
                    textAlign: 'left',
                    borderRadius: 3,
                    minWidth: 115,
                  }}
                >
                  Subgenre Y \ X
                </th>
                {genres.map((gx) => (
                  <th
                    key={gx.genre}
                    onClick={() => setTestGenre(gx.genre)}
                    title={`${gx.genre} (${gx.artistCount} artists) — click to test artists`}
                    style={{
                      position: 'sticky',
                      top: 0,
                      zIndex: 2,
                      background: testGenre === gx.genre ? '#bfdbfe' : '#e6ebf3',
                      color: '#1e293b',
                      padding: '4px 5px',
                      borderRadius: 3,
                      minWidth: 52,
                      maxWidth: 64,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      cursor: 'pointer',
                    }}
                  >
                    {gx.genre}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {genres.map((gy) => (
                <tr key={gy.genre}>
                  <th
                    onClick={() => setTestGenre(gy.genre)}
                    title={`${gy.genre} (${gy.artistCount} artists)`}
                    style={{
                      position: 'sticky',
                      left: 0,
                      zIndex: 1,
                      background: testGenre === gy.genre ? '#bfdbfe' : '#e6ebf3',
                      color: '#1e293b',
                      padding: '4px 6px',
                      textAlign: 'left',
                      borderRadius: 3,
                      maxWidth: 125,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      cursor: 'pointer',
                    }}
                  >
                    {gy.genre}
                  </th>
                  {genres.map((gx) => {
                    const isDiag = gx.genre === gy.genre;
                    const cell = cellLookup.get(`${gx.genre}|||${gy.genre}`);
                    const sim = isDiag ? 1.0 : cell ? cell.similarity : 0;
                    const locked = cell?.isUserLocked || false;
                    const colors = getHeatColor(sim, isDiag);
                    const isSelected =
                      selectedCell &&
                      ((selectedCell.genreX === gx.genre && selectedCell.genreY === gy.genre) ||
                        (selectedCell.genreX === gy.genre && selectedCell.genreY === gx.genre));

                    return (
                      <td
                        key={`${gy.genre}__${gx.genre}`}
                        title={`${gy.genre} ↔ ${gx.genre}: ${sim.toFixed(3)}${locked ? ' [LOCKED]' : ''}`}
                        onClick={() => {
                          setSelectedCell({
                            genreX: gx.genre,
                            genreY: gy.genre,
                            similarity: sim,
                            isUserLocked: locked,
                          });
                          setTrimInput(sim.toFixed(3));
                          setLockInput(true);
                          setTestGenre(gy.genre);
                        }}
                        style={{
                          background: colors.bg,
                          color: colors.fg,
                          padding: '4px 5px',
                          textAlign: 'center',
                          borderRadius: 3,
                          cursor: 'pointer',
                          outline: isSelected ? '2px solid #f59e0b' : undefined,
                          position: 'relative',
                        }}
                      >
                        {sim.toFixed(3)}
                        {locked && !isDiag && (
                          <span
                            style={{
                              position: 'absolute',
                              top: 1,
                              right: 2,
                              width: 4,
                              height: 4,
                              borderRadius: '50%',
                              background: '#f59e0b',
                            }}
                          />
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Live Artist Tester */}
      <div className="epod-capacity-card">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8, marginBottom: 8 }}>
          <strong>Live Artist Scene Tester</strong>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <label style={{ fontSize: 11 }}>Target Genre:</label>
            <input
              className="aqua-input"
              style={{ width: 120 }}
              value={testGenre}
              onChange={(e) => setTestGenre(e.target.value)}
              placeholder="e.g. emo"
            />
            <label style={{ fontSize: 11 }}>Artist Filter:</label>
            <input
              className="aqua-input"
              style={{ width: 150 }}
              value={artistQuery}
              onChange={(e) => setArtistQuery(e.target.value)}
              placeholder="Test Artist against Genre..."
            />
            <button className="aqua-btn" onClick={runArtistTest} disabled={testingArtists}>
              {testingArtists ? 'Scoring...' : 'Score'}
            </button>
          </div>
        </div>

        <div style={{ maxHeight: 155, overflowY: 'auto', border: '1px solid #cbd5e1', borderRadius: 4, background: '#fff' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
            <thead>
              <tr style={{ background: '#f1f5f9', borderBottom: '1px solid #cbd5e1', textAlign: 'left' }}>
                <th style={{ padding: '4px 8px' }}>Artist</th>
                <th style={{ padding: '4px 8px', width: 90 }}>Scene Score</th>
                <th style={{ padding: '4px 8px' }}>Artist-Level Tag Bridges</th>
              </tr>
            </thead>
            <tbody>
              {testResults.length === 0 ? (
                <tr>
                  <td colSpan={3} style={{ padding: 10, textAlign: 'center', color: '#64748b' }}>
                    No artists matched for &ldquo;{testGenre}&rdquo;.
                  </td>
                </tr>
              ) : (
                testResults.map((r) => (
                  <tr key={r.artistKey} style={{ borderBottom: '1px solid #f1f5f9' }}>
                    <td style={{ padding: '4px 8px', fontWeight: 600 }}>{r.artistName}</td>
                    <td
                      style={{
                        padding: '4px 8px',
                        fontFamily: 'var(--font-mono)',
                        fontWeight: 700,
                        color: r.score >= 0.55 ? '#15803d' : r.score >= 0.25 ? '#0369a1' : '#64748b',
                      }}
                    >
                      {r.score.toFixed(3)}
                    </td>
                    <td style={{ padding: '4px 8px', color: '#475569', fontSize: 10.5 }}>
                      {r.topTags.length === 0
                        ? 'No artist-level tags'
                        : r.topTags
                            .slice(0, 3)
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
    </div>
  );
};
