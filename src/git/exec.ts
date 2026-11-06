import { spawn } from 'node:child_process';
import * as vscode from 'vscode';

export class GitError extends Error {
  constructor(message: string, readonly args: string[], readonly code: number | null, readonly stderr: string) {
    super(message);
  }
}

let gitPath = 'git';
export function setGitPath(p: string | undefined): void {
  gitPath = p && p.trim() ? p : 'git';
}

export interface GitResult { stdout: string; stderr: string }

export function git(cwd: string, args: string[], opts: { token?: vscode.CancellationToken; maxBuffer?: number } = {}): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(gitPath, args, {
      cwd,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C.UTF-8' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on('data', (d: Buffer) => out.push(d));
    child.stderr.on('data', (d: Buffer) => err.push(d));
    const sub = opts.token?.onCancellationRequested(() => child.kill());
    child.on('error', (e) => { sub?.dispose(); reject(new GitError(e.message, args, null, '')); });
    child.on('close', (code) => {
      sub?.dispose();
      const stdout = Buffer.concat(out).toString('utf8');
      const stderr = Buffer.concat(err).toString('utf8');
      if (code === 0) resolve({ stdout, stderr });
      else reject(new GitError(stderr.trim() || `git ${args[0]} exited with ${code}`, args, code, stderr));
    });
  });
}
