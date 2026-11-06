import { test } from 'node:test';
import assert from 'node:assert/strict';
import { noreplyAvatar, parseGitHubRemote } from '../src/avatars.js';

test('noreplyAvatar decodes GitHub noreply addresses', () => {
  assert.equal(noreplyAvatar('12345+octocat@users.noreply.github.com'), 'https://avatars.githubusercontent.com/u/12345?s=48&v=4');
  assert.equal(noreplyAvatar('octocat@users.noreply.github.com'), undefined);
  assert.equal(noreplyAvatar('a@b.c'), undefined);
});

test('parseGitHubRemote handles ssh and https forms', () => {
  assert.deepEqual(parseGitHubRemote('git@github.com:richard-grosjean/git-wave.git'), { owner: 'richard-grosjean', repo: 'git-wave' });
  assert.deepEqual(parseGitHubRemote('https://github.com/git/git'), { owner: 'git', repo: 'git' });
  assert.deepEqual(parseGitHubRemote('https://github.com/git/git.git/'), { owner: 'git', repo: 'git' });
  assert.equal(parseGitHubRemote('https://invent.kde.org/utilities/kwi.git'), undefined);
  assert.equal(parseGitHubRemote(undefined), undefined);
});
