/**
 * Captures MCP tools — save and recall via the HOMEBASE bridge.
 *
 * Unlike calendar.ts (direct SQLite via mounted DB), captures must
 * round-trip through the bridge HTTP API because writes need to
 * trigger Chroma indexing in the bridge process. The bridge runs
 * on the host at port 7575; reachable from the container via
 * host.docker.internal (Docker Desktop on macOS provides this
 * natively; container-runtime.ts adds --add-host on Linux).
 *
 * Privacy boundary: embeddings are generated locally by Ollama on
 * the host. Capture content is sent to the bridge but never to a
 * cloud service unless the calling agent itself is a cloud agent
 * acting on the user's behalf.
 */
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

const BRIDGE_BASE = 'http://host.docker.internal:7575';
const TIMEOUT_MS = 10_000;

function ok(payload: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }] };
}
function err(text: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${text}` }], isError: true };
}

async function bridgeFetch(method: string, path: string, body: unknown = null): Promise<unknown> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    const init: RequestInit = { method, signal: ac.signal };
    if (body !== null) {
      init.headers = { 'Content-Type': 'application/json' };
      init.body = JSON.stringify(body);
    }
    const res = await fetch(BRIDGE_BASE + path, init);
    const text = await res.text();
    let data: unknown = null;
    if (text) {
      try { data = JSON.parse(text); } catch { data = text; }
    }
    if (!res.ok) {
      const detail = typeof data === 'object' ? JSON.stringify(data) : String(data);
      throw new Error(`bridge ${method} ${path} -> HTTP ${res.status}: ${detail}`);
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

export const captureSave: McpToolDefinition = {
  tool: {
    name: 'capture_save',
    description:
      'Save a thought, note, or article reference to the user\'s capture corpus. ' +
      'Use this when the user wants to remember something, save a snippet, bookmark a link, ' +
      'or jot down an idea. The capture is embedded for semantic recall via capture_search. ' +
      'Auto-typed: "article" if source_url is given, else "text".',
    inputSchema: {
      type: 'object' as const,
      properties: {
        content: { type: 'string', description: 'The content to save (required, non-empty).' },
        workspace_id: { type: 'string', description: 'Optional workspace to associate this capture with.' },
        source_url: { type: 'string', description: 'Optional source URL — sets type to "article".' },
      },
      required: ['content'],
    },
  },
  async handler(args) {
    try {
      const content = String(args.content ?? '').trim();
      if (!content) throw new Error('content must be non-empty');
      const source_url = args.source_url != null && args.source_url !== '' ? String(args.source_url) : null;
      const body: Record<string, unknown> = {
        type: source_url ? 'article' : 'text',
        content,
      };
      if (source_url) body.source_url = source_url;
      if (args.workspace_id) body.workspace_id = String(args.workspace_id);
      const cap = await bridgeFetch('POST', '/captures', body) as {
        id: string; embedding_status: string; workspace_id: string | null;
      };
      return ok({
        id: cap.id,
        embedding_status: cap.embedding_status,
        workspace_id: cap.workspace_id,
      });
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e));
    }
  },
};

export const captureSearch: McpToolDefinition = {
  tool: {
    name: 'capture_search',
    description:
      'Semantic search across the user\'s saved captures. Use this when the user asks to ' +
      'recall something, find a past note, or search by meaning rather than exact words. ' +
      'Returns ranked matches with content, captured_at, workspace_id, tags, reflections, and score.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Natural-language query.' },
        workspace_id: { type: 'string', description: 'Optional — restrict to a single workspace.' },
        limit: { type: 'integer', description: 'Max results (1-50, default 10).' },
      },
      required: ['query'],
    },
  },
  async handler(args) {
    try {
      const q = String(args.query ?? '').trim();
      if (!q) throw new Error('query must be non-empty');
      const params = new URLSearchParams({ q });
      if (args.workspace_id) params.set('workspace_id', String(args.workspace_id));
      if (args.limit != null) params.set('limit', String(args.limit));
      const hits = await bridgeFetch('GET', '/captures/search?' + params.toString());
      return ok(hits);
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e));
    }
  },
};

export const captureListRecent: McpToolDefinition = {
  tool: {
    name: 'capture_list_recent',
    description:
      'List the most recent captures, newest first. Use to browse recent activity ' +
      'or surface captures without a specific query.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        workspace_id: { type: 'string', description: 'Optional — restrict to a single workspace.' },
        limit: { type: 'integer', description: 'Max results, default 10.' },
      },
    },
  },
  async handler(args) {
    try {
      const params = new URLSearchParams();
      if (args.workspace_id) params.set('workspace_id', String(args.workspace_id));
      params.set('limit', String(args.limit ?? 10));
      const items = await bridgeFetch('GET', '/captures?' + params.toString());
      return ok(items);
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e));
    }
  },
};

registerTools([captureSave, captureSearch, captureListRecent]);
