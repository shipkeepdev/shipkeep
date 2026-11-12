// Creates the key-encryption key of an installation when it does not exist (SPEC section 9).
// Runs once from the control plane image, before the API starts: `node setup/ensure-kek.mjs`.
// An existing file is never replaced: losing the KEK makes every stored secret unreadable.
import { randomBytes } from 'node:crypto';
import { closeSync, openSync, statSync, writeSync } from 'node:fs';

const path = process.env['SHIPKEEP_KEK_FILE'];
if (!path) {
  console.error('SHIPKEEP_KEK_FILE is not set.');
  process.exit(1);
}

let descriptor;
try {
  // "wx" fails when the file exists, so two starts can never write two different keys.
  descriptor = openSync(path, 'wx', 0o400);
} catch (error) {
  if (error.code !== 'EEXIST') {
    console.error(`Cannot create the key-encryption key at ${path} (${error.code}).`);
    process.exit(1);
  }
}

if (descriptor === undefined) {
  const info = statSync(path);
  if (!info.isFile() || info.size === 0 || (info.mode & 0o077) !== 0) {
    console.error(
      `The key-encryption key at ${path} is empty or readable by others. Not touching it.`,
    );
    process.exit(1);
  }
  console.log(`Key-encryption key present at ${path}.`);
} else {
  try {
    writeSync(descriptor, randomBytes(32));
  } finally {
    closeSync(descriptor);
  }
  console.log(`Generated the key-encryption key at ${path}. Back it up: it cannot be recreated.`);
}
