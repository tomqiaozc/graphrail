import { closeSync, existsSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

export function withLock(path, fn) {
  if (existsSync(path)) {
    try {
      const current = JSON.parse(readFileSync(path, "utf8"));
      if (alive(current.pid)) throw new Error(`session is locked by pid ${current.pid}`);
    } catch (error) {
      if (error.message.startsWith("session is locked")) throw error;
    }
    unlinkSync(path);
  }
  const descriptor = openSync(path, "wx");
  writeFileSync(descriptor, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
  closeSync(descriptor);
  try { return fn(); } finally { if (existsSync(path)) unlinkSync(path); }
}
