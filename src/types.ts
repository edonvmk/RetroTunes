export interface TrackRow {
  id: number;
  track_uid?: string | null;
  sync_rev?: number;
  remote_nfs_path: string;
  alternate_paths?: string | null;
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
  mbid_release?: string | null;
  mbid_release_group?: string | null;
  isrc?: string | null;
  lastfm_id?: string | null;
  deezer_id?: string | null;
  theaudiodb_id?: string | null;
  lidarr_id?: string | null;
  global_listen_count: number;
  lastfm_plays?: number;
  audiodb_plays?: number;
  combined_global_plays?: number;
  popularity_updated_at?: number;
  artist_median_listen_count: number;
  artist_relative_popularity_score: number;
  artist_rarity_multiplier?: number;
  discovery_score?: number;
  local_star_rating: number;
  is_loved: number;
  play_count: number;
  last_played: string | null;
  date_added: string;
  metadata_loaded?: number;
  exclude_from_smart_playlists?: number;
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
  imdb_id?: string | null;
  radarr_id?: string | null;
  sonarr_id?: string | null;
  plex_rating_key?: string | null;
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
  cached_track_ids_json?: string | null;
  last_regenerated_at?: string | null;
  ai_prompt?: string | null;
  ai_mode?: 'standard' | 'smart' | null;
  egenius_seed_track_id?: number | null;
  egenius_mode?: 'hits' | 'balanced' | 'deep' | null;
  egenius_scene_threshold?: number | null;
  created_at: string;
  trackCount?: number;
  audioCount?: number;
  videoCount?: number;
}

export type SmartField =
  | 'title'
  | 'artist'
  | 'album'
  | 'album_artist'
  | 'genre'
  | 'year'
  | 'bitrate'
  | 'format'
  | 'play_count'
  | 'local_star_rating'
  | 'is_loved'
  | 'keep_cached'
  | 'global_listen_count'
  | 'lastfm_plays'
  | 'audiodb_plays'
  | 'combined_global_plays'
  | 'artist_median_listen_count'
  | 'artist_relative_popularity_score'
  | 'artist_rarity_multiplier'
  | 'discovery_score'
  | 'duration'
  | 'track_num'
  | 'disc_num'
  | 'file_size'
  | 'date_added'
  | 'last_played'
  | 'remote_nfs_path'
  | 'has_lyrics'
  | 'has_artwork'
  | 'is_unplayed'
  | 'is_hd_audio'
  | 'artist_scene_affinity';

export type SmartOperator =
  | 'is'
  | 'is_not'
  | 'contains'
  | 'not_contains'
  | 'starts_with'
  | 'ends_with'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'between'
  | 'in_last'
  | 'not_in_last'
  | 'in_list'
  | 'not_in_list'
  | 'is_empty'
  | 'not_empty';

export type RegenerateInterval =
  | 'live'
  | 'minutely'
  | 'hourly'
  | 'daily'
  | 'weekly'
  | 'monthly'
  | 'yearly'
  | 'manual';

export interface SmartRule {
  id: string;
  type: 'rule';
  field: SmartField;
  operator: SmartOperator;
  value: string | number;
  valueTo?: string | number;
  sceneGenre?: string;
}

export interface SmartRuleGroup {
  id?: string;
  type?: 'group';
  match: 'ALL' | 'ANY';
  conditions: (SmartRule | SmartRuleGroup)[];
  maxPerArtist?: number | null;
  maxPerAlbum?: number | null;
  avoidBackToBackArtist?: boolean;
  regenerateInterval?: RegenerateInterval;
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

export type DeviceCatalogCategory =
  | 'music'
  | 'movies'
  | 'tv'
  | 'music_videos'
  | 'audiobooks'
  | 'books'
  | 'photos'
  | 'playlists';

export interface DeviceCatalogItem {
  devicePath: string;
  storageId?: string;
  mediaType: DeviceCatalogCategory;
  localTrackId?: number | null;
  localItemId?: number | null;
  title: string;
  artist?: string;
  album?: string;
  showName?: string;
  duration?: number;
  size: number;
}

export interface DeviceCatalog {
  version: 1;
  deviceUuid: string;
  updatedAt: string;
  items: DeviceCatalogItem[];
  playlists: { name: string; devicePath: string; trackCount: number; storageId?: string }[];
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

export type AppProfile = 'client' | 'headless-client' | 'desktop-server' | 'headless-server';
export type ClientSource = 'local' | 'remote';
export type AuthMode = 'standalone' | 'local-accounts' | 'authentik' | 'proxy-headers' | 'local-pin';
export type TranscoderUpdateSchedule = 'off' | 'daily' | 'weekly';

export type LibraryPermLevel = 0 | 1 | 2;
export type FeaturePermLevel = 0 | 1 | 2;
export type SwitchPerm = 0 | 1;

export interface RolePermissions {
  libMusic: LibraryPermLevel;
  libMovies: LibraryPermLevel;
  libTvShows: LibraryPermLevel;
  libMusicVideos: LibraryPermLevel;
  libBooks: LibraryPermLevel;
  libAudiobooks: LibraryPermLevel;
  libPhotos: LibraryPermLevel;
  featEgenius: FeaturePermLevel;
  featGenreMap: FeaturePermLevel;
  featDevicesSync: SwitchPerm;
  localCacheTier: 0 | 1 | 2;
  localCacheLimitMb: number;
  mediaUpload: 0 | 1 | 2;
  storeRequest: 0 | 1 | 2;
  playlists: 0 | 1 | 2;
  approveUploads: SwitchPerm;
  approveStore: SwitchPerm;
  rescanLibrary: SwitchPerm;
  rebuildDb: SwitchPerm;
  manageApiKeys: SwitchPerm;
  viewServerLogs: SwitchPerm;
  manageUac: SwitchPerm;
}

export interface RoleRecord {
  id: number;
  name: string;
  description: string;
  color: string;
  isSystem: boolean;
  isSuperAdmin: boolean;
  permissions: RolePermissions;
  createdAt: string;
}

export interface UserRecord {
  id: number;
  username: string;
  displayName: string;
  email: string;
  phone: string;
  authentikSub: string | null;
  listenbrainzUsername: string;
  hasListenbrainzToken: boolean;
  status: 'active' | 'suspended';
  createdAt: string;
  lastSeenAt: string | null;
  roles: RoleRecord[];
  overrides: Partial<RolePermissions> | null;
  effectivePermissions: RolePermissions;
}

export interface ServerSidebarVisibility {
  music: boolean;
  movies: boolean;
  tvShows: boolean;
  musicVideos: boolean;
  audiobooks: boolean;
  books: boolean;
  photos: boolean;
  store: boolean;
  devices: boolean;
  networkShares: boolean;
  genreMap: boolean;
}

export interface RuntimeModeInfo {
  appMode: AppProfile;
  isModeLocked: boolean;
  lockReason: 'docker' | 'cli' | null;
  isDocker: boolean;
  isHeadless: boolean;
  isServerRole: boolean;
  webUiEnabled: boolean;
  autoOpenBrowserOnHeadless?: boolean;
}

export interface RemoteAuthInfo {
  serverName: string;
  version: string;
  serverVersion?: string;
  appMode: AppProfile;
  needsSetup: boolean;
  authGateEnabled: boolean;
  authMode: AuthMode;
  allowGuestRoadie: boolean;
  authentikIssuerUrl?: string;
  authentikClientId?: string;
  authentikRedirectUri?: string;
  trustedProxyHeader?: string;
}

export interface AppSettings {
  appMode: AppProfile;
  clientSource: ClientSource;
  dockerServerUrl?: string;
  remoteServerToken?: string;

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
  enableClientLocalTranscoding: boolean;
  transcoderUpdateSchedule: TranscoderUpdateSchedule;
  lastTranscoderUpdateCheckAt: number;
  hardwareAccelMode: 'auto' | 'vt_h264' | 'nvenc' | 'qsv' | 'vaapi' | 'software';
  metadataHydrationMode: 'hybrid' | 'on_demand';
  tableColumnsJson: string;
  showOfflineDevices?: boolean;
  lcdArtistClickBehavior?: 'jump' | 'filter';
  genreMapUseLastfm?: boolean;
  genreMapLastfmWeight?: number;
  lanServerPort?: number;
  desktopServerWebUiEnabled?: boolean;
  desktopServerAutoOpenWebUi?: boolean;
  serverSidebarVisibility: ServerSidebarVisibility;
  backgroundWatchers: boolean;

  authGateEnabled: boolean;
  authMode: AuthMode;
  allowGuestRoadie?: boolean;
  hasCompletedOnboarding?: boolean;
  authentikIssuerUrl: string;
  authentikClientId: string;
  authentikRedirectUri: string;
  homelabGatewayUrl: string;
  trustedProxyHeader: string;
  localPinHash?: string;
  localPinPlaintext?: string;
  hasLocalPin?: boolean;

  listenbrainzToken: string;
  listenbrainzUsername: string;
  personalListenbrainzToken?: string;
  personalListenbrainzUsername?: string;
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
  mode: AuthMode;
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

export interface CallerMeResponse {
  user: UserRecord | null;
  username: string;
  displayName: string;
  roles: string[];
  isGuest: boolean;
  isSuperAdmin: boolean;
  authSource: 'local-owner' | 'session' | 'authentik' | 'proxy-headers' | 'pin' | 'guest';
  permissions: RolePermissions;
  personalListenbrainzUsername?: string;
  hasPersonalListenbrainzToken?: boolean;
}

export interface ScrobbleQueueStats {
  pendingCount: number;
  oldestPendingAt: number | null;
  totalLogged: number;
}

export interface PendingUploadRow {
  id: number;
  media_type: string;
  title: string;
  destination_path: string;
  file_count: number;
  arr_triggered: number;
  approval_status: 'pending' | 'approved' | 'rejected';
  requested_by_user_id: number | null;
  requested_by_username: string;
  staged_payload_json?: string;
  reviewed_by_user_id?: number | null;
  reviewed_at?: string | null;
  rejection_reason?: string | null;
  uploaded_at?: string;
  created_at?: string;
}

export interface PendingStoreRequestRow {
  id: number;
  media_type: string;
  title: string;
  subtitle: string;
  foreign_id: string;
  service: string;
  status: string;
  payload_json?: string;
  approval_status: 'pending' | 'approved' | 'rejected';
  requested_by_user_id: number | null;
  requested_by_username: string;
  staged_payload_json?: string;
  reviewed_by_user_id?: number | null;
  reviewed_at?: string | null;
  rejection_reason?: string | null;
  requested_at?: string;
  created_at?: string;
}

export interface PendingApprovalsPayload {
  uploads: PendingUploadRow[];
  storeRequests: PendingStoreRequestRow[];
}

export const DEFAULT_LOCAL_OWNER_PERMISSIONS: RolePermissions = {
  libMusic: 2,
  libMovies: 2,
  libTvShows: 2,
  libMusicVideos: 2,
  libBooks: 2,
  libAudiobooks: 2,
  libPhotos: 2,
  featEgenius: 2,
  featGenreMap: 2,
  featDevicesSync: 1,
  localCacheTier: 2,
  localCacheLimitMb: 0,
  mediaUpload: 2,
  storeRequest: 2,
  playlists: 2,
  approveUploads: 1,
  approveStore: 1,
  rescanLibrary: 1,
  rebuildDb: 1,
  manageApiKeys: 1,
  viewServerLogs: 1,
  manageUac: 1,
};
