/* Clone-dialog candidates. Pure selection only: cloning still requires the dialog's
 * explicit submit and the native repository and destination validation. */
const RESERVED_FOLDER = /^(con|prn|aux|nul|com\d|lpt\d)$/i;
const idsOf = project => [project?.id, ...(Array.isArray(project?.ids) ? project.ids : [])]
  .filter(id => typeof id === 'string').map(id => id.toLowerCase());

function validFullName(value) {
  if (typeof value !== 'string') return false;
  const parts = value.split('/');
  if (parts.length !== 2) return false;
  const [owner, name] = parts;
  // Match the native clone folder restrictions; a manifest identity is not a URL
  // or permission to bypass the existing native clone_target checks.
  return /^[a-z0-9][a-z0-9-]{0,38}$/i.test(owner)
    && /^[a-z0-9._-]{1,100}$/i.test(name)
    && !name.startsWith('-') && !name.endsWith('.')
    && name.toLowerCase() !== '.git' && !RESERVED_FOLDER.test(name.split('.')[0]);
}

export function cloneableRepos(repos, projects, requestedRepo = '') {
  const local = new Set(projects.filter(p => typeof p.path === 'string' && p.path.trim())
    .flatMap(idsOf).filter(id => id.startsWith('gh:')));
  const candidates = new Map();
  for (const repo of repos) if (repo?.full_name) {
    const key = String(repo.full_name).toLowerCase();
    if (!local.has(`gh:${key}`) && !candidates.has(key)) candidates.set(key, repo);
  }
  const requestedKey = typeof requestedRepo === 'string' ? requestedRepo.toLowerCase() : '';
  // A ghost from the project manifest may belong to another account and therefore
  // never appear in the linked account's repository inventory. Keep that known
  // identity selectable, without inventing fetched visibility or access metadata.
  if (validFullName(requestedRepo) && !local.has(`gh:${requestedKey}`)
      && projects.some(p => idsOf(p).includes(`gh:${requestedKey}`)) && !candidates.has(requestedKey)) {
    candidates.set(requestedKey, { full_name: requestedRepo, name: requestedRepo.split('/')[1] });
  }
  const selected = candidates.get(requestedKey);
  if (selected) candidates.delete(requestedKey);
  // Keep the requested building visible even when the dialog truncates a long list.
  return selected ? [selected, ...candidates.values()] : [...candidates.values()];
}
