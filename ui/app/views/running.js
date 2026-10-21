/* Running (0.5): background work at a glance.
 *   Working now   every CodaClauda session with a running or queued turn, with Stop and Open;
 *   Scheduled     the enabled schedules by next run, with Stop while a run's session is working;
 *   Team          every open CodaClauda session: its board address, wake on/off, working / awake / asleep
 *                 (asleep = no live process), the board claims it holds and who started it (0.5);
 *   On this PC    Claude Code and Codex sessions found on disk (external_sessions_list), metadata
 *                 only: provider, folder, last change and whether it changed in the last 15 minutes.
 *                 0.6: "Continue in CodaClauda" (session_adopt) resumes one as a wake-on session.
 * Data comes from sessions.js, schedules.js and features.js; titles and paths render as text only. */
import { sessions, UNAVAILABLE_TEXT } from '../sessions.js';
import { schedules, SCHEDULES_UNAVAILABLE_TEXT } from '../schedules.js';
import { providerLabel, toMs } from '../session-model.js';
import { cadenceText, untilText, runStatus } from '../schedule-model.js';
import { has as hasFeature, call as callFeature, normalizeUsage, tokens } from '../features.js';
import { agentAvatar } from '../avatar/spec.js';

const baseName = path => String(path || '').split(/[\\/]/).filter(Boolean).pop() || '';
const shownPath = path => String(path || '').replace(/^\\\\\?\\UNC\\/i, '\\\\').replace(/^\\\\\?\\/, '');
const threadIdFor = s => (s.sharedId ? `pair:${s.sharedId}` : `sess:${s.id}`);
const EXTERNAL_REFRESH = 60e3;

export function mount(root, ctx) {
  const { store, ui, navigate } = ctx;
  const { h, icon, toast, pill, portrait, timeAgo, clockTime, fullTime, emptyState } = ui;
  const state = { visible: false, raf: 0, sig: '', stopping: new Set(), external: { state: 'idle', list: [], error: '', at: 0 }, showAll: false, teamAll: false, ticker: 0, adopting: new Set() };
  ui.registerIcons({
    branch: '<circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="8" r="2"/><path d="M6 7v10M18 10a6 6 0 0 1-6 6H6"/>',
    lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  });

  const workHost = h('div.run-list');
  const schedHost = h('div.run-list');
  const extHost = h('div.run-list');
  const teamHost = h('div.run-list');
  const teamCount = h('span.run-count');
  const teamToggle = h('button.btn.small.ghost', { type: 'button', onclick: () => { state.teamAll = !state.teamAll; render(true); } });
  const workCount = h('span.run-count');
  const schedCount = h('span.run-count');
  const extCount = h('span.run-count');
  const extToggle = h('button.btn.small.ghost', { type: 'button', onclick: () => { state.showAll = !state.showAll; render(true); } });
  const extRefresh = h('button.btn.small.ghost', { type: 'button', onclick: () => loadExternal(true) }, icon('refresh'), 'Refresh');
  const extSection = h('section.run-section',
    h('header.run-head', h('h2', icon('search'), 'On this PC'), extCount, h('span.run-spacer'), extToggle, extRefresh),
    h('p.field-hint', 'Claude Code and Codex sessions found in their own folders on this PC. Metadata only: CodaClauda reads the folder, the last change and whether it changed in the last 15 minutes, never the conversation.'),
    extHost);
  root.append(h('div.page.run-page',
    h('header.page-head', h('div', h('span.eyebrow', 'CodaClauda'), h('h1', 'Running'),
      h('p', 'Everything working in the background: sessions with a turn in progress or waiting, scheduled runs, and other agent sessions on this PC.'))),
    h('section.run-section', h('header.run-head', h('h2', icon('bolt'), 'Working now'), workCount), workHost),
    h('section.run-section', h('header.run-head', h('h2', icon('clock'), 'Scheduled'), schedCount, h('span.run-spacer'), h('button.btn.small.ghost', { type: 'button', onclick: () => navigate('schedules') }, 'Open Schedules')), schedHost),
    h('section.run-section', h('header.run-head', h('h2', icon('agents'), 'Team'), teamCount, h('span.run-spacer'), teamToggle),
      h('p.field-hint', 'Every open CodaClauda session and its board address. Teammates wake each other by posting to these addresses and claim shared resources on the board; a message is information, never approval. Asleep means no process is running; mail to it wakes it.'),
      teamHost),
    extSection));

  sessions.on('change', schedule);
  schedules.on('change', schedule);
  store.on('change', schedule);

  function schedule() {
    if (!state.visible || state.raf) return;
    state.raf = requestAnimationFrame(() => { state.raf = 0; render(); });
  }

  const look = provider => agentAvatar(`codaclauda:${provider}`, provider, providerLabel(provider, true));
  const projectName = s => store.project(s.projectId)?.name || baseName(s.cwd);

  function working() {
    return sessions.list.filter(s => sessions.running(s.id) || sessions.queued(s.id) > 0)
      .sort((a, b) => toMs(b.lastActivityAt) - toMs(a.lastActivityAt));
  }

  /** 'working' (a turn running or waiting), 'awake' (an owned process, idle) or 'asleep' (no process). */
  const teamState = s => (sessions.running(s.id) || sessions.queued(s.id) > 0 ? 'working' : s.live === true ? 'awake' : 'asleep');
  const STATE_RANK = { working: 0, awake: 1, asleep: 2 };
  const TEAM_PAGE = 12;
  function teammates() {
    return sessions.list.filter(s => s.status !== 'stopped')
      .map(s => ({ s, state: teamState(s) }))
      .sort((a, b) => STATE_RANK[a.state] - STATE_RANK[b.state] || toMs(b.s.lastActivityAt) - toMs(a.s.lastActivityAt));
  }
  const claimsOf = (address, now) => (address ? store.claims.filter(c => c.holder === address && ui.toMs(c.expires_at) > now).map(c => c.resource) : []);

  function render(force = false) {
    const work = working();
    const mates = teammates();
    const now = Date.now();
    const scheds = (schedules.list || []).filter(s => s.enabled !== false).sort((a, b) => (toMs(a.nextRunAt) || Infinity) - (toMs(b.nextRunAt) || Infinity));
    const ext = state.external;
    const shownExt = state.showAll ? ext.list : ext.list.filter(e => e.active);
    const minute = Math.floor(Date.now() / 30e3);
    const sig = JSON.stringify([sessions.available, schedules.available, minute, [...state.stopping],
      work.map(s => [s.id, s.title, s.provider, s.status, sessions.queued(s.id), s.lastActivityAt, s.usage || null]),
      scheds.map(s => [s.id, s.name, s.nextRunAt, s.sessionId, s.sessionId ? sessions.running(s.sessionId) : false, schedules.lastRun(s)?.status]),
      ext.state, ext.error, shownExt.map(e => [e.provider, e.cwd, e.modifiedAt, e.active, e.owned]), ext.list.length, state.showAll, hasFeature('external'), hasFeature('adopt'), [...state.adopting],
      state.teamAll, mates.map(({ s, state: st }) => [s.id, s.title, st, s.wake, s.mailboxAddress, s.startedBy?.address, claimsOf(s.mailboxAddress, now)])]);
    if (!force && sig === state.sig) return;
    state.sig = sig;

    workCount.textContent = work.length ? String(work.length) : '';
    workHost.replaceChildren(...(sessions.available === false
      ? [emptyState('bolt', UNAVAILABLE_TEXT, sessions.reason || 'This build has no session commands.')]
      : work.length ? work.map(workRow)
        : [h('p.run-empty', icon('check'), 'Nothing is working right now. Start a session in Chat, or a schedule runs on its own.')]));

    schedCount.textContent = scheds.length ? String(scheds.length) : '';
    schedHost.replaceChildren(...(schedules.available === false
      ? [h('p.run-empty', icon('clock'), `${SCHEDULES_UNAVAILABLE_TEXT}.`)]
      : schedules.available === null ? [h('p.run-empty', h('span.spinner'), 'Loading schedules…')]
        : scheds.length ? scheds.map(schedRow) : [h('p.run-empty', icon('clock'), 'No schedules are on. Create one in Schedules.')]));

    teamCount.textContent = mates.length ? `${mates.filter(m => m.state === 'working').length} working · ${mates.length} open` : '';
    teamToggle.hidden = mates.length <= TEAM_PAGE;
    teamToggle.textContent = state.teamAll ? 'Show fewer' : `Show all ${mates.length}`;
    teamHost.replaceChildren(...(sessions.available === false ? [h('p.run-empty', icon('agents'), `${UNAVAILABLE_TEXT}.`)]
      : mates.length ? mates.slice(0, state.teamAll ? 200 : TEAM_PAGE).map(m => teamRow(m, now))
        : [h('p.run-empty', icon('agents'), 'No open sessions. Start one in Chat; agents can start teammates in projects where you turned it on.')]));

    extSection.hidden = !hasFeature('external');
    const active = ext.list.filter(e => e.active).length;
    extCount.textContent = ext.list.length ? `${active} active · ${ext.list.length} found` : '';
    extToggle.hidden = !ext.list.length || active === ext.list.length;
    extToggle.textContent = state.showAll ? 'Active only' : `Show all ${ext.list.length}`;
    extRefresh.disabled = ext.state === 'loading';
    extHost.replaceChildren(...(ext.state === 'error' ? [h('p.run-empty.bad', icon('alert'), `Couldn't list them: ${ext.error}`)]
      : ext.state !== 'loaded' ? [h('p.run-empty', h('span.spinner'), 'Looking for sessions…')]
        : shownExt.length ? shownExt.slice(0, 200).map(extRow)
          : [h('p.run-empty', icon('check'), ext.list.length ? 'None changed in the last 15 minutes.' : 'No Claude Code or Codex sessions found on this PC.')]));
  }

  function workRow(s) {
    const queued = sessions.queued(s.id);
    const running = sessions.running(s.id);
    const u = normalizeUsage(s.usage);
    const stopping = state.stopping.has(s.id);
    return h('article.card.run-row',
      portrait(look(s.provider), { size: 34, provider: s.provider, status: running ? 'active' : 'idle' }),
      h('div.run-text',
        h('div.run-title', h('strong', { title: s.title || '' }, s.title || `${providerLabel(s.provider, true)} session`), pill(providerLabel(s.provider), s.provider)),
        h('div.run-meta',
          h('span', icon('projects'), projectName(s) || 'No project'),
          h('span', icon(running ? 'bolt' : 'clock'), running ? 'Working' : 'Waiting', queued ? ` · ${queued} queued` : ''),
          s.lastActivityAt ? h('span', { title: fullTime(s.lastActivityAt) }, `last activity ${timeAgo(s.lastActivityAt)}`) : null,
          u.total ? h('span', `${tokens(u.total)} tokens`) : null,
          s.branch && s.worktreePath ? h('span', { title: shownPath(s.worktreePath) }, icon('branch'), s.branch) : null)),
      h('div.run-actions',
        h('button.btn.small', { type: 'button', onclick: () => navigate('chat', { thread: threadIdFor(s) }) }, icon('chat'), 'Open'),
        h('button.btn.small.danger', { type: 'button', disabled: stopping || !running, title: running ? 'Interrupt the current turn; the session stays resumable' : 'Waiting turns start after the current one', onclick: () => stop(s) }, stopping ? h('span.spinner') : icon('stop'), 'Stop')));
  }

  function teamRow({ s, state: st }, now) {
    const claims = claimsOf(s.mailboxAddress, now);
    const by = s.startedBy && typeof s.startedBy.address === 'string' ? s.startedBy.address : '';
    const label = { working: 'Working', awake: 'Awake', asleep: 'Asleep' }[st];
    return h('article.card.run-row',
      portrait(look(s.provider), { size: 30, provider: s.provider, status: st === 'working' ? 'active' : st === 'awake' ? 'idle' : 'offline' }),
      h('div.run-text',
        h('div.run-title', h('strong', { title: s.title || '' }, s.title || `${providerLabel(s.provider, true)} session`), pill(providerLabel(s.provider), s.provider), pill(label, st === 'working' ? 'success' : 'neutral')),
        h('div.run-meta',
          s.mailboxAddress ? h('code', { title: 'Board address' }, s.mailboxAddress) : h('span.muted', 'No board address'),
          h('span', icon('bell'), s.wake === true ? 'Wake on' : 'Wake off'),
          h('span', icon('projects'), projectName(s) || 'No project'),
          claims.length ? h('span', { title: claims.join(', ') }, icon('lock'), `holds ${claims.slice(0, 3).join(', ')}${claims.length > 3 ? ` +${claims.length - 3}` : ''}`) : null,
          by ? h('span', { title: 'Started through codaclauda-team; the sender name is self-asserted' }, `started by ${by}`) : null)),
      h('div.run-actions', h('button.btn.small', { type: 'button', onclick: () => navigate('chat', { thread: threadIdFor(s) }) }, icon('chat'), 'Open')));
  }

  function schedRow(s) {
    const session = s.sessionId ? sessions.session(s.sessionId) : null;
    const running = Boolean(session && sessions.running(session.id));
    const next = toMs(s.nextRunAt);
    const last = schedules.lastRun(s);
    const status = last ? runStatus(last.status) : null;
    const stopping = session && state.stopping.has(session.id);
    return h('article.card.run-row',
      portrait(look(s.provider), { size: 34, provider: s.provider, status: running ? 'active' : undefined }),
      h('div.run-text',
        h('div.run-title', h('strong', { title: s.name || '' }, s.name || 'Untitled schedule'), pill(providerLabel(s.provider), s.provider)),
        h('div.run-meta',
          h('span', icon('projects'), store.project(s.projectId)?.name || baseName(s.cwd) || 'Unknown project'),
          h('span', icon('clock'), cadenceText(s.cadence)),
          running ? h('span.run-live', icon('bolt'), 'Running now')
            : next > 0 ? h('span', { title: fullTime(next) }, `next ${clockTime(next)} · ${untilText(next)}`) : h('span', 'Next run set after saving'),
          status ? h('span', `last: ${status.label}${last.at ? ` ${timeAgo(last.at)}` : ''}`) : null)),
      h('div.run-actions',
        session ? h('button.btn.small', { type: 'button', onclick: () => navigate('chat', { thread: threadIdFor(session) }) }, icon('chat'), 'Open') : null,
        running ? h('button.btn.small.danger', { type: 'button', disabled: stopping, onclick: () => stop(session) }, stopping ? h('span.spinner') : icon('stop'), 'Stop') : null));
  }

  function extRow(e) {
    const provider = e.provider === 'codex' ? 'codex' : e.provider === 'claude' ? 'claude' : 'other';
    const name = e.projectHint || baseName(e.cwd) || 'Unknown folder';
    const project = store.projects.find(p => p.path && shownPath(p.path).toLowerCase().replace(/[\\/]+$/, '') === shownPath(e.cwd).toLowerCase().replace(/[\\/]+$/, ''));
    return h(`article.card.run-row.ext${e.active ? '.active' : ''}`,
      portrait(look(provider === 'other' ? 'claude' : provider), { size: 30, provider, status: e.active ? 'active' : 'offline' }),
      h('div.run-text',
        h('div.run-title', h('strong', { title: name }, project?.name || name), pill(provider === 'other' ? 'Agent' : providerLabel(provider), provider === 'other' ? 'neutral' : provider), e.active ? pill('active', 'success') : null),
        h('div.run-meta',
          e.cwd ? h('span.mono', { title: shownPath(e.cwd) }, shownPath(e.cwd)) : null,
          e.modifiedAt ? h('span', { title: fullTime(e.modifiedAt) }, `changed ${timeAgo(e.modifiedAt)}`) : null)),
      h('div.run-actions',
        canAdopt(e) ? h('button.btn.small', { type: 'button', disabled: state.adopting.has(e.providerSessionId), title: 'Continue this conversation as a CodaClauda session with wake on, so board mail reaches it', onclick: () => adopt(e, project) }, state.adopting.has(e.providerSessionId) ? h('span.spinner') : icon('chat'), 'Continue in CodaClauda') : null,
        e.cwd ? h('button.btn.small.ghost', { type: 'button', onclick: () => ctx.bridge.desktop.openExternal(e.cwd).catch(() => ui.copyText(shownPath(e.cwd), 'Path copied')) }, icon('folder'), 'Folder') : null));
  }

  /* 0.6: continue a conversation found on this PC. The provider's own resume appends to the same
   * conversation; CodaClauda never edits the transcript. The other app does not show the new turns
   * until it reopens it, so the two must not be used at once. */
  function canAdopt(e) {
    return hasFeature('adopt') && !e.owned && Boolean(e.providerSessionId) && Boolean(e.cwd) && (e.provider === 'claude' || e.provider === 'codex');
  }
  function adopt(e, project) {
    const label = providerLabel(e.provider, true);
    ui.modal({
      title: 'Continue in CodaClauda?',
      body: `CodaClauda resumes this ${label} conversation in ${shownPath(e.cwd)} as its own session with wake on, at the project's current access (Read when the folder is not one of your projects). Close it in the other app first and don't use both at once: the other app won't show the new turns until you reopen it there.`,
      actions: [{ label: 'Cancel' }, { label: 'Continue here', kind: 'primary', run: () => runAdopt(e, project) }],
    });
  }
  async function runAdopt(e, project) {
    const id = e.providerSessionId;
    if (state.adopting.has(id)) return;
    state.adopting.add(id); render(true);
    try {
      const data = await callFeature('adopt', { provider: e.provider, providerSessionId: id, cwd: e.cwd, title: `${project?.name || e.projectHint || baseName(e.cwd) || providerLabel(e.provider, true)} (continued)` });
      const s = data?.session;
      await sessions.refresh();
      toast(data?.existing ? 'Already continued in CodaClauda; opening it' : `Continued in CodaClauda at ${s?.access === 'full' ? 'Full' : 'Read'} access`, { kind: 'success', timeout: 3600 });
      loadExternal(true);
      if (s?.id) navigate('chat', { thread: threadIdFor(s) });
    } catch (error) { toast(`Couldn't continue it: ${error?.message || error}`, { kind: 'error', timeout: 8000 }); }
    finally { state.adopting.delete(id); render(true); }
  }

  async function stop(s) {
    if (!s || state.stopping.has(s.id)) return;
    state.stopping.add(s.id); render(true);
    try { await sessions.stop(s.id); toast('Stopping…', { timeout: 1800 }); }
    catch (error) { toast(`Couldn't stop: ${error?.message || error}`, { kind: 'error' }); }
    finally { state.stopping.delete(s.id); render(true); }
  }

  async function loadExternal(force = false) {
    if (!hasFeature('external')) return;
    const ext = state.external;
    if (ext.state === 'loading' || (!force && ext.state === 'loaded' && Date.now() - ext.at < EXTERNAL_REFRESH)) return;
    ext.state = ext.list.length ? 'loaded' : 'loading';
    if (force) ext.state = 'loading';
    render(true);
    try {
      const data = await callFeature('external', undefined);
      const list = (Array.isArray(data?.sessions) ? data.sessions : []).filter(e => e && typeof e === 'object')
        .map(e => ({ provider: String(e.provider || ''), cwd: String(e.cwd || ''), projectHint: String(e.projectHint || ''), modifiedAt: e.modifiedAt, active: e.active === true,
          owned: e.owned === true, providerSessionId: typeof e.providerSessionId === 'string' ? e.providerSessionId : '' }));
      list.sort((a, b) => Number(b.active) - Number(a.active) || toMs(b.modifiedAt) - toMs(a.modifiedAt));
      Object.assign(ext, { state: 'loaded', list, error: '', at: Date.now() });
    } catch (error) { Object.assign(ext, { state: 'error', error: error?.message || String(error), at: Date.now() }); }
    render(true);
  }

  return {
    show() {
      state.visible = true;
      sessions.refresh(); schedules.refresh();
      render(true);
      loadExternal();
      clearInterval(state.ticker);
      state.ticker = setInterval(() => { if (state.visible) { sessions.refresh(); render(); loadExternal(); } }, 15e3);
    },
    hide() { state.visible = false; clearInterval(state.ticker); state.ticker = 0; },
  };
}
