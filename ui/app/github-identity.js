/* Exact GitHub repository identity; no basename/fork guessing or network lookup. */
export function githubIdentity(value, { allowSlug = false } = {}) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  let path;
  if (/^(?:[a-z\d._-]+@)?github\.com:/i.test(text)) path = text.slice(text.indexOf(':') + 1);
  else if (/^[a-z][a-z\d+.-]*:\/\//i.test(text)) {
    let url;
    try { url = new URL(text); } catch { return null; }
    if (!['https:', 'http:', 'ssh:', 'git:'].includes(url.protocol) || url.hostname.toLowerCase() !== 'github.com' || url.search || url.hash) return null;
    path = url.pathname.replace(/^\//, '');
  } else if (allowSlug) path = text.replace(/^gh:/i, '');
  else return null;
  path = path.replace(/\/+$/, '').replace(/\.git$/i, '');
  const parts = path.split('/');
  if (parts.length !== 2 || !/^[a-z\d][a-z\d-]{0,38}$/i.test(parts[0]) || !/^[a-z\d_.-]+$/i.test(parts[1]) || /^\.{1,2}$/.test(parts[1])) return null;
  return `gh:${parts[0].toLowerCase()}/${parts[1].toLowerCase()}`;
}
