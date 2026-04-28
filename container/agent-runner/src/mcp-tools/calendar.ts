/**
 * Calendar MCP tools — read/write events in the host's calendar.db.
 *
 * The DB is mounted at /workspace/extra/data/calendar.db (read-write).
 * Schema is owned by the host's Python tooling — do not ALTER it here.
 *
 * Overlap semantics: an event overlaps [range_start, range_end) iff
 *   event.start < range_end AND event.end > range_start
 * SQL uses datetime() to normalize ISO-8601-with-offset strings to UTC
 * for correct comparison regardless of the offset stored in each row.
 */
import { Database } from 'bun:sqlite';

import { TIMEZONE, parseZonedToUtc } from '../timezone.js';
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

const DB_PATH = '/workspace/extra/data/calendar.db';

interface EventRow {
  id: number;
  title: string;
  start: string;
  end: string;
  description: string | null;
  location: string | null;
  source: string;
  external_id: string | null;
  created_at: string;
}

let _db: Database | null = null;
function db(): Database {
  if (!_db) {
    _db = new Database(DB_PATH);
    _db.exec('PRAGMA busy_timeout = 5000');
    _db.exec('PRAGMA foreign_keys = ON');
  }
  return _db;
}

function ok(payload: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }] };
}
function err(text: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${text}` }], isError: true };
}

function normalizeRow(r: EventRow): EventRow {
  return {
    id: r.id,
    title: r.title,
    start: r.start,
    end: r.end,
    description: r.description ?? null,
    location: r.location ?? null,
    source: r.source,
    external_id: r.external_id ?? null,
    created_at: r.created_at,
  };
}

/** Compute [start, end) in UTC ISO for a YYYY-MM-DD local date in user TZ. */
function localDayBoundsUtc(dateStr: string): { startUtc: string; endUtc: string } {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    throw new Error(`date must be YYYY-MM-DD, got: ${dateStr}`);
  }
  const startLocal = `${dateStr}T00:00:00`;
  const startUtc = parseZonedToUtc(startLocal, TIMEZONE);
  const endUtc = new Date(startUtc.getTime() + 24 * 60 * 60 * 1000);
  return { startUtc: startUtc.toISOString(), endUtc: endUtc.toISOString() };
}

/** Today's date as YYYY-MM-DD in user TZ. */
function todayLocalDateString(): string {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return fmt.format(new Date());
}

function selectOverlapping(rangeStartIso: string | null, rangeEndIso: string | null): EventRow[] {
  const clauses: string[] = [];
  const params: Record<string, string> = {};
  if (rangeEndIso !== null) {
    clauses.push('datetime(start) < datetime($rangeEnd)');
    params.$rangeEnd = rangeEndIso;
  }
  if (rangeStartIso !== null) {
    clauses.push('datetime(end) > datetime($rangeStart)');
    params.$rangeStart = rangeStartIso;
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const sql = `SELECT id, title, start, end, description, location, source, external_id, created_at
               FROM events ${where} ORDER BY datetime(start) ASC, id ASC`;
  const stmt = db().query(sql);
  const rows = (clauses.length ? stmt.all(params) : stmt.all()) as EventRow[];
  return rows.map(normalizeRow);
}

function validateIso(label: string, value: string): string {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw new Error(`${label} is not a valid ISO 8601 timestamp: ${value}`);
  return value;
}

function validateStartBeforeEnd(start: string, end: string): void {
  const s = new Date(start).getTime();
  const e = new Date(end).getTime();
  if (!(s < e)) throw new Error(`start must be before end (got start=${start}, end=${end})`);
}

export const eventsToday: McpToolDefinition = {
  tool: {
    name: 'calendar_events_today',
    description: 'List calendar events for today (user-local timezone), ordered by start time.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  async handler() {
    try {
      const { startUtc, endUtc } = localDayBoundsUtc(todayLocalDateString());
      return ok(selectOverlapping(startUtc, endUtc));
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e));
    }
  },
};

export const eventsForDate: McpToolDefinition = {
  tool: {
    name: 'calendar_events_for_date',
    description: 'List calendar events overlapping a specific local-date (YYYY-MM-DD), ordered by start time.',
    inputSchema: {
      type: 'object' as const,
      properties: { date: { type: 'string', description: 'YYYY-MM-DD (interpreted in user timezone)' } },
      required: ['date'],
    },
  },
  async handler(args) {
    try {
      const date = String(args.date ?? '');
      const { startUtc, endUtc } = localDayBoundsUtc(date);
      return ok(selectOverlapping(startUtc, endUtc));
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e));
    }
  },
};

export const eventsInRange: McpToolDefinition = {
  tool: {
    name: 'calendar_events_in_range',
    description:
      'List events overlapping [start, end). Either bound may be omitted for an open-ended range. Bounds are ISO 8601 timestamps (any offset).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        start: { type: 'string', description: 'ISO 8601 lower bound (inclusive of overlap). Optional.' },
        end: { type: 'string', description: 'ISO 8601 upper bound (exclusive of overlap). Optional.' },
      },
    },
  },
  async handler(args) {
    try {
      const start = args.start != null && args.start !== '' ? validateIso('start', String(args.start)) : null;
      const end = args.end != null && args.end !== '' ? validateIso('end', String(args.end)) : null;
      return ok(selectOverlapping(start, end));
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e));
    }
  },
};

export const addEvent: McpToolDefinition = {
  tool: {
    name: 'calendar_add_event',
    description:
      'Create a calendar event. start/end are ISO 8601 timestamps with timezone. source is set to "agent" automatically.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        title: { type: 'string' },
        start: { type: 'string', description: 'ISO 8601 with timezone' },
        end: { type: 'string', description: 'ISO 8601 with timezone' },
        description: { type: 'string' },
        location: { type: 'string' },
      },
      required: ['title', 'start', 'end'],
    },
  },
  async handler(args) {
    try {
      const title = String(args.title ?? '').trim();
      if (!title) throw new Error('title must be non-empty');
      const start = validateIso('start', String(args.start ?? ''));
      const end = validateIso('end', String(args.end ?? ''));
      validateStartBeforeEnd(start, end);
      const description = args.description != null ? String(args.description) : null;
      const location = args.location != null ? String(args.location) : null;
      const createdAt = new Date().toISOString();

      const result = db()
        .query(
          `INSERT INTO events (title, start, end, description, location, source, external_id, created_at)
           VALUES ($title, $start, $end, $description, $location, 'agent', NULL, $createdAt)`,
        )
        .run({ $title: title, $start: start, $end: end, $description: description, $location: location, $createdAt: createdAt });
      return ok({ id: Number(result.lastInsertRowid) });
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e));
    }
  },
};

export const updateEvent: McpToolDefinition = {
  tool: {
    name: 'calendar_update_event',
    description: 'Update one or more fields of an event by id. Only fields supplied are changed.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'integer' },
        title: { type: 'string' },
        start: { type: 'string' },
        end: { type: 'string' },
        description: { type: 'string' },
        location: { type: 'string' },
      },
      required: ['id'],
    },
  },
  async handler(args) {
    try {
      const id = Number(args.id);
      if (!Number.isInteger(id) || id <= 0) throw new Error('id must be a positive integer');

      const existing = db()
        .query(`SELECT id, title, start, end, description, location, source, external_id, created_at FROM events WHERE id = $id`)
        .get({ $id: id }) as EventRow | null;
      if (!existing) throw new Error(`event ${id} not found`);

      const updates: string[] = [];
      const params: Record<string, unknown> = { $id: id };

      let nextStart = existing.start;
      let nextEnd = existing.end;

      if (args.title !== undefined) {
        const title = String(args.title).trim();
        if (!title) throw new Error('title must be non-empty');
        updates.push('title = $title');
        params.$title = title;
      }
      if (args.start !== undefined) {
        nextStart = validateIso('start', String(args.start));
        updates.push('start = $start');
        params.$start = nextStart;
      }
      if (args.end !== undefined) {
        nextEnd = validateIso('end', String(args.end));
        updates.push('end = $end');
        params.$end = nextEnd;
      }
      if (args.start !== undefined || args.end !== undefined) {
        validateStartBeforeEnd(nextStart, nextEnd);
      }
      if (args.description !== undefined) {
        updates.push('description = $description');
        params.$description = args.description === null ? null : String(args.description);
      }
      if (args.location !== undefined) {
        updates.push('location = $location');
        params.$location = args.location === null ? null : String(args.location);
      }

      if (updates.length === 0) return ok({ updated: false, reason: 'no fields supplied' });

      db().query(`UPDATE events SET ${updates.join(', ')} WHERE id = $id`).run(params);
      return ok({ updated: true, id });
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e));
    }
  },
};

export const deleteEvent: McpToolDefinition = {
  tool: {
    name: 'calendar_delete_event',
    description: 'Delete an event by id. Throws if the event does not exist.',
    inputSchema: {
      type: 'object' as const,
      properties: { id: { type: 'integer' } },
      required: ['id'],
    },
  },
  async handler(args) {
    try {
      const id = Number(args.id);
      if (!Number.isInteger(id) || id <= 0) throw new Error('id must be a positive integer');
      const result = db().query(`DELETE FROM events WHERE id = $id`).run({ $id: id });
      if (result.changes === 0) throw new Error(`event ${id} not found`);
      return ok({ deleted: true, id });
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e));
    }
  },
};

registerTools([eventsToday, eventsForDate, eventsInRange, addEvent, updateEvent, deleteEvent]);
