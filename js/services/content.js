// Content module: modules, lessons and scenarios in sequence.
import { need } from './errors.js';
import { moduleStatus, refreshBadges } from './progress.js';

export const listModules = moduleStatus;

function unlockedModule(db, userId, where, param) {
  const m = moduleStatus(db, userId).find(x => x[where] === param);
  need(m, 'That module was not found.');
  need(m.unlocked, `Pass the previous module's quiz to unlock "${m.title}".`);
  return m;
}

export function getModule(db, userId, slug) {
  const m = unlockedModule(db, userId, 'slug', slug);
  m.lessons = db.all(`SELECT l.lesson_id, l.title, l.sequence_no, l.est_minutes,
      EXISTS (SELECT 1 FROM lesson_progress p WHERE p.lesson_id = l.lesson_id AND p.user_id = ?) AS completed
    FROM lessons l WHERE l.module_id = ? ORDER BY l.sequence_no`, [userId, m.module_id]);
  return m;
}

export function getLesson(db, userId, lessonId) {
  const l = db.get('SELECT * FROM lessons WHERE lesson_id = ?', [Number(lessonId)]);
  need(l, 'That lesson was not found.');
  const m = unlockedModule(db, userId, 'module_id', l.module_id);
  const siblings = db.all('SELECT lesson_id, title FROM lessons WHERE module_id = ? ORDER BY sequence_no', [l.module_id]);
  const i = siblings.findIndex(s => s.lesson_id === l.lesson_id);
  l.module = m;
  l.index = i + 1; l.count = siblings.length;
  l.prev = siblings[i - 1] || null; l.next = siblings[i + 1] || null;
  l.completed = !!db.get('SELECT 1 FROM lesson_progress WHERE user_id = ? AND lesson_id = ?', [userId, l.lesson_id]);
  const sc = db.get('SELECT * FROM scenarios WHERE lesson_id = ?', [l.lesson_id]);
  if (sc) sc.options = db.all('SELECT option_id, text FROM scenario_options WHERE scenario_id = ? ORDER BY option_id', [sc.scenario_id]);
  l.scenario = sc;
  return l;
}

export async function completeLesson(db, userId, lessonId) {
  const l = getLesson(db, userId, lessonId);
  if (!l.completed) await db.tx(d => d.run('INSERT OR IGNORE INTO lesson_progress (user_id, lesson_id) VALUES (?,?)', [userId, l.lesson_id]));
  return { next: l.next, module: l.module, newBadges: await refreshBadges(db, userId) };
}

export function answerScenario(db, userId, optionId) {
  const o = db.get(`SELECT o.*, s.lesson_id FROM scenario_options o JOIN scenarios s ON s.scenario_id = o.scenario_id WHERE o.option_id = ?`, [Number(optionId)]);
  need(o, 'Choose one option.');
  getLesson(db, userId, o.lesson_id);
  return { is_best: !!o.is_best, feedback: o.feedback };
}
