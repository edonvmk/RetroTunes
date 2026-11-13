export interface TrackRow {
  id: number;
  remote_nfs_path: string;
  local_cache_path: string | null;
  keep_cached: number;
  title: string;
  artist: string;
  album: string;
  genre: string;
  year: number | null;
  track_num: number | null;
  disc_num: number | null;
  duration: number;
  bitrate: number;
  file_size: number;
  format: string;
  cover_art_path: string | null;
  lrc_path: string | null;
  mbid_recording: string | null;
  mbid_artist: string | null;
  global_listen_count: number;
  artist_median_listen_count: number;
  artist_relative_popularity_score: number;
  local_star_rating: number;
  is_loved: number;
  play_count: number;
  last_played: string | null;
  date_added: string;
  metadata_loaded?: number;
}

export interface VideoRow {
  id: number;
  remote_nfs_path: string;
  local_cache_path: string | null;
  keep_cached: number;
  is_transcoded: number;
  transcode_status: string;
  transcode_progress: number;
  title: string;
  type: 'movie' | 'tv' | 'music_video';
  artist?: string | null;
  show_name: string | null;
  season: number | null;
  episode: number | null;
  year: number | null;
  tmdb_id: string | null;
  tvdb_id: string | null;
  poster_path?: string | null;
  watched: number;
  view_offset_ms?: number;
  duration: number;
  resolution?: string;
  width: number | null;
  height: number | null;
  file_size: number;
  format: string;
  date_added: string;
}

export interface BookRow {
  id: number;
  remote_nfs_path?: string;
  remote_path?: string;
  title: string;
  author: string;
  series: string | null;
  year: number | null;
  format: string;
  file_size: number;
  cover_path: string | null;
  chaptarr_id: string | null;
  date_added: string;
}

export interface AudiobookRow {
  id: number;
  remote_nfs_path?: string;
  remote_path?: string;
  title: string;
  author: string;
  narrator: string | null;
  duration: number;
  resume_position_ms: number;
  current_time_sec?: number;
  chapters_json: string | null;
  format: string;
  file_size: number;
  cover_path: string | null;
  abs_item_id: string | null;
  date_added: string;
}

export interface PhotoRow {
  id: number;
  remote_nfs_path?: string;
  remote_path?: string;
  local_cache_path?: string | null;
  album_name: string;
  title: string;
  width: number | null;
  height: number | null;
  file_size: number;
  immich_asset_id: string | null;
  taken_at: string | null;
  date_added: string;
}

export interface NetworkShareRow {
  id: number;
  name: string;
  host: string;
  protocol: 'nfs' | 'smb';
  export_path?: string;
  base_path?: string;
  username: string;
  password?: string;
  auto_connect: number;
  mount_point: string;
  is_mounted?: number;
  folder_map_json?: string;
  status?: 'mounted' | 'unmounted' | 'error';
  last_error?: string | null;
  music_subpath?: string;
  movies_subpath?: string;
  tv_subpath?: string;
  music_videos_subpath?: string;
  books_subpath?: string;
  audiobooks_subpath?: string;
  photos_subpath?: string;
  transcode_cache_subpath?: string;
}

export interface MtpStoragePool {
  storageId: string;
  storageIdNum?: number;
  description: string;
  volumeIdentifier?: string;
  maxCapacity: number;
  freeSpaceInBytes: number;
  totalBytes?: number;
  freeBytes?: number;
  hasManifest: boolean;
  manifestJson?: string;
}

export interface PlaylistRow {
  id: number;
  name: string;
  is_smart: number;
  media_type?: 'music' | 'video' | 'mixed';
  smart_rules_json: string | null;
  track_limit: number | null;
  limit_type: string;
  limit_value: number | null;
  selection_method: string;
  keep_cached: number;
  last_synced_hash: string | null;
  owner_user: string | null;
  created_at: string;
  trackCount?: number;
  audioCount?: number;
  videoCount?: number;
}

export type SmartField =
  | 'title'
  | 'artist'
  | 'album'
  | 'genre'
  | 'year'
  | 'bitrate'
  | 'format'
  | 'play_count'
  | 'local_star_rating'
  | 'is_loved'
  | 'global_listen_count'
  | 'artist_median_listen_count'
  | 'artist_relative_popularity_score'
  | 'duration';

export type SmartOperator =
  | 'is'
  | 'is_not'
  | 'contains'
  | 'not_contains'
  | 'starts_with'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'between';

export interface SmartRule {
  id: string;
  type: 'rule';
  field: SmartField;
  operator: SmartOperator;
  value: string | number;
  valueTo?: string | number;
}

export interface SmartRuleGroup {
  id?: string;
  type?: 'group';
  match: 'ALL' | 'ANY';
  conditions: (SmartRule | SmartRuleGroup)[];
}

export interface DeviceProfile {
  uuid: string;
  name: string;
  deviceType: 'epod_y2' | 'classic_dap' | 'phone' | 'custom';
  transportMode?: 'mtp' | 'ums';
  mtpSerial?: string;
  selectedStorageId?: string;
  icon: string;
  videoResolution: '480x360' | '320x240' | '720p' | '1080p' | 'source';
  videoFps: number;
  audioBitrateKbps: number;
  audioPassthrough: boolean;
  audioTranscodeFormat?: 'mp3' | 'aac' | 'passthrough';
  includeTrackNumberInFilename?: boolean;
  playlistFormat: 'm3u8' | 'm3u';
  musicSubdir: string;
  videoSubdir: string;
  playlistSubdir: string;
  picturesSubdir?: string;
  booksSubdir?: string;
  audiobooksSubdir?: string;
  downloadLrc: boolean;
  sanitizeCoverArt: boolean;
  cleanMacMetadata: boolean;
  syncAllMusic: boolean;
  syncPlaylistIds: number[];
  syncVideoIds: number[];
  syncPlexOnDeck?: boolean;
  plexOnDeckLimit?: number;
  plexOnDeckCount?: number;
  syncPhotos?: boolean;
  syncPhotoAlbums?: string[];
  syncMusicVideos?: boolean;
  syncBookIds?: number[];
  syncAudiobookIds?: number[];
}

export interface StorageBreakdown {
  totalBytes: number;
  audioBytes: number;
  videoBytes: number;
  otherBytes: number;
  freeBytes: number;
  mounted: boolean;
}

export interface DeviceInfo {
  uuid: string;
  name: string;
  mount_path: string;
  device_type: 'epod_y2' | 'classic_dap' | 'phone' | 'custom';
  transport_mode?: 'mtp' | 'ums';
  mtp_serial?: string | null;
  mtp_storages?: MtpStoragePool[];
  mtp_connected?: boolean;
  mtp_busy_warning?: string | null;
  profile_json: string;
  last_connected: string | null;
  last_synced: string | null;
  profile: DeviceProfile;
  storage: StorageBreakdown;
}

export interface MountedVolume {
  name: string;
  mountPath: string;
  hasManifest: boolean;
  manifestUuid?: string;
  totalBytes: number;
  freeBytes: number;
}

export interface SyncProgress {
  running: boolean;
  deviceUuid: string;
  stage: string;
  processed: number;
  total: number;
  currentFile: string;
  lovedImported: number;
  listenbrainzPushed: number;
  lrcFetched: number;
  tracksSynced: number;
  videosSynced: number;
  dotfilesCleaned: number;
}

export interface CacheJobRow {
  id: number;
  item_type: 'audio' | 'video';
  item_id: number;
  title: string;
  source_path: string;
  target_path: string;
  status: 'queued' | 'running' | 'completed' | 'failed';
  progress: number;
  encoder_used: string | null;
  size_bytes: number;
  error_message: string | null;
  last_accessed: string;
  created_at: string;
  updated_at: string;
}

export interface CacheStats {
  cachePath: string;
  usedBytes: number;
  quotaBytes: number;
  usagePercent: number;
  audioCount: number;
  videoCount: number;
  artworkCount: number;
  jobs: CacheJobRow[];
}

export interface StoreCatalogItem {
  id: string;
  mediaType: 'album' | 'movie' | 'series';
  title: string;
  subtitle: string;
  year: number | null;
  genre: string;
  overview: string;
  posterUrl: string | null;
  foreignId: string;
  artistMbid?: string;
  reasonBadge?: string;
  monitored?: boolean;
  alreadyInLibrary?: boolean;
  rawPayload?: Record<string, unknown>;
}

export interface StoreHomeData {
  featuredBanners: StoreCatalogItem[];
  recommendedForYou: StoreCatalogItem[];
  recommendationBasis: string[];
  topAlbums: StoreCatalogItem[];
  topMovies: StoreCatalogItem[];
  topSeries: StoreCatalogItem[];
}

export interface ArrQueueItem {
  id: string;
  service: 'lidarr' | 'radarr' | 'sonarr';
  title: string;
  status: string;
  sizeBytes: number;
  sizeLeftBytes: number;
  progressPercent: number;
  timeleft: string;
  estimatedCompletionTime: string | null;
  downloadClient: string;
  protocol: string;
  quality: string;
}

export interface ChartTrackItem {
  id?: string;
  source: 'deezer' | 'lastfm' | 'theaudiodb' | 'library_relative';
  rank: number;
  title: string;
  artist: string;
  album: string;
  playCount?: number;
  artistMedianPlays?: number;
  relativeScore?: number;
  relativePopularityScore?: number;
  posterUrl?: string | null;
  alreadyInLibrary: boolean;
  inLibrary?: boolean;
}

export interface AppSettings {
  backendMode?: 'standalone' | 'docker_server';
  dockerServerUrl?: string;

  nfsSharePath: string;
  musicRootPath: string;
  videoRootPath: string;
  tvRootPath: string;
  musicVideosRootPath?: string;
  booksRootPath?: string;
  audiobooksRootPath?: string;
  photosRootPath?: string;
  localCachePath: string;
  ffmpegBinaryPath: string;
  ffprobeBinaryPath: string;
  handbrakeBinaryPath: string;

  cacheMaxSizeGb: number;
  autoEvictLru: boolean;
  autoCachePlayback: boolean;
  hardwareAccelMode: 'auto' | 'vt_h264' | 'nvenc' | 'qsv' | 'software';
  metadataHydrationMode: 'hybrid' | 'on_demand';
  tableColumnsJson: string;
  showOfflineDevices?: boolean;

  authMode: 'standalone' | 'authentik';
  authentikIssuerUrl: string;
  authentikClientId: string;
  authentikRedirectUri: string;
  homelabGatewayUrl: string;

  listenbrainzToken: string;
  listenbrainzUsername: string;
  lastfmApiKey?: string;
  theAudioDbApiKey?: string;

  plexUrl?: string;
  plexToken?: string;

  lidarrUrl: string;
  lidarrApiKey: string;
  lidarrQualityProfileId: number;
  lidarrMetadataProfileId: number;
  lidarrRootFolderPath: string;

  radarrUrl: string;
  radarrApiKey: string;
  radarrQualityProfileId: number;
  radarrRootFolderPath: string;

  sonarrUrl: string;
  sonarrApiKey: string;
  sonarrQualityProfileId: number;
  sonarrRootFolderPath: string;

  chaptarrUrl?: string;
  chaptarrApiKey?: string;
  audiobookshelfUrl?: string;
  audiobookshelfToken?: string;
  immichUrl?: string;
  immichApiKey?: string;

  tmdbApiKey: string;
  tvdbApiKey: string;
}

export interface ConnectionTestResult {
  ok: boolean;
  target: string;
  message: string;
  latencyMs: number;
  details?: Record<string, unknown>;
}

export interface SsoUserProfile {
  sub: string;
  username: string;
  name: string;
  email: string;
  groups: string[];
  isAdmin: boolean;
}

export interface AuthState {
  authenticated: boolean;
  mode: 'standalone' | 'authentik';
  user: SsoUserProfile | null;
  accessToken: string | null;
  expiresAt: number | null;
}

export type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';
export type LogSubsystem =
  | 'SYSTEM'
  | 'DB'
  | 'INDEXER'
  | 'CACHE'
  | 'TRANSCODE'
  | 'DEVICE_SYNC'
  | 'SMART_PLAYLIST'
  | 'LISTENBRAINZ'
  | 'LRCLIB'
  | 'ARR_STORE'
  | 'AUTH_OIDC'
  | 'PLAYBACK'
  | 'IPC';

export interface LogEntry {
  id: number;
  timestamp: string;
  formattedTime?: string;
  sessionId?: string;
  level: LogLevel;
  subsystem: LogSubsystem;
  message: string;
  details?: unknown;
  durationMs?: number;
}

export interface IndexProgress {
  running: boolean;
  phase: 'artists' | 'albums' | 'songs' | 'video' | 'metadata' | 'popularity' | 'done' | 'error';
  processed: number;
  total: number;
  currentFile: string;
  artistsFound?: number;
  albumsFound?: number;
  audioAdded: number;
  videoAdded: number;
  metadataHydrated?: number;
}
