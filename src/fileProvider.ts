import * as vscode from 'vscode';
import type { Repository } from './git/repository';

export const SCHEME = 'gitwave-git';

/** Serves `gitwave-git:/<relpath>?root=<repo>&ref=<hash>` so commits can be diffed without the Git extension. */
export class GitFileProvider implements vscode.TextDocumentContentProvider {
  constructor(private readonly repoFor: (root: string) => Repository | undefined) {}

  static uri(root: string, ref: string, relPath: string): vscode.Uri {
    return vscode.Uri.from({ scheme: SCHEME, path: '/' + relPath, query: new URLSearchParams({ root, ref }).toString() });
  }

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const q = new URLSearchParams(uri.query);
    const root = q.get('root') ?? '';
    const ref = q.get('ref') ?? '';
    const repo = this.repoFor(root);
    if (!repo) return '';
    try {
      return await repo.fileAt(ref, uri.path.replace(/^\//, ''));
    } catch {
      return '';
    }
  }
}
