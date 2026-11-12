import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRemoteUrl, pullRequestUrl } from '../src/git/remote-url.js';

test('parseRemoteUrl handles scp, ssh and https forms', () => {
  assert.deepEqual(parseRemoteUrl('git@github.com:acme/app.git'), { host: 'github.com', path: 'acme/app' });
  assert.deepEqual(parseRemoteUrl('ssh://git@gitlab.example.com:2222/grp/sub/app.git'), { host: 'gitlab.example.com', path: 'grp/sub/app' });
  assert.deepEqual(parseRemoteUrl('https://user@bitbucket.org/acme/app.git/'), { host: 'bitbucket.org', path: 'acme/app' });
  assert.deepEqual(parseRemoteUrl('https://github.com/acme/app'), { host: 'github.com', path: 'acme/app' });
  assert.equal(parseRemoteUrl('/srv/git/app.git'), undefined);
  assert.equal(parseRemoteUrl(undefined), undefined);
});

test('pullRequestUrl builds per-host compare pages', () => {
  assert.equal(pullRequestUrl('git@github.com:acme/app.git', 'feat/x y'), 'https://github.com/acme/app/compare/feat/x%20y?expand=1');
  assert.equal(pullRequestUrl('git@gitlab.com:grp/app.git', 'feat/x'), 'https://gitlab.com/grp/app/-/merge_requests/new?merge_request%5Bsource_branch%5D=feat%2Fx');
  assert.equal(pullRequestUrl('git@bitbucket.org:acme/app.git', 'fix'), 'https://bitbucket.org/acme/app/pull-requests/new?source=fix');
  assert.equal(pullRequestUrl('git@example.com:acme/app.git', 'fix'), undefined);
});
