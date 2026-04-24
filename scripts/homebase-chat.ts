/**
 * homebase-chat — smoke-test client for the Homebase channel.
 *
 * Usage:
 *   pnpm exec tsx scripts/homebase-chat.ts <message...>
 *   HOMEBASE_SESSION_ID=homebase:tab-2 pnpm exec tsx scripts/homebase-chat.ts hello
 *
 * Connects to data/homebase.sock, sends one message with a valid
 * wire-format payload, prints reply lines, exits after 2s of silence
 * following the first reply (or after a 120s hard timeout).
 *
 * Preconditions: NanoClaw host running, an agent group wired to
 * channelType=homebase, platformId=<session_id> (default "homebase:desktop")
 * via /manage-channels.
 */
import net from 'net';
import path from 'path';

import { DATA_DIR } from '../src/config.js';

const SILENCE_MS = 2000;
const TOTAL_TIMEOUT_MS = 120_000;

function socketPath(): string {
  return path.join(DATA_DIR, 'homebase.sock');
}

function main(): void {
  const words = process.argv.slice(2);
  if (words.length === 0) {
    console.error('usage: pnpm exec tsx scripts/homebase-chat.ts <message...>');
    process.exit(1);
  }
  const text = words.join(' ');
  const sessionId = process.env.HOMEBASE_SESSION_ID || 'homebase:desktop';

  const socket = net.connect(socketPath());

  socket.on('error', (err) => {
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'ENOENT' || e.code === 'ECONNREFUSED') {
      console.error(`NanoClaw Homebase socket not reachable at ${socketPath()}.`);
      console.error('Start the service (launchctl/systemd) before running this.');
    } else {
      console.error('Homebase socket error:', err);
    }
    process.exit(2);
  });

  let firstReplySeen = false;
  let silenceTimer: NodeJS.Timeout | null = null;
  let hardTimer: NodeJS.Timeout | null = null;

  function scheduleExit(): void {
    if (silenceTimer) clearTimeout(silenceTimer);
    silenceTimer = setTimeout(() => {
      socket.end();
      process.exit(0);
    }, SILENCE_MS);
  }

  socket.on('connect', () => {
    const payload = {
      type: 'message',
      text,
      session_id: sessionId,
      timestamp: new Date().toISOString(),
      in_reply_to: null,
    };
    socket.write(JSON.stringify(payload) + '\n');
    hardTimer = setTimeout(() => {
      if (!firstReplySeen) {
        console.error(`timeout: no reply in ${TOTAL_TIMEOUT_MS}ms`);
        socket.end();
        process.exit(3);
      }
    }, TOTAL_TIMEOUT_MS);
  });

  let buffer = '';
  socket.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    let idx: number;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.type === 'error') {
          process.stdout.write(`[error] ${msg.text}\n`);
        } else if (msg.type === 'message' && typeof msg.text === 'string') {
          const tag = msg.in_reply_to ? ` (re: ${msg.in_reply_to})` : '';
          process.stdout.write(`${msg.text}${tag}\n`);
        } else {
          process.stdout.write(`[unknown] ${line}\n`);
        }
        firstReplySeen = true;
        if (hardTimer) {
          clearTimeout(hardTimer);
          hardTimer = null;
        }
        scheduleExit();
      } catch {
        // Ignore non-JSON noise.
      }
    }
  });

  socket.on('close', () => {
    if (silenceTimer) clearTimeout(silenceTimer);
    if (hardTimer) clearTimeout(hardTimer);
    process.exit(firstReplySeen ? 0 : 3);
  });
}

main();
