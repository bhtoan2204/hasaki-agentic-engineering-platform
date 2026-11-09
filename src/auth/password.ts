import { hash, verify, Algorithm } from "@node-rs/argon2";

const options = {
  algorithm: Algorithm.Argon2id,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
};

export function assertPassword(password: string) {
  if (typeof password !== "string" || password.length < 10 || password.length > 200) {
    throw new Error("password must be 10 to 200 characters");
  }
}

export function hashPassword(password: string) {
  assertPassword(password);
  return hash(password, options);
}

export function verifyPassword(stored: string, password: string) {
  return verify(stored, password, options);
}
