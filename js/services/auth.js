// Authentication module: registration, login and account checks.
import { now } from '../db.js';
import { hashPassword, verifyPassword } from './crypto.js';
import { AppError, need } from './errors.js';

export const USERNAME_RE = /^[A-Za-z0-9_]{3,20}$/;
const MAX_FAILS = 5, LOCK_MINUTES = 15;

export function validatePassword(password, confirm) {
  need(password && password.length >= 8, 'Password must be at least 8 characters.', 'password');
  if (confirm !== undefined) need(password === confirm, 'Passwords do not match.', 'confirm');
}

export async function registerStudent(db, { fullName, username, password, confirm, joinCode }) {
  fullName = (fullName || '').trim(); username = (username || '').trim(); joinCode = (joinCode || '').trim().toUpperCase();
  need(fullName && username && password && confirm && joinCode, 'All fields are required.');
  need(fullName.length <= 80, 'Name must be 80 characters or fewer.', 'fullName');
  need(USERNAME_RE.test(username), 'Username must be 3–20 letters, numbers or underscores.', 'username');
  validatePassword(password, confirm);
  const cls = db.get('SELECT class_id, school_id FROM classes WHERE join_code = ?', [joinCode]);
  need(cls, 'That join code was not found. Check it with your teacher.', 'joinCode');
  need(!db.get('SELECT 1 FROM users WHERE username = ? COLLATE NOCASE', [username]), 'That username is already taken.', 'username');
  const hash = await hashPassword(password);
  return db.tx(d => {
    const id = d.run('INSERT INTO users (full_name, username, password_hash, role, class_id, school_id, last_login) VALUES (?,?,?,?,?,?,?)',
      [fullName, username, hash, 'student', cls.class_id, cls.school_id, now()]).lastId;
    return publicUser(d, id);
  });
}

// lockStore keeps failed-login counts: { get(key), set(key, value) }.
export async function login(db, { username, password }, lockStore) {
  username = (username || '').trim();
  need(username && password, 'Enter your username and password.');
  const key = 'fail:' + username.toLowerCase();
  const rec = lockStore?.get(key) || { count: 0, until: 0 };
  if (rec.until > Date.now()) {
    const mins = Math.ceil((rec.until - Date.now()) / 60000);
    throw new AppError(`Too many failed attempts. Try again in ${mins} minute${mins > 1 ? 's' : ''}.`);
  }
  const u = db.get('SELECT * FROM users WHERE username = ? COLLATE NOCASE', [username]);
  const ok = u && await verifyPassword(password, u.password_hash);
  if (!ok) {
    rec.count += 1;
    if (rec.count >= MAX_FAILS) { rec.count = 0; rec.until = Date.now() + LOCK_MINUTES * 60000; }
    lockStore?.set(key, rec);
    throw new AppError('Incorrect username or password.');
  }
  need(u.is_active, 'This account has been deactivated. Contact your administrator.');
  lockStore?.set(key, { count: 0, until: 0 });
  await db.tx(d => d.run('UPDATE users SET last_login = ? WHERE user_id = ?', [now(), u.user_id]));
  return publicUser(db, u.user_id);
}

export function publicUser(db, id) {
  return db.get(`SELECT u.user_id, u.full_name, u.username, u.role, u.class_id, u.school_id, u.is_active,
      c.name AS class_name, s.name AS school_name
    FROM users u LEFT JOIN classes c ON c.class_id = u.class_id LEFT JOIN schools s ON s.school_id = u.school_id
    WHERE u.user_id = ?`, [id]);
}

// Access control: returns the user if they are active and have one of the roles.
export function requireRole(db, userId, ...roles) {
  const u = userId && publicUser(db, userId);
  if (!u || !u.is_active || (roles.length && !roles.includes(u.role))) throw new AppError('You do not have access to this page.');
  return u;
}

export async function changePassword(db, userId, { current, password, confirm }) {
  const u = db.get('SELECT password_hash FROM users WHERE user_id = ?', [userId]);
  need(u && await verifyPassword(current || '', u.password_hash), 'Your current password is incorrect.', 'current');
  validatePassword(password, confirm);
  const hash = await hashPassword(password);
  await db.tx(d => d.run('UPDATE users SET password_hash = ? WHERE user_id = ?', [hash, userId]));
}
