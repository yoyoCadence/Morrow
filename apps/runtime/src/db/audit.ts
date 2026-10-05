import type { Queryable } from './pool.js';

export interface AuditEntry {
  /** Who acted: a component such as `worker`, or `operator` for CLI commands. */
  readonly actor: string;
  /** Dotted action name, for example `session.started`. */
  readonly action: string;
  readonly subject?: string;
  /** Must not contain secrets. */
  readonly detail?: Record<string, unknown>;
  readonly runSessionId?: string | null;
}

/** Appends to the audit log. Pass the transaction client so the entry commits with the change it describes. */
export async function writeAudit(db: Queryable, entry: AuditEntry): Promise<void> {
  await db.query(
    'INSERT INTO audit_log (actor, action, subject, detail, run_session_id) VALUES ($1, $2, $3, $4::jsonb, $5)',
    [entry.actor, entry.action, entry.subject ?? null, JSON.stringify(entry.detail ?? {}), entry.runSessionId ?? null],
  );
}
