// Usage: npm run release -- <patch|minor|major|x.y.z>
// Bumps package.json, updates CHANGELOG heading, commits, tags vX.Y.Z and pushes.
// The Release workflow then publishes to the Marketplace and creates the GitHub release.
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const kind = process.argv[2];
if (!kind) { console.error('usage: npm run release -- <patch|minor|major|x.y.z>'); process.exit(1); }
const run = (cmd) => execSync(cmd, { stdio: 'inherit' });
const out = (cmd) => execSync(cmd, { encoding: 'utf8' }).trim();

if (out('git status --porcelain')) { console.error('Working tree is not clean.'); process.exit(1); }
if (out('git branch --show-current') !== 'main') { console.error('Release from main.'); process.exit(1); }

run('npm run typecheck'); run('npm test');
const version = out(`npm version ${kind} --no-git-tag-version`).replace(/^v/, '');

const changelog = readFileSync('CHANGELOG.md', 'utf8');
const today = new Date().toISOString().slice(0, 10);
const updated = changelog.includes('## Unreleased')
  ? changelog.replace('## Unreleased', `## ${version} (${today})`)
  : changelog.replace('# Changelog\n', `# Changelog\n\n## ${version} (${today})\n\n- \n`);
writeFileSync('CHANGELOG.md', updated);

run('git add package.json package-lock.json CHANGELOG.md');
run(`git commit -m "Release v${version}"`);
run(`git tag -a v${version} -m "v${version}"`);
run('git push --follow-tags');
console.log(`\nTagged v${version}. The Release workflow will publish it.`);
