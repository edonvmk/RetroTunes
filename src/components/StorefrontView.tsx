import React, { useEffect, useState } from 'react';
import {
  ShoppingBag,
  Search,
  Disc,
  Film,
  Tv,
  DownloadCloud,
  CheckCircle2,
  AlertCircle,
  RefreshCw,
  Sparkles,
  Flame,
  Star,
  Home,
  X,
} from 'lucide-react';
import { ArrQueueItem, AppSettings, ChartTrackItem, ConnectionTestResult, StoreCatalogItem, StoreHomeData } from '../types';
import { formatBytes, invokeRpc, isDevMode } from '../bridge';

interface StorefrontViewProps {
  settings: AppSettings | null;
  onSettingsUpdated: (updated: AppSettings) => void;
}

const STORE_GENRES = [
  'All Genres',
  'Alternative',
  'Punk / Hardcore',
  'Rock',
  'Electronic',
  'Hip-Hop',
  'Pop',
  'Metal',
  'Jazz',
];

export const StorefrontView: React.FC<StorefrontViewProps> = ({ settings, onSettingsUpdated }) => {
  const [activeTab, setActiveTab] = useState<'home' | 'charts' | 'album' | 'movie' | 'series'>('home');
  const [chartSource, setChartSource] = useState<'deezer' | 'lastfm' | 'theaudiodb' | 'library_relative'>('deezer');
  const [chartItems, setChartItems] = useState<ChartTrackItem[]>([]);
  const [selectedGenre, setSelectedGenre] = useState<string>('All Genres');
  const [query, setQuery] = useState('');
  const [homeData, setHomeData] = useState<StoreHomeData | null>(null);
  const [searchResults, setSearchResults] = useState<StoreCatalogItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [requestingId, setRequestingId] = useState<string | null>(null);
  const [requestedIds, setRequestedIds] = useState<Set<string>>(new Set());
  const [feedback, setFeedback] = useState<{ ok: boolean; message: string } | null>(null);
  const [selectedItem, setSelectedItem] = useState<StoreCatalogItem | null>(null);
  const [showSetupWizard, setShowSetupWizard] = useState(false);

  // Setup Wizard local state
  const [wizLidarrUrl, setWizLidarrUrl] = useState(settings?.lidarrUrl || 'http://localhost:8686');
  const [wizLidarrKey, setWizLidarrKey] = useState(settings?.lidarrApiKey || '');
  const [wizRadarrUrl, setWizRadarrUrl] = useState(settings?.radarrUrl || 'http://localhost:7878');
  const [wizRadarrKey, setWizRadarrKey] = useState(settings?.radarrApiKey || '');
  const [wizSonarrUrl, setWizSonarrUrl] = useState(settings?.sonarrUrl || 'http://localhost:8989');
  const [wizSonarrKey, setWizSonarrKey] = useState(settings?.sonarrApiKey || '');
  const [wizTestResults, setWizTestResults] = useState<Record<string, ConnectionTestResult>>({});
  const [wizSaving, setWizSaving] = useState(false);

  const hasAnyArrConfigured = Boolean(
    settings &&
      ((settings.lidarrUrl && settings.lidarrApiKey) ||
        (settings.radarrUrl && settings.radarrApiKey) ||
        (settings.sonarrUrl && settings.sonarrApiKey) ||
        (isDevMode() && settings.authMode === 'authentik' && settings.homelabGatewayUrl))
  );

  const loadStoreHome = async (genre: string) => {
    setLoading(true);
    try {
      const data = await invokeRpc<StoreHomeData>(
        'store:home',
        genre === 'All Genres' ? undefined : genre
      );
      setHomeData(data);
    } catch (err) {
      setFeedback({
        ok: false,
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setLoading(false);
    }
  };

  const performCategorySearch = async (cat: 'album' | 'movie' | 'series', q: string) => {
    setLoading(true);
    try {
      const results = await invokeRpc<StoreCatalogItem[]>('store:search', cat, q);
      setSearchResults(results);
    } catch (err) {
      setFeedback({
        ok: false,
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setLoading(false);
    }
  };

  const loadTopCharts = async (src: 'deezer' | 'lastfm' | 'theaudiodb' | 'library_relative') => {
    setLoading(true);
    try {
      const items = await invokeRpc<ChartTrackItem[]>('store:charts', src);
      setChartItems(items);
    } catch (err) {
      setFeedback({
        ok: false,
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (activeTab === 'home') {
      void loadStoreHome(selectedGenre);
    } else if (activeTab === 'charts') {
      void loadTopCharts(chartSource);
    } else {
      void performCategorySearch(activeTab, query);
    }
  }, [activeTab, selectedGenre, chartSource]);

  const handleSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!query.trim()) {
      setActiveTab('home');
      return;
    }
    const targetCat = activeTab === 'home' || activeTab === 'charts' ? 'album' : activeTab;
    if (activeTab === 'home' || activeTab === 'charts') setActiveTab('album');
    void performCategorySearch(targetCat, query);
  };

  const handleRequestItem = async (item: StoreCatalogItem, e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    setRequestingId(item.id);
    setFeedback(null);
    try {
      const res = await invokeRpc<{ ok: boolean; message: string }>('store:request', item);
      setFeedback(res);
      if (res.ok) {
        setRequestedIds((prev) => new Set(prev).add(item.id));
      }
    } catch (err) {
      setFeedback({
        ok: false,
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setRequestingId(null);
    }
  };

  const getButtonLabel = (item: StoreCatalogItem) => {
    if (item.alreadyInLibrary) return 'In Library';
    if (requestedIds.has(item.id)) return 'Requested';
    if (requestingId === item.id) return 'Adding...';
    if (item.mediaType === 'album') return 'Get Album';
    if (item.mediaType === 'movie') return 'Get Movie';
    return 'Get Series';
  };

  const renderStoreCard = (item: StoreCatalogItem) => {
    const disabled =
      Boolean(item.alreadyInLibrary) ||
      requestedIds.has(item.id) ||
      requestingId === item.id;

    return (
      <div
        key={item.id}
        onClick={() => setSelectedItem(item)}
        style={{
          background: '#ffffff',
          border: '1px solid #cbd5e1',
          borderRadius: 7,
          padding: 10,
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          boxShadow: '0 2px 5px rgba(0,0,0,0.06)',
          cursor: 'pointer',
          transition: 'transform 0.1s ease, box-shadow 0.1s ease',
        }}
      >
        <div>
          <div
            style={{
              width: '100%',
              height: item.mediaType === 'album' ? 148 : 196,
              background: 'linear-gradient(135deg, #1e293b 0%, #334155 100%)',
              borderRadius: 4,
              marginBottom: 8,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              overflow: 'hidden',
              position: 'relative',
            }}
          >
            {item.posterUrl ? (
              <img
                src={item.posterUrl}
                alt={item.title}
                style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                onError={(e) => {
                  (e.currentTarget as HTMLImageElement).style.display = 'none';
                }}
              />
            ) : (
              <Disc size={38} color="#94a3b8" />
            )}
            {item.reasonBadge && (
              <span
                style={{
                  position: 'absolute',
                  top: 6,
                  left: 6,
                  background: 'rgba(15, 23, 42, 0.85)',
                  color: '#f8fafc',
                  fontSize: 9.5,
                  fontWeight: 700,
                  padding: '2px 6px',
                  borderRadius: 4,
                  backdropFilter: 'blur(4px)',
                }}
              >
                {item.reasonBadge}
              </span>
            )}
          </div>

          <div
            style={{
              fontWeight: 700,
              fontSize: 11.5,
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              color: '#0f172a',
            }}
            title={item.title}
          >
            {item.title}
          </div>
          <div
            style={{
              fontSize: 11,
              color: '#475569',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              marginTop: 1,
            }}
            title={item.subtitle}
          >
            {item.subtitle}
          </div>
          <div style={{ fontSize: 10, color: '#64748b', marginTop: 2 }}>
            {item.genre} {item.year ? `• ${item.year}` : ''}
          </div>
        </div>

        <button
          className={`aqua-btn ${disabled ? '' : 'primary'}`}
          style={{ width: '100%', justifyContent: 'center', marginTop: 9 }}
          disabled={disabled}
          onClick={(e) => void handleRequestItem(item, e)}
        >
          <DownloadCloud size={12} /> {getButtonLabel(item)}
        </button>
      </div>
    );
  };

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', background: '#e8edf4', overflow: 'hidden' }}>
      {/* rTunes Store Dark Glossy Navigation Bar */}
      <div
        style={{
          background: 'linear-gradient(180deg, #3b4250 0%, #1d222b 50%, #12161d 100%)',
          color: '#ffffff',
          padding: '10px 20px',
          borderBottom: '1px solid #0f172a',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 14,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
            <ShoppingBag size={17} color="#60a5fa" />
            <span style={{ fontSize: 15, fontWeight: 700, letterSpacing: 0.2 }}>rTunes Store</span>
          </div>

          <div style={{ display: 'flex', gap: 5 }}>
            {[
              { id: 'home' as const, label: 'Featured', icon: <Home size={12} /> },
              { id: 'charts' as const, label: 'Top Charts', icon: <Flame size={12} /> },
              { id: 'album' as const, label: 'Music', icon: <Disc size={12} /> },
              { id: 'movie' as const, label: 'Movies', icon: <Film size={12} /> },
              { id: 'series' as const, label: 'TV Shows', icon: <Tv size={12} /> },
            ].map((tab) => (
              <button
                key={tab.id}
                className={`aqua-btn ${activeTab === tab.id ? 'primary' : ''}`}
                onClick={() => setActiveTab(tab.id)}
              >
                {tab.icon} {tab.label}
              </button>
            ))}
            <button
              className="aqua-btn"
              onClick={() => setShowSetupWizard((s) => !s)}
              title="Configure Lidarr, Radarr, and Sonarr Store connections"
            >
              Setup Services
            </button>
          </div>
        </div>

        {/* Genre Selector & Store Search */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <select
            className="aqua-input"
            style={{ height: 24, padding: '1px 8px', fontSize: 11 }}
            value={selectedGenre}
            onChange={(e) => {
              setSelectedGenre(e.target.value);
              setActiveTab('home');
            }}
          >
            {STORE_GENRES.map((g) => (
              <option key={g} value={g}>
                {g}
              </option>
            ))}
          </select>

          <form onSubmit={handleSearchSubmit} style={{ display: 'flex', gap: 6 }}>
            <div className="aqua-pill-search" style={{ width: 210 }}>
              <Search size={12} color="#64748b" />
              <input
                placeholder="Search Store..."
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
            <button type="submit" className="aqua-btn primary">
              Search
            </button>
          </form>
        </div>
      </div>

      {/* Feedback Banner */}
      {feedback && (
        <div
          style={{
            padding: '8px 20px',
            background: feedback.ok ? '#dcfce7' : '#fee2e2',
            borderBottom: `1px solid ${feedback.ok ? '#86efac' : '#fca5a5'}`,
            color: feedback.ok ? '#166534' : '#991b1b',
            fontWeight: 600,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {feedback.ok ? <CheckCircle2 size={15} /> : <AlertCircle size={15} />}
            {feedback.message}
          </span>
          <button
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'inherit' }}
            onClick={() => setFeedback(null)}
          >
            <X size={14} />
          </button>
        </div>
      )}

      {/* Main Storefront Content */}
      {(!hasAnyArrConfigured || showSetupWizard) && (
        <div
          style={{
            margin: '16px 22px 0 22px',
            padding: 18,
            background: 'linear-gradient(180deg, #ffffff 0%, #f1f5f9 100%)',
            border: '2px solid #2563eb',
            borderRadius: 8,
            boxShadow: '0 8px 20px rgba(15, 23, 42, 0.12)',
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
            <div>
              <h3 style={{ margin: 0, fontSize: 15, color: '#0f172a' }}>
                Welcome to the rTunes Store — Media Services Setup Wizard
              </h3>
              <p style={{ margin: '4px 0 0 0', fontSize: 11.5, color: '#475569' }}>
                Connect your Lidarr (Music), Radarr (Movies), or Sonarr (TV Shows) servers below to enable one-click downloads straight into your homelab library.
              </p>
            </div>
            {hasAnyArrConfigured && (
              <button className="aqua-btn" onClick={() => setShowSetupWizard(false)}>
                <X size={12} /> Close Wizard
              </button>
            )}
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12, marginBottom: 12 }}>
            {[
              {
                id: 'lidarr' as const,
                title: 'Lidarr (Music Albums)',
                url: wizLidarrUrl,
                setUrl: setWizLidarrUrl,
                key: wizLidarrKey,
                setKey: setWizLidarrKey,
                placeholder: 'http://192.168.1.x:8686',
              },
              {
                id: 'radarr' as const,
                title: 'Radarr (Movies)',
                url: wizRadarrUrl,
                setUrl: setWizRadarrUrl,
                key: wizRadarrKey,
                setKey: setWizRadarrKey,
                placeholder: 'http://192.168.1.x:7878',
              },
              {
                id: 'sonarr' as const,
                title: 'Sonarr (TV Shows)',
                url: wizSonarrUrl,
                setUrl: setWizSonarrUrl,
                key: wizSonarrKey,
                setKey: setWizSonarrKey,
                placeholder: 'http://192.168.1.x:8989',
              },
            ].map((srv) => {
              const testRes = wizTestResults[srv.id];
              return (
                <div
                  key={srv.id}
                  style={{
                    background: '#fff',
                    border: '1px solid #cbd5e1',
                    borderRadius: 6,
                    padding: 12,
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                    <strong style={{ fontSize: 12 }}>{srv.title}</strong>
                    <button
                      className="aqua-btn"
                      style={{ fontSize: 10.5, padding: '1px 7px' }}
                      onClick={async () => {
                        const res = await invokeRpc<ConnectionTestResult>('settings:testConnection', srv.id, {
                          lidarrUrl: wizLidarrUrl,
                          lidarrApiKey: wizLidarrKey,
                          radarrUrl: wizRadarrUrl,
                          radarrApiKey: wizRadarrKey,
                          sonarrUrl: wizSonarrUrl,
                          sonarrApiKey: wizSonarrKey,
                        });
                        setWizTestResults((prev) => ({ ...prev, [srv.id]: res }));
                      }}
                    >
                      Test
                    </button>
                  </div>
                  <label style={{ display: 'block', fontSize: 10.5, fontWeight: 600, marginBottom: 2 }}>
                    Server URL:
                  </label>
                  <input
                    className="aqua-input"
                    style={{ width: '100%', marginBottom: 6 }}
                    placeholder={srv.placeholder}
                    value={srv.url}
                    onChange={(e) => srv.setUrl(e.target.value)}
                  />
                  <label style={{ display: 'block', fontSize: 10.5, fontWeight: 600, marginBottom: 2 }}>
                    API Key:
                  </label>
                  <input
                    type="password"
                    className="aqua-input"
                    style={{ width: '100%' }}
                    placeholder="Paste API Key"
                    value={srv.key}
                    onChange={(e) => srv.setKey(e.target.value)}
                  />
                  {testRes && (
                    <div
                      style={{
                        marginTop: 6,
                        fontSize: 10.5,
                        fontWeight: 600,
                        color: testRes.ok ? '#15803d' : '#b91c1c',
                      }}
                    >
                      {testRes.ok ? '✓ ' : '✗ '}
                      {testRes.message}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <button
              className="aqua-btn primary"
              disabled={wizSaving}
              onClick={async () => {
                setWizSaving(true);
                try {
                  const updated = await invokeRpc<AppSettings>('settings:save', {
                    lidarrUrl: wizLidarrUrl,
                    lidarrApiKey: wizLidarrKey,
                    radarrUrl: wizRadarrUrl,
                    radarrApiKey: wizRadarrKey,
                    sonarrUrl: wizSonarrUrl,
                    sonarrApiKey: wizSonarrKey,
                  });
                  onSettingsUpdated(updated);
                  setShowSetupWizard(false);
                  setFeedback({ ok: true, message: 'rTunes Store services configured and saved!' });
                } finally {
                  setWizSaving(false);
                }
              }}
            >
              <CheckCircle2 size={13} /> {wizSaving ? 'Saving...' : 'Save & Activate rTunes Store'}
            </button>
          </div>
        </div>
      )}

      {/* Main Storefront Content */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '18px 22px' }}>
        {loading ? (
          <div style={{ padding: 54, textAlign: 'center', color: '#475569', fontSize: 13 }}>
            <RefreshCw size={20} style={{ verticalAlign: 'middle', marginRight: 8 }} />
            Loading Storefront...
          </div>
        ) : activeTab === 'home' && homeData ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
            {/* Spotlight Hero Row */}
            {homeData.featuredBanners.length > 0 && (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 14 }}>
                {homeData.featuredBanners.map((hero) => (
                  <div
                    key={`hero-${hero.id}`}
                    onClick={() => setSelectedItem(hero)}
                    style={{
                      background: 'linear-gradient(135deg, #1e293b 0%, #0f172a 100%)',
                      color: '#ffffff',
                      borderRadius: 8,
                      padding: 14,
                      display: 'flex',
                      gap: 14,
                      alignItems: 'center',
                      boxShadow: '0 6px 16px rgba(0,0,0,0.2)',
                      border: '1px solid #334155',
                      cursor: 'pointer',
                    }}
                  >
                    {hero.posterUrl && (
                      <img
                        src={hero.posterUrl}
                        alt={hero.title}
                        style={{
                          width: 86,
                          height: 86,
                          objectFit: 'cover',
                          borderRadius: 5,
                          boxShadow: '0 4px 10px rgba(0,0,0,0.5)',
                          flexShrink: 0,
                        }}
                      />
                    )}
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div
                        style={{
                          fontSize: 10,
                          fontWeight: 700,
                          textTransform: 'uppercase',
                          color: '#60a5fa',
                          letterSpacing: 0.5,
                          marginBottom: 3,
                        }}
                      >
                        {hero.reasonBadge || 'Featured Spotlight'}
                      </div>
                      <div
                        style={{
                          fontSize: 14,
                          fontWeight: 700,
                          whiteSpace: 'nowrap',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                        }}
                      >
                        {hero.title}
                      </div>
                      <div
                        style={{
                          fontSize: 11.5,
                          color: '#cbd5e1',
                          whiteSpace: 'nowrap',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          marginBottom: 8,
                        }}
                      >
                        {hero.subtitle}
                      </div>
                      <button
                        className="aqua-btn primary"
                        onClick={(e) => void handleRequestItem(hero, e)}
                      >
                        <DownloadCloud size={11} /> {getButtonLabel(hero)}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* Personalized Recommendations Shelf */}
            {homeData.recommendedForYou.length > 0 && (
              <section>
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'baseline',
                    justifyContent: 'space-between',
                    borderBottom: '1px solid #cbd5e1',
                    paddingBottom: 6,
                    marginBottom: 12,
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                    <Sparkles size={16} color="#7c3aed" />
                    <strong style={{ fontSize: 14 }}>Recommended For You</strong>
                    {homeData.recommendationBasis.length > 0 && (
                      <span style={{ fontSize: 11, color: '#64748b' }}>
                        Inspired by {homeData.recommendationBasis.slice(0, 3).join(', ')}
                      </span>
                    )}
                  </div>
                </div>
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(auto-fill, minmax(168px, 1fr))',
                    gap: 14,
                  }}
                >
                  {homeData.recommendedForYou.slice(0, 6).map(renderStoreCard)}
                </div>
              </section>
            )}

            {/* What's Hot: Top Albums */}
            <section>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  borderBottom: '1px solid #cbd5e1',
                  paddingBottom: 6,
                  marginBottom: 12,
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                  <Flame size={16} color="#ea580c" />
                  <strong style={{ fontSize: 14 }}>
                    New & Noteworthy Albums {selectedGenre !== 'All Genres' ? `(${selectedGenre})` : ''}
                  </strong>
                </div>
                <button className="aqua-btn" onClick={() => setActiveTab('album')}>
                  See All Albums →
                </button>
              </div>
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fill, minmax(168px, 1fr))',
                  gap: 14,
                }}
              >
                {homeData.topAlbums.slice(0, 12).map(renderStoreCard)}
              </div>
            </section>

            {/* Popular Movies */}
            <section>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  borderBottom: '1px solid #cbd5e1',
                  paddingBottom: 6,
                  marginBottom: 12,
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                  <Film size={16} color="#2563eb" />
                  <strong style={{ fontSize: 14 }}>Top Movies</strong>
                </div>
                <button className="aqua-btn" onClick={() => setActiveTab('movie')}>
                  See All Movies →
                </button>
              </div>
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fill, minmax(168px, 1fr))',
                  gap: 14,
                }}
              >
                {homeData.topMovies.slice(0, 6).map(renderStoreCard)}
              </div>
            </section>

            {/* Popular TV Series */}
            <section>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  borderBottom: '1px solid #cbd5e1',
                  paddingBottom: 6,
                  marginBottom: 12,
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                  <Star size={16} color="#0d9488" />
                  <strong style={{ fontSize: 14 }}>Popular TV Shows</strong>
                </div>
                <button className="aqua-btn" onClick={() => setActiveTab('series')}>
                  See All TV Shows →
                </button>
              </div>
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fill, minmax(168px, 1fr))',
                  gap: 14,
                }}
              >
                {homeData.topSeries.slice(0, 6).map(renderStoreCard)}
              </div>
            </section>
          </div>
        ) : activeTab === 'charts' ? (
          <div>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                marginBottom: 14,
                gap: 12,
                flexWrap: 'wrap',
              }}
            >
              <div>
                <strong style={{ fontSize: 15 }}>
                  Multi-Source Top Charts & Artist-Relative Standouts
                </strong>
                <div style={{ fontSize: 11, color: '#475569' }}>
                  Compare global charts from Deezer, Last.fm, and TheAudioDB alongside your Library Relative Standout tracks (<code>song_plays / MAX(artist_median_plays, 5)</code>).
                </div>
              </div>
              <div style={{ display: 'flex', gap: 6 }}>
                {[
                  { id: 'deezer' as const, label: 'Deezer Top Chart' },
                  { id: 'lastfm' as const, label: 'Last.fm Global Chart' },
                  { id: 'theaudiodb' as const, label: 'TheAudioDB Loved' },
                  { id: 'library_relative' as const, label: 'Library Standouts (Rel. Score)' },
                ].map((src) => (
                  <button
                    key={src.id}
                    className={`aqua-btn ${chartSource === src.id ? 'primary' : ''}`}
                    onClick={() => setChartSource(src.id)}
                  >
                    {src.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="epod-capacity-card" style={{ padding: 0, overflow: 'hidden' }}>
              <table className="rtunes-table" style={{ width: '100%' }}>
                <thead>
                  <tr>
                    <th style={{ width: 52 }}>Rank</th>
                    <th>Song Title</th>
                    <th>Artist</th>
                    <th>Album</th>
                    <th style={{ width: 110 }}>Metric / Plays</th>
                    <th style={{ width: 95 }}>Rel. Score</th>
                    <th style={{ width: 130 }}>Status / Action</th>
                  </tr>
                </thead>
                <tbody>
                  {chartItems.map((c) => (
                    <tr key={`${c.source}-${c.rank}-${c.artist}-${c.title}`}>
                      <td style={{ fontWeight: 700, color: '#1d4ed8' }}>#{c.rank}</td>
                      <td style={{ fontWeight: 600 }}>{c.title}</td>
                      <td>{c.artist}</td>
                      <td style={{ color: '#475569' }}>{c.album}</td>
                      <td style={{ fontFamily: 'var(--font-mono)' }}>
                        {c.playCount ? c.playCount.toLocaleString() : '—'}
                      </td>
                      <td style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, color: '#6d28d9' }}>
                        {c.relativeScore ? `${c.relativeScore.toFixed(2)}×` : '—'}
                      </td>
                      <td>
                        {c.alreadyInLibrary ? (
                          <span style={{ color: '#15803d', fontWeight: 700, fontSize: 11 }}>
                            ✓ In Library
                          </span>
                        ) : (
                          <button
                            className="aqua-btn primary"
                            style={{ fontSize: 10.5, padding: '2px 8px' }}
                            onClick={() =>
                              void handleRequestItem({
                                id: `chart-${c.rank}-${c.artist}`,
                                mediaType: 'album',
                                title: c.album !== 'Single' ? c.album : c.title,
                                subtitle: c.artist,
                                year: null,
                                genre: 'Chart',
                                overview: `Requested from ${c.source.toUpperCase()} Chart (#${c.rank})`,
                                posterUrl: c.posterUrl || null,
                                foreignId: '',
                              })
                            }
                          >
                            <DownloadCloud size={11} /> Request in Lidarr
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ) : (
          /* Category Search / Browse Grid */
          <div>
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                marginBottom: 14,
              }}
            >
              <strong style={{ fontSize: 14 }}>
                {query.trim()
                  ? `Results for "${query}"`
                  : activeTab === 'album'
                  ? 'Top Albums'
                  : activeTab === 'movie'
                  ? 'Top Movies'
                  : 'Popular TV Shows'}
              </strong>
              <button className="aqua-btn" onClick={() => setActiveTab('home')}>
                ← Back to Store Home
              </button>
            </div>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fill, minmax(175px, 1fr))',
                gap: 16,
              }}
            >
              {searchResults.map(renderStoreCard)}
            </div>
          </div>
        )}
      </div>

      {/* Item Detail Modal when a Store Card is clicked */}
      {selectedItem && (
        <div className="aqua-modal-backdrop" onClick={() => setSelectedItem(null)}>
          <div
            className="aqua-window"
            style={{ width: 580, maxWidth: '92vw' }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="aqua-window-titlebar">
              <span>{selectedItem.title}</span>
              <button className="aqua-btn" onClick={() => setSelectedItem(null)} style={{ padding: '1px 6px' }}>
                <X size={13} />
              </button>
            </div>
            <div style={{ padding: 20, display: 'flex', gap: 18 }}>
              {selectedItem.posterUrl && (
                <img
                  src={selectedItem.posterUrl}
                  alt={selectedItem.title}
                  style={{
                    width: 160,
                    height: selectedItem.mediaType === 'album' ? 160 : 220,
                    objectFit: 'cover',
                    borderRadius: 6,
                    boxShadow: '0 4px 12px rgba(0,0,0,0.25)',
                    flexShrink: 0,
                  }}
                />
              )}
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'space-between' }}>
                <div>
                  <h2 style={{ margin: '0 0 4px 0', fontSize: 18 }}>{selectedItem.title}</h2>
                  <div style={{ fontSize: 13, fontWeight: 600, color: '#334155', marginBottom: 6 }}>
                    {selectedItem.subtitle}
                  </div>
                  <div style={{ fontSize: 11.5, color: '#64748b', marginBottom: 12 }}>
                    {selectedItem.genre} {selectedItem.year ? `• Released ${selectedItem.year}` : ''}
                  </div>
                  <p style={{ fontSize: 12, color: '#1e293b', lineHeight: 1.5, maxHeight: 150, overflowY: 'auto' }}>
                    {selectedItem.overview || 'No additional description available.'}
                  </p>
                </div>

                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14 }}>
                  <button className="aqua-btn" onClick={() => setSelectedItem(null)}>
                    Close
                  </button>
                  <button
                    className="aqua-btn primary"
                    disabled={
                      Boolean(selectedItem.alreadyInLibrary) ||
                      requestedIds.has(selectedItem.id) ||
                      requestingId === selectedItem.id
                    }
                    onClick={() => void handleRequestItem(selectedItem)}
                  >
                    <DownloadCloud size={13} /> {getButtonLabel(selectedItem)}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export const DownloadsQueueView: React.FC<{
  queue: ArrQueueItem[];
  onRefresh: () => void;
}> = ({ queue, onRefresh }) => {
  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', background: '#ffffff', overflow: 'hidden' }}>
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
        <strong>Active Downloads</strong>
        <button className="aqua-btn" onClick={onRefresh}>
          <RefreshCw size={12} /> Refresh
        </button>
      </div>

      <div className="rtunes-table-container">
        <table className="rtunes-table">
          <thead>
            <tr>
              <th style={{ width: 90 }}>Type</th>
              <th>Title</th>
              <th style={{ width: 110 }}>Status</th>
              <th style={{ width: 200 }}>Progress</th>
              <th style={{ width: 120 }}>Remaining</th>
              <th style={{ width: 100 }}>Time Left</th>
              <th style={{ width: 110 }}>Format</th>
            </tr>
          </thead>
          <tbody>
            {queue.length === 0 ? (
              <tr>
                <td colSpan={7} style={{ textAlign: 'center', padding: 32, color: '#64748b' }}>
                  No active downloads.
                </td>
              </tr>
            ) : (
              queue.map((item) => (
                <tr key={item.id}>
                  <td>
                    <span
                      style={{
                        fontWeight: 700,
                        textTransform: 'uppercase',
                        fontSize: 10,
                        padding: '1px 6px',
                        borderRadius: 4,
                        background:
                          item.service === 'lidarr'
                            ? '#dcfce7'
                            : item.service === 'radarr'
                            ? '#fef3c7'
                            : '#dbeafe',
                        color: '#1e293b',
                      }}
                    >
                      {item.service === 'lidarr' ? 'Music' : item.service === 'radarr' ? 'Movie' : 'TV'}
                    </span>
                  </td>
                  <td style={{ fontWeight: 600 }}>{item.title}</td>
                  <td>{item.status}</td>
                  <td>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <div
                        style={{
                          flex: 1,
                          height: 8,
                          background: '#e2e8f0',
                          borderRadius: 4,
                          overflow: 'hidden',
                          border: '1px solid #94a3b8',
                        }}
                      >
                        <div
                          style={{
                            width: `${item.progressPercent}%`,
                            height: '100%',
                            background: 'linear-gradient(90deg, #2563eb, #60a5fa)',
                          }}
                        />
                      </div>
                      <span style={{ fontSize: 10.5, fontFamily: 'var(--font-mono)' }}>
                        {item.progressPercent}%
                      </span>
                    </div>
                  </td>
                  <td>
                    {formatBytes(item.sizeLeftBytes)} / {formatBytes(item.sizeBytes)}
                  </td>
                  <td style={{ fontFamily: 'var(--font-mono)' }}>{item.timeleft}</td>
                  <td>{item.quality}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
};
