import { spawn } from 'bun';

export async function loadSopsDecrypted(path: string): Promise<Record<string, string>> {
  const proc = spawn(['sops', '-d', '--input-type', 'dotenv', '--output-type', 'dotenv', path], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    throw new Error(`sops decrypt failed (${String(exitCode)}): ${stderr}`);
  }
  const out: Record<string, string> = {};
  for (const line of stdout.split('\n')) {
    const [k, ...rest] = line.split('=');
    if (!k || k.startsWith('#')) continue;
    out[k.trim()] = rest.join('=').trim();
  }
  return out;
}
