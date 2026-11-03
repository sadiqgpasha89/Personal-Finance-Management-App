import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export interface Conversation { id: string; title: string; created_at: string; updated_at: string; messages: number }
export interface Msg { id: number; role: 'user' | 'assistant'; content: string; plan: any | null; tools: string[]; engine: string | null; created_at: string }

/**
 * The assistant's own SQLite file: conversations and messages, scoped per user. Chat history never mixes with the ledger database.
 * Retention is bounded (old conversations are pruned) and users can delete any or all of it.
 */
export class ConvStore {
  db: DatabaseSync;
  constructor(file: string) {
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file); this.db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;');
    this.db.exec(`CREATE TABLE IF NOT EXISTS conversations(id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, title TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')));
      CREATE TABLE IF NOT EXISTS messages(id INTEGER PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE, role TEXT NOT NULL CHECK(role IN ('user','assistant')), content TEXT NOT NULL, plan_json TEXT, tools_json TEXT, engine TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')));
      CREATE INDEX IF NOT EXISTS conv_user ON conversations(user_id, updated_at DESC); CREATE INDEX IF NOT EXISTS msg_conv ON messages(conversation_id, id);`);
  }
  private owned(user: number, id: string) { return this.db.prepare('SELECT * FROM conversations WHERE id=? AND user_id=?').get(id, user) as any; }
  create(user: number, firstMessage: string): string { const id = randomUUID(); this.db.prepare('INSERT INTO conversations(id,user_id,title) VALUES(?,?,?)').run(id, user, firstMessage.replace(/\s+/g, ' ').trim().slice(0, 60) || 'New chat'); return id; }
  has(user: number, id: string) { return !!this.owned(user, id); }
  add(user: number, id: string, m: { role: 'user' | 'assistant'; content: string; plan?: unknown; tools?: string[]; engine?: string }) {
    if (!this.owned(user, id)) throw new Error('Unknown conversation');
    this.db.prepare('INSERT INTO messages(conversation_id,role,content,plan_json,tools_json,engine) VALUES(?,?,?,?,?,?)').run(id, m.role, m.content, m.plan ? JSON.stringify(m.plan) : null, m.tools ? JSON.stringify(m.tools) : null, m.engine ?? null);
    this.db.prepare("UPDATE conversations SET updated_at=datetime('now') WHERE id=?").run(id);
  }
  messages(user: number, id: string, limit = 200): Msg[] | null {
    if (!this.owned(user, id)) return null;
    return (this.db.prepare('SELECT * FROM (SELECT * FROM messages WHERE conversation_id=? ORDER BY id DESC LIMIT ?) ORDER BY id').all(id, limit) as any[]).map((r) => ({ id: r.id, role: r.role, content: r.content, plan: r.plan_json ? JSON.parse(r.plan_json) : null, tools: r.tools_json ? JSON.parse(r.tools_json) : [], engine: r.engine, created_at: r.created_at }));
  }
  list(user: number, limit = 100): Conversation[] { return this.db.prepare('SELECT c.id,c.title,c.created_at,c.updated_at,(SELECT COUNT(*) FROM messages m WHERE m.conversation_id=c.id) messages FROM conversations c WHERE c.user_id=? ORDER BY c.updated_at DESC, c.rowid DESC LIMIT ?').all(user, limit) as any; }
  rename(user: number, id: string, title: string) { if (!this.owned(user, id)) return false; this.db.prepare('UPDATE conversations SET title=? WHERE id=?').run(title.trim().slice(0, 80) || 'Chat', id); return true; }
  remove(user: number, id: string) { if (!this.owned(user, id)) return false; this.db.prepare('DELETE FROM conversations WHERE id=?').run(id); return true; }
  removeAll(user: number) { return Number(this.db.prepare('DELETE FROM conversations WHERE user_id=?').run(user).changes); }
  /** Drops conversations idle for longer than `days`, and keeps at most `maxPerUser` per user. */
  prune(days: number, maxPerUser = 200) {
    let n = Number(this.db.prepare("DELETE FROM conversations WHERE updated_at < datetime('now', ?)").run(`-${days} days`).changes);
    for (const u of this.db.prepare('SELECT user_id FROM conversations GROUP BY user_id HAVING COUNT(*) > ?').all(maxPerUser) as any[])
      n += Number(this.db.prepare('DELETE FROM conversations WHERE user_id=? AND id NOT IN (SELECT id FROM conversations WHERE user_id=? ORDER BY updated_at DESC LIMIT ?)').run(u.user_id, u.user_id, maxPerUser).changes);
    return n;
  }
  close() { this.db.close(); }
}
