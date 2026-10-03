import { mkdir, chown } from 'node:fs/promises';
// Mounted volumes can hide the image's /data ownership. Initialize only the
// mount root, then irrevocably drop privileges before importing the Program.
if (process.getuid?.() === 0) {
  await mkdir('/data', { recursive: true });
  await chown('/data', 1000, 1000);
  process.setgroups([]);
  process.setgid(1000);
  process.setuid(1000);
}
await import('./server.ts');
