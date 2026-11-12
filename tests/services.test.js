// Service-layer tests. Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { openDatabase } from '../js/db.js';
import * as auth from '../js/services/auth.js';
import * as content from '../js/services/content.js';
import * as quiz from '../js/services/quiz.js';
import * as teacher from '../js/services/teacher.js';
import * as admin from '../js/services/admin.js';
import { getProgress } from '../js/services/progress.js';

const root = new URL('../', import.meta.url);
// The vendor file is a browser/CommonJS bundle; this package is ESM, so load it in a CommonJS-style sandbox.
const sqlModule = { exports: {} };
vm.runInThisContext(`(function (module, exports, require, __dirname) {${readFileSync(new URL('js/vendor/sql-wasm.js', root), 'utf8')}\n})`)(
  sqlModule, sqlModule.exports, (await import('node:module')).createRequire(import.meta.url), new URL('js/vendor/', root).pathname);
const initSqlJs = sqlModule.exports;
const seedData = JSON.parse(readFileSync(new URL('data/seed.json', root)));
const PW = seedData.users[0].password;

async function freshDb() {
  const SQL = await initSqlJs({ locateFile: f => new URL('js/vendor/' + f, root).pathname });
  return openDatabase({ SQL, storage: null, loadSeed: async () => structuredClone(seedData) });
}
function memLocks() { const m = new Map(); return { get: k => m.get(k), set: (k, v) => m.set(k, v) }; }
const teacherUser = seedData.users.find(u => u.role === 'teacher').username;
const adminUser = seedData.users.find(u => u.role === 'admin').username;

let db;
test('seeds the database', async () => {
  db = await freshDb();
  assert.equal(db.get('SELECT COUNT(*) AS n FROM modules').n, 3);
  assert.ok(db.get('SELECT COUNT(*) AS n FROM questions').n >= 30);
  assert.ok(db.get("SELECT COUNT(*) AS n FROM users WHERE role='student'").n >= 8);
  assert.ok(db.get('SELECT COUNT(*) AS n FROM user_badges').n > 0, 'sample students earned badges');
});

test('registration validates input and join codes', async () => {
  const base = { fullName: 'Test Pupil', username: 'test_pupil', password: 'Secret123', confirm: 'Secret123', joinCode: 'kpx7qm' };
  await assert.rejects(auth.registerStudent(db, { ...base, joinCode: 'ZZZZZZ' }), /join code/);
  await assert.rejects(auth.registerStudent(db, { ...base, confirm: 'nope12345' }), /do not match/);
  await assert.rejects(auth.registerStudent(db, { ...base, username: 'a b' }), /Username/);
  const u = await auth.registerStudent(db, base);
  assert.equal(u.class_name, 'JSS2 Gold');
  await assert.rejects(auth.registerStudent(db, { ...base, username: 'TEST_PUPIL' }), /taken/);
});

test('login locks after five failures', async () => {
  const locks = memLocks();
  for (let i = 0; i < 5; i++) await assert.rejects(auth.login(db, { username: 'test_pupil', password: 'wrong' }, locks), /Incorrect/);
  await assert.rejects(auth.login(db, { username: 'test_pupil', password: 'Secret123' }, locks), /Too many/);
  const ok = await auth.login(db, { username: 'test_pupil', password: 'Secret123' }, memLocks());
  assert.equal(ok.role, 'student');
});

test('module order, lessons, quiz and badges', async () => {
  const uid = db.get("SELECT user_id FROM users WHERE username='test_pupil'").user_id;
  const mods = content.listModules(db, uid);
  assert.deepEqual(mods.map(m => m.unlocked), [true, false, false]);
  assert.throws(() => content.getModule(db, uid, mods[1].slug), /unlock/);
  await assert.rejects(quiz.startQuiz(db, uid, mods[0].slug), /Complete all the lessons/);

  const m = content.getModule(db, uid, mods[0].slug);
  for (const l of m.lessons) await content.completeLesson(db, uid, l.lesson_id);
  const lesson = content.getLesson(db, uid, m.lessons.find(l => db.get('SELECT 1 FROM scenarios WHERE lesson_id=?', [l.lesson_id])).lesson_id);
  const best = db.get('SELECT option_id FROM scenario_options WHERE scenario_id=? AND is_best=1', [lesson.scenario.scenario_id]);
  assert.equal(content.answerScenario(db, uid, best.option_id).is_best, true);

  const q = await quiz.startQuiz(db, uid, mods[0].slug);
  assert.equal(q.questions.length, 10);
  assert.ok(!('is_correct' in q.questions[0].options[0]), 'answers not sent to the page');
  const answers = {};
  for (const qq of q.questions) answers[qq.question_id] = db.get('SELECT option_id FROM options WHERE question_id=? AND is_correct=1', [qq.question_id]).option_id;
  const r = await quiz.submitQuiz(db, uid, q.attemptId, answers);
  assert.equal(r.percentage, 100);
  assert.equal(r.passed, 1);
  assert.ok(r.newBadges.some(b => b.code === 'PERFECT_SCORE'));
  await assert.rejects(quiz.submitQuiz(db, uid, q.attemptId, answers), /already been submitted/);
  assert.equal(content.listModules(db, uid)[1].unlocked, true);
  assert.equal(getProgress(db, uid).modules[0].completion, 100);
});

test('a failing quiz is recorded but not passed', async () => {
  const uid = db.get("SELECT user_id FROM users WHERE username='test_pupil'").user_id;
  const slug = content.listModules(db, uid)[0].slug;
  const q = await quiz.startQuiz(db, uid, slug);
  const r = await quiz.submitQuiz(db, uid, q.attemptId, {});
  assert.equal(r.score, 0);
  assert.equal(r.passed, 0);
  assert.equal(r.best, 100);
});

test('teacher classes and reports', async () => {
  const t = await auth.login(db, { username: teacherUser, password: PW }, memLocks());
  const c = await teacher.createClass(db, t.user_id, { name: 'JSS3 Blue', level: 'JSS3' });
  assert.match(c.join_code, /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/);
  await assert.rejects(teacher.createClass(db, t.user_id, { name: 'jss3 blue', level: 'JSS3' }), /already/);
  const gold = teacher.listClasses(db, t.user_id).find(x => x.name === 'JSS2 Gold');
  const rep = teacher.classReport(db, t.user_id, gold.class_id);
  assert.ok(rep.students.length >= 5);
  assert.equal(rep.modules.length, 3);
  const csv = teacher.reportCsv(rep);
  assert.ok(csv.split('\r\n').length === rep.students.length + 1);
  const other = await auth.login(db, { username: adminUser, password: PW }, memLocks());
  assert.throws(() => teacher.classReport(db, other.user_id, gold.class_id), /not found/);
  const kid = rep.students[0];
  await assert.rejects(teacher.resetStudentPassword(db, t.user_id, kid.user_id, 'short'), /8 characters/);
  await assert.rejects(teacher.resetStudentPassword(db, other.user_id, kid.user_id, 'newpass123'), /not in one of your classes/);
  await teacher.resetStudentPassword(db, t.user_id, kid.user_id, 'newpass123');
  const back = await auth.login(db, { username: kid.username, password: 'newpass123' }, memLocks());
  assert.equal(back.user_id, kid.user_id);
});

test('admin functions', async () => {
  const a = await auth.login(db, { username: adminUser, password: PW }, memLocks());
  await admin.createTeacher(db, { fullName: 'Mr Test', username: 'mr_test', password: 'Teacher99', schoolId: 1 });
  const t = admin.listTeachers(db).find(x => x.username === 'mr_test');
  await admin.setActive(db, a.user_id, t.user_id, false);
  await assert.rejects(auth.login(db, { username: 'mr_test', password: 'Teacher99' }, memLocks()), /deactivated/);
  assert.throws(() => auth.requireRole(db, t.user_id, 'teacher'), /access/);
  await assert.rejects(admin.addQuestion(db, 1, { text: 'Q?', options: ['a', 'b', 'c'], correct: 0 }), /four options/);
  await admin.addQuestion(db, 1, { text: 'Q?', options: ['a', 'b', 'c', 'd'], correct: 2, difficulty: 1 });
  const qs = admin.listQuestions(db, 1);
  assert.equal(qs.at(-1).options.filter(o => o.is_correct).length, 1);
  await admin.deleteQuestion(db, qs.at(-1).question_id);
  const rep = admin.platformReport(db);
  assert.equal(rep.modules.length, 3);
  assert.ok(rep.attempts > 0);
});
