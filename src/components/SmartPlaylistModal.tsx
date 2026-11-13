import React, { useEffect, useState } from 'react';
import { Plus, Trash2, FolderPlus, Sparkles, X } from 'lucide-react';
import {
  PlaylistRow,
  SmartField,
  SmartOperator,
  SmartRule,
  SmartRuleGroup,
  TrackRow,
} from '../types';
import { invokeRpc } from '../bridge';

interface SmartPlaylistModalProps {
  existing?: PlaylistRow | null;
  onClose: () => void;
  onSaved: (playlistId: number) => void;
}

const FIELD_OPTIONS: { value: SmartField; label: string; isNumber: boolean }[] = [
  {
    value: 'artist_relative_popularity_score',
    label: 'Artist Relative Popularity Score (Global / Artist Median)',
    isNumber: true,
  },
  { value: 'global_listen_count', label: 'Global ListenBrainz Plays', isNumber: true },
  { value: 'artist_median_listen_count', label: 'Artist Median Listen Count', isNumber: true },
  { value: 'local_star_rating', label: 'Rating (Stars 0–5)', isNumber: true },
  { value: 'is_loved', label: 'Loved Status (1 = Loved, 0 = Normal)', isNumber: true },
  { value: 'genre', label: 'Genre', isNumber: false },
  { value: 'artist', label: 'Artist', isNumber: false },
  { value: 'album', label: 'Album', isNumber: false },
  { value: 'title', label: 'Track Name', isNumber: false },
  { value: 'year', label: 'Year', isNumber: true },
  { value: 'bitrate', label: 'Bitrate (kbps)', isNumber: true },
  { value: 'format', label: 'Format (FLAC, MP3, AAC...)', isNumber: false },
  { value: 'play_count', label: 'Play Count', isNumber: true },
  { value: 'duration', label: 'Duration (seconds)', isNumber: true },
];

const OPERATOR_OPTIONS: { value: SmartOperator; label: string }[] = [
  { value: 'gte', label: 'is greater than or equal to (>=)' },
  { value: 'gt', label: 'is greater than (>)' },
  { value: 'lte', label: 'is less than or equal to (<=)' },
  { value: 'lt', label: 'is less than (<)' },
  { value: 'is', label: 'is (=)' },
  { value: 'is_not', label: 'is not (!=)' },
  { value: 'contains', label: 'contains' },
  { value: 'not_contains', label: 'does not contain' },
  { value: 'starts_with', label: 'starts with' },
  { value: 'between', label: 'is in the range' },
];

export const SmartPlaylistModal: React.FC<SmartPlaylistModalProps> = ({
  existing,
  onClose,
  onSaved,
}) => {
  const [name, setName] = useState(existing?.name || 'Artist Standout Tracks');
  const [rulesGroup, setRulesGroup] = useState<SmartRuleGroup>(() => {
    if (existing?.smart_rules_json) {
      try {
        return JSON.parse(existing.smart_rules_json) as SmartRuleGroup;
      } catch {
        // fallback
      }
    }
    return {
      match: 'ALL',
      conditions: [
        {
          id: 'rule-1',
          type: 'rule',
          field: 'artist_relative_popularity_score',
          operator: 'gte',
          value: 1.5,
        },
      ],
    };
  });

  const [limitEnabled, setLimitEnabled] = useState<boolean>(
    Boolean(existing?.limit_value || existing?.track_limit)
  );
  const [limitValue, setLimitValue] = useState<number>(
    existing?.limit_value || existing?.track_limit || 50
  );
  const [limitType, setLimitType] = useState<string>(existing?.limit_type || 'tracks');
  const [selectionMethod, setSelectionMethod] = useState<string>(
    existing?.selection_method || 'popularity_desc'
  );
  const [keepCached, setKeepCached] = useState<boolean>(Boolean(existing?.keep_cached));

  const [previewTracks, setPreviewTracks] = useState<TrackRow[]>([]);
  const [compiledSql, setCompiledSql] = useState<string>('');

  useEffect(() => {
    const timer = setTimeout(async () => {
      try {
        const res = await invokeRpc<{ tracks: TrackRow[]; compiledSql: string }>(
          'playlists:previewSmart',
          rulesGroup,
          limitType,
          limitEnabled ? limitValue : null,
          selectionMethod
        );
        setPreviewTracks(res.tracks);
        setCompiledSql(res.compiledSql);
      } catch {
        // ignore
      }
    }, 150);
    return () => clearTimeout(timer);
  }, [rulesGroup, limitEnabled, limitValue, limitType, selectionMethod]);

  const updateGroupNode = (
    root: SmartRuleGroup,
    pathIndices: number[],
    updater: (group: SmartRuleGroup) => SmartRuleGroup
  ): SmartRuleGroup => {
    if (pathIndices.length === 0) {
      return updater(root);
    }
    const [head, ...rest] = pathIndices;
    const nextConditions = [...root.conditions];
    const target = nextConditions[head];
    if (target && 'conditions' in target) {
      nextConditions[head] = updateGroupNode(target, rest, updater);
    }
    return { ...root, conditions: nextConditions };
  };

  const renderGroup = (group: SmartRuleGroup, pathIndices: number[] = []) => {
    return (
      <div
        key={pathIndices.join('-') || 'root'}
        style={{
          background: pathIndices.length === 0 ? '#f8fafc' : '#eef2f7',
          border: '1px solid #94a3b8',
          borderRadius: 6,
          padding: 10,
          marginBottom: 8,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ fontWeight: 700 }}>Match</span>
            <select
              className="aqua-input"
              value={group.match}
              onChange={(e) => {
                const matchVal = e.target.value as 'ALL' | 'ANY';
                setRulesGroup((prev) =>
                  updateGroupNode(prev, pathIndices, (g) => ({ ...g, match: matchVal }))
                );
              }}
            >
              <option value="ALL">ALL (AND)</option>
              <option value="ANY">ANY (OR)</option>
            </select>
            <span style={{ fontWeight: 700 }}>of the following rules:</span>
          </div>

          <div style={{ display: 'flex', gap: 6 }}>
            <button
              className="aqua-btn"
              onClick={() => {
                setRulesGroup((prev) =>
                  updateGroupNode(prev, pathIndices, (g) => ({
                    ...g,
                    conditions: [
                      ...g.conditions,
                      {
                        id: `r-${Date.now()}-${Math.random()}`,
                        type: 'rule',
                        field: 'genre',
                        operator: 'contains',
                        value: '',
                      },
                    ],
                  }))
                );
              }}
            >
              <Plus size={12} /> Add Rule
            </button>
            <button
              className="aqua-btn"
              onClick={() => {
                setRulesGroup((prev) =>
                  updateGroupNode(prev, pathIndices, (g) => ({
                    ...g,
                    conditions: [
                      ...g.conditions,
                      {
                        id: `g-${Date.now()}-${Math.random()}`,
                        type: 'group',
                        match: 'ANY',
                        conditions: [
                          {
                            id: `r-${Date.now()}`,
                            type: 'rule',
                            field: 'local_star_rating',
                            operator: 'gte',
                            value: 4,
                          },
                        ],
                      },
                    ],
                  }))
                );
              }}
            >
              <FolderPlus size={12} /> Nested Group (...)
            </button>
          </div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {group.conditions.map((cond, idx) => {
            if ('conditions' in cond) {
              return (
                <div key={cond.id || idx} style={{ paddingLeft: 14 }}>
                  {renderGroup(cond, [...pathIndices, idx])}
                </div>
              );
            }

            const rule = cond as SmartRule;
            return (
              <div
                key={rule.id || idx}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  background: '#ffffff',
                  padding: '5px 8px',
                  borderRadius: 4,
                  border: '1px solid #cbd5e1',
                }}
              >
                <select
                  className="aqua-input"
                  style={{ width: 250 }}
                  value={rule.field}
                  onChange={(e) => {
                    const nextField = e.target.value as SmartField;
                    setRulesGroup((prev) =>
                      updateGroupNode(prev, pathIndices, (g) => {
                        const copy = [...g.conditions];
                        copy[idx] = { ...rule, field: nextField };
                        return { ...g, conditions: copy };
                      })
                    );
                  }}
                >
                  {FIELD_OPTIONS.map((f) => (
                    <option key={f.value} value={f.value}>
                      {f.label}
                    </option>
                  ))}
                </select>

                <select
                  className="aqua-input"
                  style={{ width: 195 }}
                  value={rule.operator}
                  onChange={(e) => {
                    const nextOp = e.target.value as SmartOperator;
                    setRulesGroup((prev) =>
                      updateGroupNode(prev, pathIndices, (g) => {
                        const copy = [...g.conditions];
                        copy[idx] = { ...rule, operator: nextOp };
                        return { ...g, conditions: copy };
                      })
                    );
                  }}
                >
                  {OPERATOR_OPTIONS.map((op) => (
                    <option key={op.value} value={op.value}>
                      {op.label}
                    </option>
                  ))}
                </select>

                <input
                  className="aqua-input"
                  style={{ flex: 1, minWidth: 70 }}
                  value={rule.value}
                  onChange={(e) => {
                    const val = e.target.value;
                    setRulesGroup((prev) =>
                      updateGroupNode(prev, pathIndices, (g) => {
                        const copy = [...g.conditions];
                        copy[idx] = { ...rule, value: val };
                        return { ...g, conditions: copy };
                      })
                    );
                  }}
                />

                {rule.operator === 'between' && (
                  <>
                    <span>to</span>
                    <input
                      className="aqua-input"
                      style={{ width: 80 }}
                      value={rule.valueTo ?? ''}
                      onChange={(e) => {
                        const valTo = e.target.value;
                        setRulesGroup((prev) =>
                          updateGroupNode(prev, pathIndices, (g) => {
                            const copy = [...g.conditions];
                            copy[idx] = { ...rule, valueTo: valTo };
                            return { ...g, conditions: copy };
                          })
                        );
                      }}
                    />
                  </>
                )}

                {group.conditions.length > 1 && (
                  <button
                    className="aqua-btn"
                    style={{ padding: '2px 6px' }}
                    onClick={() => {
                      setRulesGroup((prev) =>
                        updateGroupNode(prev, pathIndices, (g) => ({
                          ...g,
                          conditions: g.conditions.filter((_, i) => i !== idx),
                        }))
                      );
                    }}
                  >
                    <Trash2 size={12} />
                  </button>
                )}
              </div>
            );
          })}
        </div>
      </div>
    );
  };

  const handleSave = async () => {
    if (!name.trim()) return;
    const savedId = await invokeRpc<number>('playlists:save', {
      id: existing?.id,
      name: name.trim(),
      isSmart: true,
      smartRules: rulesGroup,
      limitType,
      limitValue: limitEnabled ? limitValue : null,
      selectionMethod,
      keepCached,
    });
    onSaved(savedId);
  };

  return (
    <div className="aqua-modal-backdrop" onClick={onClose}>
      <div
        className="aqua-window"
        style={{ width: 820, maxWidth: '95vw' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="aqua-window-titlebar">
          <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <Sparkles size={14} color="#6d28d9" /> Smart Playlist
          </span>
          <button className="aqua-btn" onClick={onClose} style={{ padding: '1px 6px' }}>
            <X size={13} />
          </button>
        </div>

        <div style={{ padding: 18, overflowY: 'auto', maxHeight: '72vh' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
            <label style={{ fontWeight: 700, width: 130 }}>Smart Playlist Name:</label>
            <input
              className="aqua-input"
              style={{ flex: 1 }}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>

          {renderGroup(rulesGroup)}

          {/* Output Constraints (Section 5) */}
          <div className="epod-capacity-card" style={{ marginTop: 12 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 600 }}>
                <input
                  type="checkbox"
                  checked={limitEnabled}
                  onChange={(e) => setLimitEnabled(e.target.checked)}
                />
                Limit to
              </label>
              <input
                type="number"
                className="aqua-input"
                style={{ width: 75 }}
                disabled={!limitEnabled}
                value={limitValue}
                onChange={(e) => setLimitValue(Number(e.target.value))}
              />
              <select
                className="aqua-input"
                disabled={!limitEnabled}
                value={limitType}
                onChange={(e) => setLimitType(e.target.value)}
              >
                <option value="tracks">items (tracks)</option>
                <option value="size_mb">MB (file size)</option>
                <option value="size_gb">GB (file size)</option>
                <option value="duration_mins">minutes (duration)</option>
                <option value="duration_hours">hours (duration)</option>
              </select>
              <span style={{ fontWeight: 600 }}>selected by</span>
              <select
                className="aqua-input"
                value={selectionMethod}
                onChange={(e) => setSelectionMethod(e.target.value)}
              >
                <option value="popularity_desc">highest artist-relative popularity score</option>
                <option value="random">random sample</option>
                <option value="rating_desc">highest star rating</option>
                <option value="most_played">most played</option>
                <option value="recently_added">most recently added</option>
                <option value="artist_asc">artist / album order</option>
              </select>
            </div>

            <label style={{ display: 'flex', alignItems: 'center', gap: 7, fontWeight: 600, cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={keepCached}
                onChange={(e) => setKeepCached(e.target.checked)}
              />
              Keep Cached Locally on SSD (Instant zero-CPU ePod USB sync)
            </label>
          </div>

          <div
            style={{
              marginTop: 12,
              fontSize: 11.5,
              color: '#475569',
              fontWeight: 600,
              textAlign: 'right',
            }}
          >
            Live Match Preview: {previewTracks.length} songs
          </div>
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
          <button className="aqua-btn" onClick={onClose}>
            Cancel
          </button>
          <button className="aqua-btn primary" onClick={handleSave}>
            Save Smart Playlist
          </button>
        </div>
      </div>
    </div>
  );
};
