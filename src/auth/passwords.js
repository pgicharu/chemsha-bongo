// Password hashing with argon2id (salt and parameters live in the hash string).

import argon2 from 'argon2';

export function hashPassword(password) {
  return argon2.hash(password, { type: argon2.argon2id });
}

export function verifyPassword(hash, password) {
  return argon2.verify(hash, password);
}

// Verified against for unknown emails so login timing does not reveal which accounts exist.
const dummyHash = hashPassword('not-a-real-password-just-for-timing');

export async function verifyAgainstDummy(password) {
  await argon2.verify(await dummyHash, password);
  return false;
}
