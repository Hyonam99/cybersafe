// CyberSafe NG: page routing and screens. All data goes through the service modules,
// which read and write the SQLite database stored on this device.
import { openDatabase } from './db.js';
import { AppError } from './services/errors.js';
import * as auth from './services/auth.js';
import * as content from './services/content.js';
import * as quiz from './services/quiz.js';
import * as teacher from './services/teacher.js';
import * as admin from './services/admin.js';
import { getProgress } from './services/progress.js';

let db, me = null;
const $ = sel => document.querySelector(sel);
const main = $('#main');

// ---------- Device storage ----------

// Keeps the database file in IndexedDB so it survives page reloads and works offline.
const storage = {
  open() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open('cybersafe-ng', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('files');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  },
  async run(mode, fn) {
    const idb = await this.open();
    return new Promise((resolve, reject) => {
      const t = idb.transaction('files', mode);
      const req = fn(t.objectStore('files'));
      t.oncomplete = () => { idb.close(); resolve(req.result); };
      t.onerror = () => { idb.close(); reject(t.error); };
    });
  },
  load() { return this.run('readonly', s => s.get('database')); },
  save(bytes) { return this.run('readwrite', s => s.put(bytes, 'database')); },
  clear() { return this.run('readwrite', s => s.delete('database')); },
};

// Failed-login counts, kept per device.
const lockStore = {
  get(k) { try { return JSON.parse(localStorage.getItem('cs:' + k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem('cs:' + k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
};

const session = {
  get() { try { return Number(localStorage.getItem('cs:session')) || null; } catch { return null; } },
  set(id) { try { id ? localStorage.setItem('cs:session', id) : localStorage.removeItem('cs:session'); } catch { /* ignore */ } },
};

const loadSeed = () => fetch('data/seed.json').then(r => { if (!r.ok) throw new Error('seed.json ' + r.status); return r.json(); });

// ---------- Helpers ----------

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pct = v => v == null ? '—' : `${Math.round(v)}%`;
const date = s => s ? new Date(s.replace(' ', 'T') + 'Z').toLocaleDateString('en-NG', { day: 'numeric', month: 'short', year: 'numeric' }) : '—';
const bar = v => `<div class="bar" role="progressbar" aria-valuenow="${v}" aria-valuemin="0" aria-valuemax="100"><span style="width:${v}%"></span></div>`;

// Lesson text: paragraphs, ### headings, - bullets, 1. lists, > tips, **bold**, *italic*.
function md(src) {
  const inline = s => esc(s).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/\*(.+?)\*/g, '<em>$1</em>');
  let out = '', list = null, para = [];
  const flushP = () => { if (para.length) { out += `<p>${inline(para.join(' '))}</p>`; para = []; } };
  const flushL = () => { if (list) { out += `<${list.t}>${list.items.map(i => `<li>${inline(i)}</li>`).join('')}</${list.t}>`; list = null; } };
  for (const line of String(src).split('\n')) {
    let m;
    if (!line.trim()) { flushP(); flushL(); }
    else if ((m = line.match(/^###\s+(.*)/))) { flushP(); flushL(); out += `<h3>${inline(m[1])}</h3>`; }
    else if ((m = line.match(/^[-*]\s+(.*)/)) || (m = line.match(/^\d+\.\s+(.*)/))) {
      const t = /^\d/.test(line) ? 'ol' : 'ul';
      flushP(); if (list?.t !== t) { flushL(); list = { t, items: [] }; }
      list.items.push(m[1]);
    }
    else if ((m = line.match(/^>\s?(.*)/))) { flushP(); flushL(); out += `<aside class="tip">${inline(m[1])}</aside>`; }
    else { flushL(); para.push(line.trim()); }
  }
  flushP(); flushL();
  return out;
}

const ICONS = {
  cyberbullying: '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/><path d="M12 7v4M12 14h.01"/></svg>',
  'online-grooming': '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><circle cx="12" cy="10" r="2.5"/><path d="M8.5 16c.8-1.6 2-2.5 3.5-2.5s2.7.9 3.5 2.5"/></svg>',
  phishing: '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-10 6L2 7"/></svg>',
  lock: '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>',
  offline: '<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5a10 10 0 0 1 14 0M8.5 16a5 5 0 0 1 7 0M12 19.5h.01M2 9a15 15 0 0 1 20 0"/></svg>',
};
const BADGE_COLOURS = { FIRST_LESSON: '#1f5fbf', PASS_CYBERBULLYING: '#0b6b47', PASS_GROOMING: '#7a3fb0', PASS_PHISHING: '#c25a00', PERFECT_SCORE: '#c79100', ALL_MODULES: '#b42318' };
const badgeIcon = (code, size = 56) => `<svg width="${size}" height="${size}" viewBox="0 0 56 56" aria-hidden="true">
  <path d="M18 34 12 52l8-4 4 7 5-17M38 34l6 18-8-4-4 7-5-17" fill="${BADGE_COLOURS[code] || '#0b6b47'}" opacity=".55"/>
  <circle cx="28" cy="24" r="18" fill="${BADGE_COLOURS[code] || '#0b6b47'}"/><circle cx="28" cy="24" r="13" fill="none" stroke="#fff" stroke-width="2" opacity=".7"/>
  <path d="m28 15 2.8 5.7 6.2.9-4.5 4.4 1 6.2-5.5-2.9-5.5 2.9 1-6.2-4.5-4.4 6.2-.9z" fill="#fff"/></svg>`;

function toast(html, ms = 4500) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.innerHTML = html;
  $('#toasts').append(el);
  setTimeout(() => el.remove(), ms);
}
const announceBadges = list => (list || []).forEach(b => toast(`${badgeIcon(b.code, 32)}<span>Badge earned: <strong>${esc(b.name)}</strong></span>`));

const go = path => { if (location.hash === '#' + path) render(); else location.hash = path; };
const home = u => ({ student: '/dashboard', teacher: '/teacher', admin: '/admin' }[u?.role] || '/');

// ---------- Navigation ----------

function renderNav() {
  const links = !me ? [['/', 'Home'], ['/help', 'Help'], ['/login', 'Log in']]
    : me.role === 'student' ? [['/dashboard', 'Dashboard'], ['/progress', 'My progress'], ['/help', 'Help'], ['/account', 'Account']]
    : me.role === 'teacher' ? [['/teacher', 'My classes'], ['/help', 'Help'], ['/account', 'Account']]
    : [['/admin', 'Reports'], ['/admin/teachers', 'Teachers'], ['/admin/schools', 'Schools'], ['/admin/content', 'Content'], ['/account', 'Account']];
  const here = location.hash.slice(1) || '/';
  $('#nav').innerHTML = links.map(([href, label]) =>
    `<a href="#${href}"${here === href || (href !== '/' && here.startsWith(href + '/') && !links.some(l => l[0] !== href && here.startsWith(l[0]) && l[0].length > href.length)) ? ' aria-current="page"' : ''}>${label}</a>`).join('')
    + (me ? `<button data-act="logout">Log out</button>` : `<a class="nav-cta" href="#/register">Register</a>`);
  $('#nav').classList.remove('open');
  $('.nav-toggle').setAttribute('aria-expanded', 'false');
}

// ---------- Routes ----------

const routes = [
  [/^\/$/, null, viewHome],
  [/^\/help$/, null, viewHelp],
  [/^\/login$/, 'guest', viewLogin],
  [/^\/register$/, 'guest', viewRegister],
  [/^\/account$/, 'any', viewAccount],
  [/^\/dashboard$/, 'student', viewDashboard],
  [/^\/module\/([\w-]+)$/, 'student', viewModule],
  [/^\/lesson\/(\d+)$/, 'student', viewLesson],
  [/^\/quiz\/([\w-]+)$/, 'student', viewQuiz],
  [/^\/result\/(\d+)$/, 'student', viewResult],
  [/^\/progress$/, 'student', viewProgress],
  [/^\/teacher$/, 'teacher', viewClasses],
  [/^\/teacher\/class\/(\d+)$/, 'teacher', viewClassReport],
  [/^\/admin$/, 'admin', viewAdminReport],
  [/^\/admin\/teachers$/, 'admin', viewTeachers],
  [/^\/admin\/schools$/, 'admin', viewSchools],
  [/^\/admin\/content$/, 'admin', viewContent],
  [/^\/admin\/module\/(\d+)$/, 'admin', viewEditModule],
  [/^\/admin\/lesson\/(\d+)$/, 'admin', viewEditLesson],
  [/^\/admin\/questions\/(\d+)$/, 'admin', viewQuestions],
];

async function render() {
  const path = location.hash.slice(1) || '/';
  me = null;
  const id = session.get();
  if (id) { try { me = auth.requireRole(db, id); } catch { session.set(null); } }
  renderNav();
  for (const [re, role, view] of routes) {
    const m = path.match(re);
    if (!m) continue;
    if (role === 'guest' && me) return go(home(me));
    if (role && role !== 'guest' && !me) return go('/login');
    if (role && !['guest', 'any'].includes(role) && me.role !== role) return go(home(me));
    try {
      main.innerHTML = `<div class="wrap">${await view(...m.slice(1))}</div>`;
    } catch (e) {
      if (!(e instanceof AppError)) console.error(e);
      main.innerHTML = `<div class="wrap narrow"><div class="card"><h1>Sorry</h1><p>${esc(e.message)}</p><a class="btn" href="#${home(me)}">Go back</a></div></div>`;
    }
    afterRender();
    return;
  }
  main.innerHTML = `<div class="wrap narrow"><div class="card"><h1>Page not found</h1><p>That page does not exist.</p><a class="btn" href="#${home(me)}">Go home</a></div></div>`;
}

function afterRender() {
  window.scrollTo(0, 0);
  const title = main.querySelector('[data-title]')?.dataset.title || main.querySelector('h1')?.textContent;
  document.title = (title ? title + ' · ' : '') + 'CyberSafe NG';
  main.focus({ preventScroll: true });
}

// ---------- Public pages ----------

function viewHome() {
  const mods = db.all(`SELECT m.title, m.slug, m.description,
      (SELECT COUNT(*) FROM lessons l WHERE l.module_id = m.module_id) AS lessons
    FROM modules m WHERE m.is_published = 1 ORDER BY m.sequence_no`);
  const count = sql => db.get(sql)?.n ?? 0;
  const lessons = count('SELECT COUNT(*) AS n FROM lessons JOIN modules USING (module_id) WHERE is_published = 1');
  const scenarios = count('SELECT COUNT(*) AS n FROM scenarios JOIN lessons USING (lesson_id) JOIN modules USING (module_id) WHERE is_published = 1');
  const questions = count('SELECT COUNT(*) AS n FROM questions JOIN modules USING (module_id) WHERE is_published = 1');
  const cta = me ? `<a class="btn" href="#${home(me)}">Go to my dashboard</a>`
    : `<a class="btn" href="#/register">Join your class</a><a class="btn secondary" href="#/login">Log in</a>`;
  const flag = (text, why) => `<button type="button" class="flag" data-act="flag" data-why="${esc(why)}">${text}</button>`;
  return `
  <section class="landing-hero full" data-title="Stay safe online">
    <div class="wrap hero-grid">
      <div>
        <p class="eyebrow">For JSS and SS students in Nigeria</p>
        <h1>Think before<br>you <span class="hl">tap.</span></h1>
        <p class="lead">Scammers, groomers and bullies are online every day. Learn to spot them with short lessons, real Nigerian scenarios and quick quizzes.</p>
        <div class="row">${cta}</div>
        <p class="hero-note">Free · Works offline · No email needed</p>
      </div>
      <div class="phone" role="img" aria-label="Three example messages: a fake prize, a stranger asking for secrets, and a bullying post">
        <div class="phone-top"><span></span></div>
        <div class="msg"><small>Unknown number</small>You have won ₦50,000 airtime!! Claim now 👉 bit.ly/fr33-cash</div>
        <span class="tag t0">Phishing</span>
        <div class="msg"><small>New friend</small>You are so mature for your age. Don't tell your parents we talk 🤫</div>
        <span class="tag t1">Grooming</span>
        <div class="msg"><small>SS2 Gist group</small>Everybody has seen your photo 😂😂 share it more</div>
        <span class="tag t2">Cyberbullying</span>
      </div>
    </div>
  </section>

  <section class="facts full">
    <div class="wrap fact-row">
      <div><b>${mods.length}</b><span>modules</span></div>
      <div><b>${lessons}</b><span>short lessons</span></div>
      <div><b>${scenarios}</b><span>real-life scenarios</span></div>
      <div><b>${questions}</b><span>quiz questions</span></div>
    </div>
  </section>

  <section class="section spot">
    <div>
      <p class="eyebrow dark">Try it now</p>
      <h2 class="big">Can you spot the scam?</h2>
      <p class="muted">This message has <strong>3 red flags</strong>. Tap the parts that look wrong.</p>
      <p class="spot-score" id="spot-score" aria-live="polite">0 of 3 found</p>
      <ul class="spot-found" id="spot-found"></ul>
      <button type="button" class="link-btn" data-act="flag-all">Show me the answers</button>
    </div>
    <div class="sms">
      <div class="sms-head"><span class="avatar" aria-hidden="true">?</span><div><strong>+234 901 ••• ••21</strong><br><span class="small muted">Text message · now</span></div></div>
      <p class="sms-body">${flag('URGENT!! Your exam result has been withheld.', 'Panic words like URGENT!! are used to make you act before you think.')}
        Pay ₦2,500 ${flag('within 1 hour', 'A short deadline is pressure, not a real rule.')} to release it at
        ${flag('exam-results-ng.xyz/pay', 'A strange web address. Real exam bodies only use their official website.')}</p>
    </div>
  </section>

  <section class="section">
    <p class="eyebrow dark">The course</p>
    <h2 class="big">${mods.length === 3 ? 'Three modules. One safer you.' : 'What you will learn'}</h2>
    <ol class="path">${mods.map((m, i) => `
      <li class="path-card c${i % 3}">
        <div class="path-top"><span class="num">${String(i + 1).padStart(2, '0')}</span><div class="icon">${ICONS[m.slug] || ICONS.lock}</div></div>
        <h3>${esc(m.title)}</h3>
        <p class="muted">${esc(m.description)}</p>
        <p class="path-meta">${m.lessons} lessons · quiz · badge</p>
        <p class="path-next small">${i < mods.length - 1 ? 'Pass with 70% to unlock the next module →' : 'Finish them all to earn every badge ★'}</p>
      </li>`).join('')}
    </ol>
  </section>

  <section class="section split">
    <div class="panel">
      ${ICONS.offline}
      <h2>Made for bad network days</h2>
      <p>After the first visit, CyberSafe NG works with no internet at all. Lessons, quizzes and progress stay on the device, so poor network or costly data will not stop you. A school can also run it from one computer for the whole computer lab.</p>
    </div>
    <div class="panel teacher">
      <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 10 12 5 2 10l10 5 10-5z"/><path d="M6 12v5c3 2 9 2 12 0v-5"/></svg>
      <h2>For teachers</h2>
      <ul>
        <li>Create a class and share a six-character join code</li>
        <li>See who has finished each module, and their scores</li>
        <li>Download or print class reports</li>
        <li>Reset a student's forgotten password</li>
      </ul>
    </div>
  </section>

  <section class="section closing">
    <h2>One tap can cost a lot. One lesson can save it.</h2>
    <p>Get your class join code from your teacher and start today.</p>
    <div class="row">${cta}</div>
  </section>`;
}

function viewHelp() {
  const faq = [
    ['How do I join my class?', 'Ask your teacher for the six-character join code, then choose <a href="#/register">Register</a> and enter it with your name, a username and a password.'],
    ['I forgot my password.', 'Ask your teacher. They can set a new password for you from your class report. (Teachers: ask the school administrator.)'],
    ['Why is a module locked?', 'Modules open one after the other. Pass the quiz of the module before it (70% or more) to unlock the next one.'],
    ['Can I retake a quiz?', 'Yes. Each attempt draws 10 questions from a larger bank, and your best score is kept.'],
    ['Does it work without internet?', 'Yes. Once the site has loaded on your device, you can keep using it offline. Your progress is saved on this device.'],
    ['Teachers: how do I add my students?', 'Log in, open <em>My classes</em>, create a class and share its join code. Students who register with the code appear in the class report.'],
  ];
  return `<div class="narrow" style="margin:0 auto">
    <h1>Help and safety</h1>
    <div class="card stack">
      <h2>If something is wrong right now</h2>
      <ul>
        <li><strong>Do not reply</strong> to the person, and do not delete the evidence. Take screenshots.</li>
        <li><strong>Tell a trusted adult</strong>: a parent, guardian, teacher or school counsellor.</li>
        <li><strong>Block and report</strong> the account on the app (WhatsApp, Instagram, TikTok, Snapchat and Facebook all have a Report option).</li>
        <li>If you are in danger, call <strong>112</strong>, Nigeria's emergency number.</li>
      </ul>
    </div>
    <h2 class="section">Questions</h2>
    ${faq.map(([q, a]) => `<details class="faq"><summary>${q}</summary><p style="margin:10px 0 0">${a}</p></details>`).join('')}
  </div>`;
}

async function viewLogin() {
  let demo = [];
  try { demo = (await loadSeed()).users; } catch { /* offline before first cache */ }
  return `<div class="auth">
    <div class="card">
      <h1>Log in</h1>
      <form data-form="login" novalidate>
        <p class="form-error" role="alert"></p>
        <label>Username<input name="username" autocomplete="username" required></label>
        <label>Password<input name="password" type="password" autocomplete="current-password" required></label>
        <button class="btn">Log in</button>
        <p class="small muted" style="margin:0">New student? <a href="#/register">Register with your class join code</a>.</p>
      </form>
    </div>
    ${demo.length ? `<aside class="card demo-box">
      <h3>Demo accounts</h3>
      <p class="small muted">This is a demonstration. Tap an account to fill in the form.</p>
      <ul>${demo.map(u => `<li><button type="button" data-act="fill-login" data-u="${esc(u.username)}" data-p="${esc(u.password)}">
        <strong>${esc(u.role[0].toUpperCase() + u.role.slice(1))}</strong><br><code>${esc(u.username)}</code> · <code>${esc(u.password)}</code></button></li>`).join('')}</ul>
      <p class="small muted" style="margin:12px 0 0">Class join codes for testing registration are on the teacher's <em>My classes</em> page.</p>
    </aside>` : ''}
  </div>`;
}

function viewRegister() {
  return `<div class="narrow card" style="margin:0 auto">
    <h1>Join your class</h1>
    <p class="muted">You need the six-character join code from your teacher. No email address is needed.</p>
    <form data-form="register" novalidate>
      <p class="form-error" role="alert"></p>
      <label>Full name<input name="fullName" autocomplete="name" maxlength="80" required></label>
      <label>Username <span class="hint">3–20 letters, numbers or underscores</span><input name="username" autocomplete="username" maxlength="20" required></label>
      <div class="grid-2">
        <label>Password <span class="hint">At least 8 characters</span><input name="password" type="password" autocomplete="new-password" required></label>
        <label>Confirm password<input name="confirm" type="password" autocomplete="new-password" required></label>
      </div>
      <label>Class join code<input name="joinCode" maxlength="6" autocapitalize="characters" style="text-transform:uppercase;letter-spacing:.15em" required></label>
      <button class="btn">Create my account</button>
      <p class="small muted" style="margin:0">Already registered? <a href="#/login">Log in</a>.</p>
    </form>
  </div>`;
}

function viewAccount() {
  return `<div class="narrow" style="margin:0 auto">
    <h1>My account</h1>
    <div class="card stack">
      <p><strong>${esc(me.full_name)}</strong><br><span class="muted">@${esc(me.username)} · ${esc(me.role)}${me.class_name ? ' · ' + esc(me.class_name) : ''}${me.school_name ? ' · ' + esc(me.school_name) : ''}</span></p>
      <h2>Change password</h2>
      <form data-form="password" novalidate>
        <p class="form-error" role="alert"></p>
        <label>Current password<input name="current" type="password" autocomplete="current-password"></label>
        <div class="grid-2">
          <label>New password<input name="password" type="password" autocomplete="new-password"></label>
          <label>Confirm new password<input name="confirm" type="password" autocomplete="new-password"></label>
        </div>
        <button class="btn">Save new password</button>
      </form>
    </div>
  </div>`;
}

// ---------- Student pages ----------

function moduleCard(m) {
  const state = !m.unlocked ? '<span class="pill">Locked</span>' : m.passed ? '<span class="pill ok">Passed</span>'
    : m.completion > 0 ? '<span class="pill info">In progress</span>' : '<span class="pill">Not started</span>';
  return `<article class="card module-card ${m.unlocked ? '' : 'locked'}">
    <div class="row spread"><div class="icon">${m.unlocked ? ICONS[m.slug] || ICONS.lock : ICONS.lock}</div>${state}</div>
    <h3>${esc(m.title)}</h3>
    <p class="muted small" style="margin:0">${esc(m.description)}</p>
    <div><div class="row spread small"><span>${m.done_lessons} of ${m.total_lessons} lessons</span><span>Best quiz: ${pct(m.best)}</span></div>${bar(m.completion)}</div>
    <div class="actions">${m.unlocked
      ? `<a class="btn ${m.completion ? 'secondary' : ''}" href="#/module/${m.slug}">${m.completion === 0 ? 'Start' : m.passed ? 'Review' : 'Continue'}</a>`
      : `<p class="small muted" style="margin:0">Pass the previous module to unlock.</p>`}</div>
  </article>`;
}

function viewDashboard() {
  const p = getProgress(db, me.user_id);
  const earned = p.badges.filter(b => b.awarded_at);
  const next = p.modules.find(m => m.unlocked && !m.passed);
  return `<div class="page-head row spread">
      <div><h1>Hello, ${esc(me.full_name.split(' ')[0])}</h1><p class="muted" style="margin:0">${esc(me.class_name || '')}${me.school_name ? ' · ' + esc(me.school_name) : ''}</p></div>
      ${next ? `<a class="btn" href="#/module/${next.slug}">${next.completion ? 'Continue' : 'Start'}: ${esc(next.title)}</a>` : ''}
    </div>
    <div class="stat-grid">
      <div class="stat"><b>${p.overall}%</b><span>of all lessons done</span></div>
      <div class="stat"><b>${p.modules.filter(m => m.passed).length} / ${p.modules.length}</b><span>modules passed</span></div>
      <div class="stat"><b>${earned.length}</b><span>badges earned</span></div>
      <div class="stat"><b>${p.attempts.length}</b><span>quizzes taken</span></div>
    </div>
    <h2 class="section">Your modules</h2>
    <div class="cards">${p.modules.map(moduleCard).join('')}</div>
    <div class="section row spread"><h2 style="margin:0">Badges</h2><a href="#/progress">See all progress</a></div>
    ${earned.length ? `<div class="badges" style="margin-top:12px">${earned.map(b => `<div class="badge">${badgeIcon(b.code)}<strong>${esc(b.name)}</strong><span>${esc(b.description)}</span></div>`).join('')}</div>`
      : `<p class="muted">Complete your first lesson to earn your first badge.</p>`}`;
}

function viewModule(slug) {
  const m = content.getModule(db, me.user_id, slug);
  const nextLesson = m.lessons.find(l => !l.completed) || m.lessons[0];
  return `<div class="crumbs"><a href="#/dashboard">Dashboard</a> › ${esc(m.title)}</div>
    <div class="page-head row spread">
      <div><h1>${esc(m.title)}</h1><p class="muted" style="margin:0;max-width:640px">${esc(m.description)}</p></div>
      <a class="btn" href="#/lesson/${nextLesson.lesson_id}">${m.done_lessons === 0 ? 'Start lesson 1' : m.lessons_done ? 'Read again' : 'Continue reading'}</a>
    </div>
    <div class="grid-2" style="align-items:start">
      <div class="card">
        <h2>Lessons</h2>
        <ol class="lesson-nav" style="list-style:none;padding:0;margin:0">${m.lessons.map((l, i) => `
          <li><a href="#/lesson/${l.lesson_id}"><span class="tick ${l.completed ? 'done' : ''}">${l.completed ? '✓' : ''}</span>
            <span>${i + 1}. ${esc(l.title)}<br><span class="small muted">${l.est_minutes} min read</span></span></a></li>`).join('')}
        </ol>
      </div>
      <div class="card stack">
        <h2>Module quiz</h2>
        <p class="muted">10 questions drawn at random. Score <strong>${m.pass_mark}%</strong> or more to pass${m.sequence_no < 3 ? ' and unlock the next module' : ''}.</p>
        <div class="row"><span class="pill ${m.passed ? 'ok' : m.best != null ? 'warn' : ''}">${m.best != null ? `Best score ${pct(m.best)}` : 'Not attempted'}</span><span class="small muted">${m.attempts} attempt${m.attempts === 1 ? '' : 's'}</span></div>
        ${m.lessons_done ? `<a class="btn" href="#/quiz/${m.slug}" data-act="new-quiz" data-slug="${m.slug}">${m.attempts ? 'Take the quiz again' : 'Take the quiz'}</a>`
          : `<button class="btn" disabled>Take the quiz</button><p class="small muted" style="margin:0">Finish all ${m.total_lessons} lessons first (${m.done_lessons} done).</p>`}
      </div>
    </div>`;
}

function viewLesson(id) {
  const l = content.getLesson(db, me.user_id, id);
  const all = content.getModule(db, me.user_id, l.module.slug).lessons;
  return `<div class="crumbs"><a href="#/dashboard">Dashboard</a> › <a href="#/module/${l.module.slug}">${esc(l.module.title)}</a> › Lesson ${l.index}</div>
    <div class="lesson-layout">
      <nav class="lesson-nav card" aria-label="Lessons in this module">
        <p class="small muted" style="margin-top:0">${esc(l.module.title)}</p>
        <ol>${all.map((x, i) => `<li><a href="#/lesson/${x.lesson_id}"${x.lesson_id === l.lesson_id ? ' aria-current="page"' : ''}>
          <span class="tick ${x.completed ? 'done' : ''}">${x.completed ? '✓' : ''}</span>${i + 1}. ${esc(x.title)}</a></li>`).join('')}</ol>
      </nav>
      <article class="card">
        <p class="small muted" style="margin:0 0 4px">Lesson ${l.index} of ${l.count} · ${l.est_minutes} min read</p>
        <h1>${esc(l.title)}</h1>
        <div class="lesson-body">${md(l.content)}</div>
        ${l.scenario ? `<section class="scenario" aria-labelledby="sc-h">
          <h3 id="sc-h">What would you do?</h3>
          <p>${esc(l.scenario.prompt)}</p>
          <div class="choices">${l.scenario.options.map(o => `<button class="choice" data-act="scenario" data-id="${o.option_id}">${esc(o.text)}</button>`).join('')}</div>
          <div class="feedback" id="sc-feedback" hidden aria-live="polite"></div>
        </section>` : ''}
        <div class="row spread section">
          ${l.prev ? `<a class="btn ghost" href="#/lesson/${l.prev.lesson_id}">← Previous</a>` : '<span></span>'}
          <button class="btn" data-act="complete-lesson" data-id="${l.lesson_id}">${l.next ? (l.completed ? 'Next lesson →' : 'Mark as done and continue →') : (l.completed ? 'Back to module' : 'Mark as done and finish')}</button>
        </div>
      </article>
    </div>`;
}

// The quiz in progress is kept for this browser tab so a reload does not lose it.
const quizState = {
  get() { try { return JSON.parse(sessionStorage.getItem('cs:quiz')); } catch { return null; } },
  set(v) { try { v ? sessionStorage.setItem('cs:quiz', JSON.stringify(v)) : sessionStorage.removeItem('cs:quiz'); } catch { /* ignore */ } },
};

async function viewQuiz(slug) {
  let q = quizState.get();
  const open = q && q.slug === slug && q.userId === me.user_id
    && db.get('SELECT 1 FROM quiz_attempts WHERE attempt_id = ? AND submitted_at IS NULL', [q.attemptId]);
  if (!open) {
    const s = await quiz.startQuiz(db, me.user_id, slug);
    q = { slug, userId: me.user_id, title: s.module.title, passMark: s.module.pass_mark, attemptId: s.attemptId, questions: s.questions, idx: 0, answers: {} };
    quizState.set(q);
  }
  const cur = q.questions[q.idx];
  const answered = Object.keys(q.answers).length;
  const last = q.idx === q.questions.length - 1;
  return `<div class="quiz-card" data-title="${esc(q.title)} quiz">
    <div class="crumbs"><a href="#/module/${slug}">${esc(q.title)}</a> › Quiz</div>
    <div class="card">
      <div class="row spread small muted"><span>Question ${q.idx + 1} of ${q.questions.length}</span><span><span id="q-count">${answered}</span> answered · pass mark ${q.passMark}%</span></div>
      ${bar(Math.round((q.idx + 1) / q.questions.length * 100))}
      <h1 class="q-text" id="q-h">${esc(cur.question_text)}</h1>
      <fieldset class="options" aria-labelledby="q-h">
        ${cur.options.map((o, i) => `<label class="option"><input type="radio" name="opt" value="${o.option_id}" data-act="answer" data-q="${cur.question_id}"
          ${q.answers[cur.question_id] === o.option_id ? 'checked' : ''}><span><strong>${'ABCD'[i]}.</strong> ${esc(o.option_text)}</span></label>`).join('')}
      </fieldset>
      <div class="row spread section" style="margin-top:20px">
        <button class="btn ghost" data-act="quiz-nav" data-to="${q.idx - 1}" ${q.idx === 0 ? 'disabled' : ''}>← Back</button>
        ${last ? `<button class="btn" data-act="submit-quiz">Submit answers</button>` : `<button class="btn" data-act="quiz-nav" data-to="${q.idx + 1}">Next →</button>`}
      </div>
      <div class="q-dots" aria-label="Jump to question">${q.questions.map((x, i) =>
        `<button data-act="quiz-nav" data-to="${i}" class="${q.answers[x.question_id] ? 'answered' : ''} ${i === q.idx ? 'current' : ''}" aria-label="Question ${i + 1}${q.answers[x.question_id] ? ', answered' : ''}">${i + 1}</button>`).join('')}</div>
    </div>
  </div>`;
}

function ring(p, passed) {
  const c = 2 * Math.PI * 62;
  return `<svg class="score-ring" viewBox="0 0 150 150" role="img" aria-label="Score ${p}%">
    <circle cx="75" cy="75" r="62" fill="none" stroke="#e6eaed" stroke-width="14"/>
    <circle cx="75" cy="75" r="62" fill="none" stroke="${passed ? '#0b6b47' : '#b42318'}" stroke-width="14" stroke-linecap="round"
      stroke-dasharray="${c * p / 100} ${c}" transform="rotate(-90 75 75)"/>
    <text x="75" y="84" text-anchor="middle" font-size="30" font-weight="700" fill="#17212b">${p}%</text></svg>`;
}

function viewResult(id) {
  const r = quiz.getResult(db, me.user_id, id);
  const passed = !!r.passed;
  return `<div class="narrow" style="margin:0 auto">
    <div class="crumbs"><a href="#/module/${r.slug}">${esc(r.title)}</a> › Result</div>
    <div class="card result-head">
      ${ring(Math.round(r.percentage), passed)}
      <div style="flex:1;min-width:220px">
        <h1>${passed ? 'Well done, you passed!' : 'Not passed yet'}</h1>
        <p>You got <strong>${r.score} of ${r.total}</strong> correct. The pass mark is ${r.pass_mark}%. Your best score in this module is ${pct(r.best)}.</p>
        <div class="row">
          ${passed && r.next ? `<a class="btn" href="#/module/${r.next.slug}">Next module: ${esc(r.next.title)}</a>` : ''}
          ${passed && !r.next ? `<a class="btn" href="#/progress">See my badges</a>` : ''}
          ${!passed ? `<a class="btn" href="#/module/${r.slug}">Revise the lessons</a>` : ''}
          <a class="btn secondary" href="#/quiz/${r.slug}" data-act="new-quiz" data-slug="${r.slug}">Try again</a>
        </div>
      </div>
    </div>
    <h2 class="section">Review your answers</h2>
    <ol class="review">${r.review.map((x, i) => `<li class="${x.is_correct ? '' : 'wrong'}">
      <p><strong>${i + 1}. ${esc(x.question_text)}</strong></p>
      <p>${x.is_correct ? '<span class="pill ok">Correct</span>' : '<span class="pill bad">Incorrect</span>'} Your answer: ${esc(x.chosen || 'No answer')}</p>
      ${x.is_correct ? '' : `<p>Correct answer: <strong>${esc(x.correct)}</strong></p>`}
      ${x.explanation ? `<p class="muted small">${esc(x.explanation)}</p>` : ''}
    </li>`).join('')}</ol>
  </div>`;
}

function viewProgress() {
  const p = getProgress(db, me.user_id);
  return `<h1>My progress</h1>
    <div class="table-wrap"><table>
      <thead><tr><th>Module</th><th>Lessons</th><th class="num">Completion</th><th class="num">Best score</th><th class="num">Attempts</th><th>Status</th></tr></thead>
      <tbody>${p.modules.map(m => `<tr><td>${esc(m.title)}</td><td>${m.done_lessons} / ${m.total_lessons}</td><td class="num">${m.completion}%</td>
        <td class="num">${pct(m.best)}</td><td class="num">${m.attempts}</td>
        <td>${!m.unlocked ? '<span class="pill">Locked</span>' : m.passed ? '<span class="pill ok">Passed</span>' : m.attempts ? '<span class="pill warn">Not passed</span>' : '<span class="pill">Not attempted</span>'}</td></tr>`).join('')}</tbody>
      <tfoot><tr><td>Overall</td><td colspan="5">${p.overall}% of lessons completed</td></tr></tfoot>
    </table></div>
    <h2 class="section">Badges</h2>
    <div class="badges">${p.badges.map(b => `<div class="badge ${b.awarded_at ? '' : 'locked'}">${badgeIcon(b.code)}<strong>${esc(b.name)}</strong>
      <span>${esc(b.description)}</span>${b.awarded_at ? `<br><span>Earned ${date(b.awarded_at)}</span>` : ''}</div>`).join('')}</div>
    <h2 class="section">Quiz history</h2>
    ${p.attempts.length ? `<div class="table-wrap"><table><thead><tr><th>Date</th><th>Module</th><th class="num">Score</th><th>Result</th><th></th></tr></thead>
      <tbody>${p.attempts.map(a => `<tr><td>${date(a.submitted_at)}</td><td>${esc(a.title)}</td><td class="num">${pct(a.percentage)}</td>
        <td>${a.passed ? '<span class="pill ok">Passed</span>' : '<span class="pill bad">Not passed</span>'}</td><td><a href="#/result/${a.attempt_id}">Review</a></td></tr>`).join('')}</tbody></table></div>`
      : '<p class="muted">You have not taken a quiz yet.</p>'}`;
}

// ---------- Teacher pages ----------

function viewClasses() {
  const list = teacher.listClasses(db, me.user_id);
  return `<div class="page-head"><h1>My classes</h1><p class="muted">Share a class's join code with your students so they can register into it.</p></div>
    ${list.length ? `<div class="cards">${list.map(c => `<article class="card stack">
      <div class="row spread"><h3 style="margin:0">${esc(c.name)}</h3><span class="pill">${esc(c.level)}</span></div>
      <p style="margin:0">Join code: <span class="code">${esc(c.join_code)}</span></p>
      <p class="muted" style="margin:0">${c.students} student${c.students === 1 ? '' : 's'}</p>
      <a class="btn secondary" href="#/teacher/class/${c.class_id}">View progress report</a>
    </article>`).join('')}</div>` : '<div class="card empty">You have no classes yet. Create one below.</div>'}
    <div class="card section narrow">
      <h2>Create a class</h2>
      <form data-form="class" novalidate>
        <p class="form-error" role="alert"></p>
        <div class="grid-2">
          <label>Class name<input name="name" maxlength="40" placeholder="e.g. JSS3 Blue"></label>
          <label>Level<select name="level"><option value="">Choose…</option>${teacher.LEVELS.map(l => `<option>${l}</option>`).join('')}</select></label>
        </div>
        <button class="btn">Create class and join code</button>
      </form>
    </div>`;
}

let lastReport = null;
function viewClassReport(id) {
  const r = lastReport = teacher.classReport(db, me.user_id, id);
  const cell = m => m.best == null && !m.completion ? '<span class="muted">—</span>'
    : `${m.completion}% <span class="pill ${m.passed ? 'ok' : m.best != null ? 'warn' : ''}">${pct(m.best)}</span>`;
  return `<div class="crumbs"><a href="#/teacher">My classes</a> › ${esc(r.cls.name)}</div>
    <div class="page-head row spread">
      <div><h1>${esc(r.cls.name)} progress report</h1><p class="muted" style="margin:0">${esc(r.cls.level)} · join code <span class="code">${esc(r.cls.join_code)}</span></p></div>
      <div class="row no-print"><button class="btn secondary" data-act="csv">Download CSV</button><button class="btn ghost" data-act="print">Print</button></div>
    </div>
    <div class="stat-grid">
      <div class="stat"><b>${r.students.length}</b><span>students</span></div>
      <div class="stat"><b>${r.notStarted}</b><span>not started yet</span></div>
      ${r.modules.map((m, i) => `<div class="stat"><b>${r.averages[i].passed} / ${r.students.length}</b><span>passed ${esc(m.title)}</span></div>`).join('')}
    </div>
    <p class="small muted section">Each cell shows lesson completion and the student's best quiz score. Class averages leave out students who have not started that module.</p>
    ${r.students.length ? `<div class="table-wrap"><table>
      <thead><tr><th>Student</th>${r.modules.map(m => `<th>${esc(m.title)}</th>`).join('')}<th class="num">Overall</th><th>Last login</th></tr></thead>
      <tbody>${r.students.map(s => `<tr><td>${esc(s.full_name)}<br><span class="small muted">@${esc(s.username)}</span>
        <br><button class="link-btn small no-print" data-act="reset-student-pw" data-id="${s.user_id}" data-name="${esc(s.full_name)}" data-username="${esc(s.username)}">Reset password</button></td>
        ${s.modules.map(m => `<td>${cell(m)}</td>`).join('')}<td class="num">${s.started ? s.overall + '%' : '<span class="pill">Not started</span>'}</td><td>${date(s.last_login)}</td></tr>`).join('')}</tbody>
      <tfoot><tr><td>Class average</td>${r.averages.map(a => `<td>${a.completion == null ? '—' : a.completion + '%'} · ${pct(a.best)}</td>`).join('')}<td></td><td></td></tr></tfoot>
    </table></div>` : `<div class="card empty">No students yet. Share the join code <span class="code">${esc(r.cls.join_code)}</span> with your class.</div>`}`;
}

// ---------- Admin pages ----------

function viewAdminReport() {
  const r = admin.platformReport(db);
  return `<h1>Platform report</h1>
    <div class="stat-grid">
      <div class="stat"><b>${r.students}</b><span>students</span></div>
      <div class="stat"><b>${r.teachers}</b><span>teachers</span></div>
      <div class="stat"><b>${r.schools}</b><span>schools</span></div>
      <div class="stat"><b>${r.classes}</b><span>classes</span></div>
      <div class="stat"><b>${r.lessonsDone}</b><span>lessons completed</span></div>
      <div class="stat"><b>${r.attempts}</b><span>quizzes submitted</span></div>
    </div>
    <h2 class="section">Modules</h2>
    <div class="table-wrap"><table><thead><tr><th>Module</th><th class="num">Quiz attempts</th><th class="num">Average score</th><th class="num">Students passed</th></tr></thead>
      <tbody>${r.modules.map(m => `<tr><td>${esc(m.title)}</td><td class="num">${m.attempts}</td><td class="num">${pct(m.avg_score)}</td><td class="num">${m.passed}</td></tr>`).join('')}</tbody></table></div>
    <h2 class="section">Questions students find hardest</h2>
    ${r.hardest.length ? `<div class="table-wrap"><table><thead><tr><th>Question</th><th>Module</th><th class="num">Answered</th><th class="num">Correct</th></tr></thead>
      <tbody>${r.hardest.map(q => `<tr><td>${esc(q.question_text)}</td><td>${esc(q.title)}</td><td class="num">${q.answered}</td><td class="num">${q.pct_correct}%</td></tr>`).join('')}</tbody></table></div>`
      : '<p class="muted">Not enough answers yet. A question appears here once it has been answered three times.</p>'}`;
}

function viewTeachers() {
  const list = admin.listTeachers(db), schools = admin.listSchools(db);
  return `<h1>Teachers</h1>
    <div class="table-wrap"><table><thead><tr><th>Name</th><th>Username</th><th>School</th><th class="num">Classes</th><th>Last login</th><th>Status</th><th>Actions</th></tr></thead>
      <tbody>${list.map(t => `<tr><td>${esc(t.full_name)}</td><td>${esc(t.username)}</td><td>${esc(t.school_name)}</td><td class="num">${t.classes}</td><td>${date(t.last_login)}</td>
        <td>${t.is_active ? '<span class="pill ok">Active</span>' : '<span class="pill bad">Deactivated</span>'}</td>
        <td class="row"><button class="btn small ghost" data-act="toggle-active" data-id="${t.user_id}" data-on="${t.is_active ? 0 : 1}">${t.is_active ? 'Deactivate' : 'Activate'}</button>
          <button class="btn small ghost" data-act="reset-pw" data-id="${t.user_id}" data-name="${esc(t.full_name)}">Reset password</button></td></tr>`).join('')}</tbody></table></div>
    <div class="card section narrow">
      <h2>Add a teacher</h2>
      <form data-form="teacher" novalidate>
        <p class="form-error" role="alert"></p>
        <div class="grid-2">
          <label>Full name<input name="fullName" maxlength="80"></label>
          <label>Username<input name="username" maxlength="20"></label>
          <label>Temporary password <span class="hint">At least 8 characters</span><input name="password" type="text" autocomplete="off"></label>
          <label>School<select name="schoolId">${schools.map(s => `<option value="${s.school_id}">${esc(s.name)}</option>`).join('')}</select></label>
        </div>
        <button class="btn">Add teacher</button>
      </form>
    </div>`;
}

function viewSchools() {
  const list = admin.listSchools(db);
  return `<h1>Schools</h1>
    <div class="table-wrap"><table><thead><tr><th>School</th><th>State</th><th>LGA</th><th class="num">Students</th></tr></thead>
      <tbody>${list.map(s => `<tr><td>${esc(s.name)}</td><td>${esc(s.state)}</td><td>${esc(s.lga || '—')}</td><td class="num">${s.students}</td></tr>`).join('')}</tbody></table></div>
    <div class="card section narrow">
      <h2>Add a school</h2>
      <form data-form="school" novalidate>
        <p class="form-error" role="alert"></p>
        <label>School name<input name="name" maxlength="100"></label>
        <div class="grid-2"><label>State<input name="state" maxlength="40"></label><label>LGA <span class="hint">Optional</span><input name="lga" maxlength="60"></label></div>
        <button class="btn">Add school</button>
      </form>
    </div>`;
}

function viewContent() {
  const mods = admin.listAllModules(db);
  return `<h1>Content</h1>
    <p class="muted">Edit modules and lessons, and manage each module's question bank. Each quiz draws 10 questions, so keep at least 10 in every bank.</p>
    <div class="table-wrap"><table><thead><tr><th>#</th><th>Module</th><th class="num">Lessons</th><th class="num">Questions</th><th class="num">Pass mark</th><th>Status</th><th>Actions</th></tr></thead>
      <tbody>${mods.map(m => `<tr><td>${m.sequence_no}</td><td>${esc(m.title)}</td><td class="num">${m.lessons}</td>
        <td class="num">${m.questions}${m.questions < 10 ? ' <span class="pill warn">Too few</span>' : ''}</td><td class="num">${m.pass_mark}%</td>
        <td>${m.is_published ? '<span class="pill ok">Published</span>' : '<span class="pill">Hidden</span>'}</td>
        <td class="row"><a class="btn small ghost" href="#/admin/module/${m.module_id}">Edit</a><a class="btn small ghost" href="#/admin/questions/${m.module_id}">Questions</a></td></tr>`).join('')}</tbody></table></div>`;
}

function viewEditModule(id) {
  const m = db.get('SELECT * FROM modules WHERE module_id = ?', [Number(id)]);
  if (!m) throw new AppError('That module was not found.');
  const lessons = admin.listLessons(db, m.module_id);
  return `<div class="crumbs"><a href="#/admin/content">Content</a> › ${esc(m.title)}</div>
    <h1>Edit module</h1>
    <div class="card narrow">
      <form data-form="module" data-id="${m.module_id}" novalidate>
        <p class="form-error" role="alert"></p>
        <label>Title<input name="title" value="${esc(m.title)}" maxlength="80"></label>
        <label>Description<textarea name="description" style="min-height:80px">${esc(m.description)}</textarea></label>
        <div class="grid-2"><label>Pass mark (%)<input name="passMark" type="number" min="40" max="100" value="${m.pass_mark}"></label>
          <label class="check" style="align-self:end"><input type="checkbox" name="published" ${m.is_published ? 'checked' : ''}> Published (visible to students)</label></div>
        <button class="btn">Save module</button>
      </form>
    </div>
    <h2 class="section">Lessons</h2>
    <div class="table-wrap narrow"><table><thead><tr><th>#</th><th>Title</th><th class="num">Minutes</th><th></th></tr></thead>
      <tbody>${lessons.map(l => `<tr><td>${l.sequence_no}</td><td>${esc(l.title)}</td><td class="num">${l.est_minutes}</td><td><a href="#/admin/lesson/${l.lesson_id}">Edit</a></td></tr>`).join('')}</tbody></table></div>`;
}

function viewEditLesson(id) {
  const l = db.get('SELECT l.*, m.title AS module_title FROM lessons l JOIN modules m ON m.module_id = l.module_id WHERE lesson_id = ?', [Number(id)]);
  if (!l) throw new AppError('That lesson was not found.');
  return `<div class="crumbs"><a href="#/admin/content">Content</a> › <a href="#/admin/module/${l.module_id}">${esc(l.module_title)}</a> › Lesson ${l.sequence_no}</div>
    <h1>Edit lesson</h1>
    <div class="card">
      <form data-form="lesson" data-id="${l.lesson_id}" data-module="${l.module_id}" novalidate>
        <p class="form-error" role="alert"></p>
        <div class="grid-2"><label>Title<input name="title" value="${esc(l.title)}" maxlength="100"></label><label>Reading time (minutes)<input name="minutes" type="number" min="1" max="60" value="${l.est_minutes}"></label></div>
        <label>Content <span class="hint">Blank line between paragraphs. ### heading, - bullet, 1. numbered, &gt; tip, **bold**, *italic*</span>
          <textarea name="content" style="min-height:360px;font-family:ui-monospace,Menlo,monospace;font-size:.9rem">${esc(l.content)}</textarea></label>
        <button class="btn">Save lesson</button>
      </form>
    </div>`;
}

function viewQuestions(id) {
  const m = db.get('SELECT * FROM modules WHERE module_id = ?', [Number(id)]);
  if (!m) throw new AppError('That module was not found.');
  const qs = admin.listQuestions(db, m.module_id);
  return `<div class="crumbs"><a href="#/admin/content">Content</a> › ${esc(m.title)}</div>
    <h1>${esc(m.title)} question bank</h1>
    <p class="muted">${qs.length} questions. Each quiz draws 10 at random.</p>
    <ol class="stack" style="padding-left:1.2em">${qs.map(q => `<li class="card">
      <div class="row spread"><strong>${esc(q.question_text)}</strong><span class="pill">Difficulty ${q.difficulty}</span></div>
      <ul class="q-bank">${q.options.map(o => `<li class="${o.is_correct ? 'correct' : ''}">${esc(o.option_text)}${o.is_correct ? ' ✓' : ''}</li>`).join('')}</ul>
      ${q.explanation ? `<p class="small muted">${esc(q.explanation)}</p>` : ''}
      <button class="btn small ghost" data-act="delete-q" data-id="${q.question_id}">Delete</button>
    </li>`).join('')}</ol>
    <div class="card section narrow">
      <h2>Add a question</h2>
      <form data-form="question" data-id="${m.module_id}" novalidate>
        <p class="form-error" role="alert"></p>
        <label>Question<textarea name="text" style="min-height:70px"></textarea></label>
        ${[0, 1, 2, 3].map(i => `<div class="row" style="flex-wrap:nowrap"><input type="radio" name="correct" value="${i}" aria-label="Option ${'ABCD'[i]} is correct" style="width:auto">
          <input name="opt${i}" placeholder="Option ${'ABCD'[i]}" aria-label="Option ${'ABCD'[i]}"></div>`).join('')}
        <p class="small muted" style="margin:0">Select the circle beside the one correct option.</p>
        <label>Explanation <span class="hint">Shown to students after the quiz</span><textarea name="explanation" style="min-height:70px"></textarea></label>
        <label>Difficulty<select name="difficulty"><option value="1">1 – easy</option><option value="2">2 – medium</option><option value="3">3 – hard</option></select></label>
        <button class="btn">Add question</button>
      </form>
    </div>`;
}

// ---------- Form and button handlers ----------

const forms = {
  async login(f) {
    const u = await auth.login(db, f, lockStore);
    session.set(u.user_id);
    go(home(u));
  },
  async register(f) {
    const u = await auth.registerStudent(db, f);
    session.set(u.user_id);
    toast(`Welcome to ${esc(u.class_name)}, ${esc(u.full_name.split(' ')[0])}!`);
    go('/dashboard');
  },
  async password(f) {
    await auth.changePassword(db, me.user_id, f);
    toast('Password changed.');
    render();
  },
  async class(f) {
    const c = await teacher.createClass(db, me.user_id, f);
    toast(`Class created. Join code: <strong>${esc(c.join_code)}</strong>`, 8000);
    render();
  },
  async teacher(f) { await admin.createTeacher(db, f); toast('Teacher added.'); render(); },
  async school(f) { await admin.addSchool(db, f); toast('School added.'); render(); },
  async module(f, el) { await admin.updateModule(db, el.dataset.id, { ...f, published: !!f.published }); toast('Module saved.'); go('/admin/content'); },
  async lesson(f, el) { await admin.updateLesson(db, el.dataset.id, f); toast('Lesson saved.'); go('/admin/module/' + el.dataset.module); },
  async question(f, el) {
    await admin.addQuestion(db, el.dataset.id, { ...f, options: [f.opt0, f.opt1, f.opt2, f.opt3], correct: f.correct ?? -1 });
    toast('Question added.');
    render();
  },
};

const acts = {
  'toggle-nav'(el) { const open = $('#nav').classList.toggle('open'); el.setAttribute('aria-expanded', open); },
  logout() { session.set(null); quizState.set(null); go('/'); },
  flag(el) {
    if (el.classList.contains('found')) return;
    el.classList.add('found');
    const li = document.createElement('li');
    li.textContent = el.dataset.why;
    $('#spot-found').append(li);
    const n = document.querySelectorAll('.flag.found').length, all = document.querySelectorAll('.flag').length;
    $('#spot-score').textContent = n === all ? `All ${all} found. Well done!` : `${n} of ${all} found`;
  },
  'flag-all'() { document.querySelectorAll('.flag:not(.found)').forEach(acts.flag); },
  'fill-login'(el) {
    const f = $('form[data-form="login"]');
    f.username.value = el.dataset.u; f.password.value = el.dataset.p; f.querySelector('button').focus();
  },
  async 'reset-demo'() {
    if (!confirm('Reset all data on this device back to the demo data? Accounts and progress created here will be removed.')) return;
    await storage.clear().catch(() => {});
    session.set(null); quizState.set(null);
    location.hash = '/';
    location.reload();
  },
  async 'complete-lesson'(el) {
    const r = await content.completeLesson(db, me.user_id, el.dataset.id);
    announceBadges(r.newBadges);
    go(r.next ? '/lesson/' + r.next.lesson_id : '/module/' + r.module.slug);
  },
  scenario(el) {
    const r = content.answerScenario(db, me.user_id, el.dataset.id);
    el.closest('.choices').querySelectorAll('.choice').forEach(b => b.classList.remove('best', 'notbest'));
    el.classList.add(r.is_best ? 'best' : 'notbest');
    const fb = $('#sc-feedback');
    fb.hidden = false;
    fb.innerHTML = `<strong>${r.is_best ? 'Good choice.' : 'Think again.'}</strong> ${esc(r.feedback)}`;
  },
  'new-quiz'(el, e) {
    e.preventDefault();
    const q = quizState.get();
    if (q?.slug === el.dataset.slug) quizState.set(null);
    go('/quiz/' + el.dataset.slug);
  },
  answer(el) {
    const q = quizState.get();
    q.answers[el.dataset.q] = Number(el.value);
    quizState.set(q);
    document.querySelectorAll('.q-dots button')[q.idx]?.classList.add('answered');
    $('#q-count').textContent = Object.keys(q.answers).length;
  },
  'quiz-nav'(el) {
    const q = quizState.get();
    q.idx = Math.max(0, Math.min(q.questions.length - 1, Number(el.dataset.to)));
    quizState.set(q);
    render();
  },
  async 'submit-quiz'() {
    const q = quizState.get();
    const missing = q.questions.length - Object.keys(q.answers).length;
    if (missing && !confirm(`You have ${missing} unanswered question${missing > 1 ? 's' : ''}. Unanswered questions are marked wrong. Submit anyway?`)) return;
    const r = await quiz.submitQuiz(db, me.user_id, q.attemptId, q.answers);
    quizState.set(null);
    announceBadges(r.newBadges);
    go('/result/' + r.attempt_id);
  },
  csv() {
    const blob = new Blob(['﻿' + teacher.reportCsv(lastReport)], { type: 'text/csv' });
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `${lastReport.cls.name.replace(/\W+/g, '-')}-progress.csv` });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  },
  print() { window.print(); },
  async 'toggle-active'(el) { await admin.setActive(db, me.user_id, el.dataset.id, el.dataset.on === '1'); render(); },
  async 'reset-pw'(el) {
    const pw = prompt(`New temporary password for ${el.dataset.name} (at least 8 characters):`);
    if (pw == null) return;
    await admin.resetPassword(db, el.dataset.id, pw);
    toast('Password reset. Give the new password to the teacher.');
  },
  async 'reset-student-pw'(el) {
    const pw = prompt(`New password for ${el.dataset.name} (at least 8 characters):`);
    if (pw == null) return;
    await teacher.resetStudentPassword(db, me.user_id, el.dataset.id, pw);
    lockStore.set('fail:' + el.dataset.username.toLowerCase(), { count: 0, until: 0 });
    toast('Password reset. Give the new password to the student.');
  },
  async 'delete-q'(el) {
    if (!confirm('Delete this question from the bank?')) return;
    await admin.deleteQuestion(db, el.dataset.id);
    render();
  },
};

function showError(form, e) {
  if (!(e instanceof AppError)) console.error(e);
  const box = form?.querySelector('.form-error');
  form?.querySelectorAll('[aria-invalid]').forEach(x => x.removeAttribute('aria-invalid'));
  if (box) {
    box.textContent = e.message;
    const field = e.field && form.elements[e.field];
    if (field?.setAttribute) { field.setAttribute('aria-invalid', 'true'); field.focus(); }
  } else toast(esc(e.message));
}

document.addEventListener('submit', async e => {
  const form = e.target.closest('form[data-form]');
  if (!form) return;
  e.preventDefault();
  const btn = form.querySelector('button:not([type="button"])');
  btn && (btn.disabled = true);
  try { await forms[form.dataset.form](Object.fromEntries(new FormData(form)), form); }
  catch (err) { showError(form, err); }
  finally { if (btn?.isConnected) btn.disabled = false; }
});

document.addEventListener('click', async e => {
  const el = e.target.closest('[data-act]');
  if (!el || el.matches('input[type="radio"]')) return;
  try { await acts[el.dataset.act]?.(el, e); }
  catch (err) { showError(null, err); }
});
document.addEventListener('change', e => { if (e.target.matches('input[data-act="answer"]')) acts.answer(e.target); });

// ---------- Start-up ----------

function showNet() {
  const n = $('#net');
  n.classList.toggle('off', !navigator.onLine);
  n.textContent = navigator.onLine ? 'Online.' : 'Offline mode.';
}

async function boot() {
  showNet();
  addEventListener('online', showNet);
  addEventListener('offline', showNet);
  if (location.protocol === 'file:') {
    $('#boot').innerHTML = '<h1>Start the local server</h1><p>This app cannot run from a file. In the project folder, run <code>npm start</code> and open the address it prints.</p>';
    return;
  }
  try {
    const SQL = await window.initSqlJs({ locateFile: f => 'js/vendor/' + f });
    let store = storage;
    try { await storage.open().then(d => d.close()); } catch { store = null; toast('This browser cannot save data, so progress will be lost when you close the page.', 8000); }
    db = await openDatabase({ SQL, storage: store, loadSeed });
  } catch (e) {
    console.error(e);
    $('#boot').innerHTML = `<h1>Could not start</h1><p>${esc(e.message)}</p><p>Connect to the internet once so the lessons can download, then reload the page.</p>`;
    return;
  }
  addEventListener('hashchange', render);
  render();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(e => console.warn('Offline support unavailable:', e));
}

boot();
