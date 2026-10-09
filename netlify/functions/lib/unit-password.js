// Unit portal password helpers (shared by unit-api, stripe-webhook, create-free-permit).
// Passwords are stored as  scrypt$<salt>$<hash>  — never as plain text.
// Older plain-text passwords still verify, and get upgraded on next login.

const crypto = require('crypto');

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 32).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

function isHashed(stored) {
  return typeof stored === 'string' && stored.startsWith('scrypt$');
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a)), bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

function verifyPassword(password, stored) {
  if (!stored || !password) return false;
  if (!isHashed(stored)) return safeEqual(password, stored); // legacy plain text
  const [, salt, hash] = stored.split('$');
  if (!salt || !hash) return false;
  const test = crypto.scryptSync(String(password), salt, 32).toString('hex');
  return safeEqual(test, hash);
}

function generatePassword(length = 10) {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  const bytes = crypto.randomBytes(length);
  return Array.from(bytes, b => chars[b % chars.length]).join('');
}

module.exports = { hashPassword, verifyPassword, isHashed, generatePassword };
