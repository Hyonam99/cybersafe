// Quiz engine: draws random questions, records the attempt and marks the answers.
import { now } from '../db.js';
import { need } from './errors.js';
import { moduleStatus, refreshBadges } from './progress.js';

export const QUIZ_SIZE = 10;

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

export async function startQuiz(db, userId, slug) {
  const m = moduleStatus(db, userId).find(x => x.slug === slug);
  need(m, 'That module was not found.');
  need(m.unlocked, 'This module is still locked.');
  need(m.lessons_done, 'Complete all the lessons in this module before taking the quiz.');
  const pool = db.all('SELECT question_id, question_text FROM questions WHERE module_id = ?', [m.module_id]);
  need(pool.length > 0, 'This module has no quiz questions yet.');
  const questions = shuffle(pool).slice(0, QUIZ_SIZE);
  for (const q of questions) q.options = shuffle(db.all('SELECT option_id, option_text FROM options WHERE question_id = ?', [q.question_id]));
  const attemptId = await db.tx(d => {
    const id = d.run('INSERT INTO quiz_attempts (user_id, module_id, total, started_at) VALUES (?,?,?,?)', [userId, m.module_id, questions.length, now()]).lastId;
    for (const q of questions) d.run('INSERT INTO attempt_answers (attempt_id, question_id, is_correct) VALUES (?,?,0)', [id, q.question_id]);
    return id;
  });
  return { attemptId, module: m, questions };
}

// answers: { [question_id]: option_id }
export async function submitQuiz(db, userId, attemptId, answers) {
  const a = db.get('SELECT a.*, m.pass_mark FROM quiz_attempts a JOIN modules m ON m.module_id = a.module_id WHERE a.attempt_id = ? AND a.user_id = ?', [Number(attemptId), userId]);
  need(a, 'That quiz attempt was not found.');
  need(!a.submitted_at, 'This quiz has already been submitted.');
  const rows = db.all('SELECT answer_id, question_id FROM attempt_answers WHERE attempt_id = ?', [a.attempt_id]);
  let score = 0;
  await db.tx(d => {
    for (const r of rows) {
      const chosen = Number(answers[r.question_id]) || null;
      const opt = chosen && d.get('SELECT is_correct FROM options WHERE option_id = ? AND question_id = ?', [chosen, r.question_id]);
      const correct = opt && opt.is_correct ? 1 : 0;
      score += correct;
      d.run('UPDATE attempt_answers SET option_id = ?, is_correct = ? WHERE answer_id = ?', [opt ? chosen : null, correct, r.answer_id]);
    }
    const total = rows.length;
    const percentage = Math.round(score / total * 1000) / 10;
    d.run('UPDATE quiz_attempts SET score = ?, total = ?, percentage = ?, passed = ?, submitted_at = ? WHERE attempt_id = ?',
      [score, total, percentage, percentage >= a.pass_mark ? 1 : 0, now(), a.attempt_id]);
  });
  const newBadges = await refreshBadges(db, userId);
  return { ...getResult(db, userId, a.attempt_id), newBadges };
}

export function getResult(db, userId, attemptId) {
  const a = db.get(`SELECT a.*, m.title, m.slug, m.pass_mark, m.sequence_no FROM quiz_attempts a JOIN modules m ON m.module_id = a.module_id
    WHERE a.attempt_id = ? AND a.user_id = ? AND a.submitted_at IS NOT NULL`, [Number(attemptId), userId]);
  need(a, 'That result was not found.');
  a.review = db.all(`SELECT q.question_text, q.explanation, aa.is_correct,
      (SELECT option_text FROM options WHERE option_id = aa.option_id) AS chosen,
      (SELECT option_text FROM options WHERE question_id = q.question_id AND is_correct = 1) AS correct
    FROM attempt_answers aa JOIN questions q ON q.question_id = aa.question_id WHERE aa.attempt_id = ? ORDER BY aa.answer_id`, [a.attempt_id]);
  a.next = db.get('SELECT slug, title FROM modules WHERE is_published = 1 AND sequence_no > ? ORDER BY sequence_no LIMIT 1', [a.sequence_no]);
  a.best = db.get('SELECT MAX(percentage) AS b FROM quiz_attempts WHERE user_id = ? AND module_id = ? AND submitted_at IS NOT NULL', [userId, a.module_id]).b;
  return a;
}
