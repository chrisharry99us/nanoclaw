/**
 * Homebase channel — bridge NanoClaw to a local GUI app on the same machine.
 *
 * Localhost-only, zero-credentials channel that mirrors the CLI adapter's
 * Unix-socket pattern at `data/homebase.sock`, chmod 0600. No TCP, no
 * external exposure — "who can connect" is gated by filesystem perms.
 *
 * Wire format: one JSON object per line, UTF-8, '\n'-terminated.
 *
 *   GUI → host:
 *     { "type": "message",
 *       "text": "hello",
 *       "session_id": "homebase:desktop",
 *       "timestamp": "2026-04-24T14:23:01.482Z",
 *       "in_reply_to": null }
 *
 *   host → GUI:
 *     { "type": "message",
 *       "text": "hi, what can I help with?",
 *       "session_id": "homebase:desktop",
 *       "timestamp": "2026-04-24T14:23:04.901Z",
 *       "in_reply_to": "hb-1745504581482-a3f9c1" }
 *
 *   host → GUI on a malformed inbound:
 *     { "type": "error",
 *       "text": "<reason>",
 *       "timestamp": "..." }
 *
 * The inbound `session_id` IS the platformId used to route the message to a
 * wired messaging group. One GUI tab = one session_id = one session. Multiple
 * clients with different session_ids may connect simultaneously; a reconnect
 * on the same session_id supersedes the prior socket for that slot.
 *
 * `in_reply_to` on an outbound echoes the most recent inbound id received on
 * that session_id (or null before the first inbound), giving the GUI a
 * best-effort correlation signal. Proactive agent messages sent before any
 * inbound arrive with `in_reply_to: null`.
 */
import fs from 'fs';
import net from 'net';
import path from 'path';

import { DATA_DIR } from '../config.js';
import { log } from '../log.js';
import type { ChannelAdapter, ChannelSetup, OutboundMessage } from './adapter.js';
import { registerChannelAdapter } from './channel-registry.js';

function socketPath(): string {
  return path.join(DATA_DIR, 'homebase.sock');
}

function nowIso(): string {
  return new Date().toISOString();
}

function genId(): string {
  return `hb-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

interface InboundPayload {
  type: string;
  text: string;
  session_id: string;
  timestamp: string;
  in_reply_to: string | null;
}

type Validated = { ok: true; msg: InboundPayload } | { ok: false; reason: string };

function validate(raw: unknown): Validated {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, reason: 'payload must be a JSON object' };
  }
  const obj = raw as Record<string, unknown>;
  if (obj.type === undefined) return { ok: false, reason: 'missing required field: type' };
  if (typeof obj.type !== 'string') return { ok: false, reason: 'type must be a string' };
  if (obj.type !== 'message') return { ok: false, reason: `unsupported type: ${obj.type}` };
  if (obj.text === undefined) return { ok: false, reason: 'missing required field: text' };
  if (typeof obj.text !== 'string' || obj.text.length === 0) {
    return { ok: false, reason: 'text must be a non-empty string' };
  }
  if (obj.session_id === undefined) return { ok: false, reason: 'missing required field: session_id' };
  if (typeof obj.session_id !== 'string' || obj.session_id.length === 0) {
    return { ok: false, reason: 'session_id must be a non-empty string' };
  }
  if (obj.timestamp === undefined) return { ok: false, reason: 'missing required field: timestamp' };
  if (typeof obj.timestamp !== 'string' || obj.timestamp.length === 0) {
    return { ok: false, reason: 'timestamp must be a non-empty string' };
  }
  if (obj.in_reply_to !== null && obj.in_reply_to !== undefined && typeof obj.in_reply_to !== 'string') {
    return { ok: false, reason: 'in_reply_to must be string or null' };
  }
  return {
    ok: true,
    msg: {
      type: obj.type,
      text: obj.text,
      session_id: obj.session_id,
      timestamp: obj.timestamp,
      in_reply_to: (obj.in_reply_to as string | null | undefined) ?? null,
    },
  };
}

function writeLine(socket: net.Socket, obj: unknown): void {
  try {
    socket.write(JSON.stringify(obj) + '\n');
  } catch (err) {
    log.warn('Homebase: failed to write to client', { err });
  }
}

function extractText(message: OutboundMessage): string | null {
  const content = message.content as Record<string, unknown> | string | undefined;
  if (typeof content === 'string') return content;
  if (content && typeof content === 'object' && typeof content.text === 'string') {
    return content.text;
  }
  return null;
}

function createAdapter(): ChannelAdapter {
  let server: net.Server | null = null;
  const clients = new Map<string, net.Socket>();
  const lastInboundId = new Map<string, string>();

  const adapter: ChannelAdapter = {
    name: 'homebase',
    channelType: 'homebase',
    supportsThreads: false,

    async setup(config: ChannelSetup): Promise<void> {
      const sock = socketPath();

      try {
        fs.unlinkSync(sock);
      } catch (err) {
        const e = err as NodeJS.ErrnoException;
        if (e.code !== 'ENOENT') {
          log.warn('Failed to unlink stale Homebase socket (will try to bind anyway)', { sock, err });
        }
      }

      server = net.createServer((socket) => handleConnection(socket, config));
      await new Promise<void>((resolve, reject) => {
        server!.once('error', reject);
        server!.listen(sock, () => {
          try {
            fs.chmodSync(sock, 0o600);
          } catch (err) {
            log.warn('Failed to chmod Homebase socket (continuing)', { sock, err });
          }
          log.info('Homebase channel listening', { sock });
          resolve();
        });
      });
    },

    async teardown(): Promise<void> {
      for (const sock of clients.values()) {
        try {
          sock.end();
        } catch {
          // swallow
        }
      }
      clients.clear();
      lastInboundId.clear();
      if (server) {
        await new Promise<void>((resolve) => {
          server!.close(() => resolve());
        });
        server = null;
      }
      try {
        fs.unlinkSync(socketPath());
      } catch {
        // swallow
      }
    },

    isConnected(): boolean {
      return server !== null;
    },

    async deliver(platformId, _threadId, message: OutboundMessage): Promise<string | undefined> {
      const client = clients.get(platformId);
      if (!client) {
        // No live GUI for this session_id. Outbound is already persisted in
        // outbound.db — it'll reach the next client that claims this slot if
        // the row is re-delivered, otherwise it's silently absorbed here.
        return undefined;
      }
      const text = extractText(message);
      if (text === null) return undefined;
      writeLine(client, {
        type: 'message',
        text,
        session_id: platformId,
        timestamp: nowIso(),
        in_reply_to: lastInboundId.get(platformId) ?? null,
      });
      return undefined;
    },
  };

  function handleConnection(socket: net.Socket, config: ChannelSetup): void {
    // The session_id isn't known until the first valid line arrives — don't
    // claim a slot until then. Until claimed, the socket exists only to
    // receive error responses about its own malformed input.
    let claimedSessionId: string | null = null;

    const claimSlot = (sessionId: string) => {
      if (claimedSessionId === sessionId) return;
      if (claimedSessionId !== null) {
        // The same physical socket is trying to change session_id mid-stream.
        // Disallow — each connection holds at most one session_id.
        writeLine(socket, {
          type: 'error',
          text: `session_id cannot change on an open connection (was "${claimedSessionId}", got "${sessionId}")`,
          timestamp: nowIso(),
        });
        return;
      }
      const prior = clients.get(sessionId);
      if (prior && prior !== socket) {
        try {
          writeLine(prior, {
            type: 'error',
            text: '[superseded by a newer client]',
            timestamp: nowIso(),
          });
          prior.end();
        } catch {
          // swallow
        }
      }
      clients.set(sessionId, socket);
      claimedSessionId = sessionId;
      log.info('Homebase client connected', { sessionId });
    };

    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let idx: number;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        void handleLine(line, config, claimSlot, socket);
      }
    });

    socket.on('close', () => {
      if (claimedSessionId && clients.get(claimedSessionId) === socket) {
        clients.delete(claimedSessionId);
        log.info('Homebase client disconnected', { sessionId: claimedSessionId });
      }
    });

    socket.on('error', (err) => {
      log.warn('Homebase client socket error', { err });
    });
  }

  async function handleLine(
    line: string,
    config: ChannelSetup,
    claimSlot: (sessionId: string) => void,
    socket: net.Socket,
  ): Promise<void> {
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch (err) {
      writeLine(socket, {
        type: 'error',
        text: `invalid JSON: ${(err as Error).message}`,
        timestamp: nowIso(),
      });
      return;
    }

    const result = validate(raw);
    if (!result.ok) {
      writeLine(socket, {
        type: 'error',
        text: result.reason,
        timestamp: nowIso(),
      });
      return;
    }

    const msg = result.msg;
    claimSlot(msg.session_id);

    const inboundId = genId();
    lastInboundId.set(msg.session_id, inboundId);

    try {
      await config.onInbound(msg.session_id, null, {
        id: inboundId,
        kind: 'chat',
        timestamp: msg.timestamp,
        content: {
          text: msg.text,
          sender: 'homebase',
          senderId: `homebase:${msg.session_id}`,
        },
      });
    } catch (err) {
      log.error('Homebase: onInbound threw', { err });
      writeLine(socket, {
        type: 'error',
        text: 'internal error routing message',
        timestamp: nowIso(),
      });
    }
  }

  return adapter;
}

registerChannelAdapter('homebase', { factory: createAdapter });
