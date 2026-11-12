// Progress and badge module: completion, best scores, module unlocking and badges.
import { now } from '../db.js';

// Status of every published module for one student, in sequence order.
export function moduleStatus(db, userId) {
  const mods = db.all(`SELECT m.module_id, m.title, m.slug, m.description, m.sequence_no, m.pass_mark,
      (SELECT COUNT(*) FROM lessons l WHERE l.module_id = m.module_id) AS total_lessons,
      (SELECT COUNT(*) FROM lesson_progress p JOIN lessons l ON l.lesson_id = p.lesson_id
         WHERE l.module_id = m.module_id AND p.user_id = ?) AS done_lessons,
      (SELECT MAX(percentage) FROM quiz_attempts a WHERE a.module_id = m.module_id AND a.user_id = ? AND a.submitted_at IS NOT NULL) AS best,
      (SELECT COUNT(*) FROM quiz_attempts a WHERE a.module_id = m.module_id AND a.user_id = ? AND a.submitted_at IS NOT NULL) AS attempts,
      (SELECT MAX(passed) FROM quiz_attempts a WHERE a.module_id = m.module_id AND a.user_id = ? AND a.submitted_at IS NOT NULL) AS passed
    FROM modules m WHERE m.is_published = 1 ORDER BY m.sequence_no`, [userId, userId, userId, userId]);
  let prevPassed = true;
  for (const m of mods) {
    m.completion = m.total_lessons ? Math.round(m.done_lessons / m.total_lessons * 100) : 0;
    m.passed = !!m.passed;
    m.unlocked = prevPassed;
    m.lessons_done = m.total_lessons > 0 && m.done_lessons >= m.total_lessons;
    prevPassed = m.passed;
  }
  return mods;
}

function criteriaMet(db, userId, criteria, mods) {
  if (criteria.startsWith('lessons_completed>=')) {
    const n = Number(criteria.split('>=')[1]);
    return db.get('SELECT COUNT(*) AS n FROM lesson_progress WHERE user_id = ?', [userId]).n >= n;
  }
  if (criteria.startsWith('passed:')) return !!mods.find(m => m.slug === criteria.slice(7) && m.passed);
  if (criteria === 'passed_all') return mods.length > 0 && mods.every(m => m.passed);
  if (criteria === 'perfect_score') return !!db.get('SELECT 1 FROM quiz_attempts WHERE user_id = ? AND percentage >= 100', [userId]);
  return false;
}

// Awards any badges the student has newly earned; returns them.
export async function refreshBadges(db, userId) {
  const mods = moduleStatus(db, userId);
  const missing = db.all(`SELECT * FROM badges WHERE badge_id NOT IN (SELECT badge_id FROM user_badges WHERE user_id = ?)`, [userId]);
  const earned = missing.filter(b => criteriaMet(db, userId, b.criteria, mods));
  if (earned.length) await db.tx(d => earned.forEach(b => d.run('INSERT INTO user_badges (user_id, badge_id, awarded_at) VALUES (?,?,?)', [userId, b.badge_id, now()])));
  return earned;
}

export function getProgress(db, userId) {
  const modules = moduleStatus(db, userId);
  const badges = db.all(`SELECT b.*, ub.awarded_at FROM badges b
    LEFT JOIN user_badges ub ON ub.badge_id = b.badge_id AND ub.user_id = ? ORDER BY b.badge_id`, [userId]);
  const attempts = db.all(`SELECT a.attempt_id, a.percentage, a.passed, a.submitted_at, m.title
    FROM quiz_attempts a JOIN modules m ON m.module_id = a.module_id
    WHERE a.user_id = ? AND a.submitted_at IS NOT NULL ORDER BY a.submitted_at DESC LIMIT 20`, [userId]);
  const total = modules.reduce((s, m) => s + m.total_lessons, 0);
  const done = modules.reduce((s, m) => s + m.done_lessons, 0);
  return { modules, badges, attempts, overall: total ? Math.round(done / total * 100) : 0 };
}
