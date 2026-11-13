import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Play,
  Pause,
  SkipBack,
  SkipForward,
  Volume2,
  VolumeX,
  List,
  Grid,
  Layers,
  Search,
  Music,
  Film,
  Tv,
  HardDrive,
  ShoppingBag,
  Download,
  Usb,
  Sparkles,
  Plus,
  Settings,
  Terminal,
  Heart,
  FolderSearch,
  RefreshCw,
  Activity,
  ShieldCheck,
  Disc,
  CheckCircle2,
  X,
  FileText,
  Upload,
  BookOpen,
  Headphones,
  Image,
  Video,
} from 'lucide-react';
import {
  AppSettings,
  ArrQueueItem,
  AudiobookRow,
  AuthState,
  BookRow,
  CacheStats,
  DeviceInfo,
  IndexProgress,
  LogEntry,
  PhotoRow,
  PlaylistRow,
  SyncProgress,
  TrackRow,
  VideoRow,
} from './types';
import {
  formatBytes,
  formatDuration,
  invokeRpc,
  isDevMode,
  subscribeEvent,
} from './bridge';
import { PreferencesModal } from './components/PreferencesModal';
import { AboutCreditsModal } from './components/AboutCreditsModal';
import { SmartPlaylistModal } from './components/SmartPlaylistModal';
import { AddDeviceWizardModal } from './components/AddDeviceWizardModal';
import { DeviceSummaryView } from './components/DeviceSummaryView';
import { DownloadsQueueView, StorefrontView } from './components/StorefrontView';
import { DiagnosticsModal } from './components/DiagnosticsModal';
import { UploadMediaWizardModal } from './components/UploadMediaWizardModal';

type NavSelection =
  | { kind: 'music' }
  | { kind: 'movies' }
  | { kind: 'tv' }
  | { kind: 'music_videos' }
  | { kind: 'audiobooks' }
  | { kind: 'books' }
  | { kind: 'photos' }
  | { kind: 'cache' }
  | { kind: 'store' }
  | { kind: 'downloads' }
  | { kind: 'device'; uuid: string }
  | { kind: 'playlist'; id: number };

export interface TableColumnConfig {
  id:
    | 'track_num'
    | 'cache'
    | 'title'
    | 'duration'
    | 'artist'
    | 'album'
    | 'genre'
    | 'year'
    | 'rating'
    | 'loved'
    | 'lb_plays'
    | 'rel_score'
    | 'play_count'
    | 'format';
  label: string;
  visible: boolean;
  width?: number;
  sortKey?: keyof TrackRow;
}

const DEFAULT_TABLE_COLUMNS: TableColumnConfig[] = [
  { id: 'track_num', label: '#', visible: true, width: 52, sortKey: 'track_num' },
  { id: 'cache', label: 'Cache', visible: true, width: 52 },
  { id: 'title', label: 'Name', visible: true, sortKey: 'title' },
  { id: 'duration', label: 'Time', visible: true, width: 58, sortKey: 'duration' },
  { id: 'artist', label: 'Artist', visible: true, sortKey: 'artist' },
  { id: 'album', label: 'Album', visible: true, sortKey: 'album' },
  { id: 'genre', label: 'Genre', visible: true, width: 95, sortKey: 'genre' },
  { id: 'year', label: 'Year', visible: false, width: 58, sortKey: 'year' },
  { id: 'rating', label: 'Rating', visible: true, width: 85, sortKey: 'local_star_rating' },
  { id: 'loved', label: '♥', visible: true, width: 46, sortKey: 'is_loved' },
  { id: 'lb_plays', label: 'LB Plays', visible: true, width: 82, sortKey: 'global_listen_count' },
  { id: 'rel_score', label: 'Rel. Score', visible: true, width: 88, sortKey: 'artist_relative_popularity_score' },
  { id: 'play_count', label: 'Plays', visible: false, width: 58, sortKey: 'play_count' },
  { id: 'format', label: 'Format', visible: true, width: 82, sortKey: 'bitrate' },
];

export const App: React.FC = () => {
  // Core backend state
  const [mediaPort, setMediaPort] = useState<number>(0);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [authState, setAuthState] = useState<AuthState>({
    authenticated: false,
    mode: 'standalone',
    user: null,
    accessToken: null,
    expiresAt: null,
  });

  // Library & navigation
  const [nav, setNav] = useState<NavSelection>({ kind: 'music' });
  const [viewMode, setViewMode] = useState<'coverflow' | 'list' | 'grid'>('coverflow');
  const [searchQuery, setSearchQuery] = useState('');
  const [tracks, setTracks] = useState<TrackRow[]>([]);
  const [videos, setVideos] = useState<VideoRow[]>([]);
  const [books, setBooks] = useState<BookRow[]>([]);
  const [audiobooks, setAudiobooks] = useState<AudiobookRow[]>([]);
  const [photos, setPhotos] = useState<PhotoRow[]>([]);
  const [playlists, setPlaylists] = useState<PlaylistRow[]>([]);
  const [playlistTracks, setPlaylistTracks] = useState<TrackRow[]>([]);
  const [playlistVideos, setPlaylistVideos] = useState<VideoRow[]>([]);
  const [devices, setDevices] = useState<DeviceInfo[]>([]);
  const [cacheStats, setCacheStats] = useState<CacheStats | null>(null);
  const [arrQueue, setArrQueue] = useState<ArrQueueItem[]>([]);

  // Column browser filters
  const [selectedGenre, setSelectedGenre] = useState<string>('All');
  const [selectedArtist, setSelectedArtist] = useState<string>('All');
  const [selectedAlbum, setSelectedAlbum] = useState<string>('All');
  const [coverFlowIndex, setCoverFlowIndex] = useState<number>(0);

  // Sorting
  const [sortCol, setSortCol] = useState<keyof TrackRow>('artist');
  const [sortAsc, setSortAsc] = useState<boolean>(true);

  // Audio / Video Playback Engine
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const [currentTrack, setCurrentTrack] = useState<TrackRow | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [showRemainingTime, setShowRemainingTime] = useState(false);
  const [volume, setVolume] = useState(0.85);
  const [isMuted, setIsMuted] = useState(false);
  const [lcdMode, setLcdMode] = useState<'info' | 'spectrum' | 'db_sync' | 'epod_sync'>('info');
  const [spectrumBars, setSpectrumBars] = useState<number[]>(new Array(28).fill(3));
  const [activeLyrics, setActiveLyrics] = useState<string | null>(null);
  const [showLyricsModal, setShowLyricsModal] = useState(false);
  const [activeVideo, setActiveVideo] = useState<VideoRow | null>(null);

  // Background workers & progress
  const [indexProgress, setIndexProgress] = useState<IndexProgress>({
    running: false,
    phase: 'done',
    processed: 0,
    total: 0,
    currentFile: '',
    audioAdded: 0,
    videoAdded: 0,
  });
  const [syncProgress, setSyncProgress] = useState<SyncProgress>({
    running: false,
    deviceUuid: '',
    stage: 'Idle',
    processed: 0,
    total: 0,
    currentFile: '',
    lovedImported: 0,
    listenbrainzPushed: 0,
    lrcFetched: 0,
    tracksSynced: 0,
    videosSynced: 0,
    dotfilesCleaned: 0,
  });
  const [syncingPopularity, setSyncingPopularity] = useState(false);

  // Modals & Drag-and-Drop Playlist state
  const [showPreferences, setShowPreferences] = useState(false);
  const [showAbout, setShowAbout] = useState(false);
  const [showSmartModal, setShowSmartModal] = useState(false);
  const [editingPlaylist, setEditingPlaylist] = useState<PlaylistRow | null>(null);
  const [showNewPlaylistModal, setShowNewPlaylistModal] = useState(false);
  const [newPlaylistName, setNewPlaylistName] = useState('New Playlist');
  const [newPlaylistMediaType, setNewPlaylistMediaType] = useState<'music' | 'video' | 'mixed'>('mixed');
  const [dragOverPlaylistId, setDragOverPlaylistId] = useState<number | null>(null);
  const [dragOverDeviceUuid, setDragOverDeviceUuid] = useState<string | null>(null);
  const [dragOverView, setDragOverView] = useState<'tv' | 'movies' | null>(null);
  const [toastBanner, setToastBanner] = useState<string | null>(null);
  const [showAddDeviceWizard, setShowAddDeviceWizard] = useState(false);
  const [showUploadWizard, setShowUploadWizard] = useState(false);
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  const [liveLogs, setLiveLogs] = useState<LogEntry[]>([]);
  const [playbackSpeed, setPlaybackSpeed] = useState<number>(1.0);
  const hasRecordedPlayRef = useRef<number | null>(null);

  // Pagination & Configurable Columns + TV Show Selection
  const [visibleTrackLimit, setVisibleTrackLimit] = useState<number>(3000);
  const [tableColumns, setTableColumns] = useState<TableColumnConfig[]>(DEFAULT_TABLE_COLUMNS);
  const [showColumnPopover, setShowColumnPopover] = useState<boolean>(false);
  const [selectedTvShow, setSelectedTvShow] = useState<string | null>(null);
  const [selectedTvSeason, setSelectedTvSeason] = useState<number | 'All'>('All');

  // Initial load & IPC event subscriptions
  const refreshAllData = async (q = searchQuery) => {
    const [port, cfg, auth, trks, vids, pls, devs, cStats, bks, abs, phs] = await Promise.all([
      invokeRpc<number>('media:port'),
      invokeRpc<AppSettings>('settings:get'),
      invokeRpc<AuthState>('auth:getState'),
      invokeRpc<TrackRow[]>('tracks:search', q, 200000),
      invokeRpc<VideoRow[]>('videos:search', q),
      invokeRpc<PlaylistRow[]>('playlists:list'),
      invokeRpc<DeviceInfo[]>('devices:list'),
      invokeRpc<CacheStats>('cache:stats'),
      invokeRpc<BookRow[]>('books:list').catch(() => [] as BookRow[]),
      invokeRpc<AudiobookRow[]>('audiobooks:list').catch(() => [] as AudiobookRow[]),
      invokeRpc<PhotoRow[]>('photos:list').catch(() => [] as PhotoRow[]),
    ]);
    setMediaPort(port);
    setSettings(cfg);
    if (cfg.tableColumnsJson) {
      try {
        const parsedCols = JSON.parse(cfg.tableColumnsJson) as TableColumnConfig[];
        if (Array.isArray(parsedCols) && parsedCols.length > 0) {
          setTableColumns(parsedCols);
        }
      } catch {
        // ignore
      }
    }
    setAuthState(auth);
    setTracks(trks);
    setVideos(vids);
    setPlaylists(pls);
    setDevices(devs);
    setCacheStats(cStats);
    setBooks(bks);
    setAudiobooks(abs);
    setPhotos(phs);
  };

  useEffect(() => {
    if (nav.kind !== 'device' || settings?.showOfflineDevices) return;
    const activeDev = devices.find((d) => d.uuid === nav.uuid);
    if (!activeDev) return;
    const connected =
      activeDev.transport_mode === 'mtp' || activeDev.mount_path.startsWith('mtp://')
        ? Boolean(activeDev.mtp_connected)
        : Boolean(activeDev.storage?.mounted);
    if (!connected) {
      setNav({ kind: 'music' });
    }
  }, [devices, nav, settings?.showOfflineDevices]);

  useEffect(() => {
    void refreshAllData('');

    const unsubLog = subscribeEvent<LogEntry>('log:entry', (entry) => {
      setLiveLogs((prev) => [...prev.slice(-400), entry]);
    });
    const unsubIdx = subscribeEvent<IndexProgress>('indexer:progress', (prog) => {
      setIndexProgress(prog);
      if (!prog.running && prog.phase === 'done') {
        void refreshAllData();
      }
    });
    const unsubBatch = subscribeEvent<IndexProgress>('indexer:batchCommitted', () => {
      void invokeRpc<TrackRow[]>('tracks:search', searchQuery, 200000).then(setTracks);
      void invokeRpc<VideoRow[]>('videos:search', searchQuery).then(setVideos);
    });
    const unsubCache = subscribeEvent<CacheStats>('cache:status', (st) => {
      setCacheStats(st);
    });
    const unsubSync = subscribeEvent<SyncProgress>('device:syncProgress', (sp) => {
      setSyncProgress(sp);
    });
    const unsubAuth = subscribeEvent<AuthState>('auth:state', (a) => {
      setAuthState(a);
    });
    const unsubDevChanged = subscribeEvent('devices:changed', () => {
      void invokeRpc<DeviceInfo[]>('devices:list').then(setDevices);
    });
    const unsubMtpLock = subscribeEvent<string | null>('devices:mtpLockWarning', (msg) => {
      if (msg) {
        setToastBanner(msg);
      }
    });

    const unsubOpenAbout = subscribeEvent<void>('ui:openAbout', () => {
      setShowAbout(true);
    });
    const unsubOpenPrefs = subscribeEvent<void>('ui:openPreferences', () => {
      setShowPreferences(true);
    });
    const unsubBinaryProgress = subscribeEvent<{ running: boolean; stage: string; percent?: number }>(
      'transcoder:binaryProgress',
      (bp) => {
        if (bp.stage) {
          setToastBanner(bp.stage);
        }
      }
    );

    return () => {
      unsubOpenAbout();
      unsubOpenPrefs();
      unsubBinaryProgress();
      unsubLog();
      unsubIdx();
      unsubBatch();
      unsubCache();
      unsubSync();
      unsubAuth();
      unsubDevChanged();
      unsubMtpLock();
    };
  }, []);

  // Poll *arr live queue periodically
  useEffect(() => {
    const fetchQueue = async () => {
      try {
        const q = await invokeRpc<ArrQueueItem[]>('arr:queue');
        setArrQueue(q);
      } catch {
        // ignore
      }
    };
    void fetchQueue();
    const interval = setInterval(fetchQueue, 8000);
    return () => clearInterval(interval);
  }, []);

  // Search debounce via SQLite FTS5
  useEffect(() => {
    setVisibleTrackLimit(3000);
    const timer = setTimeout(async () => {
      const [trks, vids] = await Promise.all([
        invokeRpc<TrackRow[]>('tracks:search', searchQuery, 200000),
        invokeRpc<VideoRow[]>('videos:search', searchQuery),
      ]);
      setTracks(trks);
      setVideos(vids);
    }, 120);
    return () => clearTimeout(timer);
  }, [searchQuery]);

  useEffect(() => {
    setVisibleTrackLimit(3000);
    if (selectedArtist !== 'All' && selectedAlbum !== 'All') {
      void invokeRpc('tracks:hydrateAlbum', selectedArtist, selectedAlbum).then(async () => {
        const refreshed = await invokeRpc<TrackRow[]>('tracks:search', searchQuery, 200000);
        setTracks(refreshed);
      });
    }
  }, [selectedArtist, selectedAlbum]);

  useEffect(() => {
    if (nav.kind === 'playlist') {
      void invokeRpc<TrackRow[]>('playlists:getTracks', nav.id).then(setPlaylistTracks);
      void invokeRpc<VideoRow[]>('playlists:getVideos', nav.id).then(setPlaylistVideos);
    }
  }, [nav, tracks, videos]);

  const showToast = (msg: string) => {
    setToastBanner(msg);
    setTimeout(() => setToastBanner((prev) => (prev === msg ? null : prev)), 3200);
  };

  const handleDropOnPlaylist = async (pl: PlaylistRow, e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOverPlaylistId(null);
    if (pl.is_smart) {
      showToast(`"${pl.name}" is a Smart Playlist (populated automatically by rules).`);
      return;
    }
    const raw =
      e.dataTransfer.getData('application/x-rtunes-media') ||
      e.dataTransfer.getData('application/json');
    if (!raw) return;
    try {
      const payload = JSON.parse(raw) as
        | { kind: 'track'; id: number; title: string }
        | { kind: 'video'; id: number; title: string }
        | { kind: 'show'; showName: string };
      const mediaType = pl.media_type || 'music';

      if (payload.kind === 'track') {
        if (mediaType === 'video') {
          showToast(`"${pl.name}" is a Video-only playlist.`);
          return;
        }
        await invokeRpc('playlists:addTrack', pl.id, payload.id);
        showToast(`Added "${payload.title}" to playlist "${pl.name}"`);
      } else if (payload.kind === 'video') {
        if (mediaType === 'music') {
          // Auto-upgrade playlist to mixed or add video directly
          await invokeRpc('playlists:addVideo', pl.id, payload.id);
          showToast(`Added video "${payload.title}" to playlist "${pl.name}"`);
        } else {
          await invokeRpc('playlists:addVideo', pl.id, payload.id);
          showToast(`Added "${payload.title}" to playlist "${pl.name}"`);
        }
      } else if (payload.kind === 'show') {
        const res = await invokeRpc<{ added: number }>('playlists:addShow', pl.id, payload.showName);
        showToast(`Added ${res.added} episodes of "${payload.showName}" to playlist "${pl.name}"`);
      }

      const updatedPls = await invokeRpc<PlaylistRow[]>('playlists:list');
      setPlaylists(updatedPls);
      if (nav.kind === 'playlist' && nav.id === pl.id) {
        const [trks, vids] = await Promise.all([
          invokeRpc<TrackRow[]>('playlists:getTracks', pl.id),
          invokeRpc<VideoRow[]>('playlists:getVideos', pl.id),
        ]);
        setPlaylistTracks(trks);
        setPlaylistVideos(vids);
      }
    } catch {
      // ignore invalid drag data
    }
  };

  const handleDropOnDevice = async (dev: DeviceInfo, e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOverDeviceUuid(null);
    const raw =
      e.dataTransfer.getData('application/x-rtunes-media') ||
      e.dataTransfer.getData('application/json');
    if (raw) {
      try {
        const payload = JSON.parse(raw) as
          | { kind: 'track'; id: number; title: string }
          | { kind: 'video'; id: number; title: string }
          | { kind: 'show'; showName: string };

        if (payload.kind === 'video') {
          const nextVideos = Array.from(new Set([...(dev.profile.syncVideoIds || []), payload.id]));
          await invokeRpc('devices:updateProfile', { ...dev.profile, syncVideoIds: nextVideos });
          showToast(`Added "${payload.title}" to ${dev.name} sync queue.`);
        } else if (payload.kind === 'show') {
          const eps = videos
            .filter((v) => v.type === 'tv' && (v.show_name || v.title) === payload.showName)
            .map((v) => v.id);
          const nextVideos = Array.from(new Set([...(dev.profile.syncVideoIds || []), ...eps]));
          await invokeRpc('devices:updateProfile', { ...dev.profile, syncVideoIds: nextVideos });
          showToast(`Added ${eps.length} episode(s) of "${payload.showName}" to ${dev.name} sync queue.`);
        } else if (payload.kind === 'track') {
          const queueName = `ePod Queue (${dev.name})`;
          let queuePl = playlists.find((p) => !p.is_smart && p.name === queueName);
          let queueId = queuePl?.id;
          if (!queueId) {
            queueId = await invokeRpc<number>('playlists:save', {
              name: queueName,
              isSmart: false,
              mediaType: 'music',
            });
          }
          await invokeRpc('playlists:addTrack', queueId, payload.id);
          const nextPls = Array.from(new Set([...(dev.profile.syncPlaylistIds || []), queueId]));
          await invokeRpc('devices:updateProfile', { ...dev.profile, syncPlaylistIds: nextPls });
          showToast(`Added "${payload.title}" to ${dev.name} (${queueName}).`);
        }
        await refreshAllData();
        return;
      } catch {
        // ignore invalid drag payload
      }
    }
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      showToast(
        `Dropped ${e.dataTransfer.files.length} file(s) onto ${dev.name}. Opening Upload Wizard to import & sync...`
      );
      setShowUploadWizard(true);
    }
  };

  const handleDropOnLibraryView = (target: 'tv' | 'movies', e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOverView(null);
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      showToast(
        `Dropped ${e.dataTransfer.files.length} file(s) onto ${target === 'tv' ? 'TV Shows' : 'Movies'}. Opening Upload Wizard...`
      );
      setShowUploadWizard(true);
    }
  };

  // Web Audio API Spectrum Visualizer Loop
  useEffect(() => {
    if (lcdMode !== 'spectrum' || !isPlaying) return;
    let rafId = 0;
    const updateSpectrum = () => {
      if (analyserRef.current) {
        const data = new Uint8Array(analyserRef.current.frequencyBinCount);
        analyserRef.current.getByteFrequencyData(data);
        const bars: number[] = [];
        const step = Math.max(1, Math.floor(data.length / 28));
        for (let i = 0; i < 28; i++) {
          const val = data[i * step] || 0;
          bars.push(Math.max(2, Math.round((val / 255) * 28)));
        }
        setSpectrumBars(bars);
      }
      rafId = requestAnimationFrame(updateSpectrum);
    };
    rafId = requestAnimationFrame(updateSpectrum);
    return () => cancelAnimationFrame(rafId);
  }, [lcdMode, isPlaying]);

  // Active track list based on navigation & column browser filters
  const baseTrackList = nav.kind === 'playlist' ? playlistTracks : tracks;

  const genres = useMemo(() => {
    const s = new Set<string>();
    for (const t of baseTrackList) {
      if (t.genre) s.add(t.genre);
    }
    return ['All', ...Array.from(s).sort()];
  }, [baseTrackList]);

  const artists = useMemo(() => {
    const s = new Set<string>();
    for (const t of baseTrackList) {
      if (selectedGenre !== 'All' && t.genre !== selectedGenre) continue;
      if (t.artist) s.add(t.artist);
    }
    return ['All', ...Array.from(s).sort()];
  }, [baseTrackList, selectedGenre]);

  const albums = useMemo(() => {
    const s = new Set<string>();
    for (const t of baseTrackList) {
      if (selectedGenre !== 'All' && t.genre !== selectedGenre) continue;
      if (selectedArtist !== 'All' && t.artist !== selectedArtist) continue;
      if (t.album) s.add(t.album);
    }
    return ['All', ...Array.from(s).sort()];
  }, [baseTrackList, selectedGenre, selectedArtist]);

  // Distinct albums for Cover Flow & Grid View
  const distinctAlbums = useMemo(() => {
    const map = new Map<
      string,
      {
        album: string;
        artist: string;
        year: number | null;
        coverArtPath: string | null;
        tracks: TrackRow[];
      }
    >();
    for (const t of baseTrackList) {
      const key = `${t.artist}___${t.album}`;
      const existing = map.get(key);
      if (existing) {
        existing.tracks.push(t);
        if (!existing.coverArtPath && t.cover_art_path) {
          existing.coverArtPath = t.cover_art_path;
        }
      } else {
        map.set(key, {
          album: t.album,
          artist: t.artist,
          year: t.year,
          coverArtPath: t.cover_art_path,
          tracks: [t],
        });
      }
    }
    return Array.from(map.values());
  }, [baseTrackList]);

  // On-demand hydration when user focuses an album in Cover Flow
  useEffect(() => {
    const activeAlbum = distinctAlbums[coverFlowIndex];
    if (activeAlbum && activeAlbum.tracks.some((t) => !t.metadata_loaded)) {
      const timer = setTimeout(async () => {
        await invokeRpc('tracks:hydrateAlbum', activeAlbum.artist, activeAlbum.album);
        const refreshed = await invokeRpc<TrackRow[]>('tracks:search', searchQuery, 200000);
        setTracks(refreshed);
      }, 180);
      return () => clearTimeout(timer);
    }
  }, [coverFlowIndex, distinctAlbums.length]);

  // Grouped TV Shows hierarchy (Show -> Seasons -> Episodes)
  const groupedTvShows = useMemo(() => {
    const map = new Map<
      string,
      {
        showName: string;
        posterPath: string | null;
        year: number | null;
        seasons: Map<number, VideoRow[]>;
        allEpisodes: VideoRow[];
      }
    >();
    for (const v of videos) {
      if (v.type !== 'tv') continue;
      const cleanShow = (v.show_name || 'Unknown Show').replace(/^Star Wars\s*-\s*/i, '').trim();
      let entry = map.get(cleanShow);
      if (!entry) {
        entry = {
          showName: cleanShow,
          posterPath: v.poster_path || null,
          year: v.year || null,
          seasons: new Map(),
          allEpisodes: [],
        };
        map.set(cleanShow, entry);
      }
      if (!entry.posterPath && v.poster_path) entry.posterPath = v.poster_path;
      if (!entry.year && v.year) entry.year = v.year;
      const sNum = v.season !== null && v.season !== undefined ? v.season : 1;
      if (!entry.seasons.has(sNum)) entry.seasons.set(sNum, []);
      entry.seasons.get(sNum)!.push(v);
      entry.allEpisodes.push(v);
    }
    return Array.from(map.values()).sort((a, b) => a.showName.localeCompare(b.showName));
  }, [videos]);

  const filteredTracks = useMemo(() => {
    let list = [...baseTrackList];
    if (viewMode === 'list') {
      if (selectedGenre !== 'All') list = list.filter((t) => t.genre === selectedGenre);
      if (selectedArtist !== 'All') list = list.filter((t) => t.artist === selectedArtist);
      if (selectedAlbum !== 'All') list = list.filter((t) => t.album === selectedAlbum);
    } else if (viewMode === 'coverflow' && distinctAlbums[coverFlowIndex]) {
      // Highlight or filter if desired; in Cover Flow, all tracks are shown or filtered by selected album
    }

    list.sort((a, b) => {
      const va = a[sortCol];
      const vb = b[sortCol];
      if (va === vb) return (a.track_num || 0) - (b.track_num || 0);
      if (va === null || va === undefined) return 1;
      if (vb === null || vb === undefined) return -1;
      const cmp =
        typeof va === 'number' && typeof vb === 'number'
          ? va - vb
          : String(va).localeCompare(String(vb), undefined, { numeric: true, sensitivity: 'base' });
      return sortAsc ? cmp : -cmp;
    });

    return list;
  }, [baseTrackList, viewMode, selectedGenre, selectedArtist, selectedAlbum, sortCol, sortAsc, distinctAlbums, coverFlowIndex]);

  const getArtworkUrl = (coverArtPath?: string | null) => {
    if (!coverArtPath || !mediaPort) return null;
    return `http://127.0.0.1:${mediaPort}/artwork?path=${encodeURIComponent(coverArtPath)}`;
  };

  // Playback handlers
  const playTrack = async (track: TrackRow) => {
    setCurrentTrack(track);
    if (!audioRef.current || !mediaPort) return;

    const srcUrl = `http://127.0.0.1:${mediaPort}/track?id=${track.id}`;
    audioRef.current.src = srcUrl;
    audioRef.current.volume = isMuted ? 0 : volume;

    try {
      if (!audioCtxRef.current) {
        const Ctx = window.AudioContext || (window as any).webkitAudioContext;
        const ctx = new Ctx();
        const source = ctx.createMediaElementSource(audioRef.current);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 128;
        source.connect(analyser);
        analyser.connect(ctx.destination);
        audioCtxRef.current = ctx;
        analyserRef.current = analyser;
      } else if (audioCtxRef.current.state === 'suspended') {
        await audioCtxRef.current.resume();
      }
    } catch {
      // ignore WebAudio attachment if already bound
    }

    try {
      await audioRef.current.play();
      setIsPlaying(true);
      hasRecordedPlayRef.current = null;
      const hydrated = await invokeRpc<TrackRow>('tracks:hydrate', track.id);
      if (hydrated) {
        setTracks((prev) => prev.map((t) => (t.id === hydrated.id ? hydrated : t)));
        setCurrentTrack(hydrated);
      }
      const lrc = await invokeRpc<string | null>('tracks:getLyrics', track.id);
      setActiveLyrics(lrc);
    } catch {
      setIsPlaying(false);
    }
  };

  const togglePlayPause = async () => {
    if (!currentTrack && filteredTracks.length > 0) {
      await playTrack(filteredTracks[0]);
      return;
    }
    if (!audioRef.current) return;
    if (isPlaying) {
      audioRef.current.pause();
      setIsPlaying(false);
    } else {
      await audioRef.current.play();
      setIsPlaying(true);
    }
  };

  const playNext = () => {
    if (!currentTrack || filteredTracks.length === 0) return;
    const idx = filteredTracks.findIndex((t) => t.id === currentTrack.id);
    const nextIdx = (idx + 1) % filteredTracks.length;
    void playTrack(filteredTracks[nextIdx]);
  };

  const playPrev = () => {
    if (!currentTrack || filteredTracks.length === 0) return;
    if (audioRef.current && audioRef.current.currentTime > 3) {
      audioRef.current.currentTime = 0;
      return;
    }
    const idx = filteredTracks.findIndex((t) => t.id === currentTrack.id);
    const prevIdx = (idx - 1 + filteredTracks.length) % filteredTracks.length;
    void playTrack(filteredTracks[prevIdx]);
  };

  const handleRateTrack = async (trackId: number, stars: number, isLoved?: boolean) => {
    const updated = await invokeRpc<TrackRow>('tracks:rate', trackId, stars, isLoved);
    if (updated) {
      setTracks((prev) => prev.map((t) => (t.id === updated.id ? updated : t)));
      if (currentTrack?.id === updated.id) setCurrentTrack(updated);
      if (nav.kind === 'playlist') {
        const plTracks = await invokeRpc<TrackRow[]>('playlists:getTracks', nav.id);
        setPlaylistTracks(plTracks);
      }
    }
  };

  const handleToggleTrackCache = async (track: TrackRow) => {
    const nextKeep = !track.keep_cached;
    await invokeRpc('cache:toggleTrack', track.id, nextKeep);
    const refreshed = await invokeRpc<TrackRow[]>('tracks:search', searchQuery, 200000);
    setTracks(refreshed);
  };

  const saveColumnConfig = async (nextCols: TableColumnConfig[]) => {
    setTableColumns(nextCols);
    const updated = await invokeRpc<AppSettings>('settings:save', {
      tableColumnsJson: JSON.stringify(nextCols),
    });
    setSettings(updated);
  };

  const handleScanDirectoryQuick = async () => {
    const folder = await invokeRpc<string | null>(
      'dialog:selectDirectory',
      'Select Music or Video Library Folder to Index into SQLite'
    );
    if (folder) {
      await invokeRpc('indexer:scan', [folder]);
    }
  };

  const handleSyncListenBrainzPopularity = async () => {
    setSyncingPopularity(true);
    try {
      await invokeRpc('indexer:syncPopularity');
      await refreshAllData();
    } finally {
      setSyncingPopularity(false);
    }
  };

  const handleSortHeader = (col: keyof TrackRow) => {
    if (sortCol === col) {
      setSortAsc(!sortAsc);
    } else {
      setSortCol(col);
      setSortAsc(true);
    }
  };

  // Summary stats for bottom metal bar
  const totalBytes = filteredTracks.reduce((acc, t) => acc + (t.file_size || 0), 0);
  const totalDurationSec = filteredTracks.reduce((acc, t) => acc + (t.duration || 0), 0);

  return (
    <div className="rtunes-app">
      {/* Hidden Native Audio Engine */}
      <audio
        ref={audioRef}
        crossOrigin="anonymous"
        onTimeUpdate={() => {
          const ct = audioRef.current?.currentTime || 0;
          const dur = audioRef.current?.duration || currentTrack?.duration || 0;
          setCurrentTime(ct);
          if (
            currentTrack &&
            hasRecordedPlayRef.current !== currentTrack.id &&
            ((dur > 0 && ct >= dur * 0.5) || ct >= 240)
          ) {
            hasRecordedPlayRef.current = currentTrack.id;
            void invokeRpc<TrackRow>('tracks:recordPlay', currentTrack.id).then((updated) => {
              if (updated) {
                setTracks((prev) => prev.map((t) => (t.id === updated.id ? updated : t)));
                setCurrentTrack(updated);
              }
            });
          }
        }}
        onLoadedMetadata={() => setDuration(audioRef.current?.duration || currentTrack?.duration || 0)}
        onEnded={playNext}
      />

      {/* =====================================================================
          TOP BRUSHED METAL BAR & INSET GREEN-YELLOW LCD PANEL (Section 1 & 2)
          ===================================================================== */}
      <header className="top-chrome">
        {/* Left: Transport & Volume */}
        <div className="transport-cluster no-drag">
          <div className="transport-buttons">
            <button className="metal-circle-btn" onClick={playPrev} title="Previous Track">
              <SkipBack size={13} fill="#2f353f" />
            </button>
            <button
              className="metal-circle-btn play-main"
              onClick={togglePlayPause}
              title={isPlaying ? 'Pause' : 'Play'}
            >
              {isPlaying ? (
                <Pause size={16} fill="#2f353f" />
              ) : (
                <Play size={16} fill="#2f353f" style={{ marginLeft: 2 }} />
              )}
            </button>
            <button className="metal-circle-btn" onClick={playNext} title="Next Track">
              <SkipForward size={13} fill="#2f353f" />
            </button>
          </div>

          <div className="volume-control">
            <button
              style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, color: '#363d48' }}
              onClick={() => {
                const nextMute = !isMuted;
                setIsMuted(nextMute);
                if (audioRef.current) audioRef.current.volume = nextMute ? 0 : volume;
              }}
            >
              {isMuted || volume === 0 ? <VolumeX size={14} /> : <Volume2 size={14} />}
            </button>
            <input
              type="range"
              className="aqua-slider"
              min={0}
              max={1}
              step={0.01}
              value={isMuted ? 0 : volume}
              onChange={(e) => {
                const v = parseFloat(e.target.value);
                setVolume(v);
                setIsMuted(false);
                if (audioRef.current) audioRef.current.volume = v;
              }}
            />
          </div>
        </div>

        {/* Center: Inset Green-Yellow Retro LCD Display */}
        <div className="lcd-panel no-drag">
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 2,
              marginRight: 8,
            }}
          >
            <div style={{ display: 'flex', gap: 2 }}>
              <button
                className="lcd-mode-btn"
                style={{
                  width: 'auto',
                  height: 15,
                  padding: '0 4px',
                  fontSize: 8.5,
                  fontWeight: 700,
                  marginRight: 0,
                  background: lcdMode === 'info' ? 'rgba(30,43,24,0.28)' : 'rgba(30,43,24,0.08)',
                }}
                onClick={() => setLcdMode('info')}
                title="Show Currently Playing"
              >
                PLAY
              </button>
              <button
                className="lcd-mode-btn"
                style={{
                  width: 'auto',
                  height: 15,
                  padding: '0 4px',
                  fontSize: 8.5,
                  fontWeight: 700,
                  marginRight: 0,
                  background: lcdMode === 'spectrum' ? 'rgba(30,43,24,0.28)' : 'rgba(30,43,24,0.08)',
                }}
                onClick={() => setLcdMode('spectrum')}
                title="Show Real-Time Audio Spectrum"
              >
                EQ
              </button>
            </div>
            <div style={{ display: 'flex', gap: 2 }}>
              <button
                className="lcd-mode-btn"
                style={{
                  width: 'auto',
                  height: 15,
                  padding: '0 4px',
                  fontSize: 8.5,
                  fontWeight: 700,
                  marginRight: 0,
                  background: lcdMode === 'db_sync' ? 'rgba(30,43,24,0.28)' : 'rgba(30,43,24,0.08)',
                }}
                onClick={() => setLcdMode('db_sync')}
                title="Show Database Indexing & Hydration Status"
              >
                {indexProgress.running ? 'DB●' : 'DB'}
              </button>
              <button
                className="lcd-mode-btn"
                style={{
                  width: 'auto',
                  height: 15,
                  padding: '0 4px',
                  fontSize: 8.5,
                  fontWeight: 700,
                  marginRight: 0,
                  background: lcdMode === 'epod_sync' ? 'rgba(30,43,24,0.28)' : 'rgba(30,43,24,0.08)',
                }}
                onClick={() => setLcdMode('epod_sync')}
                title="Show ePod Sync Status"
              >
                {syncProgress.running ? 'ePod●' : 'ePod'}
              </button>
            </div>
          </div>

          {lcdMode === 'db_sync' ? (
            <div className="lcd-content">
              <div className="lcd-title" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span>
                  {indexProgress.running
                    ? indexProgress.phase === 'artists'
                      ? 'DB Sync — Step 1/3: Scanning Artists...'
                      : indexProgress.phase === 'albums'
                      ? 'DB Sync — Step 2/3: Building Album Directory...'
                      : 'DB Sync — Step 3/3: Indexing Songs...'
                    : `DB Sync Idle (${tracks.length.toLocaleString()} Songs • ${videos.length.toLocaleString()} Videos)`}
                </span>
                {indexProgress.running ? (
                  <button
                    className="aqua-btn"
                    style={{ padding: '0 6px', fontSize: 9.5, height: 16 }}
                    onClick={() => void invokeRpc('indexer:cancel')}
                  >
                    Stop
                  </button>
                ) : (
                  <button
                    className="aqua-btn"
                    style={{ padding: '0 6px', fontSize: 9.5, height: 16 }}
                    onClick={() => void invokeRpc('indexer:scan')}
                  >
                    Rescan
                  </button>
                )}
              </div>
              <div className="lcd-subtitle">
                {indexProgress.running
                  ? indexProgress.currentFile
                  : indexProgress.currentFile || 'Library SQLite + FTS5 index verified & up to date'}
              </div>
              <div className="lcd-scrubber-track" style={{ width: '90%' }}>
                <div
                  className="lcd-scrubber-fill"
                  style={{
                    width: `${
                      indexProgress.running
                        ? indexProgress.total > 0
                          ? Math.min(100, Math.round((indexProgress.processed / Math.max(1, indexProgress.total)) * 100))
                          : 50
                        : 100
                    }%`,
                  }}
                />
              </div>
            </div>
          ) : lcdMode === 'epod_sync' ? (
            <div className="lcd-content">
              <div className="lcd-title" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span>
                  {syncProgress.running
                    ? `ePod Sync: ${syncProgress.stage} (${syncProgress.processed}/${syncProgress.total})`
                    : devices.length > 0
                    ? `ePod Ready: ${devices[0].name} (${syncProgress.stage || 'Idle'})`
                    : 'No ePod Connected'}
                </span>
                {syncProgress.running ? (
                  <button
                    className="aqua-btn"
                    style={{ padding: '0 6px', fontSize: 9.5, height: 16 }}
                    onClick={() => void invokeRpc('devices:cancelSync')}
                  >
                    Stop
                  </button>
                ) : devices.length > 0 ? (
                  <button
                    className="aqua-btn"
                    style={{ padding: '0 6px', fontSize: 9.5, height: 16 }}
                    onClick={() => void invokeRpc('devices:sync', devices[0].uuid)}
                  >
                    Sync Now
                  </button>
                ) : null}
              </div>
              <div className="lcd-subtitle">
                {syncProgress.running
                  ? syncProgress.currentFile
                  : syncProgress.currentFile ||
                    (devices.length > 0
                      ? `Mounted at ${devices[0].mount_path}`
                      : 'Connect your ePod or USB player to sync')}
              </div>
              <div className="lcd-scrubber-track" style={{ width: '90%' }}>
                <div
                  className="lcd-scrubber-fill"
                  style={{
                    width: `${
                      syncProgress.running && syncProgress.total > 0
                        ? Math.min(100, Math.round((syncProgress.processed / Math.max(1, syncProgress.total)) * 100))
                        : syncProgress.tracksSynced > 0 || syncProgress.videosSynced > 0
                        ? 100
                        : 0
                    }%`,
                  }}
                />
              </div>
            </div>
          ) : lcdMode === 'spectrum' && isPlaying ? (
            <div className="lcd-content">
              <div className="lcd-title" style={{ fontSize: 10 }}>
                {currentTrack ? `${currentTrack.artist} — ${currentTrack.title}` : 'Spectrum Analyzer'}
              </div>
              <div className="lcd-spectrum-bars">
                {spectrumBars.map((h, idx) => (
                  <div key={idx} className="lcd-spec-bar" style={{ height: `${h}px` }} />
                ))}
              </div>
            </div>
          ) : currentTrack ? (
            <div className="lcd-content">
              <div className="lcd-title">
                {currentTrack.title}
                <span
                  style={{
                    marginLeft: 8,
                    fontSize: 9,
                    padding: '0 4px',
                    borderRadius: 3,
                    background: currentTrack.local_cache_path ? '#365314' : '#4d5742',
                    color: '#ecfccb',
                  }}
                >
                  {currentTrack.local_cache_path ? 'SSD CACHED' : 'NFS MASTER'}
                </span>
              </div>
              <div className="lcd-subtitle">
                {currentTrack.artist} — {currentTrack.album}
              </div>
              <div className="lcd-scrubber-row">
                <span className="lcd-time">{formatDuration(currentTime)}</span>
                <div
                  className="lcd-scrubber-track"
                  onClick={(e) => {
                    if (!audioRef.current || !duration) return;
                    const rect = e.currentTarget.getBoundingClientRect();
                    const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
                    audioRef.current.currentTime = pct * duration;
                    setCurrentTime(pct * duration);
                  }}
                >
                  <div
                    className="lcd-scrubber-fill"
                    style={{
                      width: `${duration > 0 ? Math.min(100, (currentTime / duration) * 100) : 0}%`,
                    }}
                  />
                  <div
                    className="lcd-scrubber-diamond"
                    style={{
                      left: `${duration > 0 ? Math.min(100, (currentTime / duration) * 100) : 0}%`,
                    }}
                  />
                </div>
                <span
                  className="lcd-time"
                  onClick={() => setShowRemainingTime(!showRemainingTime)}
                  title="Click to toggle Remaining / Total Time"
                >
                  {showRemainingTime
                    ? `-${formatDuration(Math.max(0, duration - currentTime))}`
                    : formatDuration(duration)}
                </span>
              </div>
            </div>
          ) : (
            <div className="lcd-content">
              <div className="lcd-title" style={{ fontSize: 13, letterSpacing: 0.4 }}>
                RetroTunes
              </div>
              <div className="lcd-subtitle" style={{ marginBottom: 0 }}>
                {tracks.length.toLocaleString()} Songs • {distinctAlbums.length.toLocaleString()} Albums
              </div>
            </div>
          )}

          {activeLyrics && (
            <button
              className="lcd-mode-btn"
              style={{ marginLeft: 8, marginRight: 0, width: 'auto', padding: '0 6px', fontSize: 10, fontWeight: 700 }}
              onClick={() => setShowLyricsModal(true)}
              title="View Synchronized .LRC Karaoke Lyrics"
            >
              <FileText size={11} style={{ marginRight: 3 }} /> .LRC
            </button>
          )}
        </div>

        {/* Right: View Switcher, SSO Badge, Preferences, Diagnostics & Search */}
        <div className="top-right-controls no-drag">
          <div className="segmented-group" title="Switch Library View Mode">
            <button
              className={`segmented-btn ${viewMode === 'list' ? 'active' : ''}`}
              onClick={() => setViewMode('list')}
            >
              <List size={13} /> List
            </button>
            <button
              className={`segmented-btn ${viewMode === 'grid' ? 'active' : ''}`}
              onClick={() => setViewMode('grid')}
            >
              <Grid size={13} /> Grid
            </button>
            <button
              className={`segmented-btn ${viewMode === 'coverflow' ? 'active' : ''}`}
              onClick={() => setViewMode('coverflow')}
            >
              <Layers size={13} /> Cover Flow
            </button>
          </div>

          <button
            className="aqua-btn primary"
            onClick={() => setShowUploadWizard(true)}
            title="Launch Smart Media Upload Wizard & *arr Auto-Import"
          >
            <Upload size={13} /> Upload Media
          </button>

          <button
            className="aqua-btn"
            onClick={() => setShowPreferences(true)}
            title="Open Aqua Preferences & API Connection Testers"
          >
            <Settings size={13} /> Prefs
          </button>

          <button
            className="aqua-btn"
            onClick={() => setShowAbout(true)}
            title="About RetroTunes (rTunes) & FOSS Credits"
          >
            About
          </button>

          <button
            className="aqua-btn"
            onClick={() => setShowDiagnostics(true)}
            title="Open Troubleshooting & Diagnostic Console"
          >
            <Terminal size={13} /> Logs
          </button>

          <div className="aqua-pill-search">
            <Search size={12} color="#64748b" />
            <input
              placeholder="Search"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
            {searchQuery && (
              <button
                style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
                onClick={() => setSearchQuery('')}
              >
                <X size={11} color="#64748b" />
              </button>
            )}
          </div>
        </div>
      </header>

      {/* =====================================================================
          MAIN WORKSPACE: SOURCE LIST SIDEBAR + CONTENT VIEW
          ===================================================================== */}
      <div className="workspace-body">
        {/* Left Source Sidebar */}
        <aside className="source-sidebar">
          <div className="source-scroll">
            {/* LIBRARY */}
            <div className="source-section-header">LIBRARY</div>
            <div
              className={`source-item ${nav.kind === 'music' ? 'selected' : ''}`}
              onClick={() => setNav({ kind: 'music' })}
            >
              <div className="source-item-left">
                <Music size={14} color={nav.kind === 'music' ? '#fff' : '#2563eb'} />
                <span className="source-item-label">Music</span>
              </div>
              <span className="source-badge">{tracks.length}</span>
            </div>

            <div
              className={`source-item ${nav.kind === 'movies' ? 'selected' : ''}`}
              onClick={() => setNav({ kind: 'movies' })}
            >
              <div className="source-item-left">
                <Film size={14} color={nav.kind === 'movies' ? '#fff' : '#7c3aed'} />
                <span className="source-item-label">Movies</span>
              </div>
              <span className="source-badge">{videos.filter((v) => v.type === 'movie').length}</span>
            </div>

            <div
              className={`source-item ${nav.kind === 'tv' ? 'selected' : ''}`}
              onClick={() => setNav({ kind: 'tv' })}
            >
              <div className="source-item-left">
                <Tv size={14} color={nav.kind === 'tv' ? '#fff' : '#0d9488'} />
                <span className="source-item-label">TV Shows</span>
              </div>
              <span className="source-badge">{groupedTvShows.length}</span>
            </div>

            <div
              className={`source-item ${nav.kind === 'music_videos' ? 'selected' : ''}`}
              onClick={() => setNav({ kind: 'music_videos' })}
            >
              <div className="source-item-left">
                <Video size={14} color={nav.kind === 'music_videos' ? '#fff' : '#db2777'} />
                <span className="source-item-label">Music Videos</span>
              </div>
              <span className="source-badge">
                {videos.filter((v) => v.type === 'music_video').length}
              </span>
            </div>

            <div
              className={`source-item ${nav.kind === 'audiobooks' ? 'selected' : ''}`}
              onClick={() => setNav({ kind: 'audiobooks' })}
            >
              <div className="source-item-left">
                <Headphones size={14} color={nav.kind === 'audiobooks' ? '#fff' : '#ea580c'} />
                <span className="source-item-label">Audiobooks</span>
              </div>
              <span className="source-badge">{audiobooks.length}</span>
            </div>

            <div
              className={`source-item ${nav.kind === 'books' ? 'selected' : ''}`}
              onClick={() => setNav({ kind: 'books' })}
            >
              <div className="source-item-left">
                <BookOpen size={14} color={nav.kind === 'books' ? '#fff' : '#854d0e'} />
                <span className="source-item-label">Books</span>
              </div>
              <span className="source-badge">{books.length}</span>
            </div>

            <div
              className={`source-item ${nav.kind === 'photos' ? 'selected' : ''}`}
              onClick={() => setNav({ kind: 'photos' })}
            >
              <div className="source-item-left">
                <Image size={14} color={nav.kind === 'photos' ? '#fff' : '#0284c7'} />
                <span className="source-item-label">Photos</span>
              </div>
              <span className="source-badge">{photos.length}</span>
            </div>

            <div
              className={`source-item ${nav.kind === 'cache' ? 'selected' : ''}`}
              onClick={() => setNav({ kind: 'cache' })}
            >
              <div className="source-item-left">
                <HardDrive size={14} color={nav.kind === 'cache' ? '#fff' : '#d97706'} />
                <span className="source-item-label">Local Cache</span>
              </div>
              <span className="source-badge">
                {cacheStats ? `${cacheStats.audioCount + cacheStats.videoCount}` : 0}
              </span>
            </div>

            {/* STORE */}
            <div className="source-section-header">STORE</div>
            <div
              className={`source-item ${nav.kind === 'store' ? 'selected' : ''}`}
              onClick={() => setNav({ kind: 'store' })}
            >
              <div className="source-item-left">
                <ShoppingBag size={14} color={nav.kind === 'store' ? '#fff' : '#16a34a'} />
                <span className="source-item-label">rTunes Store</span>
              </div>
            </div>

            <div
              className="source-item"
              onClick={() => setShowUploadWizard(true)}
            >
              <div className="source-item-left">
                <Upload size={14} color="#2563eb" />
                <span className="source-item-label">Upload Media...</span>
              </div>
            </div>

            <div
              className={`source-item ${nav.kind === 'downloads' ? 'selected' : ''}`}
              onClick={() => setNav({ kind: 'downloads' })}
            >
              <div className="source-item-left">
                <Download size={14} color={nav.kind === 'downloads' ? '#fff' : '#2563eb'} />
                <span className="source-item-label">Downloads</span>
              </div>
              {arrQueue.length > 0 && <span className="source-badge">{arrQueue.length}</span>}
            </div>

            {/* DEVICES (ePod / Innioasis Y2) */}
            <div className="source-section-header">
              <span>DEVICES</span>
              <button
                style={{
                  background: 'none',
                  border: 'none',
                  cursor: 'pointer',
                  color: '#2563eb',
                  fontWeight: 700,
                  fontSize: 10,
                }}
                onClick={() => setShowAddDeviceWizard(true)}
                title="Provision a new ePod or portable device"
              >
                + Add ePod
              </button>
            </div>
            {(() => {
              const isDevConnected = (dev: DeviceInfo) =>
                dev.transport_mode === 'mtp' || dev.mount_path.startsWith('mtp://')
                  ? Boolean(dev.mtp_connected)
                  : Boolean(dev.storage?.mounted);

              const visibleDevices = devices.filter(
                (dev) => isDevConnected(dev) || Boolean(settings?.showOfflineDevices)
              );

              if (visibleDevices.length === 0) {
                return (
                  <div
                    style={{ padding: '4px 18px', fontSize: 11, color: '#64748b', cursor: 'pointer' }}
                    onClick={() => setShowAddDeviceWizard(true)}
                  >
                    No ePod connected (Click to Add)
                  </div>
                );
              }

              return visibleDevices.map((dev) => {
                const isSelected = nav.kind === 'device' && nav.uuid === dev.uuid;
                const connected = isDevConnected(dev);
                const isDragOver = dragOverDeviceUuid === dev.uuid;
                return (
                  <div
                    key={dev.uuid}
                    className={`source-item ${isSelected ? 'selected' : ''}`}
                    style={{
                      ...(!connected ? { opacity: 0.72 } : {}),
                      ...(isDragOver
                        ? {
                            outline: '2px solid #2563eb',
                            background: isSelected ? undefined : '#dbeafe',
                          }
                        : {}),
                    }}
                    onClick={() => setNav({ kind: 'device', uuid: dev.uuid })}
                    onDragEnter={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      e.dataTransfer.dropEffect = 'copy';
                      setDragOverDeviceUuid(dev.uuid);
                    }}
                    onDragOver={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      e.dataTransfer.dropEffect = 'copy';
                      if (dragOverDeviceUuid !== dev.uuid) {
                        setDragOverDeviceUuid(dev.uuid);
                      }
                    }}
                    onDragLeave={(e) => {
                      if (!e.currentTarget.contains(e.relatedTarget as Node)) {
                        setDragOverDeviceUuid(null);
                      }
                    }}
                    onDrop={(e) => void handleDropOnDevice(dev, e)}
                  >
                    <div
                      className="source-item-left"
                      style={{
                        minWidth: 0,
                        flex: 1,
                        pointerEvents: isDragOver ? 'none' : undefined,
                      }}
                    >
                      <Usb
                        size={14}
                        color={isSelected ? '#fff' : connected ? '#0284c7' : '#94a3b8'}
                      />
                      <span className="source-item-label">{dev.name}</span>
                      {!connected && (
                        <span
                          style={{
                            fontSize: 9,
                            fontWeight: 600,
                            padding: '1px 5px',
                            borderRadius: 4,
                            background: isSelected ? 'rgba(255,255,255,0.2)' : '#e2e8f0',
                            color: isSelected ? '#fff' : '#475569',
                            whiteSpace: 'nowrap',
                            flexShrink: 0,
                          }}
                        >
                          Not Connected
                        </span>
                      )}
                    </div>
                    {connected && (
                      <button
                        className="eject-mini-btn"
                        title="Safely Eject Device"
                        onClick={async (e) => {
                          e.stopPropagation();
                          await invokeRpc('devices:eject', dev.uuid);
                          await refreshAllData();
                        }}
                      >
                        ⏏
                      </button>
                    )}
                  </div>
                );
              });
            })()}

            {/* PLAYLISTS */}
            <div className="source-section-header">
              <span>PLAYLISTS</span>
              <button
                style={{
                  background: 'none',
                  border: 'none',
                  cursor: 'pointer',
                  color: '#2563eb',
                  fontWeight: 700,
                  fontSize: 10,
                }}
                onClick={() => {
                  setNewPlaylistName('New Playlist');
                  setNewPlaylistMediaType('mixed');
                  setShowNewPlaylistModal(true);
                }}
                title="Create a new Music, Video, or Mixed Playlist"
              >
                + New
              </button>
            </div>
            {playlists.map((pl) => {
              const isSelected = nav.kind === 'playlist' && nav.id === pl.id;
              const isDragTarget = dragOverPlaylistId === pl.id;
              const totalCount = (pl.trackCount ?? 0) + (pl.videoCount ?? 0);
              return (
                <div
                  key={pl.id}
                  className={`source-item ${isSelected ? 'selected' : ''}`}
                  style={
                    isDragTarget
                      ? {
                          outline: '2px dashed #2563eb',
                          background: isSelected ? undefined : 'rgba(59,130,246,0.18)',
                        }
                      : undefined
                  }
                  onClick={() => setNav({ kind: 'playlist', id: pl.id })}
                  onDoubleClick={() => {
                    if (pl.is_smart) {
                      setEditingPlaylist(pl);
                      setShowSmartModal(true);
                    }
                  }}
                  onDragOver={(e) => {
                    if (!pl.is_smart) {
                      e.preventDefault();
                      e.dataTransfer.dropEffect = 'copy';
                      if (dragOverPlaylistId !== pl.id) setDragOverPlaylistId(pl.id);
                    }
                  }}
                  onDragLeave={() => {
                    if (dragOverPlaylistId === pl.id) setDragOverPlaylistId(null);
                  }}
                  onDrop={(e) => void handleDropOnPlaylist(pl, e)}
                  title={
                    pl.is_smart
                      ? 'Smart Playlist (Double-click to edit rules)'
                      : `Drag & drop songs, movies, or TV shows here (${pl.media_type || 'music'} playlist)`
                  }
                >
                  <div className="source-item-left">
                    {pl.is_smart ? (
                      <Sparkles size={14} color={isSelected ? '#fff' : '#7c3aed'} />
                    ) : pl.media_type === 'video' ? (
                      <Film size={14} color={isSelected ? '#fff' : '#0d9488'} />
                    ) : pl.media_type === 'mixed' ? (
                      <Layers size={14} color={isSelected ? '#fff' : '#2563eb'} />
                    ) : (
                      <Music size={14} color={isSelected ? '#fff' : '#475569'} />
                    )}
                    <span className="source-item-label">{pl.name}</span>
                  </div>
                  <span className="source-badge">{totalCount}</span>
                </div>
              );
            })}
          </div>

          {/* Now Playing Artwork Well */}
          <div className="artwork-well">
            <div className="artwork-well-header">
              {currentTrack ? 'Now Playing' : 'Selected Artwork'}
            </div>
            <div className="artwork-well-box">
              {currentTrack && getArtworkUrl(currentTrack.cover_art_path) ? (
                <img
                  src={getArtworkUrl(currentTrack.cover_art_path)!}
                  alt={currentTrack.album}
                />
              ) : (
                <div
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    color: '#64748b',
                    gap: 6,
                  }}
                >
                  <Disc size={52} strokeWidth={1.3} />
                  <span style={{ fontSize: 10.5 }}>
                    {currentTrack ? currentTrack.album : 'No Track Playing'}
                  </span>
                </div>
              )}
            </div>
          </div>
        </aside>

        {/* ===================================================================
            MAIN CONTENT VIEW
            =================================================================== */}
        <main className="main-pane">
          {/* 1. MUSIC OR PLAYLIST VIEW */}
          {(nav.kind === 'music' || nav.kind === 'playlist') && (
            <>
              {/* Action / Toolbar Strip */}
              <div
                style={{
                  height: 34,
                  minHeight: 34,
                  background: 'linear-gradient(180deg, #f3f6fa 0%, #dce2ec 100%)',
                  borderBottom: '1px solid #98a2b3',
                  padding: '0 14px',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <strong>
                    {nav.kind === 'playlist'
                      ? playlists.find((p) => p.id === nav.id)?.name || 'Playlist'
                      : 'Music Library'}
                  </strong>
                  {nav.kind === 'playlist' &&
                    (() => {
                      const pl = playlists.find((p) => p.id === nav.id);
                      if (!pl) return null;
                      return (
                        <>
                          <span
                            style={{
                              fontSize: 10,
                              fontWeight: 700,
                              padding: '1px 6px',
                              borderRadius: 4,
                              background: '#e2e8f0',
                              color: '#334155',
                              textTransform: 'uppercase',
                            }}
                          >
                            {pl.is_smart ? 'Smart' : pl.media_type || 'music'}
                          </span>
                          {pl.is_smart === 1 && (
                            <button
                              className="aqua-btn"
                              style={{ padding: '1px 8px' }}
                              onClick={() => {
                                setEditingPlaylist(pl);
                                setShowSmartModal(true);
                              }}
                            >
                              <Sparkles size={11} /> Edit Smart Rules
                            </button>
                          )}
                          <button
                            className="aqua-btn"
                            style={{ padding: '1px 8px', color: '#b91c1c' }}
                            onClick={async () => {
                              await invokeRpc('playlists:delete', pl.id);
                              await refreshAllData();
                              setNav({ kind: 'music' });
                            }}
                          >
                            Delete Playlist
                          </button>
                        </>
                      );
                    })()}
                  {toastBanner && (
                    <span
                      style={{
                        fontSize: 11,
                        fontWeight: 700,
                        color: '#15803d',
                        background: '#dcfce7',
                        border: '1px solid #86efac',
                        padding: '1px 8px',
                        borderRadius: 4,
                      }}
                    >
                      {toastBanner}
                    </span>
                  )}
                </div>

                <div style={{ display: 'flex', gap: 6, position: 'relative' }}>
                  <button
                    className="aqua-btn"
                    onClick={() => setShowColumnPopover(!showColumnPopover)}
                    title="Configure Table Columns & Order"
                  >
                    <Settings size={12} /> Columns
                  </button>
                  {showColumnPopover && (
                    <div
                      style={{
                        position: 'absolute',
                        top: 28,
                        left: 0,
                        zIndex: 999,
                        width: 245,
                        background: '#f8fafc',
                        border: '1px solid #94a3b8',
                        borderRadius: 6,
                        boxShadow: '0 10px 25px rgba(0,0,0,0.28)',
                        padding: 10,
                        color: '#0f172a',
                      }}
                    >
                      <div
                        style={{
                          display: 'flex',
                          justifyContent: 'space-between',
                          alignItems: 'center',
                          marginBottom: 8,
                          paddingBottom: 5,
                          borderBottom: '1px solid #cbd5e1',
                          fontSize: 11.5,
                          fontWeight: 700,
                        }}
                      >
                        <span>Configure Columns</span>
                        <div style={{ display: 'flex', gap: 4 }}>
                          <button
                            className="aqua-btn"
                            style={{ padding: '0 6px', fontSize: 10 }}
                            onClick={() => void saveColumnConfig(DEFAULT_TABLE_COLUMNS)}
                          >
                            Reset
                          </button>
                          <button
                            className="aqua-btn"
                            style={{ padding: '0 6px', fontSize: 10 }}
                            onClick={() => setShowColumnPopover(false)}
                          >
                            Done
                          </button>
                        </div>
                      </div>
                      <div style={{ maxHeight: 280, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 4 }}>
                        {tableColumns.map((col, idx) => (
                          <div
                            key={col.id}
                            style={{
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'space-between',
                              padding: '3px 6px',
                              background: '#ffffff',
                              border: '1px solid #e2e8f0',
                              borderRadius: 4,
                              fontSize: 11,
                            }}
                          >
                            <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', flex: 1 }}>
                              <input
                                type="checkbox"
                                checked={col.visible}
                                onChange={(e) => {
                                  const next = tableColumns.map((c, i) =>
                                    i === idx ? { ...c, visible: e.target.checked } : c
                                  );
                                  void saveColumnConfig(next);
                                }}
                              />
                              <span style={{ fontWeight: 600 }}>{col.label}</span>
                            </label>
                            <div style={{ display: 'flex', gap: 3 }}>
                              <button
                                className="aqua-btn"
                                style={{ padding: '0 5px', fontSize: 10 }}
                                disabled={idx === 0}
                                onClick={() => {
                                  const next = [...tableColumns];
                                  [next[idx - 1], next[idx]] = [next[idx], next[idx - 1]];
                                  void saveColumnConfig(next);
                                }}
                                title="Move Up"
                              >
                                ↑
                              </button>
                              <button
                                className="aqua-btn"
                                style={{ padding: '0 5px', fontSize: 10 }}
                                disabled={idx === tableColumns.length - 1}
                                onClick={() => {
                                  const next = [...tableColumns];
                                  [next[idx], next[idx + 1]] = [next[idx + 1], next[idx]];
                                  void saveColumnConfig(next);
                                }}
                                title="Move Down"
                              >
                                ↓
                              </button>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  <button className="aqua-btn" onClick={handleScanDirectoryQuick}>
                    <FolderSearch size={12} /> Import Music...
                  </button>
                  <button
                    className="aqua-btn"
                    onClick={() => void invokeRpc('indexer:scan')}
                    disabled={indexProgress.running}
                  >
                    <RefreshCw size={12} /> Rescan Library
                  </button>
                  <button
                    className="aqua-btn"
                    onClick={handleSyncListenBrainzPopularity}
                    disabled={syncingPopularity}
                    title="Update global listen counts and calculate artist popularity scores"
                  >
                    <Activity size={12} />
                    {syncingPopularity ? 'Updating Popularity...' : 'Update Popularity'}
                  </button>
                </div>
              </div>

              {/* Cover Flow 3D Stage (when in Cover Flow mode) */}
              {viewMode === 'coverflow' && (
                <div
                  className="coverflow-stage"
                  onKeyDown={(e) => {
                    if (e.key === 'ArrowLeft') {
                      setCoverFlowIndex((i) => Math.max(0, i - 1));
                    } else if (e.key === 'ArrowRight') {
                      setCoverFlowIndex((i) => Math.min(distinctAlbums.length - 1, i + 1));
                    }
                  }}
                  tabIndex={0}
                >
                  {distinctAlbums.length === 0 ? (
                    <div
                      style={{
                        flex: 1,
                        display: 'flex',
                        flexDirection: 'column',
                        alignItems: 'center',
                        justifyContent: 'center',
                        color: '#cbd5e1',
                        gap: 8,
                      }}
                    >
                      <Disc size={44} color="#60a5fa" />
                      <div style={{ fontWeight: 700, fontSize: 13 }}>
                        Cover Flow Ready — Library Currently Empty
                      </div>
                      <div style={{ fontSize: 11, color: '#94a3b8' }}>
                        Click "Scan Folder / Import Media..." or configure your NFS/SMB Music Root in Preferences to populate Cover Flow.
                      </div>
                    </div>
                  ) : (
                    <>
                      <div className="coverflow-3d-viewport">
                        {distinctAlbums.map((alb, idx) => {
                          const offset = idx - coverFlowIndex;
                          if (Math.abs(offset) > 6) return null;
                          const isCenter = offset === 0;
                          const translateX = isCenter
                            ? 0
                            : offset * 56 + (offset > 0 ? 52 : -52);
                          const translateZ = isCenter ? 55 : -90 - Math.abs(offset) * 18;
                          const rotateY = isCenter ? 0 : offset > 0 ? -58 : 58;
                          const zIndex = 30 - Math.abs(offset);
                          const artUrl = getArtworkUrl(alb.coverArtPath);

                          return (
                            <div
                              key={`${alb.artist}-${alb.album}`}
                              className="coverflow-card"
                              style={{
                                transform: `translateX(${translateX}px) translateZ(${translateZ}px) rotateY(${rotateY}deg)`,
                                zIndex,
                                opacity: Math.abs(offset) > 5 ? 0 : 1,
                              }}
                              onClick={() => setCoverFlowIndex(idx)}
                              onDoubleClick={() => {
                                if (alb.tracks[0]) void playTrack(alb.tracks[0]);
                              }}
                            >
                              {artUrl ? (
                                <img src={artUrl} alt={alb.album} />
                              ) : (
                                <div
                                  className="cf-fallback"
                                  style={{
                                    background: 'linear-gradient(135deg, #1e3a8a 0%, #0f172a 100%)',
                                    display: 'flex',
                                    flexDirection: 'column',
                                    alignItems: 'center',
                                    justifyContent: 'center',
                                    padding: 10,
                                    textAlign: 'center',
                                    color: '#e2e8f0',
                                  }}
                                >
                                  <Disc size={36} color="#93c5fd" />
                                  <span style={{ fontSize: 10, fontWeight: 700, marginTop: 6 }}>
                                    {alb.album}
                                  </span>
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>

                      {distinctAlbums[coverFlowIndex] && (
                        <div className="coverflow-caption">
                          <div className="coverflow-caption-title">
                            {distinctAlbums[coverFlowIndex].album}
                          </div>
                          <div className="coverflow-caption-artist">
                            {distinctAlbums[coverFlowIndex].artist}
                          </div>
                        </div>
                      )}

                      <input
                        type="range"
                        className="aqua-slider coverflow-scrollbar"
                        min={0}
                        max={Math.max(0, distinctAlbums.length - 1)}
                        value={coverFlowIndex}
                        onChange={(e) => setCoverFlowIndex(Number(e.target.value))}
                      />
                    </>
                  )}
                </div>
              )}

              {/* Column Browser (when in List mode) */}
              {viewMode === 'list' && (
                <div className="column-browser">
                  <div className="column-pane">
                    <div className="column-pane-header">Genres ({genres.length - 1})</div>
                    <div className="column-pane-list">
                      {genres.map((g) => (
                        <div
                          key={g}
                          className={`column-pane-item ${selectedGenre === g ? 'selected' : ''}`}
                          onClick={() => {
                            setSelectedGenre(g);
                            setSelectedArtist('All');
                            setSelectedAlbum('All');
                          }}
                        >
                          {g === 'All' ? `All (${genres.length - 1} Genres)` : g}
                        </div>
                      ))}
                    </div>
                  </div>

                  <div className="column-pane">
                    <div className="column-pane-header">Artists ({artists.length - 1})</div>
                    <div className="column-pane-list">
                      {artists.map((a) => (
                        <div
                          key={a}
                          className={`column-pane-item ${selectedArtist === a ? 'selected' : ''}`}
                          onClick={() => {
                            setSelectedArtist(a);
                            setSelectedAlbum('All');
                          }}
                        >
                          {a === 'All' ? `All (${artists.length - 1} Artists)` : a}
                        </div>
                      ))}
                    </div>
                  </div>

                  <div className="column-pane">
                    <div className="column-pane-header">Albums ({albums.length - 1})</div>
                    <div className="column-pane-list">
                      {albums.map((alb) => (
                        <div
                          key={alb}
                          className={`column-pane-item ${selectedAlbum === alb ? 'selected' : ''}`}
                          onClick={() => setSelectedAlbum(alb)}
                        >
                          {alb === 'All' ? `All (${albums.length - 1} Albums)` : alb}
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              )}

              {/* Album Grid View OR Striped rTunes Table */}
              {viewMode === 'grid' ? (
                <div
                  style={{
                    flex: 1,
                    overflowY: 'auto',
                    padding: 18,
                    background: '#1e2229',
                    color: '#f8fafc',
                    display: 'grid',
                    gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))',
                    gap: 18,
                    alignContent: 'start',
                  }}
                >
                  {distinctAlbums.length === 0 ? (
                    <div style={{ gridColumn: '1 / -1', textAlign: 'center', padding: 48, color: '#94a3b8' }}>
                      No albums indexed yet. Use "Scan Folder / Import Media..." above to index your library.
                    </div>
                  ) : (
                    distinctAlbums.map((alb) => {
                      const artUrl = getArtworkUrl(alb.coverArtPath);
                      return (
                        <div
                          key={`${alb.artist}-${alb.album}`}
                          style={{ cursor: 'pointer', textAlign: 'center' }}
                          onClick={() => {
                            if (alb.tracks.some((t) => !t.metadata_loaded || !t.cover_art_path)) {
                              void invokeRpc('tracks:hydrateAlbum', alb.artist, alb.album);
                            }
                          }}
                          onDoubleClick={() => {
                            if (alb.tracks[0]) void playTrack(alb.tracks[0]);
                          }}
                        >
                          <div
                            style={{
                              width: '100%',
                              aspectRatio: '1/1',
                              background: '#0f172a',
                              borderRadius: 4,
                              boxShadow: '0 6px 14px rgba(0,0,0,0.55)',
                              overflow: 'hidden',
                              marginBottom: 6,
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                            }}
                          >
                            {artUrl ? (
                              <img
                                src={artUrl}
                                alt={alb.album}
                                style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                              />
                            ) : (
                              <Disc size={40} color="#64748b" />
                            )}
                          </div>
                          <div style={{ fontWeight: 700, fontSize: 11.5 }}>{alb.album}</div>
                          <div style={{ fontSize: 10.5, color: '#94a3b8' }}>{alb.artist}</div>
                        </div>
                      );
                    })
                  )}
                </div>
              ) : (
                <div className="rtunes-table-container">
                  <table className="rtunes-table">
                    <thead>
                      <tr>
                        {tableColumns
                          .filter((c) => c.visible)
                          .map((col) => (
                            <th
                              key={col.id}
                              style={col.width ? { width: col.width } : undefined}
                              className={col.sortKey && sortCol === col.sortKey ? 'sorted' : ''}
                              onClick={() => {
                                if (col.sortKey) handleSortHeader(col.sortKey);
                              }}
                              title={col.label}
                            >
                              {col.label}
                            </th>
                          ))}
                      </tr>
                    </thead>
                    <tbody>
                      {filteredTracks.length === 0 ? (
                        <tr>
                          <td
                            colSpan={Math.max(1, tableColumns.filter((c) => c.visible).length)}
                            style={{ textAlign: 'center', padding: 36, color: '#64748b' }}
                          >
                            No tracks in this view. Configure your NFS/SMB Music Root in Preferences or click{' '}
                            <strong>"Import Music..."</strong> above.
                          </td>
                        </tr>
                      ) : (
                        <>
                          {filteredTracks.slice(0, visibleTrackLimit).map((track, idx) => {
                            const isCurrent = currentTrack?.id === track.id;
                            const visibleCols = tableColumns.filter((c) => c.visible);
                            return (
                              <tr
                                key={track.id}
                                className={isCurrent ? 'active-row' : ''}
                                draggable
                                onDragStart={(e) => {
                                  const payload = JSON.stringify({ kind: 'track', id: track.id, title: track.title });
                                  e.dataTransfer.effectAllowed = 'copy';
                                  e.dataTransfer.setData('application/x-rtunes-media', payload);
                                  e.dataTransfer.setData('application/json', payload);
                                }}
                                onDoubleClick={() => void playTrack(track)}
                              >
                                {visibleCols.map((col) => {
                                  switch (col.id) {
                                    case 'track_num':
                                      return (
                                        <td
                                          key={col.id}
                                          style={{ textAlign: 'right', color: isCurrent ? '#fff' : '#64748b' }}
                                        >
                                          {isCurrent && isPlaying ? '🔊' : track.track_num || idx + 1}
                                        </td>
                                      );
                                    case 'cache':
                                      return (
                                        <td key={col.id} style={{ textAlign: 'center' }}>
                                          <input
                                            type="checkbox"
                                            checked={Boolean(track.keep_cached || track.local_cache_path)}
                                            onChange={() => void handleToggleTrackCache(track)}
                                            title="Keep Cached Locally on SSD for instant ePod sync"
                                          />
                                        </td>
                                      );
                                    case 'title':
                                      return (
                                        <td key={col.id} style={{ fontWeight: isCurrent ? 700 : 500 }}>
                                          {track.title}
                                        </td>
                                      );
                                    case 'duration':
                                      return (
                                        <td key={col.id} style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}>
                                          {formatDuration(track.duration)}
                                        </td>
                                      );
                                    case 'artist':
                                      return <td key={col.id}>{track.artist}</td>;
                                    case 'album':
                                      return <td key={col.id}>{track.album}</td>;
                                    case 'genre':
                                      return <td key={col.id}>{track.genre}</td>;
                                    case 'year':
                                      return (
                                        <td key={col.id} style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}>
                                          {track.year || '—'}
                                        </td>
                                      );
                                    case 'rating':
                                      return (
                                        <td key={col.id}>
                                          <div className="star-rating">
                                            {[1, 2, 3, 4, 5].map((star) => (
                                              <span
                                                key={star}
                                                onClick={(e) => {
                                                  e.stopPropagation();
                                                  const nextVal = track.local_star_rating === star ? 0 : star;
                                                  void handleRateTrack(track.id, nextVal);
                                                }}
                                              >
                                                {star <= track.local_star_rating ? (
                                                  '★'
                                                ) : (
                                                  <span className="star-dot">•</span>
                                                )}
                                              </span>
                                            ))}
                                          </div>
                                        </td>
                                      );
                                    case 'loved':
                                      return (
                                        <td key={col.id} style={{ textAlign: 'center' }}>
                                          <span
                                            style={{
                                              cursor: 'pointer',
                                              color: track.is_loved
                                                ? isCurrent
                                                  ? '#fecdd3'
                                                  : '#e11d48'
                                                : '#94a3b8',
                                              fontSize: 13,
                                            }}
                                            onClick={(e) => {
                                              e.stopPropagation();
                                              void handleRateTrack(
                                                track.id,
                                                track.local_star_rating,
                                                !track.is_loved
                                              );
                                            }}
                                            title="Toggle Loved & Push Feedback to ListenBrainz"
                                          >
                                            {track.is_loved ? '♥' : '♡'}
                                          </span>
                                        </td>
                                      );
                                    case 'lb_plays':
                                      return (
                                        <td key={col.id} style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}>
                                          {track.global_listen_count.toLocaleString()}
                                        </td>
                                      );
                                    case 'rel_score':
                                      return (
                                        <td key={col.id}>
                                          <span
                                            style={{
                                              fontFamily: 'var(--font-mono)',
                                              fontSize: 10.5,
                                              fontWeight: 700,
                                              padding: '1px 5px',
                                              borderRadius: 4,
                                              background:
                                                track.artist_relative_popularity_score >= 1.5
                                                  ? isCurrent
                                                    ? 'rgba(255,255,255,0.25)'
                                                    : '#dcfce7'
                                                  : 'transparent',
                                              color:
                                                track.artist_relative_popularity_score >= 1.5 && !isCurrent
                                                  ? '#166534'
                                                  : 'inherit',
                                            }}
                                          >
                                            {track.artist_relative_popularity_score.toFixed(2)}×
                                          </span>
                                        </td>
                                      );
                                    case 'play_count':
                                      return (
                                        <td key={col.id} style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}>
                                          {track.play_count}
                                        </td>
                                      );
                                    case 'format':
                                      return (
                                        <td key={col.id} style={{ fontSize: 10.5 }}>
                                          {track.format} {track.bitrate ? `${track.bitrate}k` : ''}
                                        </td>
                                      );
                                    default:
                                      return <td key={col.id} />;
                                  }
                                })}
                              </tr>
                            );
                          })}
                          {filteredTracks.length > visibleTrackLimit && (
                            <tr>
                              <td
                                colSpan={Math.max(1, tableColumns.filter((c) => c.visible).length)}
                                style={{
                                  textAlign: 'center',
                                  padding: '10px 14px',
                                  background: '#e2e8f0',
                                  borderTop: '1px solid #cbd5e1',
                                }}
                              >
                                <div style={{ display: 'inline-flex', alignItems: 'center', gap: 10 }}>
                                  <span style={{ fontSize: 11.5, fontWeight: 600, color: '#334155' }}>
                                    Showing {visibleTrackLimit.toLocaleString()} of{' '}
                                    {filteredTracks.length.toLocaleString()} songs in view
                                  </span>
                                  <button
                                    className="aqua-btn primary"
                                    onClick={() => setVisibleTrackLimit((prev) => prev + 5000)}
                                  >
                                    Show +5,000 More Songs
                                  </button>
                                  <button
                                    className="aqua-btn"
                                    onClick={() => setVisibleTrackLimit(filteredTracks.length)}
                                  >
                                    Show All ({filteredTracks.length.toLocaleString()})
                                  </button>
                                </div>
                              </td>
                            </tr>
                          )}
                        </>
                      )}
                    </tbody>
                  </table>

                  {/* Mixed / Video Playlist Videos Section */}
                  {nav.kind === 'playlist' && playlistVideos.length > 0 && (
                    <div style={{ borderTop: '2px solid #94a3b8', background: '#f8fafc' }}>
                      <div
                        style={{
                          padding: '6px 12px',
                          background: 'linear-gradient(180deg, #e2e8f0 0%, #cbd5e1 100%)',
                          fontWeight: 700,
                          fontSize: 11.5,
                          color: '#1e293b',
                          borderBottom: '1px solid #94a3b8',
                        }}
                      >
                        Movies & TV Episodes in Playlist ({playlistVideos.length})
                      </div>
                      <table className="rtunes-table">
                        <thead>
                          <tr>
                            <th style={{ width: 65 }}>Play</th>
                            <th style={{ width: 75 }}>Type</th>
                            <th>Title</th>
                            <th style={{ width: 160 }}>Show / Year</th>
                            <th style={{ width: 90 }}>Duration</th>
                            <th style={{ width: 70 }}>Remove</th>
                          </tr>
                        </thead>
                        <tbody>
                          {playlistVideos.map((v) => (
                            <tr
                              key={`plv-${v.id}`}
                              onDoubleClick={async () => {
                                setActiveVideo(v);
                                await invokeRpc('videos:markWatched', v.id, true);
                              }}
                            >
                              <td>
                                <button
                                  className="aqua-btn primary"
                                  style={{ padding: '1px 7px' }}
                                  onClick={async () => {
                                    setActiveVideo(v);
                                    await invokeRpc('videos:markWatched', v.id, true);
                                  }}
                                >
                                  <Play size={11} /> Play
                                </button>
                              </td>
                              <td style={{ textTransform: 'uppercase', fontSize: 10.5, fontWeight: 700 }}>
                                {v.type}
                              </td>
                              <td style={{ fontWeight: 600 }}>{v.title}</td>
                              <td>
                                {v.type === 'tv'
                                  ? `${v.show_name || ''} ${
                                      v.season === 0
                                        ? '(Special)'
                                        : v.season
                                        ? `S${String(v.season).padStart(2, '0')}E${String(v.episode || 1).padStart(2, '0')}`
                                        : ''
                                    }`
                                  : v.year || '—'}
                              </td>
                              <td style={{ fontFamily: 'var(--font-mono)' }}>{formatDuration(v.duration)}</td>
                              <td>
                                <button
                                  className="aqua-btn"
                                  style={{ padding: '1px 6px', color: '#b91c1c' }}
                                  onClick={async () => {
                                    await invokeRpc('playlists:removeVideo', nav.id, v.id);
                                    const updatedVids = await invokeRpc<VideoRow[]>('playlists:getVideos', nav.id);
                                    setPlaylistVideos(updatedVids);
                                    const updatedPls = await invokeRpc<PlaylistRow[]>('playlists:list');
                                    setPlaylists(updatedPls);
                                  }}
                                >
                                  ✕
                                </button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              )}
            </>
          )}

          {/* 2A. TV SHOWS ORGANIZED BY SHOW -> SEASON -> EPISODE */}
          {nav.kind === 'tv' && (
            <div
              style={{
                flex: 1,
                display: 'flex',
                flexDirection: 'column',
                overflow: 'hidden',
                outline: dragOverView === 'tv' ? '2px dashed #2563eb' : undefined,
                outlineOffset: -4,
              }}
              onDragEnter={(e) => {
                e.preventDefault();
                e.stopPropagation();
                e.dataTransfer.dropEffect = 'copy';
                setDragOverView('tv');
              }}
              onDragOver={(e) => {
                e.preventDefault();
                e.stopPropagation();
                e.dataTransfer.dropEffect = 'copy';
                if (dragOverView !== 'tv') setDragOverView('tv');
              }}
              onDragLeave={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget as Node)) {
                  setDragOverView(null);
                }
              }}
              onDrop={(e) => handleDropOnLibraryView('tv', e)}
            >
              <div
                style={{
                  height: 36,
                  padding: '0 16px',
                  background: 'linear-gradient(180deg, #f3f5f9 0%, #d8dfe9 100%)',
                  borderBottom: '1px solid #9aa4b4',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <strong>TV Shows Library ({groupedTvShows.length} Shows)</strong>
                  <span style={{ fontSize: 11, color: '#475569' }}>
                    {videos.filter((v) => v.type === 'tv').length} Episodes Indexed
                  </span>
                  {toastBanner && (
                    <span
                      style={{
                        fontSize: 11,
                        fontWeight: 700,
                        color: '#15803d',
                        background: '#dcfce7',
                        border: '1px solid #86efac',
                        padding: '1px 8px',
                        borderRadius: 4,
                      }}
                    >
                      {toastBanner}
                    </span>
                  )}
                </div>
                <div style={{ display: 'flex', gap: 6 }}>
                  <button
                    className="aqua-btn"
                    onClick={async () => {
                      await invokeRpc('videos:hydrateArtwork');
                      const updated = await invokeRpc<VideoRow[]>('videos:search', searchQuery);
                      setVideos(updated);
                    }}
                    title="Fetch missing TV Show & Movie posters from TVMaze / IMDb"
                  >
                    <RefreshCw size={12} /> Fetch Posters
                  </button>
                  <button className="aqua-btn" onClick={handleScanDirectoryQuick}>
                    <FolderSearch size={12} /> Import TV Shows...
                  </button>
                </div>
              </div>

              {groupedTvShows.length === 0 ? (
                <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', color: '#64748b', gap: 8 }}>
                  <Tv size={42} color="#0d9488" />
                  <div style={{ fontWeight: 700, fontSize: 13, color: '#1e293b' }}>No TV Shows Indexed Yet</div>
                  <div style={{ fontSize: 11.5 }}>
                    Click <strong>"Import TV Shows..."</strong> above or configure your TV Shows Library Root in Preferences.
                  </div>
                </div>
              ) : (
                <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
                  {/* Left Pane: TV Shows Directory with Poster Art */}
                  <div
                    style={{
                      width: 290,
                      minWidth: 290,
                      borderRight: '1px solid #9aa4b4',
                      background: '#edf1f7',
                      overflowY: 'auto',
                      padding: 10,
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 8,
                    }}
                  >
                    {groupedTvShows.map((show) => {
                      const activeShowName = selectedTvShow || groupedTvShows[0]?.showName;
                      const isSelected = activeShowName === show.showName;
                      const posterUrl = getArtworkUrl(show.posterPath);
                      const cachedCount = show.allEpisodes.filter(
                        (e) => e.keep_cached || e.is_transcoded
                      ).length;

                      return (
                        <div
                          key={show.showName}
                          draggable
                          onDragStart={(e) => {
                            const payload = JSON.stringify({ kind: 'show', showName: show.showName });
                            e.dataTransfer.effectAllowed = 'copy';
                            e.dataTransfer.setData('application/x-rtunes-media', payload);
                            e.dataTransfer.setData('application/json', payload);
                          }}
                          onClick={() => {
                            setSelectedTvShow(show.showName);
                            setSelectedTvSeason('All');
                          }}
                          style={{
                            display: 'flex',
                            gap: 10,
                            padding: 8,
                            borderRadius: 6,
                            cursor: 'pointer',
                            background: isSelected
                              ? 'linear-gradient(180deg, #3b82f6 0%, #1d4ed8 100%)'
                              : '#ffffff',
                            color: isSelected ? '#ffffff' : '#0f172a',
                            border: isSelected ? '1px solid #1e40af' : '1px solid #cbd5e1',
                            boxShadow: '0 1px 3px rgba(0,0,0,0.06)',
                          }}
                          title="Click to view episodes, or drag & drop onto a Playlist in the sidebar"
                        >
                          <div
                            style={{
                              width: 54,
                              height: 76,
                              borderRadius: 4,
                              overflow: 'hidden',
                              background: '#0f172a',
                              flexShrink: 0,
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                            }}
                          >
                            {posterUrl ? (
                              <img
                                src={posterUrl}
                                alt={show.showName}
                                style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                              />
                            ) : (
                              <Tv size={22} color="#64748b" />
                            )}
                          </div>
                          <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
                            <div
                              style={{
                                fontWeight: 700,
                                fontSize: 12.5,
                                whiteSpace: 'nowrap',
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                              }}
                            >
                              {show.showName}
                            </div>
                            <div
                              style={{
                                fontSize: 11,
                                color: isSelected ? '#dbeafe' : '#475569',
                                marginTop: 2,
                              }}
                            >
                              {show.seasons.size} {show.seasons.size === 1 ? 'Season' : 'Seasons'} •{' '}
                              {show.allEpisodes.length} Episodes
                            </div>
                            {cachedCount > 0 && (
                              <div
                                style={{
                                  fontSize: 10,
                                  marginTop: 4,
                                  fontWeight: 700,
                                  color: isSelected ? '#bbf7d0' : '#15803d',
                                }}
                              >
                                ✓ {cachedCount}/{show.allEpisodes.length} Pre-Cached (360p)
                              </div>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>

                  {/* Right Pane: Selected Show Header, Season Selector, and Episode List */}
                  {(() => {
                    const activeShow =
                      groupedTvShows.find((s) => s.showName === selectedTvShow) || groupedTvShows[0];
                    if (!activeShow) return null;

                    const posterUrl = getArtworkUrl(activeShow.posterPath);
                    const seasonsList = Array.from(activeShow.seasons.keys()).sort((a, b) => a - b);
                    const episodesToDisplay = (
                      selectedTvSeason === 'All'
                        ? activeShow.allEpisodes
                        : activeShow.seasons.get(selectedTvSeason) || []
                    )
                      .slice()
                      .sort(
                        (a, b) =>
                          (a.season ?? 1) - (b.season ?? 1) || (a.episode || 1) - (b.episode || 1)
                      );

                    const allShowCached = activeShow.allEpisodes.every(
                      (e) => e.keep_cached || e.is_transcoded
                    );

                    return (
                      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
                        {/* Show Banner Header */}
                        <div
                          style={{
                            padding: '14px 18px',
                            background: 'linear-gradient(180deg, #1e293b 0%, #0f172a 100%)',
                            color: '#f8fafc',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'space-between',
                            gap: 16,
                            borderBottom: '1px solid #334155',
                          }}
                        >
                          <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
                            <div
                              style={{
                                width: 64,
                                height: 90,
                                borderRadius: 6,
                                overflow: 'hidden',
                                background: '#334155',
                                boxShadow: '0 4px 12px rgba(0,0,0,0.45)',
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                flexShrink: 0,
                              }}
                            >
                              {posterUrl ? (
                                <img
                                  src={posterUrl}
                                  alt={activeShow.showName}
                                  style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                                />
                              ) : (
                                <Tv size={28} color="#94a3b8" />
                              )}
                            </div>
                            <div>
                              <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700 }}>
                                {activeShow.showName}
                              </h2>
                              <div style={{ fontSize: 11.5, color: '#94a3b8', marginTop: 4 }}>
                                {activeShow.seasons.size}{' '}
                                {activeShow.seasons.size === 1 ? 'Season' : 'Seasons'} •{' '}
                                {activeShow.allEpisodes.length} Episodes
                              </div>
                              <div style={{ display: 'flex', gap: 6, marginTop: 10, flexWrap: 'wrap' }}>
                                <button
                                  className={`aqua-btn ${selectedTvSeason === 'All' ? 'primary' : ''}`}
                                  onClick={() => setSelectedTvSeason('All')}
                                >
                                  All Seasons ({activeShow.allEpisodes.length})
                                </button>
                                {seasonsList.map((sNum) => (
                                  <button
                                    key={sNum}
                                    className={`aqua-btn ${selectedTvSeason === sNum ? 'primary' : ''}`}
                                    onClick={() => setSelectedTvSeason(sNum)}
                                  >
                                    {sNum === 0
                                      ? `Specials / Extras (${activeShow.seasons.get(sNum)?.length || 0})`
                                      : `Season ${sNum} (${activeShow.seasons.get(sNum)?.length || 0})`}
                                  </button>
                                ))}
                              </div>
                            </div>
                          </div>

                          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 6 }}>
                            <button
                              className="aqua-btn primary"
                              onClick={async () => {
                                await invokeRpc(
                                  'cache:toggleShow',
                                  activeShow.showName,
                                  !allShowCached
                                );
                                const updated = await invokeRpc<VideoRow[]>('videos:search', searchQuery);
                                setVideos(updated);
                              }}
                            >
                              {allShowCached
                                ? '✓ Entire Show Cached (360p)'
                                : 'Pre-Transcode Entire Show (360p)'}
                            </button>
                            <span style={{ fontSize: 10.5, color: '#94a3b8' }}>
                              Ready for 1-click ePod Video Sync
                            </span>
                          </div>
                        </div>

                        {/* Episodes Table */}
                        <div className="rtunes-table-container">
                          <table className="rtunes-table">
                            <thead>
                              <tr>
                                <th style={{ width: 68 }}>Play</th>
                                <th style={{ width: 95 }}>Season / Ep</th>
                                <th>Episode Title</th>
                                <th style={{ width: 95 }}>360p Cache</th>
                                <th style={{ width: 85 }}>Duration</th>
                                <th style={{ width: 90 }}>Size</th>
                                <th style={{ width: 130 }}>ePod Status</th>
                              </tr>
                            </thead>
                            <tbody>
                              {episodesToDisplay.map((ep) => (
                                <tr
                                  key={ep.id}
                                  draggable
                                  onDragStart={(e) => {
                                    const payload = JSON.stringify({ kind: 'video', id: ep.id, title: ep.title });
                                    e.dataTransfer.effectAllowed = 'copy';
                                    e.dataTransfer.setData('application/x-rtunes-media', payload);
                                    e.dataTransfer.setData('application/json', payload);
                                  }}
                                  onDoubleClick={async () => {
                                    setActiveVideo(ep);
                                    await invokeRpc('videos:markWatched', ep.id, true);
                                  }}
                                >
                                  <td>
                                    <button
                                      className="aqua-btn primary"
                                      style={{ padding: '1px 7px' }}
                                      onClick={async () => {
                                        setActiveVideo(ep);
                                        await invokeRpc('videos:markWatched', ep.id, true);
                                      }}
                                    >
                                      <Play size={11} /> Play
                                    </button>
                                  </td>
                                  <td style={{ fontFamily: 'var(--font-mono)', fontWeight: 700 }}>
                                    {ep.season === 0
                                      ? ep.episode
                                        ? `S00E${String(ep.episode).padStart(2, '0')}`
                                        : 'Special'
                                      : `S${String(ep.season || 1).padStart(2, '0')}E${String(
                                          ep.episode || 1
                                        ).padStart(2, '0')}`}
                                  </td>
                                  <td style={{ fontWeight: 600 }}>{ep.title}</td>
                                  <td>
                                    <input
                                      type="checkbox"
                                      checked={Boolean(ep.keep_cached || ep.is_transcoded)}
                                      onChange={async (e) => {
                                        await invokeRpc('cache:toggleVideo', ep.id, e.target.checked);
                                        const updated = await invokeRpc<VideoRow[]>(
                                          'videos:search',
                                          searchQuery
                                        );
                                        setVideos(updated);
                                      }}
                                      title="Queue 480x360 30fps H.264 + AAC 128k hardware transcode for instant ePod sync"
                                    />{' '}
                                    <span style={{ fontSize: 10.5 }}>Keep 360p</span>
                                  </td>
                                  <td style={{ fontFamily: 'var(--font-mono)' }}>
                                    {formatDuration(ep.duration)}
                                  </td>
                                  <td>{formatBytes(ep.file_size)}</td>
                                  <td>
                                    <span
                                      style={{
                                        fontSize: 10.5,
                                        fontWeight: 700,
                                        color:
                                          ep.transcode_status === 'ready'
                                            ? '#15803d'
                                            : ep.transcode_status === 'transcoding'
                                            ? '#2563eb'
                                            : '#64748b',
                                      }}
                                    >
                                      {ep.transcode_status === 'ready'
                                        ? '✓ 360p Cached'
                                        : ep.transcode_status === 'transcoding'
                                        ? `Transcoding ${ep.transcode_progress}%`
                                        : ep.transcode_status === 'queued'
                                        ? 'Queued'
                                        : 'Master Only'}
                                    </span>
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    );
                  })()}
                </div>
              )}
            </div>
          )}

          {/* 2B. MOVIES VIEW WITH POSTER ARTWORK */}
          {nav.kind === 'movies' && (
            <div
              style={{
                flex: 1,
                display: 'flex',
                flexDirection: 'column',
                overflow: 'hidden',
                outline: dragOverView === 'movies' ? '2px dashed #2563eb' : undefined,
                outlineOffset: -4,
              }}
              onDragEnter={(e) => {
                e.preventDefault();
                e.stopPropagation();
                e.dataTransfer.dropEffect = 'copy';
                setDragOverView('movies');
              }}
              onDragOver={(e) => {
                e.preventDefault();
                e.stopPropagation();
                e.dataTransfer.dropEffect = 'copy';
                if (dragOverView !== 'movies') setDragOverView('movies');
              }}
              onDragLeave={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget as Node)) {
                  setDragOverView(null);
                }
              }}
              onDrop={(e) => handleDropOnLibraryView('movies', e)}
            >
              <div
                style={{
                  height: 36,
                  padding: '0 16px',
                  background: 'linear-gradient(180deg, #f3f5f9 0%, #d8dfe9 100%)',
                  borderBottom: '1px solid #9aa4b4',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                }}
              >
                <strong>
                  Movies Library ({videos.filter((v) => v.type === 'movie').length} Movies)
                </strong>
                <div style={{ display: 'flex', gap: 6 }}>
                  <button
                    className="aqua-btn"
                    onClick={async () => {
                      await invokeRpc('videos:hydrateArtwork');
                      const updated = await invokeRpc<VideoRow[]>('videos:search', searchQuery);
                      setVideos(updated);
                    }}
                  >
                    <RefreshCw size={12} /> Fetch Posters
                  </button>
                  <button className="aqua-btn" onClick={handleScanDirectoryQuick}>
                    <FolderSearch size={12} /> Import Movies...
                  </button>
                </div>
              </div>

              <div className="rtunes-table-container">
                <table className="rtunes-table">
                  <thead>
                    <tr>
                      <th style={{ width: 54 }}>Poster</th>
                      <th style={{ width: 65 }}>Play</th>
                      <th style={{ width: 95 }}>360p Cache</th>
                      <th>Movie Title</th>
                      <th style={{ width: 70 }}>Year</th>
                      <th style={{ width: 90 }}>Duration</th>
                      <th style={{ width: 95 }}>Format</th>
                      <th style={{ width: 85 }}>Size</th>
                      <th style={{ width: 130 }}>ePod Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {videos.filter((v) => v.type === 'movie').length === 0 ? (
                      <tr>
                        <td colSpan={9} style={{ textAlign: 'center', padding: 36, color: '#64748b' }}>
                          No movies indexed in your library yet. Click <strong>"Import Movies..."</strong> above or configure your Movies Root in Preferences.
                        </td>
                      </tr>
                    ) : (
                      videos
                        .filter((v) => v.type === 'movie')
                        .map((v) => {
                          const posterUrl = getArtworkUrl(v.poster_path);
                          return (
                            <tr
                              key={v.id}
                              draggable
                              onDragStart={(e) => {
                                const payload = JSON.stringify({ kind: 'video', id: v.id, title: v.title });
                                e.dataTransfer.effectAllowed = 'copy';
                                e.dataTransfer.setData('application/x-rtunes-media', payload);
                                e.dataTransfer.setData('application/json', payload);
                              }}
                              onDoubleClick={async () => {
                                setActiveVideo(v);
                                await invokeRpc('videos:markWatched', v.id, true);
                              }}
                            >
                              <td>
                                <div
                                  style={{
                                    width: 34,
                                    height: 48,
                                    borderRadius: 3,
                                    overflow: 'hidden',
                                    background: '#0f172a',
                                    display: 'flex',
                                    alignItems: 'center',
                                    justifyContent: 'center',
                                  }}
                                >
                                  {posterUrl ? (
                                    <img
                                      src={posterUrl}
                                      alt={v.title}
                                      style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                                    />
                                  ) : (
                                    <Film size={14} color="#64748b" />
                                  )}
                                </div>
                              </td>
                              <td>
                                <button
                                  className="aqua-btn primary"
                                  style={{ padding: '1px 7px' }}
                                  onClick={async () => {
                                    setActiveVideo(v);
                                    await invokeRpc('videos:markWatched', v.id, true);
                                  }}
                                >
                                  <Play size={11} /> Play
                                </button>
                              </td>
                              <td>
                                <input
                                  type="checkbox"
                                  checked={Boolean(v.keep_cached || v.is_transcoded)}
                                  onChange={async (e) => {
                                    await invokeRpc('cache:toggleVideo', v.id, e.target.checked);
                                    const updated = await invokeRpc<VideoRow[]>('videos:search', searchQuery);
                                    setVideos(updated);
                                  }}
                                  title="Queue 480x360 30fps H.264 + AAC 128k hardware transcode for instant ePod sync"
                                />{' '}
                                <span style={{ fontSize: 10.5 }}>Keep 360p</span>
                              </td>
                              <td style={{ fontWeight: 600 }}>{v.title}</td>
                              <td>{v.year || '—'}</td>
                              <td style={{ fontFamily: 'var(--font-mono)' }}>{formatDuration(v.duration)}</td>
                              <td>{v.width && v.height ? `${v.width}×${v.height}` : v.format}</td>
                              <td>{formatBytes(v.file_size)}</td>
                              <td>
                                <span
                                  style={{
                                    fontSize: 10.5,
                                    fontWeight: 700,
                                    color:
                                      v.transcode_status === 'ready'
                                        ? '#15803d'
                                        : v.transcode_status === 'transcoding'
                                        ? '#2563eb'
                                        : '#64748b',
                                  }}
                                >
                                  {v.transcode_status === 'ready'
                                    ? '✓ 360p Cached'
                                    : v.transcode_status === 'transcoding'
                                    ? `Transcoding ${v.transcode_progress}%`
                                    : v.transcode_status === 'queued'
                                    ? 'Queued'
                                    : 'Master Only'}
                                </span>
                              </td>
                            </tr>
                          );
                        })
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* 3. LOCAL SSD PRE-CACHE & 360P TRANSCODE WORKER VIEW (Section 3) */}
          {nav.kind === 'cache' && cacheStats && (
            <div style={{ flex: 1, overflowY: 'auto', padding: 20, background: '#e6ebf2', display: 'flex', flexDirection: 'column', gap: 16 }}>
              <div className="epod-capacity-card">
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                  <div>
                    <h3 style={{ margin: 0 }}>Local Pre-Cache Storage</h3>
                    <div style={{ fontSize: 11, color: '#475569', marginTop: 2 }}>
                      Location: <code>{cacheStats.cachePath}</code>
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button
                      className="aqua-btn primary"
                      onClick={async () => {
                        const st = await invokeRpc<CacheStats>('cache:precacheAllPlaylists');
                        setCacheStats(st);
                      }}
                    >
                      Pre-Cache All Playlists
                    </button>
                    <button
                      className="aqua-btn"
                      onClick={async () => {
                        await invokeRpc('cache:clear');
                        await refreshAllData();
                      }}
                    >
                      Clear Local Cache
                    </button>
                  </div>
                </div>

                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11.5, fontWeight: 600, marginBottom: 6 }}>
                  <span>
                    Used: {formatBytes(cacheStats.usedBytes)} of {formatBytes(cacheStats.quotaBytes)} ({cacheStats.usagePercent}%)
                  </span>
                  <span>
                    {cacheStats.audioCount} Cached Audio Tracks • {cacheStats.videoCount} 360p Transcoded Videos • {cacheStats.artworkCount} Cached Covers
                  </span>
                </div>
                <div className="epod-segmented-bar">
                  <div className="seg-audio" style={{ width: `${Math.min(100, cacheStats.usagePercent)}%` }} />
                </div>
              </div>

              <div className="epod-capacity-card" style={{ padding: 0, overflow: 'hidden' }}>
                <div style={{ padding: '10px 14px', borderBottom: '1px solid #cbd5e1', fontWeight: 700 }}>
                  Background Audio Copy & Hardware-Accelerated 360p Video Transcoding Queue
                </div>
                <table className="rtunes-table">
                  <thead>
                    <tr>
                      <th style={{ width: 55 }}>ID</th>
                      <th style={{ width: 70 }}>Type</th>
                      <th>Item</th>
                      <th style={{ width: 150 }}>Encoder</th>
                      <th style={{ width: 110 }}>Status</th>
                      <th style={{ width: 140 }}>Progress</th>
                      <th style={{ width: 90 }}>Size</th>
                    </tr>
                  </thead>
                  <tbody>
                    {cacheStats.jobs.length === 0 ? (
                      <tr>
                        <td colSpan={7} style={{ textAlign: 'center', padding: 28, color: '#64748b' }}>
                          No cache or transcode jobs queued yet. Toggle "Cache" on any track or "Keep 360p" on any video.
                        </td>
                      </tr>
                    ) : (
                      cacheStats.jobs.map((job) => (
                        <tr key={job.id}>
                          <td>#{job.id}</td>
                          <td style={{ textTransform: 'uppercase', fontWeight: 700, fontSize: 10.5 }}>
                            {job.item_type}
                          </td>
                          <td style={{ fontWeight: 600 }}>{job.title}</td>
                          <td style={{ fontFamily: 'var(--font-mono)', fontSize: 10.5 }}>
                            {job.encoder_used || 'pending'}
                          </td>
                          <td>
                            <span
                              style={{
                                fontWeight: 700,
                                color:
                                  job.status === 'completed'
                                    ? '#15803d'
                                    : job.status === 'failed'
                                    ? '#b91c1c'
                                    : '#2563eb',
                              }}
                            >
                              {job.status.toUpperCase()}
                            </span>
                          </td>
                          <td>{job.progress}%</td>
                          <td>{formatBytes(job.size_bytes)}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* 3B. MUSIC VIDEOS SECTION (Priority 7.3) */}
          {nav.kind === 'music_videos' && (
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
              <div
                style={{
                  height: 36,
                  padding: '0 16px',
                  background: 'linear-gradient(180deg, #f3f5f9 0%, #d8dfe9 100%)',
                  borderBottom: '1px solid #9aa4b4',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                }}
              >
                <strong>
                  Music Videos ({videos.filter((v) => v.type === 'music_video').length} Videos)
                </strong>
                <div style={{ display: 'flex', gap: 6 }}>
                  <button
                    className="aqua-btn primary"
                    onClick={() => {
                      const mvs = videos.filter((v) => v.type === 'music_video');
                      if (mvs.length > 0) {
                        const rand = mvs[Math.floor(Math.random() * mvs.length)];
                        setActiveVideo(rand);
                      }
                    }}
                  >
                    <Play size={12} /> Continuous Music Video Shuffle
                  </button>
                  <button className="aqua-btn" onClick={() => setShowUploadWizard(true)}>
                    <Upload size={12} /> Upload Music Video...
                  </button>
                </div>
              </div>
              <div className="rtunes-table-container">
                <table className="rtunes-table">
                  <thead>
                    <tr>
                      <th style={{ width: 65 }}>Play</th>
                      <th>Title</th>
                      <th>Artist</th>
                      <th style={{ width: 100 }}>Resolution</th>
                      <th style={{ width: 140 }}>ePod Target</th>
                    </tr>
                  </thead>
                  <tbody>
                    {videos.filter((v) => v.type === 'music_video').length === 0 ? (
                      <tr>
                        <td colSpan={5} style={{ textAlign: 'center', padding: 36, color: '#64748b' }}>
                          No Music Videos indexed yet. Configure your Music Videos folder in Preferences → Paths & Backend or click <strong>Upload Music Video...</strong> above.
                        </td>
                      </tr>
                    ) : (
                      videos
                        .filter((v) => v.type === 'music_video')
                        .map((mv) => (
                          <tr key={mv.id} onDoubleClick={() => setActiveVideo(mv)}>
                            <td>
                              <button className="aqua-btn primary" onClick={() => setActiveVideo(mv)}>
                                <Play size={11} /> Play
                              </button>
                            </td>
                            <td style={{ fontWeight: 600 }}>{mv.title}</td>
                            <td>{mv.artist || 'Unknown Artist'}</td>
                            <td>{mv.resolution || '480×360'}</td>
                            <td>
                              <code>Root/Videos/Music Videos/</code>
                            </td>
                          </tr>
                        ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* 3C. AUDIOBOOKS SECTION WITH 1.0x-2.5x SPEED & +-30s SKIP (Priority 7.2) */}
          {nav.kind === 'audiobooks' && (
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
              <div
                style={{
                  height: 38,
                  padding: '0 16px',
                  background: 'linear-gradient(180deg, #f3f5f9 0%, #d8dfe9 100%)',
                  borderBottom: '1px solid #9aa4b4',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                }}
              >
                <strong>
                  Audiobooks ({audiobooks.length}) • Audiobookshelf / Narratarr Ready
                </strong>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: 11, fontWeight: 600 }}>Playback Speed:</span>
                  {[1.0, 1.25, 1.5, 2.0, 2.5].map((spd) => (
                    <button
                      key={spd}
                      className={`aqua-btn ${playbackSpeed === spd ? 'primary' : ''}`}
                      style={{ padding: '2px 7px', fontSize: 10.5 }}
                      onClick={() => {
                        setPlaybackSpeed(spd);
                        if (audioRef.current) audioRef.current.playbackRate = spd;
                      }}
                    >
                      {spd}×
                    </button>
                  ))}
                  <button
                    className="aqua-btn"
                    onClick={() => {
                      if (audioRef.current) {
                        audioRef.current.currentTime = Math.max(0, audioRef.current.currentTime - 30);
                      }
                    }}
                  >
                    ↺ -30s
                  </button>
                  <button
                    className="aqua-btn"
                    onClick={() => {
                      if (audioRef.current) {
                        audioRef.current.currentTime = audioRef.current.currentTime + 30;
                      }
                    }}
                  >
                    +30s ↻
                  </button>
                  <button className="aqua-btn" onClick={() => setShowUploadWizard(true)}>
                    <Upload size={12} /> Upload Audiobook...
                  </button>
                </div>
              </div>
              <div className="rtunes-table-container">
                <table className="rtunes-table">
                  <thead>
                    <tr>
                      <th>Audiobook Title</th>
                      <th>Author</th>
                      <th style={{ width: 130 }}>Resume Position</th>
                      <th style={{ width: 160 }}>ePod Target Path</th>
                    </tr>
                  </thead>
                  <tbody>
                    {audiobooks.length === 0 ? (
                      <tr>
                        <td colSpan={4} style={{ textAlign: 'center', padding: 36, color: '#64748b' }}>
                          No Audiobooks indexed yet. Configure your Audiobooks folder or Audiobookshelf server in Preferences, or click <strong>Upload Audiobook...</strong> above.
                        </td>
                      </tr>
                    ) : (
                      audiobooks.map((ab) => (
                        <tr key={ab.id}>
                          <td style={{ fontWeight: 600 }}>{ab.title}</td>
                          <td>{ab.author}</td>
                          <td style={{ fontFamily: 'var(--font-mono)' }}>
                            {formatDuration(ab.current_time_sec || 0)}
                          </td>
                          <td>
                            <code>
                              Root/Audiobooks/{ab.author}/{ab.title}/
                            </code>
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* 3D. BOOKS (EBOOKS) SECTION (Priority 7.1) */}
          {nav.kind === 'books' && (
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
              <div
                style={{
                  height: 36,
                  padding: '0 16px',
                  background: 'linear-gradient(180deg, #f3f5f9 0%, #d8dfe9 100%)',
                  borderBottom: '1px solid #9aa4b4',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                }}
              >
                <strong>
                  Books & eBooks ({books.length}) • Chaptarr / Calibre-Web Ready
                </strong>
                <button className="aqua-btn primary" onClick={() => setShowUploadWizard(true)}>
                  <Upload size={12} /> Upload Book (EPUB/PDF/CBZ)...
                </button>
              </div>
              <div className="rtunes-table-container">
                <table className="rtunes-table">
                  <thead>
                    <tr>
                      <th>Book Title</th>
                      <th>Author</th>
                      <th style={{ width: 90 }}>Format</th>
                      <th style={{ width: 90 }}>Size</th>
                      <th style={{ width: 180 }}>ePod Sync Path</th>
                    </tr>
                  </thead>
                  <tbody>
                    {books.length === 0 ? (
                      <tr>
                        <td colSpan={5} style={{ textAlign: 'center', padding: 36, color: '#64748b' }}>
                          No Books indexed yet. Configure your Books folder or Chaptarr URL in Preferences, or click <strong>Upload Book...</strong> above.
                        </td>
                      </tr>
                    ) : (
                      books.map((bk) => (
                        <tr key={bk.id}>
                          <td style={{ fontWeight: 600 }}>{bk.title}</td>
                          <td>{bk.author}</td>
                          <td>{bk.format}</td>
                          <td>{formatBytes(bk.file_size || 0)}</td>
                          <td>
                            <code>Root/Books/{bk.author}/</code>
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* 3E. PHOTOS & IMMICH ALBUM GRID (Priority 7.4) */}
          {nav.kind === 'photos' && (
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
              <div
                style={{
                  height: 36,
                  padding: '0 16px',
                  background: 'linear-gradient(180deg, #f3f5f9 0%, #d8dfe9 100%)',
                  borderBottom: '1px solid #9aa4b4',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                }}
              >
                <strong>
                  Photos & Immich Library ({photos.length} Photos • Syncs to ePod <code>Root/Pictures/</code> at 480×360)
                </strong>
                <button className="aqua-btn primary" onClick={() => setShowUploadWizard(true)}>
                  <Upload size={12} /> Upload Photos...
                </button>
              </div>
              <div style={{ flex: 1, overflowY: 'auto', padding: 20 }}>
                {photos.length === 0 ? (
                  <div className="epod-capacity-card" style={{ textAlign: 'center', padding: 36, color: '#64748b' }}>
                    No Photos indexed yet. Configure your Photos folder or Immich Server URL in Preferences, or click <strong>Upload Photos...</strong> above.
                  </div>
                ) : (
                  <div
                    style={{
                      display: 'grid',
                      gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))',
                      gap: 14,
                    }}
                  >
                    {photos.map((ph) => (
                      <div
                        key={ph.id}
                        style={{
                          background: '#fff',
                          border: '1px solid #cbd5e1',
                          borderRadius: 6,
                          padding: 8,
                          textAlign: 'center',
                        }}
                      >
                        <div
                          style={{
                            height: 110,
                            background: '#0f172a',
                            borderRadius: 4,
                            marginBottom: 6,
                            overflow: 'hidden',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                          }}
                        >
                          {mediaPort > 0 && ph.remote_path ? (
                            <img
                              src={`http://127.0.0.1:${mediaPort}/artwork?path=${encodeURIComponent(ph.remote_path)}`}
                              alt={ph.title}
                              style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                            />
                          ) : (
                            <Image size={28} color="#94a3b8" />
                          )}
                        </div>
                        <div style={{ fontWeight: 700, fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {ph.title}
                        </div>
                        <div style={{ fontSize: 10, color: '#64748b' }}>{ph.album_name}</div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* 4. RTUNES STOREFRONT (*ARR REQUEST GATEWAY) */}
          {nav.kind === 'store' && (
            <StorefrontView
              settings={settings}
              onSettingsUpdated={(updated) => setSettings(updated)}
            />
          )}

          {/* 5. LIVE DOWNLOADS QUEUE */}
          {nav.kind === 'downloads' && (
            <DownloadsQueueView
              queue={arrQueue}
              onRefresh={async () => {
                const q = await invokeRpc<ArrQueueItem[]>('arr:queue');
                setArrQueue(q);
              }}
            />
          )}

          {/* 6. EPOD DEVICE SUMMARY TAB */}
          {nav.kind === 'device' &&
            (() => {
              const dev = devices.find((d) => d.uuid === nav.uuid);
              if (!dev) return null;
              return (
                <DeviceSummaryView
                  device={dev}
                  playlists={playlists}
                  videos={videos}
                  syncProgress={syncProgress}
                  onDeviceUpdated={setDevices}
                  onEjected={() => {
                    void refreshAllData();
                    setNav({ kind: 'music' });
                  }}
                />
              );
            })()}
        </main>
      </div>

      {/* =====================================================================
          BOTTOM BRUSHED METAL STATUS BAR
          ===================================================================== */}
      <footer className="bottom-status-bar">
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <button
            className="aqua-btn"
            onClick={() => {
              setNewPlaylistName('New Playlist');
              setNewPlaylistMediaType('mixed');
              setShowNewPlaylistModal(true);
            }}
            title="Create Regular Music, Video, or Mixed Playlist"
          >
            <Plus size={12} /> Playlist
          </button>
          <button
            className="aqua-btn"
            onClick={() => {
              setEditingPlaylist(null);
              setShowSmartModal(true);
            }}
            title="Create Granular Smart Playlist with Artist-Normalized Popularity Rules"
          >
            <Sparkles size={12} color="#6d28d9" /> Smart Playlist...
          </button>
          <button
            className="aqua-btn"
            onClick={() => setShowAddDeviceWizard(true)}
            title="Open Universal ePod Provisioning Wizard"
          >
            <Usb size={12} /> Add Device...
          </button>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 14, fontWeight: 600 }}>
          <span>
            {filteredTracks.length.toLocaleString()} items • {formatDuration(totalDurationSec)} •{' '}
            {formatBytes(totalBytes)}
          </span>

          {/* Always-Visible Sync Status Pills in Bottom Bar */}
          <span
            onClick={() => setLcdMode(lcdMode === 'db_sync' ? 'info' : 'db_sync')}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 5,
              padding: '1px 8px',
              borderRadius: 10,
              background: indexProgress.running ? '#dbeafe' : 'rgba(255,255,255,0.45)',
              border: '1px solid #94a3b8',
              cursor: 'pointer',
              fontSize: 10.5,
              color: indexProgress.running ? '#1d4ed8' : '#334155',
            }}
            title="Click to flip Top LCD Display to Database Sync view"
          >
            <span className={`status-dot ${indexProgress.running ? 'green' : 'gray'}`} />
            {indexProgress.running
              ? `DB Sync: ${indexProgress.processed.toLocaleString()}/${indexProgress.total.toLocaleString()}`
              : 'DB Sync: Ready'}
          </span>

          <span
            onClick={() => setLcdMode(lcdMode === 'epod_sync' ? 'info' : 'epod_sync')}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 5,
              padding: '1px 8px',
              borderRadius: 10,
              background: syncProgress.running ? '#dcfce7' : 'rgba(255,255,255,0.45)',
              border: '1px solid #94a3b8',
              cursor: 'pointer',
              fontSize: 10.5,
              color: syncProgress.running ? '#15803d' : '#334155',
            }}
            title="Click to flip Top LCD Display to ePod Sync view"
          >
            <span
              className={`status-dot ${
                syncProgress.running ? 'green' : devices.length > 0 ? 'green' : 'gray'
              }`}
            />
            {syncProgress.running
              ? `ePod Sync: ${syncProgress.stage} (${syncProgress.processed}/${syncProgress.total})`
              : devices.length > 0
              ? `ePod (${devices[0].name}): ${syncProgress.stage || 'Idle'}`
              : 'ePod Sync: Disconnected'}
          </span>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 5,
              cursor: 'pointer',
              fontWeight: 600,
            }}
            onClick={() => setShowPreferences(true)}
            title={
              !isDevMode()
                ? 'Coming soon — rTunes is currently focused on direct network shares, local media, and USB/MTP ePod syncing.'
                : undefined
            }
          >
            <ShieldCheck size={13} color={isDevMode() && authState.authenticated ? '#15803d' : '#475569'} />
            {isDevMode() ? (
              authState.authenticated && authState.user ? (
                <>
                  SSO: @{authState.user.username} <span className="aqua-dev-badge">[DEV PREVIEW]</span>
                </>
              ) : (
                <>
                  Mode: Standalone <span className="aqua-dev-badge">[DEV]</span>
                </>
              )
            ) : (
              <>
                Mode: Standalone <span className="aqua-coming-soon-pill">SSO: Coming Soon</span>
              </>
            )}
          </span>
        </div>
      </footer>

      {/* =====================================================================
          CREATE REGULAR / MIXED PLAYLIST MODAL
          ===================================================================== */}
      {showNewPlaylistModal && (
        <div className="aqua-modal-backdrop" onClick={() => setShowNewPlaylistModal(false)}>
          <div
            className="aqua-window"
            style={{ width: 440, maxWidth: '92vw' }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="aqua-window-titlebar">
              <span>Create New Playlist</span>
              <button
                className="aqua-btn"
                onClick={() => setShowNewPlaylistModal(false)}
                style={{ padding: '1px 6px' }}
              >
                <X size={13} />
              </button>
            </div>
            <div style={{ padding: 18, display: 'flex', flexDirection: 'column', gap: 14 }}>
              <div>
                <label style={{ display: 'block', fontWeight: 700, marginBottom: 5 }}>
                  Playlist Name:
                </label>
                <input
                  className="aqua-input"
                  style={{ width: '100%' }}
                  value={newPlaylistName}
                  onChange={(e) => setNewPlaylistName(e.target.value)}
                  autoFocus
                  onKeyDown={async (e) => {
                    if (e.key === 'Enter' && newPlaylistName.trim()) {
                      const newId = await invokeRpc<number>('playlists:save', {
                        name: newPlaylistName.trim(),
                        isSmart: false,
                        mediaType: newPlaylistMediaType,
                      });
                      setShowNewPlaylistModal(false);
                      await refreshAllData();
                      setNav({ kind: 'playlist', id: newId });
                    }
                  }}
                />
              </div>

              <div>
                <label style={{ display: 'block', fontWeight: 700, marginBottom: 6 }}>
                  Playlist Media Mode:
                </label>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontWeight: 600 }}>
                    <input
                      type="radio"
                      checked={newPlaylistMediaType === 'mixed'}
                      onChange={() => setNewPlaylistMediaType('mixed')}
                    />
                    Mixed Media Playlist (Songs + Movies + TV Shows)
                  </label>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontWeight: 600 }}>
                    <input
                      type="radio"
                      checked={newPlaylistMediaType === 'music'}
                      onChange={() => setNewPlaylistMediaType('music')}
                    />
                    Music Only Playlist (Songs)
                  </label>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontWeight: 600 }}>
                    <input
                      type="radio"
                      checked={newPlaylistMediaType === 'video'}
                      onChange={() => setNewPlaylistMediaType('video')}
                    />
                    Video Only Playlist (Movies & TV Episodes)
                  </label>
                </div>
                <p style={{ fontSize: 11, color: '#475569', marginTop: 8, marginBottom: 0 }}>
                  Tip: You can drag and drop any song, movie, TV episode, or entire TV show from the library directly onto this playlist in the left sidebar!
                </p>
              </div>
            </div>
            <div
              style={{
                padding: '10px 16px',
                borderTop: '1px solid #9da6b4',
                background: '#dfe4ec',
                display: 'flex',
                justifyContent: 'flex-end',
                gap: 8,
              }}
            >
              <button className="aqua-btn" onClick={() => setShowNewPlaylistModal(false)}>
                Cancel
              </button>
              <button
                className="aqua-btn primary"
                onClick={async () => {
                  if (!newPlaylistName.trim()) return;
                  const newId = await invokeRpc<number>('playlists:save', {
                    name: newPlaylistName.trim(),
                    isSmart: false,
                    mediaType: newPlaylistMediaType,
                  });
                  setShowNewPlaylistModal(false);
                  await refreshAllData();
                  setNav({ kind: 'playlist', id: newId });
                }}
              >
                Create Playlist
              </button>
            </div>
          </div>
        </div>
      )}

      {/* =====================================================================
          RETROTUNES VIDEO OVERLAY WINDOW (Section 1.3)
          ===================================================================== */}
      {activeVideo && mediaPort > 0 && (
        <div className="aqua-modal-backdrop" onClick={() => setActiveVideo(null)}>
          <div
            className="aqua-window"
            style={{ width: 860, maxWidth: '94vw', background: '#000000', borderColor: '#334155' }}
            onClick={(e) => e.stopPropagation()}
          >
            <div
              className="aqua-window-titlebar"
              style={{
                background: 'linear-gradient(180deg, #333a45 0%, #171b22 100%)',
                color: '#f8fafc',
                borderBottomColor: '#0f172a',
              }}
            >
              <span>
                rTunes Video Player — {activeVideo.title}{' '}
                {activeVideo.is_transcoded ? '(360p Cached MP4)' : `(${activeVideo.format} Master)`}
              </span>
              <button className="aqua-btn" onClick={() => setActiveVideo(null)} style={{ padding: '1px 6px' }}>
                <X size={13} />
              </button>
            </div>
            <video
              controls
              autoPlay
              style={{ width: '100%', maxHeight: '74vh', background: '#000' }}
              src={`http://127.0.0.1:${mediaPort}/video?id=${activeVideo.id}`}
            />
          </div>
        </div>
      )}

      {/* =====================================================================
          SYNCHRONIZED KARAOKE LYRICS (.LRC) VIEWER MODAL
          ===================================================================== */}
      {showLyricsModal && activeLyrics && (
        <div className="aqua-modal-backdrop" onClick={() => setShowLyricsModal(false)}>
          <div
            className="aqua-window"
            style={{ width: 520, maxWidth: '92vw' }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="aqua-window-titlebar">
              <span>Synchronized .LRC Karaoke Lyrics — {currentTrack?.title}</span>
              <button className="aqua-btn" onClick={() => setShowLyricsModal(false)}>
                <X size={13} />
              </button>
            </div>
            <pre
              style={{
                padding: 18,
                margin: 0,
                maxHeight: '60vh',
                overflowY: 'auto',
                background: '#0f172a',
                color: '#e2e8f0',
                fontFamily: 'var(--font-mono)',
                fontSize: 12,
                lineHeight: 1.6,
              }}
            >
              {activeLyrics}
            </pre>
          </div>
        </div>
      )}

      {/* =====================================================================
          MODALS: PREFERENCES, SMART PLAYLIST, ADD DEVICE WIZARD, DIAGNOSTICS
          ===================================================================== */}
      {showAbout && <AboutCreditsModal onClose={() => setShowAbout(false)} />}

      {showPreferences && settings && (
        <PreferencesModal
          settings={settings}
          authState={authState}
          onClose={() => setShowPreferences(false)}
          onSaved={(updated) => {
            setSettings(updated);
            void refreshAllData();
          }}
          onAuthChanged={setAuthState}
          onOpenUpload={() => {
            setShowPreferences(false);
            setShowUploadWizard(true);
          }}
          onOpenDiagnostics={() => {
            setShowPreferences(false);
            setShowDiagnostics(true);
          }}
          onOpenAbout={() => {
            setShowPreferences(false);
            setShowAbout(true);
          }}
          onOpenNewPlaylist={() => {
            setShowPreferences(false);
            setNewPlaylistName('New Playlist');
            setNewPlaylistMediaType('mixed');
            setShowNewPlaylistModal(true);
          }}
          onOpenNewSmartPlaylist={() => {
            setShowPreferences(false);
            setEditingPlaylist(null);
            setShowSmartModal(true);
          }}
          onRescanLibrary={() => {
            void invokeRpc('indexer:scan');
            showToast('Library scan started in background.');
          }}
          onDevicesChanged={() => {
            void invokeRpc<DeviceInfo[]>('devices:list').then(setDevices);
          }}
        />
      )}

      {showSmartModal && (
        <SmartPlaylistModal
          existing={editingPlaylist}
          onClose={() => setShowSmartModal(false)}
          onSaved={async (savedId) => {
            setShowSmartModal(false);
            await refreshAllData();
            setNav({ kind: 'playlist', id: savedId });
          }}
        />
      )}

      {showAddDeviceWizard && (
        <AddDeviceWizardModal
          onClose={() => setShowAddDeviceWizard(false)}
          onProvisioned={async (dev) => {
            setShowAddDeviceWizard(false);
            await refreshAllData();
            setNav({ kind: 'device', uuid: dev.uuid });
          }}
        />
      )}

      {showUploadWizard && (
        <UploadMediaWizardModal
          onClose={() => setShowUploadWizard(false)}
          onUploaded={() => {
            void refreshAllData();
          }}
        />
      )}

      {showDiagnostics && (
        <DiagnosticsModal
          liveEntries={liveLogs}
          onClose={() => setShowDiagnostics(false)}
          onCleared={() => setLiveLogs([])}
        />
      )}
    </div>
  );
};
