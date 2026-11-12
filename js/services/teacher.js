// Teacher module: classes, join codes and class progress reports.
import { need } from './errors.js';
import { hashPassword, makeJoinCode } from './crypto.js';
import { validatePassword } from './auth.js';
import { moduleStatus } from './progress.js';

export const LEVELS = ['JSS1', 'JSS2', 'JSS3', 'SS1', 'SS2', 'SS3'];

export function listClasses(db, teacherId) {
  return db.all(`SELECT c.*, (SELECT COUNT(*) FROM users u WHERE u.class_id = c.class_id AND u.role = 'student') AS students
    FROM classes c WHERE c.teacher_id = ? ORDER BY c.level, c.name`, [teacherId]);
}

export async function createClass(db, teacherId, { name, level }) {
  name = (name || '').trim();
  need(name, 'Enter a class name.', 'name');
  need(name.length <= 40, 'Class name must be 40 characters or fewer.', 'name');
  need(LEVELS.includes(level), 'Choose a class level.', 'level');
  const t = db.get('SELECT school_id FROM users WHERE user_id = ?', [teacherId]);
  need(!db.get('SELECT 1 FROM classes WHERE teacher_id = ? AND name = ? COLLATE NOCASE', [teacherId, name]), 'You already have a class with that name.', 'name');
  let code;
  do code = makeJoinCode(); while (db.get('SELECT 1 FROM classes WHERE join_code = ?', [code]));
  const id = await db.tx(d => d.run('INSERT INTO classes (school_id, teacher_id, name, level, join_code) VALUES (?,?,?,?,?)',
    [t.school_id, teacherId, name, level, code]).lastId);
  return db.get('SELECT * FROM classes WHERE class_id = ?', [id]);
}

// Per-student completion and best score for each module, plus class averages.
export function classReport(db, teacherId, classId) {
  const cls = db.get('SELECT * FROM classes WHERE class_id = ? AND teacher_id = ?', [Number(classId), teacherId]);
  need(cls, 'That class was not found.');
  const students = db.all(`SELECT user_id, full_name, username, last_login FROM users
    WHERE class_id = ? AND role = 'student' ORDER BY full_name`, [cls.class_id]);
  let modules = [];
  for (const s of students) {
    const ms = moduleStatus(db, s.user_id);
    modules = ms.map(m => ({ module_id: m.module_id, title: m.title, slug: m.slug }));
    s.modules = ms.map(m => ({ completion: m.completion, best: m.best, passed: m.passed, attempts: m.attempts }));
    s.overall = ms.length ? Math.round(ms.reduce((t, m) => t + m.completion, 0) / ms.length) : 0;
    s.started = ms.some(m => m.done_lessons > 0 || m.attempts > 0);
  }
  if (!students.length) modules = db.all('SELECT module_id, title, slug FROM modules WHERE is_published = 1 ORDER BY sequence_no');
  const averages = modules.map((m, i) => {
    const active = students.filter(s => s.modules[i].completion > 0 || s.modules[i].attempts > 0);
    const scored = students.filter(s => s.modules[i].best != null);
    return {
      completion: active.length ? Math.round(active.reduce((t, s) => t + s.modules[i].completion, 0) / active.length) : null,
      best: scored.length ? Math.round(scored.reduce((t, s) => t + s.modules[i].best, 0) / scored.length) : null,
      passed: students.filter(s => s.modules[i].passed).length,
    };
  });
  return { cls, modules, students, averages, notStarted: students.filter(s => !s.started).length };
}

// Sets a new password for a student in one of this teacher's classes.
export async function resetStudentPassword(db, teacherId, studentId, password) {
  const s = db.get(`SELECT u.user_id FROM users u JOIN classes c ON c.class_id = u.class_id
    WHERE u.user_id = ? AND u.role = 'student' AND c.teacher_id = ?`, [Number(studentId), teacherId]);
  need(s, 'That student is not in one of your classes.');
  validatePassword(password);
  const hash = await hashPassword(password);
  await db.tx(d => d.run('UPDATE users SET password_hash = ? WHERE user_id = ?', [hash, s.user_id]));
}

const csvCell = v => {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@]/.test(s)) s = "'" + s; // stop spreadsheet formula injection
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function reportCsv(report) {
  const head = ['Name', 'Username', ...report.modules.flatMap(m => [`${m.title} completion %`, `${m.title} best score %`]), 'Overall completion %', 'Last login'];
  const rows = report.students.map(s => [s.full_name, s.username, ...s.modules.flatMap(m => [m.completion, m.best ?? '']), s.overall, s.last_login ?? '']);
  return [head, ...rows].map(r => r.map(csvCell).join(',')).join('\r\n');
}
