import React, { useEffect, useState } from 'react';
import {
  Terminal,
  RefreshCw,
  Trash2,
  Copy,
  CheckCircle2,
  PlayCircle,
  Database,
  X,
} from 'lucide-react';
import { LogEntry, LogLevel, LogSubsystem } from '../types';
import { formatBytes, invokeRpc } from '../bridge';

interface DiagnosticsModalProps {
  liveEntries: LogEntry[];
  onClose: () => void;
  onCleared: () => void;
}

const SUBSYSTEMS: LogSubsystem[] = [
  'SYSTEM',
  'DB',
  'INDEXER',
  'CACHE',
  'TRANSCODE',
  'DEVICE_SYNC',
  'SMART_PLAYLIST',
  'LISTENBRAINZ',
  'LRCLIB',
  'ARR_STORE',
  'AUTH_OIDC',
  'PLAYBACK',
  'IPC',
];

export const DiagnosticsModal: React.FC<DiagnosticsModalProps> = ({
  liveEntries,
  onClose,
  onCleared,
}) => {
  const [entries, setEntries] = useState<LogEntry[]>(liveEntries);
  const [levelFilter, setLevelFilter] = useState<string>('');
  const [subsystemFilter, setSubsystemFilter] = useState<string>('');
  const [search, setSearch] = useState<string>('');
  const [logPaths, setLogPaths] = useState<{
    workspaceLogPath: string;
    sessionLogPath?: string;
    systemLogPath: string;
    sessionId?: string;
  } | null>(null);
  const [dbStats, setDbStats] = useState<{
    dbFilePath: string;
    dbSizeBytes: number;
    tracksCount: number;
    ftsCount: number;
    cachedTracksCount: number;
    videosCount: number;
    transcodedVideosCount: number;
    playlistsCount: number;
    devicesCount: number;
    pendingJobsCount: number;
  } | null>(null);
  const [copied, setCopied] = useState(false);
  const [runningSelfCheck, setRunningSelfCheck] = useState(false);

  const fetchLogsAndDiagnostics = async () => {
    const res = await invokeRpc<{
      entries: LogEntry[];
      paths: { workspaceLogPath: string; systemLogPath: string };
      dbDiagnostics: any;
    }>('logs:get', {
      level: levelFilter || undefined,
      subsystem: subsystemFilter || undefined,
      search: search || undefined,
      limit: 500,
    });
    setEntries(res.entries);
    setLogPaths(res.paths);
    setDbStats(res.dbDiagnostics);
  };

  useEffect(() => {
    void fetchLogsAndDiagnostics();
  }, [levelFilter, subsystemFilter, search, liveEntries.length]);

  const handleRunSelfCheck = async () => {
    setRunningSelfCheck(true);
    try {
      await invokeRpc(
        'logs:testEvent',
        'INFO',
        'SYSTEM',
        'Starting RetroTunes Diagnostic Self-Check across subsystems...'
      );
      await invokeRpc('settings:testConnection', 'paths');
      await invokeRpc('settings:testConnection', 'binaries');
      await invokeRpc('indexer:recalculateMedians');
      await fetchLogsAndDiagnostics();
    } finally {
      setRunningSelfCheck(false);
    }
  };

  const handleCopyBundle = async () => {
    const bundle = {
      generatedAt: new Date().toISOString(),
      logPaths,
      dbStats,
      recentLogs: entries.slice(-150),
    };
    await navigator.clipboard.writeText(JSON.stringify(bundle, null, 2));
    setCopied(true);
    setTimeout(() => setCopied(false), 2500);
  };

  const getLevelColor = (level: LogLevel) => {
    switch (level) {
      case 'ERROR':
        return '#f87171';
      case 'WARN':
        return '#fbbf24';
      case 'INFO':
        return '#60a5fa';
      case 'DEBUG':
      default:
        return '#94a3b8';
    }
  };

  return (
    <div className="aqua-modal-backdrop" onClick={onClose}>
      <div
        className="aqua-window"
        style={{ width: 980, maxWidth: '96vw', height: '84vh' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="aqua-window-titlebar">
          <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <Terminal size={14} /> RetroTunes Troubleshooting & Diagnostic Console
          </span>
          <button className="aqua-btn" onClick={onClose} style={{ padding: '1px 6px' }}>
            <X size={13} />
          </button>
        </div>

        {/* SQLite & File Path Summary Header */}
        <div
          style={{
            padding: '10px 16px',
            background: '#dfe5ef',
            borderBottom: '1px solid #94a3b8',
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
          }}
        >
          {dbStats && (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 14, fontSize: 11 }}>
                <span style={{ display: 'flex', alignItems: 'center', gap: 4, fontWeight: 700 }}>
                  <Database size={13} color="#1d4ed8" /> SQLite + FTS5:
                </span>
                <span>
                  Tracks: <strong>{dbStats.tracksCount}</strong> (FTS5: <strong>{dbStats.ftsCount}</strong>, Cached: <strong>{dbStats.cachedTracksCount}</strong>)
                </span>
                <span>
                  Videos: <strong>{dbStats.videosCount}</strong> (360p Transcoded: <strong>{dbStats.transcodedVideosCount}</strong>)
                </span>
                <span>
                  Playlists: <strong>{dbStats.playlistsCount}</strong>
                </span>
                <span>
                  ePods: <strong>{dbStats.devicesCount}</strong>
                </span>
                <span>
                  DB Size: <strong>{formatBytes(dbStats.dbSizeBytes)}</strong>
                </span>
              </div>

              <div style={{ display: 'flex', gap: 6 }}>
                <button className="aqua-btn primary" onClick={handleRunSelfCheck} disabled={runningSelfCheck}>
                  <PlayCircle size={12} />
                  {runningSelfCheck ? 'Running Self-Check...' : 'Run System Self-Check'}
                </button>
                <button className="aqua-btn" onClick={handleCopyBundle}>
                  {copied ? <CheckCircle2 size={12} color="#15803d" /> : <Copy size={12} />}
                  {copied ? 'Copied Bundle!' : 'Copy Diagnostic Bundle'}
                </button>
                <button
                  className="aqua-btn"
                  onClick={async () => {
                    await invokeRpc('logs:clear');
                    onCleared();
                    await fetchLogsAndDiagnostics();
                  }}
                >
                  <Trash2 size={12} /> Clear Buffer
                </button>
              </div>
            </div>
          )}

          {logPaths && (
            <div style={{ fontSize: 10.5, color: '#475569', display: 'flex', gap: 16, flexWrap: 'wrap' }}>
              {logPaths.sessionLogPath && (
                <span>
                  Current Session Log: <code>{logPaths.sessionLogPath}</code>
                </span>
              )}
              <span>
                Workspace Log: <code>{logPaths.workspaceLogPath}</code>
              </span>
              <span>
                System Log: <code>{logPaths.systemLogPath}</code>
              </span>
            </div>
          )}

          {/* Filters */}
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <select
              className="aqua-input"
              value={levelFilter}
              onChange={(e) => setLevelFilter(e.target.value)}
            >
              <option value="">All Severity Levels</option>
              <option value="DEBUG">DEBUG</option>
              <option value="INFO">INFO</option>
              <option value="WARN">WARN</option>
              <option value="ERROR">ERROR</option>
            </select>

            <select
              className="aqua-input"
              value={subsystemFilter}
              onChange={(e) => setSubsystemFilter(e.target.value)}
            >
              <option value="">All Subsystems</option>
              {SUBSYSTEMS.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>

            <input
              className="aqua-input"
              style={{ flex: 1 }}
              placeholder="Filter logs by message, path, SQL query, MBID, or error..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />

            <button className="aqua-btn" onClick={fetchLogsAndDiagnostics}>
              <RefreshCw size={12} /> Refresh
            </button>
          </div>
        </div>

        {/* Terminal Stream Output */}
        <div
          style={{
            flex: 1,
            background: '#0b0f19',
            color: '#e2e8f0',
            fontFamily: 'var(--font-mono)',
            fontSize: 11.5,
            overflowY: 'auto',
            padding: 12,
          }}
        >
          {entries.length === 0 ? (
            <div style={{ color: '#64748b', padding: 24, textAlign: 'center' }}>
              No diagnostic log entries match the current filter.
            </div>
          ) : (
            entries
              .slice()
              .reverse()
              .map((entry) => (
                <div
                  key={entry.id}
                  style={{
                    padding: '5px 8px',
                    borderBottom: '1px solid rgba(148, 163, 184, 0.14)',
                    lineHeight: 1.45,
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
                    <span style={{ color: '#94a3b8', fontSize: 10.5, fontFamily: 'var(--font-mono)' }}>
                      {entry.formattedTime || entry.timestamp.replace('T', ' ').slice(0, 23)}
                    </span>
                    <span
                      style={{
                        color: getLevelColor(entry.level),
                        fontWeight: 700,
                        minWidth: 46,
                      }}
                    >
                      [{entry.level}]
                    </span>
                    <span
                      style={{
                        background: '#1e293b',
                        color: '#93c5fd',
                        padding: '0 6px',
                        borderRadius: 3,
                        fontSize: 10.5,
                        fontWeight: 600,
                      }}
                    >
                      {entry.subsystem}
                    </span>
                    <span style={{ color: '#f8fafc', flex: 1 }}>{entry.message}</span>
                    {entry.durationMs !== undefined && (
                      <span style={{ color: '#34d399', fontSize: 10.5 }}>{entry.durationMs}ms</span>
                    )}
                  </div>
                  {entry.details !== undefined && (
                    <pre
                      style={{
                        margin: '4px 0 2px 64px',
                        padding: '4px 8px',
                        background: 'rgba(30, 41, 59, 0.65)',
                        borderRadius: 4,
                        color: '#cbd5e1',
                        fontSize: 10.5,
                        overflowX: 'auto',
                      }}
                    >
                      {typeof entry.details === 'string'
                        ? entry.details
                        : JSON.stringify(entry.details, null, 2)}
                    </pre>
                  )}
                </div>
              ))
          )}
        </div>
      </div>
    </div>
  );
};
