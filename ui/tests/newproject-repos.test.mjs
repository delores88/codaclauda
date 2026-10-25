import test from 'node:test';
import assert from 'node:assert/strict';
import { cloneableRepos } from '../app/newproject-repos.js';

const ghost = fullName => ({ id: `gh:${fullName.toLowerCase()}`, ids: [], path: '' });

test('a manifest-only ghost stays selectable before and after loading another account inventory', () => {
  const project = ghost('OtherOwner/City'), expected = { full_name: 'OtherOwner/City', name: 'City' };
  assert.deepEqual(cloneableRepos([], [project], 'OtherOwner/City'), [expected]);
  const inventory = Array.from({ length: 305 }, (_, i) => ({ full_name: `me/repo-${i}`, name: `repo-${i}` }));
  const candidates = cloneableRepos(inventory, [project], 'OtherOwner/City');
  assert.deepEqual(candidates[0], expected, 'the requested ghost is within the visible list limit');
  assert.equal(candidates.length, 306);
  assert.equal(inventory.length, 305, 'selection does not alter the fetched inventory');
  assert.equal(Object.hasOwn(candidates[0], 'private'), false, 'an identity does not imply fetched access metadata');
});

test('a fetched repository wins over the fallback identity regardless of casing', () => {
  const fetched = { full_name: 'OtherOwner/City', name: 'City', private: true, description: 'Fetched description' };
  const candidates = cloneableRepos([{ full_name: 'me/elsewhere', name: 'elsewhere' }, fetched], [ghost('OtherOwner/City')], 'otherowner/city');
  assert.equal(candidates[0], fetched);
  assert.equal(candidates.filter(r => r.full_name.toLowerCase() === 'otherowner/city').length, 1);
});

test('a newly linked folder removes the requested repository instead of offering another clone', () => {
  const project = { id: 'local:c:/projects/city', ids: ['GH:OtherOwner/City'], path: 'C:/projects/City' };
  const fetched = { full_name: 'otherowner/city', name: 'city' };
  assert.deepEqual(cloneableRepos([fetched], [project], 'OtherOwner/City'), []);
  assert.deepEqual(cloneableRepos([], [project], 'OtherOwner/City'), []);
  assert.deepEqual(cloneableRepos([], [{ ...project, path: '   ' }], 'OtherOwner/City'), [{ full_name: 'OtherOwner/City', name: 'City' }]);
});

test('the fallback accepts only a known full repository identity with a safe native folder name', () => {
  assert.deepEqual(cloneableRepos([], [], 'owner/unrelated'), []);
  for (const fullName of ['https://github.com/owner/repo', 'owner/../repo', 'owner/..', 'owner/.git', '-owner/repo', 'owner/-repo', 'owner/repo.', 'owner/CON.txt', 'owner/LPT0', 'owner/repo name', 'owner/repo\\child', 'owner/repo?x=1']) {
    assert.deepEqual(cloneableRepos([], [ghost(fullName)], fullName), [], fullName);
  }
  assert.deepEqual(cloneableRepos([], [ghost('owner/.github')], 'owner/.github'), [{ full_name: 'owner/.github', name: '.github' }]);
});
