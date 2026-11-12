// Administration module: teachers, schools, content, question bank and platform reports.
import { need } from './errors.js';
import { hashPassword } from './crypto.js';
import { USERNAME_RE, validatePassword } from './auth.js';

// Teachers
export function listTeachers(db) {
  return db.all(`SELECT u.user_id, u.full_name, u.username, u.is_active, u.last_login, s.name AS school_name,
      (SELECT COUNT(*) FROM classes c WHERE c.teacher_id = u.user_id) AS classes
    FROM users u LEFT JOIN schools s ON s.school_id = u.school_id WHERE u.role = 'teacher' ORDER BY u.full_name`);
}

export async function createTeacher(db, { fullName, username, password, schoolId }) {
  fullName = (fullName || '').trim(); username = (username || '').trim();
  need(fullName && username && password && schoolId, 'All fields are required.');
  need(USERNAME_RE.test(username), 'Username must be 3–20 letters, numbers or underscores.', 'username');
  validatePassword(password);
  need(db.get('SELECT 1 FROM schools WHERE school_id = ?', [Number(schoolId)]), 'Choose a school.', 'schoolId');
  need(!db.get('SELECT 1 FROM users WHERE username = ? COLLATE NOCASE', [username]), 'That username is already taken.', 'username');
  const hash = await hashPassword(password);
  await db.tx(d => d.run("INSERT INTO users (full_name, username, password_hash, role, school_id) VALUES (?,?,?,'teacher',?)", [fullName, username, hash, Number(schoolId)]));
}

export async function setActive(db, adminId, userId, active) {
  need(Number(userId) !== adminId, 'You cannot deactivate your own account.');
  await db.tx(d => d.run("UPDATE users SET is_active = ? WHERE user_id = ? AND role != 'admin'", [active ? 1 : 0, Number(userId)]));
}

export async function resetPassword(db, userId, password) {
  validatePassword(password);
  const hash = await hashPassword(password);
  await db.tx(d => d.run("UPDATE users SET password_hash = ? WHERE user_id = ? AND role != 'admin'", [hash, Number(userId)]));
}

// Schools
export function listSchools(db) {
  return db.all(`SELECT s.*, (SELECT COUNT(*) FROM users u WHERE u.school_id = s.school_id AND u.role = 'student') AS students
    FROM schools s ORDER BY s.name`);
}

export async function addSchool(db, { name, state, lga }) {
  name = (name || '').trim(); state = (state || '').trim(); lga = (lga || '').trim();
  need(name && state, 'School name and state are required.');
  need(!db.get('SELECT 1 FROM schools WHERE name = ? COLLATE NOCASE', [name]), 'That school is already listed.', 'name');
  await db.tx(d => d.run('INSERT INTO schools (name, state, lga) VALUES (?,?,?)', [name, state, lga || null]));
}

// Content
export function listAllModules(db) {
  return db.all(`SELECT m.*, (SELECT COUNT(*) FROM lessons l WHERE l.module_id = m.module_id) AS lessons,
      (SELECT COUNT(*) FROM questions q WHERE q.module_id = m.module_id) AS questions
    FROM modules m ORDER BY m.sequence_no`);
}

export async function updateModule(db, moduleId, { title, description, passMark, published }) {
  title = (title || '').trim();
  need(title, 'Enter a title.', 'title');
  passMark = Number(passMark);
  need(Number.isInteger(passMark) && passMark >= 40 && passMark <= 100, 'Pass mark must be a whole number from 40 to 100.', 'passMark');
  await db.tx(d => d.run('UPDATE modules SET title = ?, description = ?, pass_mark = ?, is_published = ? WHERE module_id = ?',
    [title, (description || '').trim(), passMark, published ? 1 : 0, Number(moduleId)]));
}

export function listLessons(db, moduleId) {
  return db.all('SELECT lesson_id, title, sequence_no, est_minutes FROM lessons WHERE module_id = ? ORDER BY sequence_no', [Number(moduleId)]);
}

export async function updateLesson(db, lessonId, { title, content, minutes }) {
  title = (title || '').trim(); content = (content || '').trim();
  need(title && content, 'Title and content are required.');
  minutes = Number(minutes) || 5;
  need(minutes >= 1 && minutes <= 60, 'Minutes must be between 1 and 60.', 'minutes');
  await db.tx(d => d.run('UPDATE lessons SET title = ?, content = ?, est_minutes = ? WHERE lesson_id = ?', [title, content, minutes, Number(lessonId)]));
}

// Question bank
export function listQuestions(db, moduleId) {
  const qs = db.all('SELECT * FROM questions WHERE module_id = ? ORDER BY question_id', [Number(moduleId)]);
  for (const q of qs) q.options = db.all('SELECT * FROM options WHERE question_id = ? ORDER BY option_id', [q.question_id]);
  return qs;
}

export async function addQuestion(db, moduleId, { text, options, correct, explanation, difficulty }) {
  text = (text || '').trim();
  options = (options || []).map(o => (o || '').trim());
  need(text, 'Enter the question.', 'text');
  need(options.length === 4 && options.every(Boolean), 'Fill in all four options.', 'options');
  need(new Set(options.map(o => o.toLowerCase())).size === 4, 'The four options must be different.', 'options');
  correct = Number(correct);
  need(Number.isInteger(correct) && correct >= 0 && correct < 4, 'Mark exactly one option as correct.', 'correct');
  difficulty = Number(difficulty) || 1;
  need(difficulty >= 1 && difficulty <= 3, 'Difficulty must be 1, 2 or 3.', 'difficulty');
  await db.tx(d => {
    const qid = d.run('INSERT INTO questions (module_id, question_text, explanation, difficulty) VALUES (?,?,?,?)',
      [Number(moduleId), text, (explanation || '').trim(), difficulty]).lastId;
    options.forEach((o, i) => d.run('INSERT INTO options (question_id, option_text, is_correct) VALUES (?,?,?)', [qid, o, i === correct ? 1 : 0]));
  });
}

export async function deleteQuestion(db, questionId) {
  const used = db.get('SELECT 1 FROM attempt_answers WHERE question_id = ?', [Number(questionId)]);
  need(!used, 'This question appears in past quiz results, so it cannot be deleted.');
  await db.tx(d => d.run('DELETE FROM questions WHERE question_id = ?', [Number(questionId)]));
}

// Platform report
export function platformReport(db) {
  const count = sql => db.get(sql).n;
  return {
    students: count("SELECT COUNT(*) AS n FROM users WHERE role = 'student'"),
    teachers: count("SELECT COUNT(*) AS n FROM users WHERE role = 'teacher'"),
    schools: count('SELECT COUNT(*) AS n FROM schools'),
    classes: count('SELECT COUNT(*) AS n FROM classes'),
    attempts: count('SELECT COUNT(*) AS n FROM quiz_attempts WHERE submitted_at IS NOT NULL'),
    lessonsDone: count('SELECT COUNT(*) AS n FROM lesson_progress'),
    modules: db.all(`SELECT m.title,
        (SELECT COUNT(*) FROM quiz_attempts a WHERE a.module_id = m.module_id AND a.submitted_at IS NOT NULL) AS attempts,
        (SELECT ROUND(AVG(percentage), 1) FROM quiz_attempts a WHERE a.module_id = m.module_id AND a.submitted_at IS NOT NULL) AS avg_score,
        (SELECT COUNT(DISTINCT user_id) FROM quiz_attempts a WHERE a.module_id = m.module_id AND a.passed = 1) AS passed
      FROM modules m ORDER BY m.sequence_no`),
    hardest: db.all(`SELECT q.question_text, m.title, COUNT(*) AS answered, ROUND(100.0 * SUM(aa.is_correct) / COUNT(*), 0) AS pct_correct
      FROM attempt_answers aa JOIN questions q ON q.question_id = aa.question_id JOIN modules m ON m.module_id = q.module_id
      JOIN quiz_attempts a ON a.attempt_id = aa.attempt_id WHERE a.submitted_at IS NOT NULL
      GROUP BY q.question_id HAVING COUNT(*) >= 3 ORDER BY pct_correct ASC LIMIT 5`),
  };
}
