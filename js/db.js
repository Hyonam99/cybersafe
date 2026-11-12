// Database module: opens the SQLite database, creates the tables on first run,
// seeds them from data/seed.json, and saves the database to the device.
import { hashPassword } from './services/crypto.js';

export const SCHEMA_VERSION = 1;

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS schools (
  school_id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  state TEXT NOT NULL,
  lga TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS users (
  user_id INTEGER PRIMARY KEY AUTOINCREMENT,
  full_name TEXT NOT NULL,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('student','teacher','admin')),
  class_id INTEGER REFERENCES classes(class_id),
  school_id INTEGER REFERENCES schools(school_id),
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  last_login DATETIME
);
CREATE TABLE IF NOT EXISTS classes (
  class_id INTEGER PRIMARY KEY AUTOINCREMENT,
  school_id INTEGER NOT NULL REFERENCES schools(school_id),
  teacher_id INTEGER NOT NULL REFERENCES users(user_id),
  name TEXT NOT NULL,
  level TEXT NOT NULL CHECK (level IN ('JSS1','JSS2','JSS3','SS1','SS2','SS3')),
  join_code TEXT NOT NULL UNIQUE
);
CREATE TABLE IF NOT EXISTS modules (
  module_id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  description TEXT,
  sequence_no INTEGER NOT NULL,
  pass_mark INTEGER NOT NULL DEFAULT 70,
  is_published INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS lessons (
  lesson_id INTEGER PRIMARY KEY AUTOINCREMENT,
  module_id INTEGER NOT NULL REFERENCES modules(module_id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  sequence_no INTEGER NOT NULL,
  est_minutes INTEGER DEFAULT 5
);
CREATE TABLE IF NOT EXISTS scenarios (
  scenario_id INTEGER PRIMARY KEY AUTOINCREMENT,
  lesson_id INTEGER NOT NULL REFERENCES lessons(lesson_id) ON DELETE CASCADE,
  prompt TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS scenario_options (
  option_id INTEGER PRIMARY KEY AUTOINCREMENT,
  scenario_id INTEGER NOT NULL REFERENCES scenarios(scenario_id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  is_best INTEGER NOT NULL DEFAULT 0,
  feedback TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS questions (
  question_id INTEGER PRIMARY KEY AUTOINCREMENT,
  module_id INTEGER NOT NULL REFERENCES modules(module_id) ON DELETE CASCADE,
  question_text TEXT NOT NULL,
  explanation TEXT,
  difficulty INTEGER CHECK (difficulty BETWEEN 1 AND 3)
);
CREATE TABLE IF NOT EXISTS options (
  option_id INTEGER PRIMARY KEY AUTOINCREMENT,
  question_id INTEGER NOT NULL REFERENCES questions(question_id) ON DELETE CASCADE,
  option_text TEXT NOT NULL,
  is_correct INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS quiz_attempts (
  attempt_id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(user_id),
  module_id INTEGER NOT NULL REFERENCES modules(module_id),
  score INTEGER,
  total INTEGER,
  percentage REAL,
  passed INTEGER,
  started_at DATETIME NOT NULL,
  submitted_at DATETIME
);
CREATE TABLE IF NOT EXISTS attempt_answers (
  answer_id INTEGER PRIMARY KEY AUTOINCREMENT,
  attempt_id INTEGER NOT NULL REFERENCES quiz_attempts(attempt_id) ON DELETE CASCADE,
  question_id INTEGER NOT NULL REFERENCES questions(question_id),
  option_id INTEGER REFERENCES options(option_id),
  is_correct INTEGER
);
CREATE TABLE IF NOT EXISTS lesson_progress (
  progress_id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(user_id),
  lesson_id INTEGER NOT NULL REFERENCES lessons(lesson_id) ON DELETE CASCADE,
  completed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (user_id, lesson_id)
);
CREATE TABLE IF NOT EXISTS badges (
  badge_id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT,
  criteria TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS user_badges (
  user_id INTEGER NOT NULL REFERENCES users(user_id),
  badge_id INTEGER NOT NULL REFERENCES badges(badge_id),
  awarded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, badge_id)
);
`;

// Thin wrapper over a sql.js Database. Every query uses prepared statements.
export class Db {
  constructor(sqlDb, storage) {
    this.raw = sqlDb;
    this.storage = storage;
    this.raw.run('PRAGMA foreign_keys = ON;');
  }
  all(sql, params = []) {
    const st = this.raw.prepare(sql);
    try {
      st.bind(params);
      const rows = [];
      while (st.step()) rows.push(st.getAsObject());
      return rows;
    } finally { st.free(); }
  }
  get(sql, params = []) { return this.all(sql, params)[0] || null; }
  run(sql, params = []) {
    const st = this.raw.prepare(sql);
    try { st.run(params); } finally { st.free(); }
    return { lastId: this.raw.exec('SELECT last_insert_rowid()')[0].values[0][0], changes: this.raw.getRowsModified() };
  }
  // Runs fn inside a transaction, then saves the database to the device.
  async tx(fn) {
    this.raw.run('BEGIN');
    let out;
    try { out = await fn(this); this.raw.run('COMMIT'); }
    catch (e) { this.raw.run('ROLLBACK'); throw e; }
    await this.save();
    return out;
  }
  async save() { if (this.storage) await this.storage.save(this.raw.export()); }
}

export const now = () => new Date().toISOString().replace('T', ' ').slice(0, 19);

// Opens the saved database, or creates and seeds a new one.
export async function openDatabase({ SQL, storage, loadSeed }) {
  const bytes = storage ? await storage.load() : null;
  if (bytes) {
    const db = new Db(new SQL.Database(bytes), storage);
    const v = db.get('PRAGMA user_version');
    if (v && v.user_version === SCHEMA_VERSION) return db;
  }
  const db = new Db(new SQL.Database(), storage);
  db.raw.run(SCHEMA);
  db.raw.run(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  await seed(db, await loadSeed());
  return db;
}

export async function seed(db, data) {
  const demoHash = await hashPassword(data.users[0].password);
  const hashes = {};
  for (const u of data.users) hashes[u.username] = u.password === data.users[0].password ? demoHash : await hashPassword(u.password);
  await db.tx(d => {
    const school = {}, cls = {}, user = {}, mod = {};
    for (const s of data.schools) school[s.key] = d.run('INSERT INTO schools (name, state, lga) VALUES (?,?,?)', [s.name, s.state, s.lga]).lastId;
    const insUser = (u, hash, classId) => d.run(
      'INSERT INTO users (full_name, username, password_hash, role, class_id, school_id) VALUES (?,?,?,?,?,?)',
      [u.full_name, u.username, hash, u.role, classId ?? null, school[u.school] ?? school.demo]).lastId;
    for (const u of data.users.filter(u => u.role !== 'student')) user[u.username] = insUser(u, hashes[u.username]);
    for (const c of data.classes) cls[c.name] = d.run('INSERT INTO classes (school_id, teacher_id, name, level, join_code) VALUES (?,?,?,?,?)',
      [school[c.school], user[c.teacher], c.name, c.level, c.join_code]).lastId;
    for (const u of data.users.filter(u => u.role === 'student')) user[u.username] = insUser(u, hashes[u.username], cls[u.class]);

    for (const m of data.modules) {
      const mid = mod[m.slug] = d.run('INSERT INTO modules (title, slug, description, sequence_no, pass_mark, is_published) VALUES (?,?,?,?,?,1)',
        [m.title, m.slug, m.description, m.sequence_no, m.pass_mark]).lastId;
      const lessonIds = m.lessons.map((l, i) => d.run('INSERT INTO lessons (module_id, title, content, sequence_no, est_minutes) VALUES (?,?,?,?,?)',
        [mid, l.title, l.content, i + 1, l.est_minutes]).lastId);
      if (m.scenario) {
        const sid = d.run('INSERT INTO scenarios (lesson_id, prompt) VALUES (?,?)', [lessonIds[m.scenario.lesson_index], m.scenario.prompt]).lastId;
        for (const o of m.scenario.options) d.run('INSERT INTO scenario_options (scenario_id, text, is_best, feedback) VALUES (?,?,?,?)', [sid, o.text, o.is_best ? 1 : 0, o.feedback]);
      }
      for (const q of m.questions) {
        const qid = d.run('INSERT INTO questions (module_id, question_text, explanation, difficulty) VALUES (?,?,?,?)', [mid, q.q, q.explanation, q.difficulty]).lastId;
        q.options.forEach((o, i) => d.run('INSERT INTO options (question_id, option_text, is_correct) VALUES (?,?,?)', [qid, o, i === q.answer ? 1 : 0]));
      }
    }
    for (const b of data.badges) d.run('INSERT INTO badges (code, name, description, criteria) VALUES (?,?,?,?)', [b.code, b.name, b.description, b.criteria]);

    // Sample class activity so the teacher dashboard has something to show.
    // Timestamps are spread over the past few weeks, oldest first, ending before today.
    const students = data.demo_students || [];
    let step = students.reduce((t, s) => t + 1 + Object.values(s.progress).reduce((a, p) => a + p.lessons + p.scores.length, 0), 0);
    const gap = 21 * 86400000 / Math.max(step, 1);
    const stamp = () => { const t = new Date(Date.now() - step-- * gap); return t.toISOString().replace('T', ' ').slice(0, 19); };
    for (const s of students) {
      const uid = insUser({ ...s, role: 'student', school: 'demo' }, demoHash, cls[s.class]);
      for (const [slug, p] of Object.entries(s.progress)) {
        const mid = mod[slug];
        d.all('SELECT lesson_id FROM lessons WHERE module_id=? ORDER BY sequence_no LIMIT ?', [mid, p.lessons])
          .forEach(l => d.run('INSERT INTO lesson_progress (user_id, lesson_id, completed_at) VALUES (?,?,?)', [uid, l.lesson_id, stamp()]));
        for (const pct of p.scores) {
          const t = stamp();
          d.run('INSERT INTO quiz_attempts (user_id, module_id, score, total, percentage, passed, started_at, submitted_at) VALUES (?,?,?,?,?,?,?,?)',
            [uid, mid, pct / 10, 10, pct, pct >= 70 ? 1 : 0, t, t]);
        }
      }
      d.run('UPDATE users SET last_login=? WHERE user_id=?', [stamp(), uid]);
    }
  });
  // Award badges the sample students have earned.
  const { refreshBadges } = await import('./services/progress.js');
  for (const s of db.all("SELECT user_id FROM users WHERE role='student'")) await refreshBadges(db, s.user_id);
}
