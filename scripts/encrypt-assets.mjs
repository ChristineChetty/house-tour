#!/usr/bin/env node
// Encrypts the stage 5 exports for publishing. The password is typed at a hidden prompt
// and is never written anywhere.
//
//   npm run encrypt                 # reads ../export
//   npm run encrypt -- <export dir>
//
// Output: public/models/<name>.glb.enc and public/spawns.json.enc
// Layout: salt (16) | iv (12) | AES-256-GCM ciphertext + 16-byte tag (matches src/crypto.js).
// One random salt per run (so the browser derives the key once), a fresh IV per file.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const ITERATIONS = 600000;
const MAX_FILE = 100 * 1024 * 1024; // GitHub's per-file limit

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const exportDir = path.resolve(process.argv[2] ?? path.join(root, '..', 'export'));
const FILES = [
  ['spawns.json', 'public/spawns.json.enc'],
  ['collision.glb', 'public/models/collision.glb.enc'],
  ['collision_furniture.glb', 'public/models/collision_furniture.glb.enc'],
  ['house_unfurnished.glb', 'public/models/house_unfurnished.glb.enc'],
  ['house_furnished.glb', 'public/models/house_furnished.glb.enc'],
];

function askHidden(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    let muted = false;
    rl._writeToOutput = (s) => {
      if (!muted) process.stdout.write(s);
    };
    // Print the question ourselves: readline may write it after `muted` is set, which hid it.
    process.stdout.write(question);
    rl.question('', (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
    muted = true;
  });
}

const mb = (n) => `${(n / 1024 / 1024).toFixed(1)} MB`;

if (!process.stdin.isTTY) {
  console.error('Run this in a terminal so the password can be typed at a hidden prompt.');
  process.exit(1);
}

const missing = FILES.filter(([src]) => !fs.existsSync(path.join(exportDir, src))).map(([src]) => src);
if (missing.length) {
  console.error(`Missing in ${exportDir}: ${missing.join(', ')}`);
  process.exit(1);
}

const password = await askHidden('Tour password: ');
if ((await askHidden('Repeat password: ')) !== password) {
  console.error('Passwords do not match. Nothing written.');
  process.exit(1);
}
if (password.length < 16) {
  console.warn('Warning: short password. Four or more random words is much safer for a public site.');
}

const salt = crypto.randomBytes(16);
const key = crypto.pbkdf2Sync(password, salt, ITERATIONS, 32, 'sha256');

for (const [src, dest] of FILES) {
  const plain = fs.readFileSync(path.join(exportDir, src));
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const out = Buffer.concat([salt, iv, cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
  const target = path.join(root, dest);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, out);
  console.log(`${dest.padEnd(42)} ${mb(out.length).padStart(9)}${out.length > MAX_FILE ? '  ** over 100 MB, GitHub will reject it **' : ''}`);
}
console.log('Done. Only these .enc files are published; the plaintext stays in ../export.');
