import { invokeRpc } from '../bridge';
import { TrackRow } from '../types';

export interface PlaylistToolDefinition {
  name:
    | 'search_local_catalog'
    | 'discover_via_lastfm'
    | 'lookup_musicbrainz'
    | 'ask_user_followup'
    | 'finalize_playlist';
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export const PLAYLIST_TOOL_DEFINITIONS: PlaylistToolDefinition[] = [
  {
    name: 'search_local_catalog',
    description:
      'Runs parameterized SQLite FTS5 & filter queries against the local owned tracks database and returns compact metadata rows.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Optional FTS5 search query (mood, genre, title, artist)' },
        artist: { type: 'string', description: 'Optional artist filter' },
        genre: { type: 'string', description: 'Optional genre filter' },
        min_rating: { type: 'number', description: 'Minimum star rating (0-5)' },
        loved_only: { type: 'boolean', description: 'Only return loved tracks' },
        exclude_track_ids: {
          type: 'array',
          items: { type: 'number' },
          description: 'Track IDs to exclude from results',
        },
        limit: { type: 'number', description: 'Max rows to return (default 25, max 60)' },
      },
    },
  },
  {
    name: 'discover_via_lastfm',
    description:
      'Queries Last.fm (track.getSimilar, artist.getSimilar, tag.getTopTracks) and inner-joins against local SQLite tracks so only owned tracks are returned.',
    parameters: {
      type: 'object',
      properties: {
        seed_artist: { type: 'string', description: 'Seed artist name' },
        seed_track: { type: 'string', description: 'Optional seed track title' },
        tag: { type: 'string', description: 'Optional mood/genre tag' },
        limit: { type: 'number', description: 'Max owned matches to return (default 20)' },
      },
      required: ['seed_artist'],
    },
  },
  {
    name: 'lookup_musicbrainz',
    description:
      'Queries MusicBrainz (recording, release-group, artist) for scene/era/label discovery and resolves matches against local SQLite track IDs.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'MusicBrainz search query' },
        entity_type: {
          type: 'string',
          enum: ['recording', 'release-group', 'artist'],
          description: 'MusicBrainz entity type',
        },
      },
      required: ['query', 'entity_type'],
    },
  },
  {
    name: 'ask_user_followup',
    description:
      'Pauses generation to present 1-2 concise clarifying questions with clickable quick-reply chips before finalizing the playlist.',
    parameters: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'Concise clarifying question for the user' },
        options: {
          type: 'array',
          items: { type: 'string' },
          description: '2-5 clickable quick-reply options',
        },
      },
      required: ['question', 'options'],
    },
  },
  {
    name: 'finalize_playlist',
    description:
      'Validates that every returned track_id exists in SQLite and presents the generated playlist preview for confirmation.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Playlist title' },
        description: { type: 'string', description: 'Short description of the playlist vibe' },
        track_ids: {
          type: 'array',
          items: { type: 'number' },
          description: 'Ordered array of owned SQLite track IDs',
        },
      },
      required: ['name', 'description', 'track_ids'],
    },
  },
];

export type AgentTurnResult =
  | {
      type: 'followup';
      question: string;
      options: string[];
      assistantMessage?: string;
    }
  | {
      type: 'finalized';
      name: string;
      description: string;
      tracks: TrackRow[];
      assistantMessage?: string;
    }
  | {
      type: 'message';
      message: string;
    };

export interface AgentChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface PlaylistProvider {
  readonly id: string;
  runTurn(input: {
    prompt: string;
    history: AgentChatMessage[];
    excludedTrackIds?: number[];
  }): Promise<AgentTurnResult>;
  dispose(): Promise<void>;
}

/**
 * LocalLlamaProvider delegates inference to Electron's main process (`node-llama-cpp`),
 * keeping GGUF weights, SQLite queries, and Last.fm/MusicBrainz calls out of the renderer.
 */
export class LocalLlamaProvider implements PlaylistProvider {
  readonly id = 'local-llama';

  async runTurn(input: {
    prompt: string;
    history: AgentChatMessage[];
    excludedTrackIds?: number[];
  }): Promise<AgentTurnResult> {
    return await invokeRpc<AgentTurnResult>('ai:agent-turn', input);
  }

  async dispose(): Promise<void> {
    await invokeRpc('ai:dispose-model');
  }
}

/**
 * Future placeholder for remote Docker rTunes Companion Server (MCP).
 */
export class RemoteMcpServerProvider implements PlaylistProvider {
  readonly id = 'remote-mcp';

  async runTurn(): Promise<AgentTurnResult> {
    throw new Error('rTunes Companion Server (MCP) is disabled in Pre-Alpha.');
  }

  async dispose(): Promise<void> {
    // No-op in Pre-Alpha stub
  }
}

export class PlaylistAgent {
  private provider: PlaylistProvider;
  private history: AgentChatMessage[] = [];

  constructor(provider: PlaylistProvider = new LocalLlamaProvider()) {
    this.provider = provider;
  }

  getHistory(): AgentChatMessage[] {
    return this.history;
  }

  async sendMessage(prompt: string, excludedTrackIds: number[] = []): Promise<AgentTurnResult> {
    this.history = [...this.history, { role: 'user', content: prompt }];
    const result = await this.provider.runTurn({
      prompt,
      history: this.history,
      excludedTrackIds,
    });

    if (result.type === 'followup') {
      this.history = [...this.history, { role: 'assistant', content: result.question }];
    } else if (result.type === 'finalized') {
      this.history = [
        ...this.history,
        { role: 'assistant', content: `Proposed playlist "${result.name}" (${result.tracks.length} tracks).` },
      ];
    } else if (result.type === 'message') {
      this.history = [...this.history, { role: 'assistant', content: result.message }];
    }

    return result;
  }

  async dispose(): Promise<void> {
    await this.provider.dispose();
  }
}
