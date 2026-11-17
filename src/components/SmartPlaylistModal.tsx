import React, { useEffect, useRef, useState } from 'react';
import { Plus, Trash2, FolderPlus, Sparkles, X } from 'lucide-react';
import {
  PlaylistRow,
  RegenerateInterval,
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

type FieldKind = 'text' | 'number' | 'boolean' | 'rating' | 'date' | 'scene';

interface FieldSpec {
  value: SmartField;
  label: string;
  kind: FieldKind;
  hasSuggestions?: boolean;
  unit?: string;
}

const FIELD_SPECS: FieldSpec[] = [
  { value: 'title', label: 'Name', kind: 'text', hasSuggestions: true },
  { value: 'artist', label: 'Artist', kind: 'text', hasSuggestions: true },
  { value: 'album', label: 'Album', kind: 'text', hasSuggestions: true },
  { value: 'album_artist', label: 'Album Artist', kind: 'text', hasSuggestions: true },
  { value: 'genre', label: 'Genre', kind: 'text', hasSuggestions: true },
  { value: 'artist_scene_affinity', label: 'Artist Scene [Subgenre]', kind: 'scene', hasSuggestions: true },
  { value: 'format', label: 'Kind', kind: 'text', hasSuggestions: true },
  { value: 'year', label: 'Year', kind: 'number', hasSuggestions: true },
  { value: 'local_star_rating', label: 'Rating', kind: 'rating' },
  { value: 'is_loved', label: 'Loved', kind: 'boolean' },
  { value: 'play_count', label: 'User Plays', kind: 'number' },
  { value: 'global_listen_count', label: 'LB Plays', kind: 'number' },
  { value: 'lastfm_plays', label: 'LastFM Plays', kind: 'number' },
  { value: 'audiodb_plays', label: 'AudioDB Plays', kind: 'number' },
  { value: 'combined_global_plays', label: 'Global Plays', kind: 'number' },
  { value: 'artist_relative_popularity_score', label: 'Rel. Score (0-100)', kind: 'number' },
  { value: 'artist_rarity_multiplier', label: 'Rarity Mult. (0.1-10x)', kind: 'number' },
  { value: 'discovery_score', label: 'Final Score (0-1000)', kind: 'number' },
  { value: 'artist_median_listen_count', label: 'Artist Median Plays', kind: 'number' },
  { value: 'duration', label: 'Time', kind: 'number', unit: 'sec' },
  { value: 'bitrate', label: 'Bit Rate', kind: 'number', unit: 'kbps' },
  { value: 'track_num', label: 'Track Number', kind: 'number' },
  { value: 'disc_num', label: 'Disc Number', kind: 'number' },
  { value: 'file_size', label: 'Size', kind: 'number', unit: 'bytes' },
  { value: 'date_added', label: 'Date Added', kind: 'date' },
  { value: 'last_played', label: 'Last Played', kind: 'date' },
  { value: 'keep_cached', label: 'Downloaded', kind: 'boolean' },
  { value: 'has_lyrics', label: 'Has Lyrics', kind: 'boolean' },
  { value: 'has_artwork', label: 'Has Artwork', kind: 'boolean' },
  { value: 'is_unplayed', label: 'Never Played', kind: 'boolean' },
  { value: 'is_hd_audio', label: 'Lossless / Hi-Res', kind: 'boolean' },
  { value: 'remote_nfs_path', label: 'Location', kind: 'text' },
];

const TEXT_OPERATORS: { value: SmartOperator; label: string }[] = [
  { value: 'contains', label: 'contains' },
  { value: 'not_contains', label: 'does not contain' },
  { value: 'is', label: 'is' },
  { value: 'is_not', label: 'is not' },
  { value: 'starts_with', label: 'begins with' },
  { value: 'ends_with', label: 'ends with' },
  { value: 'in_list', label: 'is one of (comma list)' },
  { value: 'not_in_list', label: 'is none of (comma list)' },
  { value: 'is_empty', label: 'is empty' },
  { value: 'not_empty', label: 'is not empty' },
];

const NUMBER_OPERATORS: { value: SmartOperator; label: string }[] = [
  { value: 'is', label: 'is' },
  { value: 'is_not', label: 'is not' },
  { value: 'gt', label: 'is greater than' },
  { value: 'lt', label: 'is less than' },
  { value: 'gte', label: 'is at least' },
  { value: 'lte', label: 'is at most' },
  { value: 'between', label: 'is in the range' },
  { value: 'in_list', label: 'is one of (comma list)' },
];

const BOOLEAN_OPERATORS: { value: SmartOperator; label: string }[] = [
  { value: 'is', label: 'is' },
  { value: 'is_not', label: 'is not' },
];

const DATE_OPERATORS: { value: SmartOperator; label: string }[] = [
  { value: 'in_last', label: 'is in the last' },
  { value: 'not_in_last', label: 'is not in the last' },
  { value: 'gt', label: 'is after' },
  { value: 'lt', label: 'is before' },
  { value: 'is_empty', label: 'never / empty' },
  { value: 'not_empty', label: 'is set' },
];

function getFieldSpec(field: SmartField): FieldSpec {
  return FIELD_SPECS.find((f) => f.value === field) || FIELD_SPECS[0];
}

function getOperatorsForKind(kind: FieldKind): { value: SmartOperator; label: string }[] {
  switch (kind) {
    case 'text':
      return TEXT_OPERATORS;
    case 'boolean':
      return BOOLEAN_OPERATORS;
    case 'date':
      return DATE_OPERATORS;
    case 'scene':
      return NUMBER_OPERATORS.filter((o) =>
        ['gte', 'lte', 'gt', 'lt', 'between'].includes(o.value)
      );
    case 'rating':
    case 'number':
    default:
      return NUMBER_OPERATORS;
  }
}

interface AutocompleteValueInputProps {
  field: SmartField;
  value: string | number;
  placeholder?: string;
  isNumber?: boolean;
  onChange: (nextVal: string) => void;
}

const AutocompleteValueInput: React.FC<AutocompleteValueInputProps> = ({
  field,
  value,
  placeholder,
  isNumber,
  onChange,
}) => {
  const [open, setOpen] = useState(false);
  const [options, setOptions] = useState<string[]>([]);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const strVal = String(value ?? '');

  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const list = await invokeRpc<string[]>('playlists:getDistinctFieldValues', field, strVal);
        if (!cancelled && Array.isArray(list)) {
          setOptions(list);
        }
      } catch {
        // ignore
      }
    }, 90);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [field, strVal]);

  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, []);

  const filtered = options.filter((opt) =>
    !strVal.trim() ? true : opt.toLowerCase().includes(strVal.trim().toLowerCase())
  );

  return (
    <div ref={containerRef} style={{ position: 'relative', flex: 1, minWidth: 120 }}>
      <input
        type={isNumber ? 'number' : 'text'}
        className="aqua-input"
        style={{ width: '100%' }}
        value={strVal}
        placeholder={placeholder}
        onFocus={() => setOpen(true)}
        onChange={(e) => {
          onChange(e.target.value);
          setOpen(true);
        }}
      />
      {open && filtered.length > 0 && (
        <div
          style={{
            position: 'absolute',
            top: 'calc(100% + 2px)',
            left: 0,
            right: 0,
            maxHeight: 190,
            overflowY: 'auto',
            background: '#ffffff',
            border: '1px solid #94a3b8',
            borderRadius: 5,
            boxShadow: '0 6px 16px rgba(15, 23, 42, 0.18)',
            zIndex: 60,
          }}
        >
          {filtered.slice(0, 80).map((item) => (
            <div
              key={item}
              onMouseDown={(e) => {
                e.preventDefault();
                onChange(item);
                setOpen(false);
              }}
              style={{
                padding: '4px 9px',
                fontSize: 11.5,
                cursor: 'pointer',
                color: '#1e293b',
                borderBottom: '1px solid #f1f5f9',
                background: item.toLowerCase() === strVal.trim().toLowerCase() ? '#dbeafe' : 'transparent',
              }}
            >
              {item}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export const SmartPlaylistModal: React.FC<SmartPlaylistModalProps> = ({
  existing,
  onClose,
  onSaved,
}) => {
  const [name, setName] = useState(existing?.name || 'Standout Tracks');
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
          value: 65,
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
      } catch {
        // ignore
      }
    }, 140);
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

  const renderRuleValueControl = (
    rule: SmartRule,
    spec: FieldSpec,
    updateRule: (patch: Partial<SmartRule>) => void
  ) => {
    if (spec.kind === 'boolean') {
      return (
        <select
          className="aqua-input"
          style={{ flex: 1, minWidth: 110 }}
          value={Number(rule.value) ? '1' : '0'}
          onChange={(e) => updateRule({ value: Number(e.target.value) })}
        >
          <option value="1">{rule.field === 'is_loved' ? 'Loved' : 'Yes'}</option>
          <option value="0">{rule.field === 'is_loved' ? 'Not Loved' : 'No'}</option>
        </select>
      );
    }

    if (spec.kind === 'rating') {
      const renderRatingSelect = (val: string | number, onChangeVal: (n: number) => void) => (
        <select
          className="aqua-input"
          style={{ width: 135 }}
          value={String(Number(val ?? 4))}
          onChange={(e) => onChangeVal(Number(e.target.value))}
        >
          <option value="5">★★★★★</option>
          <option value="4">★★★★</option>
          <option value="3">★★★</option>
          <option value="2">★★</option>
          <option value="1">★</option>
          <option value="0">Unrated</option>
        </select>
      );

      return (
        <>
          {renderRatingSelect(rule.value, (n) => updateRule({ value: n }))}
          {rule.operator === 'between' && (
            <>
              <span>to</span>
              {renderRatingSelect(rule.valueTo ?? 5, (n) => updateRule({ valueTo: n }))}
            </>
          )}
        </>
      );
    }

    if (spec.kind === 'scene') {
      return (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flex: 1 }}>
          <div style={{ flex: 1, minWidth: 110 }}>
            <AutocompleteValueInput
              field="artist_scene_affinity"
              value={rule.sceneGenre ?? 'emo'}
              placeholder="Subgenre (e.g. emo)"
              onChange={(val) => updateRule({ sceneGenre: val })}
            />
          </div>
          <input
            type="number"
            min={0}
            max={1}
            step={0.005}
            className="aqua-input"
            style={{ width: 78 }}
            value={rule.value}
            onChange={(e) => updateRule({ value: e.target.value })}
          />
          {rule.operator === 'between' && (
            <>
              <span>to</span>
              <input
                type="number"
                min={0}
                max={1}
                step={0.005}
                className="aqua-input"
                style={{ width: 78 }}
                value={rule.valueTo ?? 1}
                onChange={(e) => updateRule({ valueTo: e.target.value })}
              />
            </>
          )}
        </div>
      );
    }

    if (spec.kind === 'date') {
      const isRelativeDays = rule.operator === 'in_last' || rule.operator === 'not_in_last';
      if (isRelativeDays) {
        return (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flex: 1 }}>
            <input
              type="number"
              min={1}
              className="aqua-input"
              style={{ width: 85 }}
              value={rule.value || 30}
              onChange={(e) => updateRule({ value: Number(e.target.value) })}
            />
            <span style={{ fontSize: 11.5, color: '#475569' }}>days</span>
          </div>
        );
      }
      return (
        <input
          type="date"
          className="aqua-input"
          style={{ flex: 1, minWidth: 130 }}
          value={String(rule.value || '2025-01-01')}
          onChange={(e) => updateRule({ value: e.target.value })}
        />
      );
    }

    if (rule.operator === 'is_empty' || rule.operator === 'not_empty') {
      return <span style={{ flex: 1, fontSize: 11.5, color: '#64748b' }}>(no value needed)</span>;
    }

    return (
      <>
        {spec.hasSuggestions ? (
          <AutocompleteValueInput
            field={rule.field}
            value={rule.value}
            isNumber={spec.kind === 'number'}
            placeholder={spec.kind === 'text' ? `Type or choose ${spec.label.toLowerCase()}...` : undefined}
            onChange={(val) => updateRule({ value: val })}
          />
        ) : (
          <input
            type={spec.kind === 'number' ? 'number' : 'text'}
            step={rule.field === 'artist_relative_popularity_score' ? '0.1' : '1'}
            className="aqua-input"
            style={{ flex: 1, minWidth: 80 }}
            value={rule.value}
            onChange={(e) => updateRule({ value: e.target.value })}
          />
        )}

        {rule.operator === 'between' && (
          <>
            <span>to</span>
            <input
              type={spec.kind === 'number' ? 'number' : 'text'}
              className="aqua-input"
              style={{ width: 85 }}
              value={rule.valueTo ?? ''}
              onChange={(e) => updateRule({ valueTo: e.target.value })}
            />
          </>
        )}

        {spec.unit && <span style={{ fontSize: 11, color: '#64748b' }}>{spec.unit}</span>}
      </>
    );
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
              <option value="ALL">all</option>
              <option value="ANY">any</option>
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
              <FolderPlus size={12} /> Add Group
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
            const spec = getFieldSpec(rule.field);
            const validOperators = getOperatorsForKind(spec.kind);
            const currentOpValid = validOperators.some((op) => op.value === rule.operator);
            const effectiveOp = currentOpValid ? rule.operator : validOperators[0].value;

            const updateRule = (patch: Partial<SmartRule>) => {
              setRulesGroup((prev) =>
                updateGroupNode(prev, pathIndices, (g) => {
                  const copy = [...g.conditions];
                  copy[idx] = { ...rule, operator: effectiveOp, ...patch };
                  return { ...g, conditions: copy };
                })
              );
            };

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
                  style={{ width: 175 }}
                  value={rule.field}
                  onChange={(e) => {
                    const nextField = e.target.value as SmartField;
                    const nextSpec = getFieldSpec(nextField);
                    const nextOps = getOperatorsForKind(nextSpec.kind);
                    const keepOp = nextOps.some((o) => o.value === rule.operator);
                    const defaultOp = keepOp ? rule.operator : nextOps[0].value;
                    const defaultVal =
                      nextSpec.kind === 'boolean'
                        ? 1
                        : nextSpec.kind === 'rating'
                        ? 4
                        : nextSpec.kind === 'date'
                        ? 30
                        : nextSpec.kind === 'scene'
                        ? 0.55
                        : nextSpec.kind === 'number'
                        ? nextField === 'year'
                          ? 2000
                          : 1
                        : '';
                    updateRule({
                      field: nextField,
                      operator: defaultOp,
                      value: nextSpec.kind !== spec.kind ? defaultVal : rule.value,
                      sceneGenre:
                        nextSpec.kind === 'scene'
                          ? rule.sceneGenre || 'emo'
                          : rule.sceneGenre,
                    });
                  }}
                >
                  {FIELD_SPECS.map((f) => (
                    <option key={f.value} value={f.value}>
                      {f.label}
                    </option>
                  ))}
                </select>

                <select
                  className="aqua-input"
                  style={{ width: 165 }}
                  value={effectiveOp}
                  onChange={(e) => {
                    const nextOp = e.target.value as SmartOperator;
                    updateRule({ operator: nextOp });
                  }}
                >
                  {validOperators.map((op) => (
                    <option key={op.value} value={op.value}>
                      {op.label}
                    </option>
                  ))}
                </select>

                {renderRuleValueControl({ ...rule, operator: effectiveOp }, spec, updateRule)}

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
        style={{ width: 780, maxWidth: '95vw' }}
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

        <div style={{ padding: 18, overflowY: 'auto', maxHeight: '74vh' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
            <label style={{ fontWeight: 700, width: 115 }}>Playlist Name:</label>
            <input
              className="aqua-input"
              style={{ flex: 1 }}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>

          {renderGroup(rulesGroup)}

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
                <option value="tracks">items</option>
                <option value="size_mb">MB</option>
                <option value="size_gb">GB</option>
                <option value="duration_mins">minutes</option>
                <option value="duration_hours">hours</option>
              </select>
              <span style={{ fontWeight: 600 }}>selected by</span>
              <select
                className="aqua-input"
                value={selectionMethod}
                onChange={(e) => setSelectionMethod(e.target.value)}
              >
                <option value="popularity_desc">most popular by artist (Rel. Score)</option>
                <option value="discovery_desc">highest Final Score (Discovery)</option>
                <option value="random">random</option>
                <option value="random_weighted">weighted random (prefer higher rated)</option>
                <option value="rating_desc">highest rating</option>
                <option value="most_played">most often played</option>
                <option value="least_played">least often played</option>
                <option value="least_recently_played">least recently played</option>
                <option value="most_recently_played">most recently played</option>
                <option value="deep_cuts">deep cuts</option>
                <option value="recently_added">most recently added</option>
                <option value="oldest_added">oldest added</option>
                <option value="year_desc">newest year</option>
                <option value="year_asc">oldest year</option>
                <option value="artist_asc">album / artist</option>
              </select>
            </div>

            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                flexWrap: 'wrap',
                paddingTop: 8,
                paddingBottom: 8,
                borderTop: '1px solid #cbd5e1',
                borderBottom: '1px solid #cbd5e1',
                marginBottom: 8,
                fontSize: 12,
              }}
            >
              <label style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontWeight: 600 }}>
                Max per Artist:
                <input
                  type="number"
                  min={0}
                  placeholder="Any"
                  className="aqua-input"
                  style={{ width: 60 }}
                  value={rulesGroup.maxPerArtist ?? ''}
                  onChange={(e) => {
                    const v = e.target.value === '' ? null : Math.max(0, Number(e.target.value));
                    setRulesGroup((prev) => ({ ...prev, maxPerArtist: v || null }));
                  }}
                />
              </label>

              <label style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontWeight: 600 }}>
                Max per Album:
                <input
                  type="number"
                  min={0}
                  placeholder="Any"
                  className="aqua-input"
                  style={{ width: 60 }}
                  value={rulesGroup.maxPerAlbum ?? ''}
                  onChange={(e) => {
                    const v = e.target.value === '' ? null : Math.max(0, Number(e.target.value));
                    setRulesGroup((prev) => ({ ...prev, maxPerAlbum: v || null }));
                  }}
                />
              </label>

              <label style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontWeight: 600, cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={Boolean(rulesGroup.avoidBackToBackArtist)}
                  onChange={(e) =>
                    setRulesGroup((prev) => ({ ...prev, avoidBackToBackArtist: e.target.checked }))
                  }
                />
                No back-to-back artist
              </label>

              <label style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontWeight: 600 }}>
                Refresh:
                <select
                  className="aqua-input"
                  value={rulesGroup.regenerateInterval || 'live'}
                  onChange={(e) =>
                    setRulesGroup((prev) => ({
                      ...prev,
                      regenerateInterval: e.target.value as RegenerateInterval,
                    }))
                  }
                >
                  <option value="live">Live (Every Open)</option>
                  <option value="minutely">Every Minute</option>
                  <option value="hourly">Hourly</option>
                  <option value="daily">Daily</option>
                  <option value="weekly">Weekly</option>
                  <option value="monthly">Monthly</option>
                  <option value="yearly">Yearly</option>
                  <option value="manual">Manual Only</option>
                </select>
              </label>
            </div>

            <label style={{ display: 'flex', alignItems: 'center', gap: 7, fontWeight: 600, cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={keepCached}
                onChange={(e) => setKeepCached(e.target.checked)}
              />
              Keep downloaded for offline playback
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
            {previewTracks.length.toLocaleString()} matching songs
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
            OK
          </button>
        </div>
      </div>
    </div>
  );
};
