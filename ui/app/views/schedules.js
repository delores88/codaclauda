/* Schedules (0.4.1): a prompt sent to a dedicated Claude Code or Codex session on a timer.
 * Runs happen in process, only while CodaClauda is open; with catch-up on, a run missed while it
 * was closed runs once at the next start. Each schedule reuses one session (created on its first run
 * at the project's access level), so a run's reply is read in Chat.
 * Data: ../schedules.js (desktop.schedule*). Without those commands the view says so and offers
 * nothing that cannot work. Prompts and errors are rendered as text only. */
import { schedules, SCHEDULES_UNAVAILABLE_TEXT, RUNS_SHOWN } from '../schedules.js';
import { sessions } from '../sessions.js';
import { cadenceText, untilText, validateSchedule, runStatus, runAccepted, WEEK_ORDER, DAY_SHORT, MIN_INTERVAL, NAME_LIMIT, PROMPT_LIMIT } from '../schedule-model.js';
import { providerLabel } from '../session-model.js';
import { levelInfo } from '../access.js';

const NOTE = 'Runs only while CodaClauda is open.';
const baseName = path => String(path || '').split(/[\\/]/).filter(Boolean).pop() || '';

export function mount(root, ctx) {
  const { store, ui, navigate } = ctx;
  const { h, icon, iconButton, toast, modal, pill, clockTime, fullTime, timeAgo, emptyState, toMs } = ui;
  const state = { visible: false, raf: 0, sig: '', open: new Set(), busy: new Set(), ticker: 0 };

  const newBtn = h('button.btn.primary', { type: 'button', onclick: () => openEditor() }, icon('plus'), 'New schedule');
  const listHost = h('div.sched-list', { 'aria-live': 'polite' });
  root.append(h('div.page.sched-page',
    h('header.page-head',
      h('div', h('span.eyebrow', 'CodaClauda'), h('h1', 'Schedules'),
        h('p', "Send a prompt to a Claude Code or Codex session on a timer. Each schedule keeps one session at its project's access level; read the replies in Chat.")),
      newBtn),
    h('p.sched-note', icon('clock'), h('span', h('strong', NOTE), ' With catch-up on, a run missed while the app was closed or the PC was asleep runs once when available.')),
    listHost));

  /* ---------- rendering ---------- */
  function schedule() {
    if (!state.visible || state.raf) return;
    state.raf = requestAnimationFrame(() => { state.raf = 0; render(); });
  }
  const projectOf = s => store.project(s.projectId) || null;
  const projectName = s => projectOf(s)?.name || baseName(s.cwd) || 'Unknown project';
  function nextText(s) {
    if (s.enabled === false) return 'Paused';
    const next = toMs(s.nextRunAt);
    return Number.isFinite(next) && next > 0 ? `${clockTime(next)} · ${untilText(next)}` : 'Set after saving';
  }

  function render() {
    const available = schedules.available;
    newBtn.disabled = available !== true;
    newBtn.title = available === true ? 'Create a schedule' : SCHEDULES_UNAVAILABLE_TEXT;
    const rows = (schedules.list || []).slice().sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
    const sig = JSON.stringify([available, schedules.reason, [...state.open], [...state.busy], rows.map(s => [
      s.id, s.name, s.provider, s.enabled, s.catchUp, projectName(s), cadenceText(s.cadence), nextText(s),
      schedules.lastRun(s), timeAgo(schedules.lastRun(s)?.at), state.open.has(s.id) ? schedules.runs.get(s.id) : 0,
    ])]);
    if (sig === state.sig) return;
    state.sig = sig;
    const focus = document.activeElement && listHost.contains(document.activeElement) ? document.activeElement.dataset.fid : null;
    if (available === false) {
      listHost.replaceChildren(emptyState('clock', SCHEDULES_UNAVAILABLE_TEXT, `${schedules.reason || 'This build has no schedule commands.'} Sessions in Chat still work.`));
    } else if (available === null) {
      listHost.replaceChildren(h('div.view-loading.sched-loading', h('span.spinner'), 'Loading schedules…'));
    } else if (!rows.length) {
      listHost.replaceChildren(emptyState('clock', 'No schedules yet',
        'A schedule sends its prompt to a Claude Code or Codex session every N minutes, or daily at a set time on the weekdays you pick.',
        h('button.btn.primary', { type: 'button', onclick: () => openEditor() }, icon('plus'), 'New schedule')));
    } else listHost.replaceChildren(...rows.map(card));
    if (focus) listHost.querySelector(`[data-fid="${CSS.escape(focus)}"]`)?.focus({ preventScroll: true });
  }

  function card(s) {
    const last = schedules.lastRun(s);
    const status = last ? runStatus(last.status) : null;
    const open = state.open.has(s.id);
    const busy = state.busy.has(s.id);
    const name = s.name || 'Untitled schedule';
    const enabled = s.enabled !== false;
    const fid = part => ({ fid: `${s.id}:${part}` });
    const edit = iconButton('edit', `Edit ${name}`, () => openEditor(s));
    const remove = iconButton('trash', `Delete ${name}`, () => confirmDelete(s));
    edit.disabled = busy; remove.disabled = busy;
    Object.assign(edit.dataset, fid('edit'));
    Object.assign(remove.dataset, fid('delete'));
    return h(`article.card.sched-card${enabled ? '' : '.paused'}`, { dataset: { id: s.id } },
      h('div.sched-row',
        h('label.switch', { title: enabled ? 'On · turn off to pause' : 'Paused · turn on to run' },
          h('input', { type: 'checkbox', checked: enabled, disabled: busy, 'aria-label': `${name}: ${enabled ? 'on' : 'paused'}`, dataset: fid('enabled'), onchange: event => setEnabled(s, event.currentTarget.checked) }),
          h('span')),
        h('div.sched-text',
          h('div.sched-title', h('strong', { title: name }, name), pill(providerLabel(s.provider, true), s.provider === 'codex' ? 'codex' : 'claude')),
          h('div.sched-meta',
            h('span', icon('projects'), projectName(s)),
            h('span', icon('clock'), cadenceText(s.cadence)),
            s.catchUp ? h('span', icon('refresh'), 'Catch-up') : null)),
        h('dl.sched-times',
          h('div', h('dt', 'Next run'), h('dd', nextText(s))),
          h('div', h('dt', 'Last run'), h('dd', last
            ? [pill(status.label, status.tone), h('time', { title: fullTime(last.at) }, ` ${timeAgo(last.at)}`)]
            : s.lastRunAt ? h('time', { title: fullTime(s.lastRunAt) }, timeAgo(s.lastRunAt)) : h('span.muted', 'Not run yet')))),
        h('div.sched-actions',
          h('button.btn.small', { type: 'button', disabled: busy, dataset: fid('run'), title: 'Send the prompt now', onclick: () => runNow(s) }, busy ? h('span.spinner') : icon('play'), 'Run now'),
          h('button.btn.small.ghost', { type: 'button', 'aria-expanded': String(open), dataset: fid('history'), onclick: () => toggleHistory(s) }, icon('clock'), 'History'),
          edit, remove)),
      open ? history(s) : null);
  }

  function history(s) {
    const entry = schedules.runs.get(s.id);
    const wrap = (...children) => h('div.sched-history', h('h4', `Run history · last ${RUNS_SHOWN}`), ...children);
    if (!entry || (entry.state === 'loading' && !entry.runs.length)) return wrap(h('p.muted', 'Loading runs…'));
    if (entry.state === 'error') return wrap(h('p.sched-error', `Couldn't load the runs: ${entry.error}`), h('button.link-btn', { type: 'button', onclick: () => schedules.loadRuns(s.id) }, 'Try again'));
    if (!entry.runs.length) return wrap(h('p.muted', 'No runs yet. Run now sends the prompt right away.'));
    return wrap(h('ol.sched-runs', entry.runs.slice(0, RUNS_SHOWN).map(run => {
      const st = runStatus(run.status);
      return h('li',
        h('time', { title: fullTime(run.at) }, clockTime(run.at)),
        pill(st.label, st.tone),
        run.error ? h('span.sched-run-error', { title: String(run.error) }, String(run.error)) : h('span.sched-run-gap'),
        run.sessionId ? h('button.link-btn', { type: 'button', onclick: () => openSession(run.sessionId) }, icon('chat'), 'Open in Chat') : null);
    })));
  }

  /* ---------- actions ---------- */
  function openSession(id) {
    const s = sessions.session(id);
    navigate('chat', { thread: s?.sharedId ? `pair:${s.sharedId}` : `sess:${id}` });
  }
  function toggleHistory(s) {
    if (state.open.has(s.id)) state.open.delete(s.id);
    else { state.open.add(s.id); schedules.loadRuns(s.id, RUNS_SHOWN); }
    render();
  }
  async function withBusy(s, fn) {
    if (state.busy.has(s.id)) return;
    state.busy.add(s.id); render();
    try { return await fn(); }
    finally { state.busy.delete(s.id); render(); }
  }
  /** The record to save: the stored fields plus edits; the engine computes the next run. */
  const forSave = (s, patch = {}) => { const { nextRunAt, lastRun, lastRunStatus, ...rest } = { ...s, ...patch }; return rest; };

  async function setEnabled(s, enabled) {
    await withBusy(s, async () => {
      try { await schedules.save(forSave(s, { enabled })); toast(enabled ? `${s.name}: on` : `${s.name}: paused`, { kind: 'success', timeout: 2400 }); }
      catch (error) { toast(`Couldn't change ${s.name}: ${error?.message || error}`, { kind: 'error', timeout: 8000 }); }
    });
    schedules.refresh();
  }
  async function runNow(s) {
    await withBusy(s, async () => {
      try {
        const run = await schedules.runNow(s.id);
        const sessionId = run?.sessionId;
        if (runAccepted(run)) {
          toast(`${s.name}: prompt accepted by ${providerLabel(s.provider, true)}`, { kind: 'success', timeout: 6000, action: sessionId ? { label: 'Open', run: () => openSession(sessionId) } : undefined });
        } else {
          toast(`${s.name}: ${run?.error || 'The run was not confirmed. Check History before retrying.'}`, { kind: 'error', timeout: 9000, action: sessionId ? { label: 'Open', run: () => openSession(sessionId) } : undefined });
        }
        sessions.scheduleRefresh(400);
      } catch (error) { toast(`Couldn't run ${s.name}: ${error?.message || error}`, { kind: 'error', timeout: 8000 }); }
    });
  }
  function confirmDelete(s) {
    modal({
      title: 'Delete this schedule?',
      body: `“${s.name || 'Untitled schedule'}” will not start new runs. Already running work continues; use Stop in Chat to cancel it. Its session and existing receipts stay in Chat.`,
      actions: [
        { label: 'Cancel', kind: 'ghost' },
        { label: 'Delete schedule', kind: 'danger', run: async () => {
          try { await schedules.remove(s.id); state.open.delete(s.id); toast('Schedule deleted', { kind: 'success', timeout: 2200 }); }
          catch (error) { toast(`Couldn't delete: ${error?.message || error}`, { kind: 'error', timeout: 8000 }); }
        } },
      ],
    });
  }

  /* ---------- create / edit ---------- */
  function openEditor(existing = null) {
    if (schedules.available !== true) { toast(SCHEDULES_UNAVAILABLE_TEXT); return; }
    const local = store.projects.filter(p => p.path);
    const known = existing ? store.project(existing.projectId) : null;
    if (!local.length && !existing) {
      toast('Schedules run in a project folder on this PC. Link a folder or clone a repo in Projects first.', { kind: 'error', timeout: 8000, action: { label: 'Open Projects', run: () => navigate('projects') } });
      return;
    }
    const filtered = store.prefs.chatProject ? store.project(store.prefs.chatProject) : null;
    const pick = {
      name: existing?.name || '',
      projectId: existing?.projectId || (filtered?.path && filtered.id) || local[0]?.id || '',
      provider: existing?.provider === 'codex' ? 'codex' : 'claude',
      prompt: existing?.prompt || '',
      kind: existing?.cadence?.kind === 'daily' ? 'daily' : 'interval',
      minutes: existing?.cadence?.kind === 'interval' ? Number(existing.cadence.minutes) || 60 : 60,
      time: existing?.cadence?.kind === 'daily' ? existing.cadence.time || '09:00' : '09:00',
      days: new Set(existing?.cadence?.kind === 'daily' && Array.isArray(existing.cadence.days) ? existing.cadence.days.map(Number) : [1, 2, 3, 4, 5]),
      enabled: existing ? existing.enabled !== false : true,
      catchUp: existing ? existing.catchUp === true : false,
    };
    const projectOptions = local.map(p => h('option', { value: p.id }, p.name));
    if (existing && !local.some(p => p.id === existing.projectId)) projectOptions.unshift(h('option', { value: existing.projectId }, `${known?.name || baseName(existing.cwd) || 'Unknown'} · ${known ? 'no local folder' : 'not linked'}`));
    const cwdOf = id => store.project(id)?.path || (existing && id === existing.projectId ? existing.cwd : '');

    const nameInput = h('input.input', { type: 'text', maxLength: NAME_LIMIT, value: pick.name, placeholder: 'e.g. Morning test sweep', autocomplete: 'off', 'aria-label': 'Name', oninput: e => { pick.name = e.currentTarget.value; } });
    const projectSelect = h('select.select', { 'aria-label': 'Project', onchange: e => { pick.projectId = e.currentTarget.value; refresh(); } }, projectOptions);
    projectSelect.value = pick.projectId;
    const providerButtons = [['claude', 'Claude Code'], ['codex', 'Codex']].map(([id, label]) => h('button', { type: 'button', 'aria-pressed': String(pick.provider === id), onclick: () => { pick.provider = id; refresh(); } }, label));
    const promptInput = h('textarea.textarea.sched-prompt', { rows: 5, maxLength: PROMPT_LIMIT, placeholder: 'What each run asks the agent, for example: Run the test suite and summarise any failures.', 'aria-label': 'Prompt', oninput: e => { pick.prompt = e.currentTarget.value; } });
    promptInput.value = pick.prompt;
    const kindButtons = [['interval', 'Every N minutes'], ['daily', 'Daily at a time']].map(([id, label]) => h('button', { type: 'button', 'aria-pressed': String(pick.kind === id), onclick: () => { pick.kind = id; refresh(); } }, label));
    const minutesInput = h('input.input.sched-minutes', { type: 'number', min: String(MIN_INTERVAL), step: '5', value: String(pick.minutes), 'aria-label': 'Minutes between runs', oninput: e => { pick.minutes = Number(e.currentTarget.value); refresh(); } });
    const timeInput = h('input.input.sched-time', { type: 'time', value: pick.time, 'aria-label': 'Time of day', oninput: e => { pick.time = e.currentTarget.value; refresh(); } });
    const dayButtons = WEEK_ORDER.map(d => h('button.sched-day', { type: 'button', 'aria-pressed': String(pick.days.has(d)), 'aria-label': DAY_SHORT[d], onclick: () => { if (pick.days.has(d)) pick.days.delete(d); else pick.days.add(d); refresh(); } }, DAY_SHORT[d]));
    const preset = (label, days) => h('button.link-btn', { type: 'button', onclick: () => { pick.days = new Set(days); refresh(); } }, label);
    const intervalRow = h('div.sched-cadence-row', h('span', 'Every'), minutesInput, h('span', 'minutes'), h('span.field-hint', `${MIN_INTERVAL} or more`));
    const dailyRow = h('div.sched-cadence-daily',
      h('div.sched-cadence-row', h('span', 'At'), timeInput, h('span.field-hint', 'local time')),
      h('div.sched-days', { role: 'group', 'aria-label': 'Weekdays' }, dayButtons),
      h('div.sched-presets', preset('Every day', [0, 1, 2, 3, 4, 5, 6]), preset('Weekdays', [1, 2, 3, 4, 5]), preset('Weekends', [0, 6])));
    const cadenceWords = h('p.field-hint.sched-words');
    const enabledInput = h('input', { type: 'checkbox', checked: pick.enabled, 'aria-label': 'Enabled', onchange: e => { pick.enabled = e.currentTarget.checked; } });
    const catchUpInput = h('input', { type: 'checkbox', checked: pick.catchUp, 'aria-label': 'Catch up', onchange: e => { pick.catchUp = e.currentTarget.checked; } });
    const accessLine = h('p.field-hint.sched-access');
    const errorLine = h('p.sched-error', { role: 'alert', hidden: true });

    function cadence() { return pick.kind === 'daily' ? { kind: 'daily', time: pick.time, days: [...pick.days] } : { kind: 'interval', minutes: pick.minutes }; }
    function refresh() {
      for (const b of providerButtons) b.setAttribute('aria-pressed', String(b.textContent === (pick.provider === 'codex' ? 'Codex' : 'Claude Code')));
      kindButtons.forEach((b, i) => b.setAttribute('aria-pressed', String((i === 0 ? 'interval' : 'daily') === pick.kind)));
      dayButtons.forEach((b, i) => b.setAttribute('aria-pressed', String(pick.days.has(WEEK_ORDER[i]))));
      intervalRow.hidden = pick.kind !== 'interval';
      dailyRow.hidden = pick.kind !== 'daily';
      cadenceWords.textContent = cadenceText(cadence());
      const project = store.project(pick.projectId);
      const level = levelInfo(project ? store.projectAccess(project.id).level : 'read');
      accessLine.replaceChildren(...(project?.path
        ? [h(`span.acc-tag.${level.id}`, level.long), ` Each run checks this level. A ${providerLabel(pick.provider, true)} session in ${project.name} is reused while its access matches; a change starts a new session.`]
        : ['Pick a project with a local folder.']));
    }
    refresh();

    const body = h('div.sched-editor',
      h('label.field', h('span', 'Name'), nameInput),
      h('div.sched-two',
        h('label.field', h('span', 'Project'), projectSelect),
        h('div.field', h('span', 'Agent'), h('div.segmented', { role: 'group', 'aria-label': 'Agent' }, providerButtons))),
      accessLine,
      h('label.field', h('span', 'Prompt'), promptInput),
      h('div.field', h('span', 'Cadence'), h('div.segmented', { role: 'group', 'aria-label': 'Cadence' }, kindButtons), intervalRow, dailyRow, cadenceWords),
      h('div.setting-row.sched-switch-row', h('div.setting-text', h('strong', 'On'), h('span.field-hint', 'Pausing prevents new automatic runs. Run now is a one-shot; use Stop in Chat for a turn already running.')), h('label.switch', enabledInput, h('span'))),
      h('div.setting-row.sched-switch-row', h('div.setting-text', h('strong', 'Catch up'), h('span.field-hint', 'If a run was missed while CodaClauda was closed or the PC was asleep, run once when available.')), h('label.switch', catchUpInput, h('span'))),
      h('p.sched-note.small', icon('clock'), h('span', NOTE)),
      errorLine);

    async function submit() {
      const result = validateSchedule({ name: pick.name, projectId: pick.projectId, cwd: cwdOf(pick.projectId), provider: pick.provider, prompt: pick.prompt, access: store.projectAccess(pick.projectId).level, cadence: cadence(), enabled: pick.enabled, catchUp: pick.catchUp });
      if (!result.ok) {
        errorLine.textContent = result.error; errorLine.hidden = false;
        ({ name: nameInput, project: projectSelect, prompt: promptInput, cadence: pick.kind === 'daily' ? timeInput : minutesInput }[result.field])?.focus();
        return false;
      }
      try {
        const saved = await schedules.save(existing ? forSave(existing, result.schedule) : result.schedule);
        toast(existing ? `${saved.name || result.schedule.name} saved` : `${saved.name || result.schedule.name} created · ${cadenceText(saved.cadence || result.schedule.cadence)}`, { kind: 'success', timeout: 4200 });
        schedules.scheduleRefresh(300);
        return true;
      } catch (error) {
        errorLine.textContent = `Couldn't save: ${error?.message || error}`; errorLine.hidden = false;
        return false;
      }
    }
    const dialog = modal({ title: existing ? 'Edit schedule' : 'New schedule', body, wide: true, actions: [{ label: 'Cancel', kind: 'ghost' }, { label: existing ? 'Save' : 'Create schedule', kind: 'primary', run: submit }] });
    dialog.classList.add('sched-modal');
    dialog.addEventListener('keydown', event => {
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); dialog.querySelector('.modal-actions .btn.primary')?.click(); }
    });
    setTimeout(() => nameInput.focus(), 40);
  }

  /* ---------- lifecycle ---------- */
  schedules.on('change', schedule);
  store.on('change', schedule);
  render();
  return {
    show() {
      state.visible = true;
      state.sig = '';
      schedules.refresh();
      for (const id of state.open) schedules.loadRuns(id, RUNS_SHOWN);
      render();
      clearInterval(state.ticker);
      state.ticker = setInterval(schedule, 30e3);   // "in 5 min" and "2m ago" stay current
    },
    hide() {
      state.visible = false;
      clearInterval(state.ticker); state.ticker = 0;
      if (state.raf) { cancelAnimationFrame(state.raf); state.raf = 0; }
    },
  };
}
