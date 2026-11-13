import { getDb } from './db';
import { getSettings } from './settings';
import { getAuthState } from './authOidc';
import { logger } from './logger';

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
  reasonBadge?: string; // e.g. "Because you listen to Agnostic Front" or "#1 Top Album"
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

function checkIfAlbumInLocalDb(artist: string, album: string): boolean {
  try {
    const db = getDb();
    const row = db
      .prepare('SELECT id FROM tracks WHERE LOWER(artist) = LOWER(?) AND LOWER(album) = LOWER(?) LIMIT 1')
      .get(artist, album);
    return Boolean(row);
  } catch {
    return false;
  }
}

async function fetchTopAlbumsCatalog(limit = 18, genreId?: number): Promise<StoreCatalogItem[]> {
  try {
    const chartId = genreId || 0;
    const url = `https://api.deezer.com/chart/${chartId}/albums?limit=${limit}`;
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) return [];
    const data = (await res.json()) as {
      data?: {
        id: number;
        title?: string;
        cover_big?: string;
        cover_medium?: string;
        artist?: { name?: string };
        record_type?: string;
      }[];
    };

    const entries = data.data || [];
    return entries.map((e, idx) => {
      const title = e.title || 'Unknown Album';
      const artist = e.artist?.name || 'Unknown Artist';
      const hiRes = e.cover_big || e.cover_medium || null;
      const genre = e.record_type ? e.record_type.toUpperCase() : 'Music';

      return {
        id: `dz-alb-${e.id || idx}`,
        mediaType: 'album',
        title,
        subtitle: artist,
        year: null,
        genre,
        overview: `${genre} • Trending Release`,
        posterUrl: hiRes,
        foreignId: '',
        reasonBadge: idx < 3 ? `#${idx + 1} Chart` : undefined,
        alreadyInLibrary: checkIfAlbumInLocalDb(artist, title),
      };
    });
  } catch {
    return [];
  }
}

const CURATED_TOP_MOVIES = [
  'Dune Part Two',
  'Oppenheimer',
  'Deadpool & Wolverine',
  'Gladiator II',
  'Alien Romulus',
  'The Batman',
  'Furiosa',
  'Civil War',
  'Blade Runner 2049',
  'Interstellar',
  'Spider-Man Across the Spider-Verse',
  'Everything Everywhere All at Once',
  'Top Gun Maverick',
  'The Substance',
  'Nosferatu',
  'Mad Max Fury Road',
];

async function searchImdbMovies(query: string, limit = 16): Promise<StoreCatalogItem[]> {
  try {
    const clean = query.trim();
    if (!clean) return [];
    const firstChar = (clean[0] || 'a').toLowerCase().replace(/[^a-z0-9]/, 'a');
    const res = await fetch(
      `https://v3.sg.media-imdb.com/suggestion/${firstChar}/${encodeURIComponent(clean)}.json`,
      { headers: { Accept: 'application/json' } }
    );
    if (!res.ok) return [];
    const data = (await res.json()) as {
      d?: {
        id: string;
        l?: string;
        y?: number;
        q?: string;
        qid?: string;
        s?: string;
        i?: { imageUrl?: string };
      }[];
    };
    const items = (data.d || []).filter(
      (x) => !x.qid || x.qid === 'movie' || x.q === 'feature' || x.q === 'TV movie'
    );
    return items.slice(0, limit).map((m) => ({
      id: `imdb-mov-${m.id}`,
      mediaType: 'movie',
      title: m.l || 'Unknown Movie',
      subtitle: m.s || 'Feature Film',
      year: m.y || null,
      genre: 'Feature Film',
      overview: m.s ? `Starring ${m.s}` : 'Feature Film',
      posterUrl: m.i?.imageUrl || null,
      foreignId: '',
    }));
  } catch {
    return [];
  }
}

async function fetchTopMoviesCatalog(limit = 16): Promise<StoreCatalogItem[]> {
  try {
    const seeds = CURATED_TOP_MOVIES.slice(0, limit);
    const results = await Promise.all(
      seeds.map(async (title, idx) => {
        const found = await searchImdbMovies(title, 1);
        const item = found[0];
        if (!item) return null;
        return {
          ...item,
          reasonBadge: idx < 3 ? `#${idx + 1} Box Office` : undefined,
        } as StoreCatalogItem;
      })
    );
    return results.filter((x): x is StoreCatalogItem => x !== null);
  } catch {
    return [];
  }
}

async function fetchPopularSeries(limit = 16): Promise<StoreCatalogItem[]> {
  try {
    const res = await fetch('https://api.tvmaze.com/shows?page=0', {
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) return [];
    const shows = (await res.json()) as {
      id: number;
      name: string;
      premiered?: string;
      genres?: string[];
      summary?: string;
      rating?: { average?: number };
      network?: { name?: string };
      image?: { medium?: string; original?: string };
      externals?: { thetvdb?: number };
      weight?: number;
    }[];

    return shows
      .sort((a, b) => (b.weight || 0) - (a.weight || 0))
      .slice(0, limit)
      .map((s) => ({
        id: `tvmaze-${s.id}`,
        mediaType: 'series',
        title: s.name,
        subtitle: s.network?.name || (s.rating?.average ? `★ ${s.rating.average}/10` : 'TV Series'),
        year: s.premiered ? parseInt(s.premiered.slice(0, 4), 10) || null : null,
        genre: s.genres?.[0] || 'Drama',
        overview: (s.summary || '').replace(/<[^>]+>/g, ''),
        posterUrl: s.image?.medium || s.image?.original || null,
        foreignId: s.externals?.thetvdb ? String(s.externals.thetvdb) : '',
        reasonBadge: s.rating?.average && s.rating.average >= 8.5 ? `★ ${s.rating.average}` : undefined,
      }));
  } catch {
    return [];
  }
}

/**
 * Builds personalized recommendations based on the user's own library artists,
 * loved/5-star tracks, and ListenBrainz listening profile!
 */
export async function getStorefrontHome(genreFilter?: string): Promise<StoreHomeData> {
  const start = Date.now();
  const db = getDb();
  const settings = getSettings();

  // 1. Inspect the user's top / favorite artists in their local library
  const topLocalArtists = db
    .prepare(
      `SELECT artist, COUNT(*) as track_cnt, MAX(is_loved) as loved, MAX(local_star_rating) as max_stars
       FROM tracks
       WHERE artist IS NOT NULL AND artist != '' AND artist != 'Unknown Artist'
       GROUP BY artist
       ORDER BY loved DESC, max_stars DESC, SUM(play_count) DESC, track_cnt DESC
       LIMIT 6`
    )
    .all() as { artist: string; track_cnt: number }[];

  const seedArtists = topLocalArtists.map((a) => a.artist);

  // Also check ListenBrainz top artists for the user if ListenBrainz username is configured
  if (settings.listenbrainzUsername && seedArtists.length < 4) {
    try {
      const lbRes = await fetch(
        `https://api.listenbrainz.org/1/stats/user/${encodeURIComponent(settings.listenbrainzUsername)}/artists?range=all_time&count=5`
      );
      if (lbRes.ok) {
        const lbData = (await lbRes.json()) as {
          payload?: { artists?: { artist_name?: string }[] };
        };
        for (const a of lbData.payload?.artists || []) {
          if (a.artist_name && !seedArtists.includes(a.artist_name)) {
            seedArtists.push(a.artist_name);
          }
        }
      }
    } catch {
      // ignore
    }
  }

  // Genre mapping for Deezer Charts if a genre pill is selected
  const GENRE_ID_MAP: Record<string, number> = {
    Alternative: 85,
    Rock: 152,
    'Punk / Hardcore': 152,
    Electronic: 106,
    'Hip-Hop': 116,
    Pop: 132,
    Metal: 464,
    Jazz: 129,
  };
  const genreId = genreFilter ? GENRE_ID_MAP[genreFilter] : undefined;

  const [topAlbums, topMovies, topSeries] = await Promise.all([
    fetchTopAlbumsCatalog(18, genreId),
    fetchTopMoviesCatalog(16),
    fetchPopularSeries(16),
  ]);

  // Fetch personalized album suggestions based on the user's seed artists or genre filter
  const recommendedForYou: StoreCatalogItem[] = [];
  const searchSeeds = genreFilter
    ? [genreFilter]
    : seedArtists.length > 0
    ? seedArtists.slice(0, 4)
    : ['Turnstile', 'Blink-182', 'Deftones', 'The Cure'];

  await Promise.all(
    searchSeeds.map(async (seed) => {
      try {
        const res = await fetch(
          `https://api.deezer.com/search/album?q=${encodeURIComponent(seed)}&limit=5`
        );
        if (!res.ok) return;
        const data = (await res.json()) as {
          data?: {
            id: number;
            title: string;
            cover_big?: string;
            cover_medium?: string;
            artist?: { name?: string };
            record_type?: string;
          }[];
        };
        for (const alb of data.data || []) {
          const artistName = alb.artist?.name || seed;
          const inLib = checkIfAlbumInLocalDb(artistName, alb.title);
          recommendedForYou.push({
            id: `rec-alb-${alb.id}`,
            mediaType: 'album',
            title: alb.title,
            subtitle: artistName,
            year: null,
            genre: alb.record_type ? alb.record_type.toUpperCase() : 'Music',
            overview: `Recommended based on ${seed}`,
            posterUrl: alb.cover_big || alb.cover_medium || null,
            foreignId: '',
            reasonBadge: seedArtists.includes(seed) ? `Because you like ${seed}` : `Trending in ${seed}`,
            alreadyInLibrary: inLib,
          });
        }
      } catch {
        // ignore
      }
    })
  );

  // De-duplicate recommendations and prioritize albums not already in the user's library
  const seenRec = new Set<string>();
  const uniqueRecs = recommendedForYou
    .filter((item) => {
      const k = `${item.subtitle.toLowerCase()}__${item.title.toLowerCase()}`;
      if (seenRec.has(k)) return false;
      seenRec.add(k);
      return true;
    })
    .sort((a, b) => Number(Boolean(a.alreadyInLibrary)) - Number(Boolean(b.alreadyInLibrary)))
    .slice(0, 12);

  const featuredBanners = [
    ...(uniqueRecs[0] ? [uniqueRecs[0]] : []),
    ...(topAlbums[0] ? [topAlbums[0]] : []),
    ...(topMovies[0] ? [topMovies[0]] : []),
    ...(topSeries[0] ? [topSeries[0]] : []),
  ].slice(0, 3);

  logger.debug(
    'ARR_STORE',
    `Loaded Storefront Home (${uniqueRecs.length} recommendations, ${topAlbums.length} albums, ${topMovies.length} movies, ${topSeries.length} series)`,
    { seedArtists },
    Date.now() - start
  );

  return {
    featuredBanners,
    recommendedForYou: uniqueRecs,
    recommendationBasis: seedArtists,
    topAlbums,
    topMovies,
    topSeries,
  };
}

export async function searchStoreCatalog(
  category: 'album' | 'movie' | 'series',
  query: string
): Promise<StoreCatalogItem[]> {
  const start = Date.now();
  const settings = getSettings();
  const trimmed = query.trim();

  if (!trimmed) {
    const home = await getStorefrontHome();
    if (category === 'album') return home.topAlbums;
    if (category === 'movie') return home.topMovies;
    return home.topSeries;
  }

  try {
    if (category === 'album') {
      // 1. Try Lidarr lookup first if Lidarr is configured
      if (settings.lidarrUrl && settings.lidarrApiKey) {
        try {
          const base = settings.lidarrUrl.replace(/\/+$/, '');
          const res = await fetch(
            `${base}/api/v1/album/lookup?term=${encodeURIComponent(trimmed)}`,
            {
              headers: { 'X-Api-Key': settings.lidarrApiKey.trim(), Accept: 'application/json' },
            }
          );
          if (res.ok) {
            const items = (await res.json()) as Record<string, unknown>[];
            if (items.length > 0) {
              return items.slice(0, 30).map((it) => {
                const artistObj = it.artist as { artistName?: string; foreignArtistId?: string } | undefined;
                const images = (it.images as { coverType?: string; remoteUrl?: string; url?: string }[]) || [];
                const cover = images.find((img) => img.coverType === 'cover') || images[0];
                const relDate = typeof it.releaseDate === 'string' ? it.releaseDate : '';
                const artistName = artistObj?.artistName || String(it.artistTitle || 'Unknown Artist');
                const title = String(it.title || 'Unknown Album');
                return {
                  id: String(it.foreignAlbumId || it.id || Math.random()),
                  mediaType: 'album',
                  title,
                  subtitle: artistName,
                  year: relDate ? parseInt(relDate.slice(0, 4), 10) || null : null,
                  genre: Array.isArray(it.genres) && it.genres.length > 0 ? String(it.genres[0]) : 'Music',
                  overview: String(it.overview || `${it.albumType || 'Album'} release`),
                  posterUrl: cover?.remoteUrl || cover?.url || null,
                  foreignId: String(it.foreignAlbumId || ''),
                  artistMbid: artistObj?.foreignArtistId,
                  alreadyInLibrary: Boolean(it.id && Number(it.id) > 0) || checkIfAlbumInLocalDb(artistName, title),
                  rawPayload: it,
                };
              });
            }
          }
        } catch {
          // fallback to Deezer / MusicBrainz search
        }
      }

      // 2. Fast Deezer Album Search (instant artwork + release metadata)
      const dRes = await fetch(
        `https://api.deezer.com/search/album?q=${encodeURIComponent(trimmed)}&limit=28`
      );
      if (dRes.ok) {
        const dData = (await dRes.json()) as {
          data?: {
            id: number;
            title: string;
            cover_big?: string;
            cover_medium?: string;
            nb_tracks?: number;
            record_type?: string;
            artist?: { name?: string };
          }[];
        };
        if (dData.data && dData.data.length > 0) {
          return dData.data.map((alb) => {
            const artistName = alb.artist?.name || 'Unknown Artist';
            return {
              id: `dz-alb-${alb.id}`,
              mediaType: 'album',
              title: alb.title,
              subtitle: artistName,
              year: null,
              genre: alb.record_type ? alb.record_type.toUpperCase() : 'Music',
              overview: `${alb.nb_tracks || ''} Tracks • ${alb.record_type || 'Album'}`,
              posterUrl: alb.cover_big || alb.cover_medium || null,
              foreignId: '',
              alreadyInLibrary: checkIfAlbumInLocalDb(artistName, alb.title),
            };
          });
        }
      }
    }

    if (category === 'movie') {
      // 1. Try Radarr lookup if configured
      if (settings.radarrUrl && settings.radarrApiKey) {
        try {
          const base = settings.radarrUrl.replace(/\/+$/, '');
          const res = await fetch(
            `${base}/api/v3/movie/lookup?term=${encodeURIComponent(trimmed)}`,
            {
              headers: { 'X-Api-Key': settings.radarrApiKey.trim(), Accept: 'application/json' },
            }
          );
          if (res.ok) {
            const items = (await res.json()) as Record<string, unknown>[];
            if (items.length > 0) {
              return items.slice(0, 30).map((it) => {
                const images = (it.images as { coverType?: string; remoteUrl?: string }[]) || [];
                const poster = images.find((i) => i.coverType === 'poster') || images[0];
                return {
                  id: String(it.tmdbId || it.id || Math.random()),
                  mediaType: 'movie',
                  title: String(it.title || 'Unknown Movie'),
                  subtitle: String(it.studio || (it.year ? `Released ${it.year}` : 'Feature Film')),
                  year: typeof it.year === 'number' ? it.year : null,
                  genre: Array.isArray(it.genres) && it.genres.length > 0 ? String(it.genres[0]) : 'Movie',
                  overview: String(it.overview || ''),
                  posterUrl: poster?.remoteUrl || (typeof it.remotePoster === 'string' ? it.remotePoster : null),
                  foreignId: String(it.tmdbId || ''),
                  alreadyInLibrary: Boolean(it.id && Number(it.id) > 0),
                  rawPayload: it,
                };
              });
            }
          }
        } catch {
          // fallback to IMDb movie search
        }
      }

      // 2. IMDb Movie Search (works out of the box with zero API keys!)
      return await searchImdbMovies(trimmed, 28);
    }

    if (category === 'series') {
      // 1. Try Sonarr lookup if configured
      if (settings.sonarrUrl && settings.sonarrApiKey) {
        try {
          const base = settings.sonarrUrl.replace(/\/+$/, '');
          const res = await fetch(
            `${base}/api/v3/series/lookup?term=${encodeURIComponent(trimmed)}`,
            {
              headers: { 'X-Api-Key': settings.sonarrApiKey.trim(), Accept: 'application/json' },
            }
          );
          if (res.ok) {
            const items = (await res.json()) as Record<string, unknown>[];
            if (items.length > 0) {
              return items.slice(0, 30).map((it) => {
                const images = (it.images as { coverType?: string; remoteUrl?: string }[]) || [];
                const poster = images.find((i) => i.coverType === 'poster') || images[0];
                return {
                  id: String(it.tvdbId || it.id || Math.random()),
                  mediaType: 'series',
                  title: String(it.title || 'Unknown Series'),
                  subtitle: String(it.network || (it.year ? `Series (${it.year})` : 'TV Series')),
                  year: typeof it.year === 'number' ? it.year : null,
                  genre: Array.isArray(it.genres) && it.genres.length > 0 ? String(it.genres[0]) : 'TV Show',
                  overview: String(it.overview || ''),
                  posterUrl: poster?.remoteUrl || (typeof it.remotePoster === 'string' ? it.remotePoster : null),
                  foreignId: String(it.tvdbId || ''),
                  alreadyInLibrary: Boolean(it.id && Number(it.id) > 0),
                  rawPayload: it,
                };
              });
            }
          }
        } catch {
          // fallback to TVMaze
        }
      }

      // 2. TVMaze Search API (works out of the box with zero API keys and includes thetvdb IDs!)
      const tvRes = await fetch(
        `https://api.tvmaze.com/search/shows?q=${encodeURIComponent(trimmed)}`
      );
      if (tvRes.ok) {
        const tvData = (await tvRes.json()) as {
          show: {
            id: number;
            name: string;
            premiered?: string;
            genres?: string[];
            summary?: string;
            network?: { name?: string };
            image?: { medium?: string; original?: string };
            externals?: { thetvdb?: number };
          };
        }[];
        return tvData.map(({ show }) => ({
          id: `tvmaze-${show.id}`,
          mediaType: 'series',
          title: show.name,
          subtitle: show.network?.name || 'TV Series',
          year: show.premiered ? parseInt(show.premiered.slice(0, 4), 10) || null : null,
          genre: show.genres?.[0] || 'TV Show',
          overview: (show.summary || '').replace(/<[^>]+>/g, ''),
          posterUrl: show.image?.medium || show.image?.original || null,
          foreignId: show.externals?.thetvdb ? String(show.externals.thetvdb) : '',
        }));
      }
    }

    return [];
  } catch (err) {
    logger.error('ARR_STORE', `Store catalog search failed (${category}: "${trimmed}")`, err, Date.now() - start);
    throw err;
  }
}

export async function requestStoreItem(item: StoreCatalogItem): Promise<{
  ok: boolean;
  message: string;
}> {
  const start = Date.now();
  const settings = getSettings();
  const auth = getAuthState();

  try {
    if (settings.authMode === 'authentik' && settings.homelabGatewayUrl && auth.accessToken) {
      const gwBase = settings.homelabGatewayUrl.replace(/\/+$/, '');
      const res = await fetch(`${gwBase}/api/requests/${item.mediaType}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${auth.accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(item),
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Gateway returned HTTP ${res.status}: ${text}`);
      }
      const msg = `Requested "${item.title}" (${auth.user?.username || 'User'})`;
      logger.info('ARR_STORE', msg, { item }, Date.now() - start);
      return { ok: true, message: msg };
    }

    if (item.mediaType === 'album') {
      const base = settings.lidarrUrl.replace(/\/+$/, '');
      const apiKey = settings.lidarrApiKey.trim();
      if (!base || !apiKey) {
        throw new Error('Configure your Music download service in Preferences -> API Keys to download albums.');
      }

      let rootFolder = settings.lidarrRootFolderPath;
      if (!rootFolder) {
        const rfRes = await fetch(`${base}/api/v1/rootfolder`, {
          headers: { 'X-Api-Key': apiKey },
        });
        if (rfRes.ok) {
          const rfs = (await rfRes.json()) as { path: string }[];
          rootFolder = rfs[0]?.path || '/music';
        }
      }

      const lookupTerm = item.foreignId
        ? `lidarr:${item.foreignId}`
        : `${item.subtitle} ${item.title}`;
      const lookupRes = await fetch(
        `${base}/api/v1/album/lookup?term=${encodeURIComponent(lookupTerm)}`,
        { headers: { 'X-Api-Key': apiKey } }
      );
      const lookupItems = lookupRes.ok ? ((await lookupRes.json()) as Record<string, unknown>[]) : [];
      const basePayload = lookupItems[0] || item.rawPayload;
      if (!basePayload) {
        throw new Error(`Could not find matching release metadata for "${item.title}" by ${item.subtitle}.`);
      }

      const artistPayload = (basePayload.artist as Record<string, unknown>) || {};
      const postBody = {
        ...basePayload,
        monitored: true,
        addOptions: { searchForNewAlbum: true },
        artist: {
          ...artistPayload,
          qualityProfileId: settings.lidarrQualityProfileId || 1,
          metadataProfileId: settings.lidarrMetadataProfileId || 1,
          rootFolderPath: rootFolder,
          monitored: true,
        },
      };

      const postRes = await fetch(`${base}/api/v1/album`, {
        method: 'POST',
        headers: { 'X-Api-Key': apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify(postBody),
      });

      if (!postRes.ok) {
        const errText = await postRes.text();
        throw new Error(`Request returned HTTP ${postRes.status}: ${errText.slice(0, 180)}`);
      }

      const msg = `"${item.title}" by ${item.subtitle} has been added to your download queue.`;
      logger.info('ARR_STORE', msg, { title: item.title }, Date.now() - start);
      return { ok: true, message: msg };
    }

    if (item.mediaType === 'movie') {
      const base = settings.radarrUrl.replace(/\/+$/, '');
      const apiKey = settings.radarrApiKey.trim();
      if (!base || !apiKey) {
        throw new Error('Configure your Movie download service in Preferences -> API Keys to download movies.');
      }

      let rootFolder = settings.radarrRootFolderPath;
      if (!rootFolder) {
        const rfRes = await fetch(`${base}/api/v3/rootfolder`, {
          headers: { 'X-Api-Key': apiKey },
        });
        if (rfRes.ok) {
          const rfs = (await rfRes.json()) as { path: string }[];
          rootFolder = rfs[0]?.path || '/movies';
        }
      }

      let basePayload = item.rawPayload;
      if (!basePayload || !item.foreignId) {
        const lookupRes = await fetch(
          `${base}/api/v3/movie/lookup?term=${encodeURIComponent(`${item.title} ${item.year || ''}`)}`,
          { headers: { 'X-Api-Key': apiKey } }
        );
        const list = lookupRes.ok ? ((await lookupRes.json()) as Record<string, unknown>[]) : [];
        basePayload = list[0];
      }

      if (!basePayload) {
        throw new Error(`Could not resolve movie "${item.title}" in catalog.`);
      }

      const postBody = {
        ...basePayload,
        qualityProfileId: settings.radarrQualityProfileId || 1,
        rootFolderPath: rootFolder,
        monitored: true,
        addOptions: { searchForMovie: true },
      };

      const postRes = await fetch(`${base}/api/v3/movie`, {
        method: 'POST',
        headers: { 'X-Api-Key': apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify(postBody),
      });

      if (!postRes.ok) {
        const errText = await postRes.text();
        throw new Error(`Request returned HTTP ${postRes.status}: ${errText.slice(0, 180)}`);
      }

      const msg = `"${item.title}" has been added to your movie download queue.`;
      logger.info('ARR_STORE', msg, { title: item.title }, Date.now() - start);
      return { ok: true, message: msg };
    }

    if (item.mediaType === 'series') {
      const base = settings.sonarrUrl.replace(/\/+$/, '');
      const apiKey = settings.sonarrApiKey.trim();
      if (!base || !apiKey) {
        throw new Error('Configure your TV Series download service in Preferences -> API Keys to download shows.');
      }

      let rootFolder = settings.sonarrRootFolderPath;
      if (!rootFolder) {
        const rfRes = await fetch(`${base}/api/v3/rootfolder`, {
          headers: { 'X-Api-Key': apiKey },
        });
        if (rfRes.ok) {
          const rfs = (await rfRes.json()) as { path: string }[];
          rootFolder = rfs[0]?.path || '/tv';
        }
      }

      let basePayload = item.rawPayload;
      if (!basePayload) {
        const term = item.foreignId ? `tvdb:${item.foreignId}` : item.title;
        const lookupRes = await fetch(
          `${base}/api/v3/series/lookup?term=${encodeURIComponent(term)}`,
          { headers: { 'X-Api-Key': apiKey } }
        );
        const list = lookupRes.ok ? ((await lookupRes.json()) as Record<string, unknown>[]) : [];
        basePayload = list[0];
      }

      if (!basePayload) {
        throw new Error(`Could not resolve series "${item.title}" in catalog.`);
      }

      const postBody = {
        ...basePayload,
        qualityProfileId: settings.sonarrQualityProfileId || 1,
        languageProfileId: 1,
        rootFolderPath: rootFolder,
        monitored: true,
        seasonFolder: true,
        addOptions: { searchForMissingEpisodes: true },
      };

      const postRes = await fetch(`${base}/api/v3/series`, {
        method: 'POST',
        headers: { 'X-Api-Key': apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify(postBody),
      });

      if (!postRes.ok) {
        const errText = await postRes.text();
        throw new Error(`Request returned HTTP ${postRes.status}: ${errText.slice(0, 180)}`);
      }

      const msg = `"${item.title}" has been added to your TV download queue.`;
      logger.info('ARR_STORE', msg, { title: item.title }, Date.now() - start);
      return { ok: true, message: msg };
    }

    return { ok: false, message: 'Unsupported media type.' };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('ARR_STORE', `Store request failed for "${item.title}": ${msg}`, err);
    return { ok: false, message: msg };
  }
}

export async function getArrLiveQueue(): Promise<ArrQueueItem[]> {
  const settings = getSettings();
  const combined: ArrQueueItem[] = [];

  const fetchServiceQueue = async (
    service: 'lidarr' | 'radarr' | 'sonarr',
    baseUrl: string,
    apiKey: string,
    apiVer: 'v1' | 'v3'
  ) => {
    if (!baseUrl || !apiKey) return;
    try {
      const base = baseUrl.replace(/\/+$/, '');
      const res = await fetch(`${base}/api/${apiVer}/queue?page=1&pageSize=50`, {
        headers: { 'X-Api-Key': apiKey.trim(), Accept: 'application/json' },
      });
      if (!res.ok) return;
      const data = (await res.json()) as {
        records?: {
          id: number;
          title?: string;
          status?: string;
          size?: number;
          sizeleft?: number;
          timeleft?: string;
          estimatedCompletionTime?: string;
          downloadClient?: string;
          protocol?: string;
          quality?: { quality?: { name?: string } };
        }[];
      };
      for (const r of data.records || []) {
        const sz = Number(r.size || 0);
        const left = Number(r.sizeleft || 0);
        const pct = sz > 0 ? Math.min(100, Math.max(0, Math.round(((sz - left) / sz) * 100))) : 0;
        combined.push({
          id: `${service}-${r.id}`,
          service,
          title: r.title || 'Downloading item...',
          status: r.status || 'downloading',
          sizeBytes: sz,
          sizeLeftBytes: left,
          progressPercent: pct,
          timeleft: r.timeleft || '--:--:--',
          estimatedCompletionTime: r.estimatedCompletionTime || null,
          downloadClient: r.downloadClient || service.toUpperCase(),
          protocol: r.protocol || 'download',
          quality: r.quality?.quality?.name || 'Standard',
        });
      }
    } catch {
      // silently skip unreachable local service during background poll
    }
  };

  await Promise.all([
    fetchServiceQueue('lidarr', settings.lidarrUrl, settings.lidarrApiKey, 'v1'),
    fetchServiceQueue('radarr', settings.radarrUrl, settings.radarrApiKey, 'v3'),
    fetchServiceQueue('sonarr', settings.sonarrUrl, settings.sonarrApiKey, 'v3'),
  ]);

  return combined;
}

export interface ChartTrackItem {
  rank: number;
  title: string;
  artist: string;
  album: string;
  playCount?: number;
  relativeScore?: number;
  posterUrl?: string | null;
  source: 'deezer' | 'lastfm' | 'theaudiodb' | 'library_relative';
  alreadyInLibrary: boolean;
}

function checkIfTrackInLocalDb(artist: string, title: string): {
  inLibrary: boolean;
  album?: string;
  relativeScore?: number;
  plays?: number;
} {
  try {
    const db = getDb();
    const row = db
      .prepare(
        'SELECT album, artist_relative_popularity_score, global_listen_count, play_count FROM tracks WHERE LOWER(artist) = LOWER(?) AND LOWER(title) = LOWER(?) LIMIT 1'
      )
      .get(artist, title) as
      | {
          album: string;
          artist_relative_popularity_score: number;
          global_listen_count: number;
          play_count: number;
        }
      | undefined;
    if (!row) return { inLibrary: false };
    return {
      inLibrary: true,
      album: row.album,
      relativeScore: row.artist_relative_popularity_score,
      plays: (row.global_listen_count || 0) + (row.play_count || 0),
    };
  } catch {
    return { inLibrary: false };
  }
}

/**
 * Priority 5.3: Multi-Source Top Charts (Deezer Public API, Last.fm API, TheAudioDB API, & Library Relative Standouts).
 */
export async function getMultiSourceTopCharts(
  source: 'deezer' | 'lastfm' | 'theaudiodb' | 'library_relative' = 'deezer'
): Promise<ChartTrackItem[]> {
  const settings = getSettings();
  const db = getDb();

  if (source === 'library_relative') {
    const rows = db
      .prepare(
        `SELECT title, artist, album, global_listen_count, play_count, artist_relative_popularity_score
         FROM tracks
         WHERE artist_relative_popularity_score > 0 OR global_listen_count > 0 OR play_count > 0
         ORDER BY artist_relative_popularity_score DESC, global_listen_count DESC, play_count DESC
         LIMIT 40`
      )
      .all() as {
      title: string;
      artist: string;
      album: string;
      global_listen_count: number;
      play_count: number;
      artist_relative_popularity_score: number;
    }[];

    return rows.map((r, idx) => ({
      rank: idx + 1,
      title: r.title,
      artist: r.artist,
      album: r.album || 'Single',
      playCount: (r.global_listen_count || 0) + (r.play_count || 0),
      relativeScore: Number((r.artist_relative_popularity_score || 0).toFixed(2)),
      posterUrl: null,
      source: 'library_relative',
      alreadyInLibrary: true,
    }));
  }

  if (source === 'lastfm' && settings.lastfmApiKey) {
    try {
      const url = `https://ws.audioscrobbler.com/2.0/?method=chart.gettoptracks&api_key=${encodeURIComponent(
        settings.lastfmApiKey.trim()
      )}&format=json&limit=30`;
      const res = await fetch(url);
      if (res.ok) {
        const data = (await res.json()) as {
          tracks?: {
            track?: {
              name: string;
              playcount?: string;
              listeners?: string;
              artist?: { name?: string };
              image?: { '#text'?: string; size?: string }[];
            }[];
          };
        };
        const list = data.tracks?.track || [];
        if (list.length > 0) {
          return list.map((t, idx) => {
            const artist = t.artist?.name || 'Unknown Artist';
            const localMatch = checkIfTrackInLocalDb(artist, t.name);
            const img =
              t.image?.find((i) => i.size === 'extralarge' || i.size === 'large')?.['#text'] ||
              null;
            return {
              rank: idx + 1,
              title: t.name,
              artist,
              album: localMatch.album || 'Top Chart Single',
              playCount: parseInt(t.playcount || t.listeners || '0', 10) || undefined,
              relativeScore: localMatch.relativeScore,
              posterUrl: img || null,
              source: 'lastfm',
              alreadyInLibrary: localMatch.inLibrary,
            };
          });
        }
      }
    } catch {
      // fallback below
    }
  }

  if (source === 'theaudiodb') {
    try {
      const key = (settings.theAudioDbApiKey || '2').trim();
      const res = await fetch(
        `https://www.theaudiodb.com/api/v1/json/${encodeURIComponent(key)}/mostloved.php?format=track`
      );
      if (res.ok) {
        const data = (await res.json()) as {
          loved?: {
            strTrack: string;
            strArtist: string;
            strAlbum?: string;
            intTotalPlays?: string;
            intLoved?: string;
            strTrackThumb?: string;
          }[];
        };
        if (data.loved && data.loved.length > 0) {
          return data.loved.slice(0, 30).map((t, idx) => {
            const localMatch = checkIfTrackInLocalDb(t.strArtist, t.strTrack);
            return {
              rank: idx + 1,
              title: t.strTrack,
              artist: t.strArtist,
              album: t.strAlbum || localMatch.album || 'TheAudioDB Loved',
              playCount: parseInt(t.intTotalPlays || t.intLoved || '0', 10) || undefined,
              relativeScore: localMatch.relativeScore,
              posterUrl: t.strTrackThumb || null,
              source: 'theaudiodb',
              alreadyInLibrary: localMatch.inLibrary,
            };
          });
        }
      }
    } catch {
      // fallback to Deezer chart
    }
  }

  // Default / Deezer Public API (https://api.deezer.com/chart)
  try {
    const res = await fetch('https://api.deezer.com/chart/0/tracks?limit=30');
    if (res.ok) {
      const data = (await res.json()) as {
        data?: {
          title: string;
          rank?: number;
          artist?: { name?: string };
          album?: { title?: string; cover_big?: string; cover_medium?: string };
        }[];
      };
      return (data.data || []).map((t, idx) => {
        const artist = t.artist?.name || 'Unknown Artist';
        const album = t.album?.title || 'Single';
        const localMatch = checkIfTrackInLocalDb(artist, t.title);
        return {
          rank: idx + 1,
          title: t.title,
          artist,
          album,
          playCount: t.rank || undefined,
          relativeScore: localMatch.relativeScore,
          posterUrl: t.album?.cover_big || t.album?.cover_medium || null,
          source,
          alreadyInLibrary: localMatch.inLibrary,
        };
      });
    }
  } catch {
    // ignore
  }
  return [];
}
