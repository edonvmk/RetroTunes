import React, { useEffect, useRef, useState } from 'react';
import { Sparkles, X, HardDriveDownload, Cpu, CheckCircle2, Trash2 } from 'lucide-react';
import {
  AI_MODEL_CATALOG,
  AiModelCacheStatus,
  AiModelSpec,
  getDefaultAiModel,
} from '../ai/modelRegistry';
import {
  AgentChatMessage,
  AgentTurnResult,
  LocalLlamaProvider,
  PlaylistAgent,
} from '../ai/PlaylistAgent';
import { formatDuration, invokeRpc, subscribeEvent } from '../bridge';
import { TrackRow } from '../types';

interface AiPlaylistModalProps {
  onClose: () => void;
  onSaved: (playlistId: number) => void;
}

const RANDOM_PLAYLIST_IDEAS: string[] = [
  'Late-night indie & synth-pop drive, around 20 tracks, moody with a steady pulse',
  '90s alternative & grunge deep cuts from my library, ~25 tracks, high energy',
  'Sunday morning acoustic, folk, and mellow singer-songwriter favorites, 15 tracks',
  'Upbeat workout mix: electronic, hip-hop, and rock bangers, ~30 tracks',
  'Rainy afternoon shoegaze, dream pop, and ambient post-rock, 18 tracks',
  'Classic 70s & 80s soul, funk, and disco grooves for cooking dinner, 20 tracks',
  'Focus & deep work: instrumental, jazz, and lo-fi beats without heavy vocals, 25 tracks',
  'Road trip sing-alongs: loved tracks and top-rated anthems across all eras, 30 tracks',
  'Dark wave, industrial, and post-punk classics for midnight listening, 20 tracks',
  'Hidden gems: high relative-popularity deep cuts I have rated 4+ stars, 20 tracks',
];

function pickRandomIdea(exclude?: string): string {
  const pool = RANDOM_PLAYLIST_IDEAS.filter((i) => i !== exclude);
  return pool[Math.floor(Math.random() * pool.length)] || RANDOM_PLAYLIST_IDEAS[0];
}

export const AiPlaylistModal: React.FC<AiPlaylistModalProps> = ({ onClose, onSaved }) => {
  const [step, setStep] = useState<'setup' | 'loading' | 'chat'>('setup');
  const [selectedModelId, setSelectedModelId] = useState<string>(getDefaultAiModel().id);
  const [cacheStatuses, setCacheStatuses] = useState<Record<string, AiModelCacheStatus>>({});
  const [initialPrompt, setInitialPrompt] = useState<string>(() => pickRandomIdea());

  // Two-phase loading state (0-50% download, 50-100% load)
  const [loadPercent, setLoadPercent] = useState<number>(0);
  const [loadPhase, setLoadPhase] = useState<string>('download');
  const [loadMessage, setLoadMessage] = useState<string>('Initializing...');
  const [loadError, setLoadError] = useState<string | null>(null);

  // Interactive agent state
  const agentRef = useRef<PlaylistAgent | null>(null);
  const [messages, setMessages] = useState<AgentChatMessage[]>([]);
  const [followup, setFollowup] = useState<{ question: string; options: string[] } | null>(null);
  const [replyInput, setReplyInput] = useState<string>('');
  const [isThinking, setIsThinking] = useState<boolean>(false);

  // Finalized playlist preview state
  const [finalPlaylist, setFinalPlaylist] = useState<{
    name: string;
    description: string;
    tracks: TrackRow[];
  } | null>(null);
  const [checkedIds, setCheckedIds] = useState<Record<number, boolean>>({});
  const [saving, setSaving] = useState<boolean>(false);

  const selectedModel: AiModelSpec =
    AI_MODEL_CATALOG.find((m) => m.id === selectedModelId) || getDefaultAiModel();

  useEffect(() => {
    invokeRpc<AiModelCacheStatus[]>(
      'ai:model-cache-status',
      AI_MODEL_CATALOG.map((m) => ({ id: m.id, filename: m.filename }))
    )
      .then((list) => {
        const map: Record<string, AiModelCacheStatus> = {};
        for (const item of list) map[item.modelId] = item;
        setCacheStatuses(map);
      })
      .catch(() => {});

    const unsub = subscribeEvent<{
      modelId: string;
      percent: number;
      phase: string;
      message: string;
    }>('ai:prepare-progress', (prog) => {
      setLoadPercent(prog.percent);
      setLoadPhase(prog.phase);
      setLoadMessage(prog.message);
    });

    return () => {
      unsub();
      if (agentRef.current) {
        void agentRef.current.dispose();
        agentRef.current = null;
      } else {
        void invokeRpc('ai:dispose-model');
      }
    };
  }, []);

  const handleClose = async () => {
    if (step === 'loading') {
      await invokeRpc('ai:cancel-prepare').catch(() => {});
    }
    if (agentRef.current) {
      await agentRef.current.dispose().catch(() => {});
      agentRef.current = null;
    } else {
      await invokeRpc('ai:dispose-model').catch(() => {});
    }
    onClose();
  };

  const runAgentPrompt = async (promptText: string) => {
    if (!agentRef.current || !promptText.trim()) return;
    setIsThinking(true);
    setFollowup(null);
    try {
      const result: AgentTurnResult = await agentRef.current.sendMessage(promptText.trim());
      setMessages([...agentRef.current.getHistory()]);
      if (result.type === 'followup') {
        setFollowup({ question: result.question, options: result.options });
      } else if (result.type === 'finalized') {
        setFinalPlaylist({
          name: result.name,
          description: result.description,
          tracks: result.tracks,
        });
        const nextChecked: Record<number, boolean> = {};
        for (const t of result.tracks) nextChecked[t.id] = true;
        setCheckedIds(nextChecked);
      }
    } catch (err) {
      setMessages((prev) => [
        ...prev,
        { role: 'assistant', content: `Agent error: ${err instanceof Error ? err.message : String(err)}` },
      ]);
    } finally {
      setIsThinking(false);
    }
  };

  const handleContinue = async () => {
    if (!selectedModel.enabled || !selectedModel.uri || !selectedModel.filename) return;
    setLoadError(null);
    setLoadPercent(0);
    setLoadPhase('download');
    setLoadMessage('Preparing model...');
    setStep('loading');

    try {
      await invokeRpc('ai:prepare-model', {
        modelId: selectedModel.id,
        uri: selectedModel.uri,
        filename: selectedModel.filename,
        contextWindow: selectedModel.contextWindow || 32768,
      });

      const agent = new PlaylistAgent(new LocalLlamaProvider());
      agentRef.current = agent;
      setStep('chat');
      await runAgentPrompt(initialPrompt);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.toLowerCase().includes('cancel')) {
        setStep('setup');
      } else {
        setLoadError(msg);
      }
    }
  };

  const handleSavePlaylist = async () => {
    if (!finalPlaylist) return;
    const chosenIds = finalPlaylist.tracks
      .filter((t) => checkedIds[t.id] !== false)
      .map((t) => t.id);
    if (chosenIds.length === 0) return;
    setSaving(true);
    try {
      const newId = await invokeRpc<number>('playlists:save', {
        name: finalPlaylist.name.trim() || 'AI Generated Playlist',
        isSmart: false,
        mediaType: 'music',
      });
      for (const tid of chosenIds) {
        await invokeRpc('playlists:addTrack', newId, tid);
      }
      await handleClose();
      onSaved(newId);
    } finally {
      setSaving(false);
    }
  };

  const selectedCache = cacheStatuses[selectedModel.id];

  return (
    <div className="aqua-modal-backdrop" onClick={() => void handleClose()}>
      <div
        className="aqua-window"
        style={{ width: 680, maxWidth: '94vw', maxHeight: '88vh', display: 'flex', flexDirection: 'column' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="aqua-window-titlebar">
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <Sparkles size={14} color="#1d4ed8" /> AI Playlist Generator (Pre-Alpha)
          </span>
          <button className="aqua-btn" onClick={() => void handleClose()} style={{ padding: '1px 6px' }}>
            <X size={13} />
          </button>
        </div>

        <div style={{ padding: 18, overflowY: 'auto', flex: 1, display: 'flex', flexDirection: 'column', gap: 14 }}>
          {step === 'setup' && (
            <>
              <div className="epod-capacity-card">
                <label style={{ display: 'block', fontWeight: 700, marginBottom: 6 }}>
                  1. Select AI Model:
                </label>
                <select
                  className="aqua-input"
                  style={{ width: '100%' }}
                  value={selectedModelId}
                  onChange={(e) => setSelectedModelId(e.target.value)}
                >
                  {AI_MODEL_CATALOG.map((m) => {
                    const st = cacheStatuses[m.id];
                    const statusText = m.enabled
                      ? st?.cached
                        ? 'Cached on Disk'
                        : `~${m.approxSizeMB} MB • Downloads on Continue`
                      : m.badge;
                    return (
                      <option key={m.id} value={m.id} disabled={!m.enabled}>
                        {m.label} — [{statusText}]
                      </option>
                    );
                  })}
                </select>
                <div
                  style={{
                    marginTop: 8,
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    fontSize: 11,
                    color: '#475569',
                  }}
                >
                  <span>{selectedModel.description}</span>
                  <span
                    style={{
                      fontWeight: 700,
                      padding: '2px 8px',
                      borderRadius: 10,
                      whiteSpace: 'nowrap',
                      marginLeft: 10,
                      background: selectedCache?.cached ? '#dcfce7' : '#dbeafe',
                      color: selectedCache?.cached ? '#15803d' : '#1d4ed8',
                    }}
                  >
                    {selectedCache?.cached ? 'Cached on Disk' : 'Downloads on Continue'}
                  </span>
                </div>
              </div>

              <div className="epod-capacity-card">
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                  <label style={{ fontWeight: 700 }}>
                    2. Describe Your Playlist (Mood, Genre, Era, Energy, Track Count):
                  </label>
                  <button
                    type="button"
                    className="aqua-btn"
                    style={{ padding: '2px 8px', fontSize: 11 }}
                    onClick={() => setInitialPrompt((prev) => pickRandomIdea(prev))}
                  >
                    🎲 Random Idea
                  </button>
                </div>
                <textarea
                  className="aqua-input"
                  rows={4}
                  style={{ width: '100%', resize: 'vertical', fontFamily: 'inherit' }}
                  value={initialPrompt}
                  onChange={(e) => setInitialPrompt(e.target.value)}
                  placeholder="e.g., 90s shoegaze and dream pop for rainy afternoons, ~20 tracks..."
                />
                <p style={{ fontSize: 11, color: '#64748b', marginTop: 6, marginBottom: 0 }}>
                  Zero weights are downloaded until you click <strong>Continue</strong>. The agent queries only your local SQLite library, Last.fm, and MusicBrainz via structured tools.
                </p>
              </div>
            </>
          )}

          {step === 'loading' && (
            <div className="epod-capacity-card" style={{ padding: 20 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                {loadPhase === 'download' ? <HardDriveDownload size={16} color="#1d4ed8" /> : <Cpu size={16} color="#15803d" />}
                <strong>
                  {loadPercent < 50
                    ? 'Phase 1 / 2: Downloading GGUF Weights (0% – 50%)'
                    : 'Phase 2 / 2: Loading Model & Context into Memory (50% – 100%)'}
                </strong>
                <span style={{ marginLeft: 'auto', fontWeight: 700, fontFamily: 'var(--font-mono)' }}>
                  {loadPercent}%
                </span>
              </div>

              <div
                style={{
                  height: 16,
                  borderRadius: 8,
                  background: '#cbd5e1',
                  border: '1px solid #94a3b8',
                  overflow: 'hidden',
                  marginBottom: 10,
                }}
              >
                <div
                  style={{
                    width: `${Math.max(0, Math.min(100, loadPercent))}%`,
                    height: '100%',
                    background:
                      loadPercent < 50
                        ? 'linear-gradient(180deg, #60a5fa 0%, #2563eb 100%)'
                        : 'linear-gradient(180deg, #4ade80 0%, #16a34a 100%)',
                    transition: 'width 150ms ease',
                  }}
                />
              </div>

              <div style={{ fontSize: 11.5, color: '#334155', marginBottom: 12 }}>{loadMessage}</div>

              {loadError && (
                <div
                  style={{
                    padding: 10,
                    borderRadius: 6,
                    background: '#fee2e2',
                    border: '1px solid #fca5a5',
                    color: '#991b1b',
                    fontSize: 11.5,
                  }}
                >
                  {loadError}
                </div>
              )}
            </div>
          )}

          {step === 'chat' && (
            <>
              <div
                className="epod-capacity-card"
                style={{ maxHeight: 210, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 8 }}
              >
                {messages.map((m, idx) => (
                  <div
                    key={idx}
                    style={{
                      alignSelf: m.role === 'user' ? 'flex-end' : 'flex-start',
                      maxWidth: '85%',
                      padding: '6px 10px',
                      borderRadius: 8,
                      fontSize: 12,
                      background: m.role === 'user' ? '#dbeafe' : '#f1f5f9',
                      border: `1px solid ${m.role === 'user' ? '#93c5fd' : '#cbd5e1'}`,
                      color: '#0f172a',
                    }}
                  >
                    <strong>{m.role === 'user' ? 'You' : 'rTunes AI'}:</strong> {m.content}
                  </div>
                ))}
                {isThinking && (
                  <div style={{ fontSize: 11.5, color: '#475569', fontStyle: 'italic' }}>
                    Searching your library, Last.fm, &amp; MusicBrainz...
                  </div>
                )}
              </div>

              {followup && !isThinking && (
                <div className="epod-capacity-card">
                  <div style={{ fontWeight: 700, marginBottom: 8 }}>{followup.question}</div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 10 }}>
                    {followup.options.map((opt) => (
                      <button
                        key={opt}
                        className="aqua-btn primary"
                        onClick={() => void runAgentPrompt(opt)}
                      >
                        {opt}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {finalPlaylist && (
                <div className="epod-capacity-card">
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                    <div>
                      <input
                        className="aqua-input"
                        style={{ fontWeight: 700, fontSize: 13, width: 280 }}
                        value={finalPlaylist.name}
                        onChange={(e) =>
                          setFinalPlaylist({ ...finalPlaylist, name: e.target.value })
                        }
                      />
                      <div style={{ fontSize: 11, color: '#475569', marginTop: 4 }}>
                        {finalPlaylist.description}
                      </div>
                    </div>
                    <span style={{ fontSize: 11, fontWeight: 700, color: '#15803d' }}>
                      <CheckCircle2 size={13} style={{ verticalAlign: 'middle' }} />{' '}
                      {finalPlaylist.tracks.filter((t) => checkedIds[t.id] !== false).length} tracks selected
                    </span>
                  </div>

                  <div style={{ maxHeight: 210, overflowY: 'auto', border: '1px solid #cbd5e1', borderRadius: 4 }}>
                    <table className="rtunes-table">
                      <thead>
                        <tr>
                          <th style={{ width: 32 }}>Keep</th>
                          <th>Track</th>
                          <th>Artist</th>
                          <th style={{ width: 55 }}>Time</th>
                          <th style={{ width: 32 }}></th>
                        </tr>
                      </thead>
                      <tbody>
                        {finalPlaylist.tracks.map((t) => (
                          <tr key={t.id}>
                            <td style={{ textAlign: 'center' }}>
                              <input
                                type="checkbox"
                                checked={checkedIds[t.id] !== false}
                                onChange={(e) =>
                                  setCheckedIds((prev) => ({ ...prev, [t.id]: e.target.checked }))
                                }
                              />
                            </td>
                            <td style={{ fontWeight: 600 }}>{t.title}</td>
                            <td>{t.artist}</td>
                            <td style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}>
                              {formatDuration(t.duration)}
                            </td>
                            <td>
                              <button
                                type="button"
                                className="aqua-btn"
                                style={{ padding: '1px 4px', color: '#b91c1c' }}
                                title="Remove from preview"
                                onClick={() =>
                                  setFinalPlaylist((prev) =>
                                    prev
                                      ? { ...prev, tracks: prev.tracks.filter((x) => x.id !== t.id) }
                                      : null
                                  )
                                }
                              >
                                <Trash2 size={11} />
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              <div style={{ display: 'flex', gap: 8 }}>
                <input
                  className="aqua-input"
                  style={{ flex: 1 }}
                  value={replyInput}
                  disabled={isThinking}
                  onChange={(e) => setReplyInput(e.target.value)}
                  placeholder="Ask to adjust mood, add/remove artists, or finalize..."
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && replyInput.trim() && !isThinking) {
                      const txt = replyInput;
                      setReplyInput('');
                      void runAgentPrompt(txt);
                    }
                  }}
                />
                <button
                  className="aqua-btn primary"
                  disabled={isThinking || !replyInput.trim()}
                  onClick={() => {
                    const txt = replyInput;
                    setReplyInput('');
                    void runAgentPrompt(txt);
                  }}
                >
                  Send
                </button>
              </div>
            </>
          )}
        </div>

        <div
          style={{
            padding: '10px 18px',
            borderTop: '1px solid #9da6b4',
            background: '#dfe4ec',
            display: 'flex',
            justifyContent: 'flex-end',
            gap: 8,
          }}
        >
          {step === 'setup' && (
            <>
              <button className="aqua-btn" onClick={() => void handleClose()}>
                Cancel
              </button>
              <button
                className="aqua-btn primary"
                disabled={!selectedModel.enabled || !initialPrompt.trim()}
                onClick={() => void handleContinue()}
              >
                Continue
              </button>
            </>
          )}

          {step === 'loading' && (
            <button
              className="aqua-btn"
              onClick={async () => {
                await invokeRpc('ai:cancel-prepare');
                setStep('setup');
              }}
            >
              Cancel
            </button>
          )}

          {step === 'chat' && (
            <>
              <button className="aqua-btn" onClick={() => void handleClose()}>
                Close
              </button>
              {finalPlaylist && (
                <button
                  className="aqua-btn primary"
                  disabled={saving}
                  onClick={() => void handleSavePlaylist()}
                >
                  {saving ? 'Saving...' : 'Save Playlist'}
                </button>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
};
