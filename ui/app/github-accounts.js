/* Owned GitHub accounts and cloning (Projects view).
 * Accounts: the main account (always part of the City) plus more accounts you own. Each extra
 * account is either part of the main city or its own island on the same level beside it
 * (contributor islands, repos other people added you to, stay below). Cloning: pick an account's
 * repos that are not on this PC, one by one or all at once, into a folder CodaClauda suggests on
 * the Desktop (changeable). Each clone is linked and scanned, so its lot's "Clone to build" sign
 * becomes a building. Tokens never reach the UI: the GitHub CLI runs as each signed-in account
 * natively (desktop.rs account_token). */
import { h, icon, modal, toast, plural, formatBytes, timeAgo } from './ui.js';
import { cloneableRepos } from './newproject-repos.js';

const LOGIN = /^[a-z\d](?:[a-z\d-]{0,38})$/i;
const lower = value => String(value || '').toLowerCase();
const joinPath = (dir, ...parts) => [String(dir || '').replace(/[\\/]+$/, ''), ...parts].join('\\');

/** Suggested clone folder for an account: Desktop\GitHub\<account>. */
export function defaultCloneDir(store, account) {
  return joinPath(store.paths?.desktop_dir || store.paths?.home_dir || 'C:', 'GitHub', account);
}
export function cloneDirFor(store, account) {
  return String(store.prefs?.[`cloneFolder:${lower(account)}`] || defaultCloneDir(store, account));
}
/** Repos of one owned account that are not on this PC yet. */
export function uncloned(store, account) {
  const entry = store.githubAccounts.find(a => lower(a.user) === lower(account));
  return entry ? cloneableRepos(entry.repos || [], store.projects) : [];
}
const sizeOf = repos => repos.reduce((sum, repo) => sum + (Number(repo.size_kb) || 0) * 1024, 0);

/** A successful clone is never repeated just because its local scan/link failed. */
export async function cloneAndLinkRepo({ store, bridge, repo, parentDir, account, row }) {
  if (!row.path) {
    const result = await bridge.desktop.cloneRepo({ fullName: repo.full_name, parentDir, account, createParent: true });
    row.path = result.path;
  }
  await store.linkFolder(row.path);
  return row.path;
}

/** One choice for all your extra accounts: one big city, or each account its own island. */
function layoutControl(current, onPick) {
  const option = (value, label, hint) => h('label.gha-mode-opt', { title: hint },
    h('input', { type: 'radio', name: 'gha-layout', value, checked: current === value, onchange: () => onPick(value) }), h('span', label));
  return h('div.gha-mode', { role: 'radiogroup', 'aria-label': 'Where your other accounts appear in the City' },
    option('city', 'One big city', "Every account's repos join Downtown in your main city"),
    option('islands', 'Each account its own island', 'Each other account gets its own island beside your main city, on the same level'));
}

/** Accounts dialog: list, mode, refresh, clone, remove; add another signed-in or typed account. */
export function openGithubAccounts({ store, bridge }) {
  const list = h('ul.gha-list');
  const addSelect = h('select.input', { 'aria-label': 'Signed-in GitHub CLI account' });
  const addInput = h('input.input', { type: 'text', placeholder: 'or type a GitHub username', autocomplete: 'off', spellcheck: 'false', 'aria-label': 'GitHub username' });
  const layoutSlot = h('div.gha-layout');
  const error = h('p.proj-error', { hidden: true, role: 'alert' });
  const addButton = h('button.btn.primary', { type: 'button', onclick: () => add() }, icon('plus'), 'Add account');
  let signedIn = [], listSig = '';

  function render() {
    const accounts = store.githubAccounts;
    // The store changes often; rebuild only when an account changes, so focus stays on the radios.
    const sig = JSON.stringify([store.accountLayout, signedIn.map(a => a.login), accounts.map(a => [a.user, (a.repos || []).length, uncloned(store, a.user).length, a.fetchedAt ? timeAgo(a.fetchedAt) : ''])]);
    if (sig === listSig) return;
    listSig = sig;
    layoutSlot.replaceChildren(h('h3', 'Your other accounts in the City'), layoutControl(store.accountLayout, value => store.setAccountLayout(value)),
      h('p.field-hint', store.accountLayout === 'islands'
        ? 'Each account below your main one gets its own island beside your city, on the same level, joined by a bridge.'
        : "Every account's repos are buildings in one city."));
    list.replaceChildren(...(accounts.length ? accounts.map(account => {
      const repos = account.repos || [], waiting = uncloned(store, account.user).length;
      const refresh = h('button.btn.small', { type: 'button', title: `Refresh @${account.user}`, onclick: async event => {
        const button = event.currentTarget; button.disabled = true;
        try { if (account.main) await store.linkGithub(account.user); else await store.linkGithubAccount(account.user); toast(`Refreshed @${account.user}`, { kind: 'success', timeout: 2200 }); }
        catch (e) { toast(`Could not refresh @${account.user}: ${e.message}`, { kind: 'error' }); }
        finally { button.disabled = false; }
      } }, icon('refresh'), 'Refresh');
      const clone = h('button.btn.small', { type: 'button', disabled: !waiting, title: waiting ? `Clone repos of @${account.user} to this PC` : 'Every repo is already on this PC',
        onclick: () => openCloneRepos({ store, bridge, account: account.user }) }, icon('download'), waiting ? `Clone… (${waiting})` : 'All cloned');
      const remove = account.main ? null : h('button.btn.small.ghost', { type: 'button', title: `Remove @${account.user} from CodaClauda (nothing is deleted on GitHub or this PC)`,
        onclick: () => { store.removeGithubAccount(account.user); toast(`Removed @${account.user}`, { timeout: 2200 }); } }, icon('close'), 'Remove');
      return h('li.gha-row',
        h('div.gha-who', h('span.gha-icon', icon('github')),
          h('div.gha-name', h('strong', `@${account.user}`), account.main ? h('span.pill.neutral', 'Main account') : null,
            h('span.gha-meta', `${plural(repos.length, 'repo')} · ${plural(repos.length - waiting, 'on this PC', 'on this PC')}${account.fetchedAt ? ` · synced ${timeAgo(account.fetchedAt)}` : ''}`))),
        account.main ? h('p.gha-note', 'Your main city.') : h('p.gha-note', store.accountLayout === 'islands' ? 'Its own island beside your city.' : 'Part of your one big city.'),
        h('div.gha-actions', refresh, clone, remove));
    }) : [h('li.gha-empty', 'No GitHub account linked yet. Connect your main account from Projects first.')]));
    const linked = new Set(accounts.map(a => lower(a.user)));
    const options = signedIn.filter(a => !linked.has(lower(a.login)));
    const kept = addSelect.value;   // the store changes often; keep what the user picked
    addSelect.replaceChildren(h('option', { value: '' }, options.length ? 'Pick a signed-in account…' : 'No other signed-in accounts'), ...options.map(a => h('option', { value: a.login }, `@${a.login}`)));
    addSelect.value = options.some(a => a.login === kept) ? kept : '';
    addSelect.disabled = !options.length;
  }
  async function add() {
    const user = (addInput.value.trim() || addSelect.value).replace(/^@/, '');
    if (!LOGIN.test(user)) { error.textContent = 'Pick a signed-in account or type a GitHub username.'; error.hidden = false; return; }
    error.hidden = true; addButton.disabled = true;
    try {
      const result = await store.linkGithubAccount(user);
      const repos = result?.repos || [], privateCount = repos.filter(r => r.private).length;
      toast(`Added @${result?.user || user} · ${plural(repos.length, 'repository', 'repositories')}${privateCount ? ` (${privateCount} private)` : ''}`, { kind: 'success' });
      addInput.value = ''; addSelect.value = '';
    } catch (e) { error.textContent = `Could not add @${user}: ${e.message}`; error.hidden = false; }
    finally { addButton.disabled = false; }
  }
  const off = () => store.removeEventListener('change', render);
  store.addEventListener('change', render);
  render();
  Promise.resolve().then(() => bridge.desktop.githubAccounts()).then(result => { signedIn = result?.accounts || []; render(); }).catch(() => { /* GitHub CLI missing: typing still works */ });
  const body = h('div.gha',
    h('p.field-hint', 'Every GitHub account you own can appear in the City. Choose once for all of them: one big city, or each account its own island beside your city on the same level. Islands for repos other people added you to always stay below.'),
    layoutSlot,
    list,
    h('section.gha-add',
      h('h3', 'Add an account'),
      h('div.gha-add-row', addSelect, addInput),
      h('p.field-hint', 'To include an account\'s private repos, sign it into the GitHub CLI on this PC first (', h('code', 'gh auth login'), '). Otherwise only its public repos appear.'),
      error,
      h('div.gha-add-actions', addButton)));
  modal({ title: 'GitHub accounts', body, wide: true, actions: [{ label: 'Done' }], onClose: off });
}

/* Clone runs by account. A run outlives its dialog: closing the dialog never stops a clone (the
 * City shows "Cloning…" signs meanwhile), and reopening it for that account shows the same run. */
const runs = new Map();
function runFor(account) {
  return runs.get(lower(account)) || { account, picked: new Set(), running: false, cancel: false, rows: new Map(), views: new Set() };
}
const notify = run => { for (const view of run.views) view(); };

/** Clone dialog: one account's repos not on this PC; tick some or Clone all; pick the folder. */
export function openCloneRepos({ store, bridge, account }) {
  const accounts = store.githubAccounts;
  let state = runFor(account || accounts[0]?.user || '');
  const accountSelect = h('select.input', { 'aria-label': 'GitHub account', onchange: () => {
    state.views.delete(render);
    state = runFor(accountSelect.value); state.views.add(render);
    if (!state.running) state.picked.clear();
    render();
  } }, ...accounts.map(a => h('option', { value: a.user, selected: lower(a.user) === lower(state.account) }, `@${a.user}`)));
  const folder = h('input.input.gha-folder', { type: 'text', readOnly: true, 'aria-label': 'Clone folder' });
  const change = h('button.btn.small', { type: 'button', onclick: async () => {
    try { const picked = await bridge.desktop.pickFolder(); if (picked?.path) { store.setPref(`cloneFolder:${lower(state.account)}`, String(picked.path)); render(); } }
    catch (e) { toast(`Could not pick a folder: ${e.message}`, { kind: 'error' }); }
  } }, icon('folder'), 'Change…');
  const reset = h('button.btn.small.ghost', { type: 'button', onclick: () => { store.setPref(`cloneFolder:${lower(state.account)}`, ''); render(); } }, 'Use suggested');
  const selectAll = h('input', { type: 'checkbox', 'aria-label': 'Select every repository', onchange: () => {
    const repos = available(state);
    if (selectAll.checked) for (const r of repos) state.picked.add(lower(r.full_name)); else state.picked.clear();
    render();
  } });
  const list = h('ul.gha-repos', { 'aria-label': 'Repositories not on this PC' });
  const summary = h('span.gha-summary');
  const cloneAll = h('button.btn', { type: 'button', onclick: () => { for (const r of available(state)) state.picked.add(lower(r.full_name)); start(state); } }, icon('download'), 'Clone all');
  const clonePicked = h('button.btn.primary', { type: 'button', onclick: () => start(state) }, icon('download'), 'Clone selected');
  const stop = h('button.btn.ghost', { type: 'button', hidden: true, onclick: () => { state.cancel = true; notify(state); } }, 'Stop');
  const note = h('p.field-hint');

  const available = run => uncloned(store, run.account).filter(r => !run.rows.get(lower(r.full_name))?.path);
  const retainRecovery = run => {
    if ([...run.rows.values()].some(row => row.state === 'link-failed')) runs.set(lower(run.account), run);
    else runs.delete(lower(run.account));
  };
  const STATUS = { queued: 'Queued', cloning: 'Cloning…', linking: 'Linking…', done: 'Cloned and linked', 'link-failed': 'Clone saved · link failed', failed: 'Failed', skipped: 'Stopped' };
  let listSig = '';
  function render() {
    const repos = available(state);
    const running = [...state.rows.keys()];
    // Keep finished rows visible during and after a run, even once they leave the uncloned list.
    const shown = [...repos, ...running.filter(key => !repos.some(r => lower(r.full_name) === key)).map(key => state.rows.get(key).repo)];
    const dir = cloneDirFor(store, state.account), custom = Boolean(store.prefs?.[`cloneFolder:${lower(state.account)}`]);
    folder.value = dir; reset.hidden = !custom;
    // The store changes often (agents, sync); rebuild the rows only when they change, so focus and ticks stay put.
    const sig = JSON.stringify([state.account, state.running, shown.map(r => { const key = lower(r.full_name), row = state.rows.get(key); return [key, state.picked.has(key), row?.state, row?.message]; })]);
    if (sig !== listSig) {
      listSig = sig;
      list.replaceChildren(...(shown.length ? shown.map(repo => {
        const key = lower(repo.full_name), row = state.rows.get(key);
        const box = h('input', { type: 'checkbox', checked: state.picked.has(key), disabled: state.running || Boolean(row?.path), 'aria-label': `Clone ${repo.full_name}`,
          onchange: () => { if (box.checked) state.picked.add(key); else state.picked.delete(key); render(); } });
        return h('li.gha-repo', { dataset: { state: row?.state || '' } },
          h('label.gha-repo-main', box, h('span.gha-repo-icon', icon(repo.private ? 'lock' : 'github')),
            h('span.gha-repo-text', h('strong', repo.name || repo.full_name), h('span', repo.description || repo.full_name))),
          h('span.gha-repo-meta', repo.size_kb ? formatBytes(repo.size_kb * 1024) : '', row ? h('span.gha-repo-status', { title: row.message || '' }, row.message && row.state === 'failed' ? `Failed: ${row.message}` : STATUS[row.state]) : null,
            row?.state === 'link-failed' ? h('button.btn.small', { type: 'button', disabled: state.running, title: row.message || '', onclick: () => retryLink(state, row) }, 'Retry link') : null));
      }) : [h('li.gha-empty', 'Every repository of this account is already on this PC.')]));
    }
    const picked = repos.filter(r => state.picked.has(lower(r.full_name)));
    selectAll.checked = Boolean(repos.length) && picked.length === repos.length; selectAll.disabled = state.running || !repos.length;
    summary.textContent = repos.length ? `${plural(repos.length, 'repo')} not on this PC · ${picked.length} selected${picked.length ? ` · about ${formatBytes(sizeOf(picked))}` : ''}` : '';
    clonePicked.disabled = state.running || !picked.length;
    clonePicked.lastChild.textContent = picked.length ? `Clone ${plural(picked.length, 'repo')}` : 'Clone selected';
    cloneAll.disabled = state.running || !repos.length;
    cloneAll.lastChild.textContent = repos.length ? `Clone all (${repos.length} · ${formatBytes(sizeOf(repos))})` : 'Clone all';
    change.disabled = reset.disabled = state.running;
    stop.hidden = !state.running; stop.disabled = state.cancel;
    stop.textContent = state.cancel ? 'Stopping after this repo…' : 'Stop';
    note.textContent = state.running
      ? `Cloning into ${dir}. You can close this window: cloning carries on and the City shows each lot as "Cloning…".`
      : `Each repo goes into its own folder inside ${dir}. Existing folders are never overwritten or automatically linked. Choose another folder if one already exists.`;
  }

  async function start(run) {
    const repos = available(run).filter(r => run.picked.has(lower(r.full_name)) && !store.cloning.has(`gh:${lower(r.full_name)}`));
    if (!repos.length || run.running) return;
    const dir = cloneDirFor(store, run.account);
    run.running = true; run.cancel = false;
    runs.set(lower(run.account), run);
    for (const repo of repos) { run.rows.set(lower(repo.full_name), { repo, state: 'queued' }); store.setCloning(`gh:${lower(repo.full_name)}`, { state: 'queued' }); }
    notify(run);
    let done = 0, failed = 0;
    for (const repo of repos) {
      const key = lower(repo.full_name), ghId = `gh:${key}`, row = run.rows.get(key);
      if (run.cancel) { row.state = 'skipped'; store.setCloning(ghId, null); continue; }
      row.state = 'cloning'; store.setCloning(ghId, { state: 'cloning' }); notify(run);
      try {
        await cloneAndLinkRepo({ store, bridge, repo, parentDir: dir, account: run.account, row });
        row.state = 'done'; done++;
      } catch (e) {
        row.state = row.path ? 'link-failed' : 'failed'; row.message = e?.message || String(e); failed++;
      }
      store.setCloning(ghId, null);
      run.picked.delete(key);
      notify(run);
    }
    run.running = false; retainRecovery(run);
    notify(run);
    toast(`@${run.account}: ${plural(done, 'repo')} cloned and linked${failed ? ` · ${failed} failed` : ''}${run.cancel ? ' · stopped' : ''}`, { kind: failed ? 'error' : 'success' });
  }

  async function retryLink(run, row) {
    if (run.running || row.state !== 'link-failed' || !row.path) return;
    run.running = true; run.cancel = false; row.state = 'linking'; runs.set(lower(run.account), run); notify(run);
    try {
      await cloneAndLinkRepo({ store, bridge, repo: row.repo, account: run.account, row });
      row.state = 'done'; row.message = ''; toast(`Linked ${row.repo.full_name}`, { kind: 'success' });
    } catch (e) {
      row.state = 'link-failed'; row.message = e?.message || String(e);
      toast(`Could not link ${row.repo.full_name}: ${row.message}`, { kind: 'error' });
    } finally { run.running = false; retainRecovery(run); notify(run); }
  }

  const body = h('div.gha-clone',
    h('div.gha-clone-top',
      h('label.field', 'Account', accountSelect),
      h('label.field.gha-folder-field', 'Clone into', h('div.gha-folder-row', folder, change, reset))),
    note,
    h('div.gha-tools', h('label.gha-all', selectAll, h('span', 'Select all')), summary),
    list,
    h('div.gha-run', cloneAll, clonePicked, stop));
  const off = () => { store.removeEventListener('change', render); state.views.delete(render); };
  store.addEventListener('change', render);
  state.views.add(render);
  render();
  modal({ title: 'Clone repositories to this PC', body, wide: true, actions: [{ label: 'Close' }], onClose: off });
}
