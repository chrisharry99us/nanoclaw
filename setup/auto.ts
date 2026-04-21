/**
 * Non-interactive setup driver. Chains the deterministic setup steps so a
 * scripted install can go from a fresh checkout to a running service without
 * the `/setup` skill.
 *
 * Prerequisite: `bash setup.sh` has run (Node >= 20, pnpm install, native
 * module check). This driver picks up from there.
 *
 * Config via env:
 *   NANOCLAW_DISPLAY_NAME  how the agents address the operator — skips the
 *                          prompt. Defaults to $USER.
 *   NANOCLAW_AGENT_NAME    name for the messaging-channel agent (Telegram,
 *                          etc.) — skips the prompt. Defaults to "Nano".
 *                          (The CLI scratch agent is always "Terminal Agent".)
 *   NANOCLAW_SKIP          comma-separated step names to skip
 *                          (environment|container|onecli|auth|mounts|
 *                           service|cli-agent|channel|verify)
 *
 * Timezone is not configured here — it defaults to the host system's TZ.
 * Run `pnpm exec tsx setup/index.ts --step timezone -- --tz <zone>` later
 * if autodetect is wrong (e.g. headless server with TZ=UTC).
 *
 * UI is rendered with @clack/prompts: spinners wrap each step, child output
 * is captured quietly and only dumped on failure. Interactive children
 * (register-claude-token.sh, add-telegram.sh) bypass the spinner and run
 * with inherited stdio — clack resumes cleanly on the next step.
 */
import { spawn, spawnSync } from 'child_process';
import fs from 'fs';

import * as p from '@clack/prompts';
import k from 'kleur';

import * as setupLog from './logs.js';

const CLI_AGENT_NAME = 'Terminal Agent';
const DEFAULT_AGENT_NAME = 'Nano';

const RUN_START = Date.now();
let failingStep = 'setup';

/**
 * Brand palette, pulled from assets/nanoclaw-logo.png:
 *   brand cyan  ≈ #2BB7CE  — the "Claw" wordmark + mascot body
 *   brand navy  ≈ #171B3B  — the dark logo background + outlines
 * Gated on TTY + NO_COLOR so piped / CI output stays plain. Falls back to
 * kleur's 16-color cyan when the terminal isn't truecolor.
 */
const USE_ANSI = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
const TRUECOLOR =
  USE_ANSI &&
  (process.env.COLORTERM === 'truecolor' || process.env.COLORTERM === '24bit');

const brand = (s: string): string => {
  if (!USE_ANSI) return s;
  if (TRUECOLOR) return `\x1b[38;2;43;183;206m${s}\x1b[0m`;
  return k.cyan(s);
};
const brandBold = (s: string): string => {
  if (!USE_ANSI) return s;
  if (TRUECOLOR) return `\x1b[1;38;2;43;183;206m${s}\x1b[0m`;
  return k.bold(k.cyan(s));
};
const brandChip = (s: string): string => {
  if (!USE_ANSI) return s;
  if (TRUECOLOR) {
    return `\x1b[48;2;43;183;206m\x1b[38;2;23;27;59m\x1b[1m${s}\x1b[0m`;
  }
  return k.bgCyan(k.black(k.bold(s)));
};

type Fields = Record<string, string>;
type Block = { type: string; fields: Fields };
type StepResult = {
  ok: boolean;
  exitCode: number;
  blocks: Block[];
  transcript: string;
  /** The last block matching `stepName.toUpperCase()` if any. */
  terminal: Block | null;
};

/**
 * Streaming parser for `=== NANOCLAW SETUP: TYPE ===` blocks. Emits each
 * block as it closes so the UI can react mid-stream (e.g. render a pairing
 * code card as soon as pair-telegram emits it, rather than after the step
 * has finished).
 */
class StatusStream {
  private lineBuf = '';
  private current: Block | null = null;
  readonly blocks: Block[] = [];
  transcript = '';

  constructor(private readonly onBlock: (block: Block) => void) {}

  write(chunk: string): void {
    this.transcript += chunk;
    this.lineBuf += chunk;
    let idx: number;
    while ((idx = this.lineBuf.indexOf('\n')) !== -1) {
      const line = this.lineBuf.slice(0, idx);
      this.lineBuf = this.lineBuf.slice(idx + 1);
      this.processLine(line);
    }
  }

  private processLine(line: string): void {
    const start = line.match(/^=== NANOCLAW SETUP: (\S+) ===/);
    if (start) {
      this.current = { type: start[1], fields: {} };
      return;
    }
    if (line.startsWith('=== END ===')) {
      if (this.current) {
        this.blocks.push(this.current);
        this.onBlock(this.current);
        this.current = null;
      }
      return;
    }
    if (!this.current) return;
    const colon = line.indexOf(':');
    if (colon === -1) return;
    const key = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    if (key) this.current.fields[key] = value;
  }
}

/**
 * Spawn a setup step as a child process. Output is tee'd to the provided
 * raw log file (level 3) and parsed for status blocks (level 2 summary).
 * The onBlock callback fires per status block as they close so the UI can
 * react mid-stream.
 */
function spawnStep(
  stepName: string,
  extra: string[],
  onBlock: (block: Block) => void,
  rawLogPath: string,
): Promise<StepResult> {
  return new Promise((resolve) => {
    const args = ['exec', 'tsx', 'setup/index.ts', '--step', stepName];
    if (extra.length > 0) args.push('--', ...extra);

    const child = spawn('pnpm', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const stream = new StatusStream(onBlock);
    const raw = fs.createWriteStream(rawLogPath, { flags: 'w' });
    raw.write(`# ${stepName} — ${new Date().toISOString()}\n\n`);

    child.stdout.on('data', (chunk: Buffer) => {
      stream.write(chunk.toString('utf-8'));
      raw.write(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stream.transcript += chunk.toString('utf-8');
      raw.write(chunk);
    });

    child.on('close', (code) => {
      raw.end();
      // Step block types don't always mirror step names (e.g. `mounts` emits
      // CONFIGURE_MOUNTS, `container` emits SETUP_CONTAINER). Any block with
      // a STATUS field is a terminal block; the last one wins.
      const terminal =
        [...stream.blocks].reverse().find((b) => b.fields.STATUS) ?? null;
      const status = terminal?.fields.STATUS;
      const ok = code === 0 && (status === 'success' || status === 'skipped');
      resolve({
        ok,
        exitCode: code ?? 1,
        blocks: stream.blocks,
        transcript: stream.transcript,
        terminal,
      });
    });
  });
}

type SpinnerLabels = {
  running: string;
  done: string;
  skipped?: string;
  failed?: string;
};

/** Run a step under a clack spinner. Teed to a per-step raw log + progression entry at the end. */
async function runQuietStep(
  stepName: string,
  labels: SpinnerLabels,
  extra: string[] = [],
): Promise<StepResult & { rawLog: string; durationMs: number }> {
  failingStep = stepName;
  const rawLog = setupLog.stepRawLog(stepName);
  const start = Date.now();
  const result = await runUnderSpinner(labels, () =>
    spawnStep(stepName, extra, () => {}, rawLog),
  );
  const durationMs = Date.now() - start;
  writeStepEntry(stepName, result, durationMs, rawLog);
  return { ...result, rawLog, durationMs };
}

/** Run an arbitrary child under a spinner. Same raw-log + progression treatment as runQuietStep. */
async function runQuietChild(
  logName: string,
  cmd: string,
  args: string[],
  labels: SpinnerLabels,
  opts?: {
    /** Extra fields to merge into the progression entry (on top of any status-block fields). */
    extraFields?: Record<string, string | number | boolean>;
    /** Environment overrides to pass to the child process. */
    env?: NodeJS.ProcessEnv;
  },
): Promise<{
  ok: boolean;
  exitCode: number;
  transcript: string;
  terminal: Block | null;
  rawLog: string;
  durationMs: number;
}> {
  failingStep = logName;
  const rawLog = setupLog.stepRawLog(logName);
  const start = Date.now();
  const result = await runUnderSpinner(labels, () =>
    spawnQuiet(cmd, args, rawLog, opts?.env),
  );
  const durationMs = Date.now() - start;

  const blockFields = summariseTerminalFields(result.terminal);
  const fields = { ...blockFields, ...(opts?.extraFields ?? {}) };
  const rawStatus = result.terminal?.fields.STATUS;
  const status: 'success' | 'skipped' | 'failed' = !result.ok
    ? 'failed'
    : rawStatus === 'skipped'
      ? 'skipped'
      : 'success';
  setupLog.step(logName, status, durationMs, fields, rawLog);
  return { ...result, rawLog, durationMs };
}

/** Turn a step's terminal-block fields into a concise progression-log entry. */
function writeStepEntry(
  stepName: string,
  result: StepResult,
  durationMs: number,
  rawLog: string,
): void {
  const rawStatus = result.terminal?.fields.STATUS;
  const logStatus: 'success' | 'skipped' | 'failed' = !result.ok
    ? 'failed'
    : rawStatus === 'skipped'
      ? 'skipped'
      : 'success';
  const fields = summariseTerminalFields(result.terminal);
  setupLog.step(stepName, logStatus, durationMs, fields, rawLog);
}

/** Strip STATUS + LOG (redundant) and any oversize values from the terminal block's fields. */
function summariseTerminalFields(block: Block | null): Record<string, string> {
  if (!block) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(block.fields)) {
    if (k === 'STATUS' || k === 'LOG') continue;
    if (v.length > 120) continue; // keep it skimmable; full value lives in the raw log
    out[k] = v;
  }
  return out;
}

async function runUnderSpinner<
  T extends { ok: boolean; transcript: string; terminal?: Block | null },
>(
  labels: SpinnerLabels,
  work: () => Promise<T>,
): Promise<T> {
  const s = p.spinner();
  const start = Date.now();
  s.start(labels.running);
  const tick = setInterval(() => {
    const elapsed = Math.round((Date.now() - start) / 1000);
    s.message(`${labels.running} ${k.dim(`(${elapsed}s)`)}`);
  }, 1000);

  const result = await work();

  clearInterval(tick);
  const elapsed = Math.round((Date.now() - start) / 1000);
  if (result.ok) {
    const isSkipped = result.terminal?.fields.STATUS === 'skipped';
    const msg = isSkipped && labels.skipped ? labels.skipped : labels.done;
    s.stop(`${msg} ${k.dim(`(${elapsed}s)`)}`);
  } else {
    const failMsg = labels.failed ?? labels.running.replace(/…$/, ' failed');
    s.stop(`${failMsg} ${k.dim(`(${elapsed}s)`)}`, 1);
    dumpTranscriptOnFailure(result.transcript);
  }
  return result;
}

function spawnQuiet(
  cmd: string,
  args: string[],
  rawLogPath: string,
  envOverride?: NodeJS.ProcessEnv,
): Promise<{ ok: boolean; exitCode: number; transcript: string; terminal: Block | null; blocks: Block[] }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: envOverride ? { ...process.env, ...envOverride } : process.env,
    });
    let transcript = '';
    const raw = fs.createWriteStream(rawLogPath, { flags: 'w' });
    raw.write(`# ${[cmd, ...args].join(' ')} — ${new Date().toISOString()}\n\n`);
    const blocks: Block[] = [];
    const stream = new StatusStream((b) => blocks.push(b));
    child.stdout.on('data', (c: Buffer) => {
      const s = c.toString('utf-8');
      transcript += s;
      stream.write(s);
      raw.write(c);
    });
    child.stderr.on('data', (c: Buffer) => {
      transcript += c.toString('utf-8');
      raw.write(c);
    });
    child.on('close', (code) => {
      raw.end();
      const terminal =
        [...blocks].reverse().find((b) => b.fields.STATUS) ?? null;
      resolve({ ok: code === 0, exitCode: code ?? 1, transcript, terminal, blocks });
    });
  });
}

function dumpTranscriptOnFailure(transcript: string): void {
  const lines = transcript.split('\n').filter((l) => {
    if (l.startsWith('=== NANOCLAW SETUP:')) return false;
    if (l.startsWith('=== END ===')) return false;
    return true;
  });
  const tail = lines.slice(-40).join('\n').trimEnd();
  if (tail) {
    console.log();
    console.log(k.dim(tail));
    console.log();
  }
}

function fail(msg: string, hint?: string): never {
  setupLog.abort(failingStep, msg);
  p.log.error(msg);
  if (hint) p.log.message(k.dim(hint));
  p.log.message(k.dim('Logs: logs/setup.log · Raw: logs/setup-steps/'));
  p.cancel('Setup aborted.');
  process.exit(1);
}

function ensureAnswer<T>(value: T | symbol): T {
  if (p.isCancel(value)) {
    setupLog.abort(failingStep, 'user-cancelled');
    p.cancel('Setup cancelled.');
    process.exit(0);
  }
  return value as T;
}

/**
 * After installing Docker, this process's supplementary groups are still
 * frozen from login — subsequent steps that talk to /var/run/docker.sock
 * (onecli install, service start, …) fail with EACCES even though the
 * daemon is up. Detect that and re-exec the whole driver under `sg docker`
 * so the rest of the run inherits the docker group without a re-login.
 */
function maybeReexecUnderSg(): void {
  if (process.env.NANOCLAW_REEXEC_SG === '1') return;
  if (process.platform !== 'linux') return;
  const info = spawnSync('docker', ['info'], { encoding: 'utf-8' });
  if (info.status === 0) return;
  const err = `${info.stderr ?? ''}\n${info.stdout ?? ''}`;
  if (!/permission denied/i.test(err)) return;
  if (spawnSync('which', ['sg'], { stdio: 'ignore' }).status !== 0) return;

  p.log.warn('Docker socket not accessible in current group — re-executing under `sg docker`.');
  const res = spawnSync('sg', ['docker', '-c', 'pnpm run setup:auto'], {
    stdio: 'inherit',
    env: { ...process.env, NANOCLAW_REEXEC_SG: '1' },
  });
  process.exit(res.status ?? 1);
}

function anthropicSecretExists(): boolean {
  try {
    const res = spawnSync('onecli', ['secrets', 'list'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (res.status !== 0) return false;
    return /anthropic/i.test(res.stdout ?? '');
  } catch {
    return false;
  }
}

function runInheritScript(cmd: string, args: string[]): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: 'inherit' });
    child.on('close', (code) => resolve(code ?? 1));
  });
}

function formatCodeCard(code: string): string {
  const spaced = code.split('').join('   ');
  return [
    '',
    `   ${brandBold(spaced)}`,
    '',
    k.dim('   Send these digits from Telegram to your bot.'),
  ].join('\n');
}

async function runPairTelegram(): Promise<StepResult & { rawLog: string; durationMs: number }> {
  failingStep = 'pair-telegram';
  const rawLog = setupLog.stepRawLog('pair-telegram');
  const start = Date.now();
  const s = p.spinner();
  s.start('Creating pairing code…');
  let spinnerActive = true;

  const stopSpinner = (msg: string, code?: number) => {
    if (spinnerActive) {
      s.stop(msg, code);
      spinnerActive = false;
    }
  };

  const result = await spawnStep(
    'pair-telegram',
    ['--intent', 'main'],
    (block) => {
      if (block.type === 'PAIR_TELEGRAM_CODE') {
        const reason = block.fields.REASON ?? 'initial';
        if (reason === 'initial') {
          stopSpinner('Pairing code ready.');
        } else {
          stopSpinner('Previous code invalidated. New code below.');
        }
        p.note(formatCodeCard(block.fields.CODE ?? '????'), 'Pairing code');
        s.start('Waiting for the code from Telegram…');
        spinnerActive = true;
      } else if (block.type === 'PAIR_TELEGRAM_ATTEMPT') {
        stopSpinner(`Received "${block.fields.CANDIDATE ?? '?'}" — doesn't match.`);
        s.start('Waiting for the correct code…');
        spinnerActive = true;
      } else if (block.type === 'PAIR_TELEGRAM') {
        if (block.fields.STATUS === 'success') {
          stopSpinner('Telegram paired.');
        } else {
          stopSpinner(`Pairing failed: ${block.fields.ERROR ?? 'unknown'}`, 1);
        }
      }
    },
    rawLog,
  );
  const durationMs = Date.now() - start;

  // Safety net: if the child died without emitting a terminal block, make
  // sure we don't leave the spinner running.
  if (spinnerActive) {
    stopSpinner(result.ok ? 'Done.' : 'Pairing exited unexpectedly.', result.ok ? 0 : 1);
    if (!result.ok) dumpTranscriptOnFailure(result.transcript);
  }

  writeStepEntry('pair-telegram', result, durationMs, rawLog);
  return { ...result, rawLog, durationMs };
}

async function askDisplayName(fallback: string): Promise<string> {
  const answer = ensureAnswer(
    await p.text({
      message: 'What should your agents call you?',
      placeholder: fallback,
      defaultValue: fallback,
    }),
  );
  const value = (answer as string).trim() || fallback;
  setupLog.userInput('display_name', value);
  return value;
}

async function askAgentName(fallback: string): Promise<string> {
  const answer = ensureAnswer(
    await p.text({
      message: 'What should your messaging agent be called?',
      placeholder: fallback,
      defaultValue: fallback,
    }),
  );
  const value = (answer as string).trim() || fallback;
  setupLog.userInput('agent_name', value);
  return value;
}

async function askChannelChoice(): Promise<'telegram' | 'skip'> {
  const choice = ensureAnswer(
    await p.select({
      message: 'Connect a messaging app so you can chat from your phone?',
      options: [
        { value: 'telegram', label: 'Telegram', hint: 'recommended' },
        { value: 'skip', label: 'Skip — use the CLI only' },
      ],
    }),
  );
  setupLog.userInput('channel_choice', String(choice));
  return choice as 'telegram' | 'skip';
}

async function collectTelegramToken(): Promise<string> {
  p.note(
    [
      '1. Open Telegram and message @BotFather',
      '2. Send: /newbot',
      '3. Follow the prompts (name + username ending in "bot")',
      '4. Copy the token it gives you (format: <digits>:<chars>)',
      '',
      k.dim('Optional, but recommended for groups:'),
      k.dim('    @BotFather → /mybots → Bot Settings → Group Privacy → OFF'),
    ].join('\n'),
    'Create a Telegram bot',
  );

  const answer = ensureAnswer(
    await p.password({
      message: 'Paste your bot token',
      validate: (v) => {
        if (!v || !v.trim()) return 'Token is required';
        if (!/^[0-9]+:[A-Za-z0-9_-]{35,}$/.test(v.trim())) {
          return 'Format looks wrong — expected <digits>:<chars>';
        }
        return undefined;
      },
    }),
  );
  const token = (answer as string).trim();
  setupLog.userInput(
    'telegram_token',
    `${token.slice(0, 12)}…${token.slice(-4)}`,
  );
  return token;
}

async function validateTelegramToken(token: string): Promise<string> {
  failingStep = 'telegram-validate';
  const s = p.spinner();
  const start = Date.now();
  s.start('Validating token with Telegram…');
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/getMe`);
    const data = (await res.json()) as {
      ok?: boolean;
      result?: { username?: string; id?: number };
      description?: string;
    };
    const elapsed = Math.round((Date.now() - start) / 1000);
    if (data.ok && data.result?.username) {
      const username = data.result.username;
      s.stop(`Bot is @${username}. ${k.dim(`(${elapsed}s)`)}`);
      setupLog.step(
        'telegram-validate',
        'success',
        Date.now() - start,
        { BOT_USERNAME: username, BOT_ID: data.result.id ?? '' },
      );
      return username;
    }
    const reason = data.description ?? 'token rejected by Telegram';
    s.stop(`Telegram rejected the token: ${reason}`, 1);
    setupLog.step(
      'telegram-validate',
      'failed',
      Date.now() - start,
      { ERROR: reason },
    );
    fail(
      'Telegram rejected the token.',
      'Double-check the token (copy it again from @BotFather) and retry.',
    );
  } catch (err) {
    const elapsed = Math.round((Date.now() - start) / 1000);
    s.stop(`Could not reach Telegram. ${k.dim(`(${elapsed}s)`)}`, 1);
    const message = err instanceof Error ? err.message : String(err);
    setupLog.step('telegram-validate', 'failed', Date.now() - start, {
      ERROR: message,
    });
    fail(
      'Telegram API unreachable.',
      'Check your network connection and retry.',
    );
  }
}

function printIntro(): void {
  const isReexec = process.env.NANOCLAW_REEXEC_SG === '1';
  const wordmark = `${k.bold('Nano')}${brandBold('Claw')}`;

  if (isReexec) {
    p.intro(`${brandChip(' setup:auto ')}  ${wordmark}  ${k.dim('· resuming under docker group')}`);
    return;
  }

  console.log();
  console.log(`  ${wordmark}`);
  console.log(`  ${k.dim('end-to-end scripted setup of your personal assistant')}`);
  p.intro(`${brandChip(' setup:auto ')}`);
}

async function main(): Promise<void> {
  printIntro();
  initProgressionLog();

  const skip = new Set(
    (process.env.NANOCLAW_SKIP ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );

  if (!skip.has('environment')) {
    const res = await runQuietStep(
      'environment',
      { running: 'Checking environment…', done: 'Environment OK.' },
    );
    if (!res.ok) fail('Environment check failed.');
  }

  if (!skip.has('container')) {
    const res = await runQuietStep('container', {
      running: 'Building the agent container image…',
      done: 'Container image ready.',
      failed: 'Container build failed.',
    });
    if (!res.ok) {
      const err = res.terminal?.fields.ERROR;
      if (err === 'runtime_not_available') {
        fail(
          'Docker is not available and could not be started automatically.',
          'Install Docker Desktop or start it manually, then retry.',
        );
      }
      if (err === 'docker_group_not_active') {
        fail(
          'Docker was just installed but your shell is not yet in the `docker` group.',
          'Log out and back in (or run `newgrp docker` in a new shell), then retry.',
        );
      }
      fail(
        'Container build/test failed.',
        'For stale cache: `docker builder prune -f`, then retry `pnpm run setup:auto`.',
      );
    }
    maybeReexecUnderSg();
  }

  if (!skip.has('onecli')) {
    const res = await runQuietStep('onecli', {
      running: 'Installing OneCLI credential vault…',
      done: 'OneCLI installed.',
    });
    if (!res.ok) {
      const err = res.terminal?.fields.ERROR;
      if (err === 'onecli_not_on_path_after_install') {
        fail(
          'OneCLI installed but not on PATH.',
          'Open a new shell or run `export PATH="$HOME/.local/bin:$PATH"`, then retry.',
        );
      }
      fail(
        `OneCLI install failed (${err ?? 'unknown'}).`,
        'Check that curl + a writable ~/.local/bin are available, then retry.',
      );
    }
  }

  if (!skip.has('auth')) {
    failingStep = 'auth';
    if (anthropicSecretExists()) {
      p.log.success('OneCLI already has an Anthropic secret — skipping.');
      setupLog.step('auth', 'skipped', 0, { REASON: 'secret-already-present' });
    } else {
      p.log.step('Registering your Anthropic credential…');
      console.log(
        k.dim('   (browser sign-in or paste a token/key — this part is interactive)'),
      );
      console.log();
      const start = Date.now();
      const code = await runInheritScript('bash', ['setup/register-claude-token.sh']);
      const durationMs = Date.now() - start;
      console.log();
      if (code !== 0) {
        setupLog.step('auth', 'failed', durationMs, { EXIT_CODE: code });
        fail(
          'Anthropic credential registration failed or was aborted.',
          'Re-run `bash setup/register-claude-token.sh` or handle via `/setup` §4.',
        );
      }
      setupLog.step('auth', 'interactive', durationMs, { METHOD: 'register-claude-token.sh' });
      p.log.success('Anthropic credential registered with OneCLI.');
    }
  }

  if (!skip.has('mounts')) {
    const res = await runQuietStep('mounts', {
      running: 'Writing mount allowlist…',
      done: 'Mount allowlist in place.',
      skipped: 'Mount allowlist already configured.',
    }, ['--empty']);
    if (!res.ok) fail('Mount allowlist step failed.');
  }

  if (!skip.has('service')) {
    const res = await runQuietStep('service', {
      running: 'Installing the background service…',
      done: 'Service installed and running.',
    });
    if (!res.ok) {
      fail(
        'Service install failed.',
        'Check logs/nanoclaw.error.log, or run `/setup` to iterate interactively.',
      );
    }
    if (res.terminal?.fields.DOCKER_GROUP_STALE === 'true') {
      p.log.warn('Docker group stale in systemd session.');
      p.log.message(
        k.dim(
          '  sudo setfacl -m u:$(whoami):rw /var/run/docker.sock\n' +
            '  systemctl --user restart nanoclaw',
        ),
      );
    }
  }

  let displayName: string | undefined;
  const needsDisplayName = !skip.has('cli-agent') || !skip.has('channel');
  if (needsDisplayName) {
    const fallback = process.env.USER?.trim() || 'Operator';
    const preset = process.env.NANOCLAW_DISPLAY_NAME?.trim();
    displayName = preset || (await askDisplayName(fallback));
  }

  if (!skip.has('cli-agent')) {
    const res = await runQuietStep(
      'cli-agent',
      {
        running: 'Wiring the terminal agent…',
        done: 'Terminal agent wired (try `pnpm run chat hi`).',
      },
      ['--display-name', displayName!, '--agent-name', CLI_AGENT_NAME],
    );
    if (!res.ok) {
      fail(
        'CLI agent wiring failed.',
        `Re-run \`pnpm exec tsx scripts/init-cli-agent.ts --display-name "${displayName!}" --agent-name "${CLI_AGENT_NAME}"\` to fix.`,
      );
    }
  }

  if (!skip.has('channel')) {
    const choice = await askChannelChoice();
    if (choice === 'telegram') {
      const token = await collectTelegramToken();
      const botUsername = await validateTelegramToken(token);

      const install = await runQuietChild(
        'telegram-install',
        'bash',
        ['setup/add-telegram.sh'],
        {
          running: `Installing Telegram adapter and wiring @${botUsername}…`,
          done: `Telegram adapter ready.`,
        },
        {
          env: { TELEGRAM_BOT_TOKEN: token },
          extraFields: { BOT_USERNAME: botUsername },
        },
      );
      if (!install.ok) {
        fail(
          'Telegram install failed.',
          'Check the raw log under logs/setup-steps/, then retry `pnpm run setup:auto`.',
        );
      }

      const pair = await runPairTelegram();
      if (!pair.ok) {
        fail(
          'Telegram pairing failed.',
          'Re-run `pnpm exec tsx setup/index.ts --step pair-telegram -- --intent main`.',
        );
      }

      const platformId = pair.terminal?.fields.PLATFORM_ID;
      const pairedUserId = pair.terminal?.fields.PAIRED_USER_ID;
      if (!platformId || !pairedUserId) {
        fail(
          'pair-telegram succeeded but did not return PLATFORM_ID and PAIRED_USER_ID.',
          'Re-run `pnpm exec tsx setup/index.ts --step pair-telegram -- --intent main` and capture the success block.',
        );
      }

      const agentName =
        process.env.NANOCLAW_AGENT_NAME?.trim() ||
        (await askAgentName(DEFAULT_AGENT_NAME));

      const init = await runQuietChild(
        'init-first-agent',
        'pnpm',
        [
          'exec', 'tsx', 'scripts/init-first-agent.ts',
          '--channel', 'telegram',
          '--user-id', pairedUserId,
          '--platform-id', platformId,
          '--display-name', displayName!,
          '--agent-name', agentName,
        ],
        {
          running: `Wiring ${agentName} to your Telegram chat…`,
          done: `${agentName} is wired — welcome DM incoming.`,
        },
        {
          extraFields: { CHANNEL: 'telegram', AGENT_NAME: agentName, PLATFORM_ID: platformId },
        },
      );
      if (!init.ok) {
        fail(
          'Wiring the Telegram agent failed.',
          `Re-run \`pnpm exec tsx scripts/init-first-agent.ts --channel telegram --user-id "${pairedUserId}" --platform-id "${platformId}" --display-name "${displayName!}" --agent-name "${agentName}"\`.`,
        );
      }
    } else {
      p.log.info('No messaging channel wired — you can add one later with `/add-<channel>`.');
    }
  }

  if (!skip.has('verify')) {
    const res = await runQuietStep('verify', {
      running: 'Verifying the install…',
      done: 'Install verified.',
      failed: 'Verification found issues.',
    });
    if (!res.ok) {
      const notes: string[] = [];
      if (res.terminal?.fields.CREDENTIALS !== 'configured') {
        notes.push('• Anthropic secret not detected — re-run `bash setup/register-claude-token.sh`.');
      }
      const agentPing = res.terminal?.fields.AGENT_PING;
      if (agentPing && agentPing !== 'ok' && agentPing !== 'skipped') {
        notes.push(
          `• CLI agent did not reply (status: ${agentPing}). ` +
            'Check `logs/nanoclaw.log` and `groups/*/logs/container-*.log`, then try `pnpm run chat hi`.',
        );
      }
      if (!res.terminal?.fields.CONFIGURED_CHANNELS) {
        notes.push('• Optional: add a messaging channel — `/add-discord`, `/add-slack`, `/add-telegram`, …');
      }
      if (notes.length > 0) {
        p.note(notes.join('\n'), 'What’s left');
      }
      p.outro(k.yellow('Scripted steps done — some pieces still need you.'));
      return;
    }
  }

  const nextSteps = [
    `${k.cyan('Chat from the CLI:')}     pnpm run chat hi`,
    `${k.cyan('Tail host logs:')}        tail -f logs/nanoclaw.log`,
    `${k.cyan('Open Claude Code:')}      claude`,
  ].join('\n');
  p.note(nextSteps, 'Next steps');
  setupLog.complete(Date.now() - RUN_START);
  p.outro(k.green('Setup complete.'));
}

/**
 * Bootstrap (nanoclaw.sh) normally initializes logs/setup.log and writes
 * the bootstrap entry before we even boot. If someone runs `pnpm run
 * setup:auto` directly, start a fresh progression log here so we don't
 * append to a stale one from a previous run.
 */
function initProgressionLog(): void {
  if (process.env.NANOCLAW_BOOTSTRAPPED === '1') return;
  let commit = '';
  try {
    commit = spawnSync('git', ['rev-parse', '--short', 'HEAD'], {
      encoding: 'utf-8',
    }).stdout.trim();
  } catch {
    // git not available or not a repo — skip
  }
  let branch = '';
  try {
    branch = spawnSync('git', ['branch', '--show-current'], {
      encoding: 'utf-8',
    }).stdout.trim();
  } catch {
    // skip
  }
  setupLog.reset({
    invocation: 'setup:auto (standalone)',
    user: process.env.USER ?? 'unknown',
    cwd: process.cwd(),
    branch: branch || 'unknown',
    commit: commit || 'unknown',
  });
}

main().catch((err) => {
  p.log.error(err instanceof Error ? err.message : String(err));
  p.cancel('Setup aborted.');
  process.exit(1);
});
