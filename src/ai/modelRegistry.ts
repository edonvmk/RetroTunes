export interface AiModelSpec {
  id: string;
  label: string;
  enabled: boolean;
  badge?: 'Default' | 'Coming Soon' | 'Future Docker';
  uri?: string;
  filename?: string;
  approxSizeMB?: number;
  contextWindow?: number;
  description: string;
}

export interface AiModelCacheStatus {
  modelId: string;
  cached: boolean;
  filePath: string;
  sizeBytes: number;
}

export const AI_MODEL_CATALOG: AiModelSpec[] = [
  {
    id: 'qwen3.5-0.8b-q4',
    label: 'Qwen 3.5 — 0.8B (Q4_K_M • Pre-Alpha Default)',
    enabled: true,
    badge: 'Default',
    uri: 'hf:lmstudio-community/Qwen3.5-0.8B-GGUF:Q4_K_M',
    filename: 'Qwen3.5-0.8B-Q4_K_M.gguf',
    approxSizeMB: 580,
    contextWindow: 32768,
    description:
      'Lightweight 0.8B quantized GGUF model downloaded on demand (~580 MB) with a 32k context cap to keep RAM usage low.',
  },
  {
    id: 'qwen3.5-2b-q4',
    label: 'Qwen 3.5 — 2B (Q4_K_M)',
    enabled: false,
    badge: 'Coming Soon',
    filename: 'Qwen3.5-2B-Q4_K_M.gguf',
    approxSizeMB: 1450,
    contextWindow: 32768,
    description: 'Higher-capacity 2B local model (~1.45 GB). Disabled in Pre-Alpha.',
  },
  {
    id: 'rtunes-companion-mcp',
    label: 'rTunes Companion Server (Remote / MCP)',
    enabled: false,
    badge: 'Future Docker',
    description:
      'Remote Docker companion MCP playlist agent. Disabled in Pre-Alpha standalone mode.',
  },
];

export function getDefaultAiModel(): AiModelSpec {
  return AI_MODEL_CATALOG.find((m) => m.enabled) || AI_MODEL_CATALOG[0];
}
