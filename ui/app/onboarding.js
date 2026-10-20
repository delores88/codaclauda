/* 60-second onboarding (0.5): a dismissible four-step card on first run, floating over the app so
 * every view stays usable behind it.
 *   1. CLIs detected (the board CLI's discover: installed and signed in, never a model call)
 *   2. projects found (linked projects, plus Desktop folders not linked yet)
 *   3. pick your default access (Full for your own projects, or Read only everywhere)
 *   4. start your first chat (opens Chat)
 * Finishing or closing it stores prefs.onboardingDone, so it shows once. main.js calls maybeOnboard
 * after the desktop state loads. Text from the system (CLI versions, folder names) is set as text. */
import { store } from './store.js';
import * as bridge from './bridge.js';
import { h, icon, iconButton, clear, toast, pill } from './ui.js';
import { ACCESS_NOTE, ownedByBen } from './access.js';

const PREF = 'onboardingDone';
const STEPS = [
  { id: 'clis', title: 'Your agents', lead: 'CodaClauda drives the Claude Code and Codex CLIs already on this PC, with your own sign-in.' },
  { id: 'projects', title: 'Your projects', lead: 'Each linked folder or GitHub repo becomes a project: a chat target and a building in the City.' },
  { id: 'access', title: 'Pick your default access', lead: 'How freely agents may work in the chats CodaClauda starts. You can change it per project any time.' },
  { id: 'chat', title: 'Start your first chat', lead: 'Pick a project and an agent, then just say what you want done.' },
];
const NAMES = { claude: 'Claude Code', codex: 'Codex' };

/** Shows the tour unless it was finished or dismissed before. */
export function maybeOnboard(ctx) {
  if (store.prefs?.[PREF] || document.querySelector('.onb')) return null;
  return openOnboarding(ctx);
}

function ensureStyles() {
  const ready = document.querySelector('link[data-onboarding]');
  if (ready) return Promise.resolve();
  return new Promise(resolve => {
    const link = h('link', { rel: 'stylesheet', href: 'styles/onboarding.css', dataset: { onboarding: '1' } });
    link.addEventListener('load', resolve, { once: true });
    link.addEventListener('error', resolve, { once: true });
    setTimeout(resolve, 1500);
    document.head.append(link);
  });
}

/** CLI discovery → [{ agent, status, kind, detail }] for Claude Code and Codex. */
function summarize(found) {
  return ['claude', 'codex'].map(agent => {
    const list = (Array.isArray(found) ? found : []).filter(item => item && item.agent === agent && (item.executable || item.path));
    const ready = list.find(item => item.supported === true && item.authenticated === true);
    if (ready) return { agent, status: 'Signed in', kind: 'success', detail: String(ready.version || 'Installed').slice(0, 60) };
    if (list.some(item => item.supported === true)) return { agent, status: 'Sign in needed', kind: 'warning', detail: `Sign in once with ${NAMES[agent]}'s own login, then rescan.` };
    if (list.length) return { agent, status: 'Update needed', kind: 'danger', detail: `Update the official ${NAMES[agent]} CLI, then rescan.` };
    return { agent, status: 'Not found', kind: 'danger', detail: `Install the official ${NAMES[agent]} CLI to use it here.` };
  });
}

export function openOnboarding({ navigate }) {
  let step = 0, closed = false;
  const state = { clis: null, clisError: '', found: null, choice: 'own', applying: false };
  const body = h('div.onb-body');
  const dots = h('div.onb-dots', { 'aria-hidden': 'true' }, STEPS.map(() => h('span.onb-dot')));
  const counter = h('span.onb-count');
  const back = h('button.btn.small.ghost', { type: 'button', onclick: () => go(step - 1) }, 'Back');
  const next = h('button.btn.small.primary', { type: 'button', onclick: () => advance() });
  const heading = h('h2.onb-title', { id: 'onb-title' });
  const lead = h('p.onb-lead');
  const card = h('section.onb', { role: 'dialog', 'aria-modal': 'false', 'aria-labelledby': 'onb-title', hidden: true, onkeydown: event => { if (event.key === 'Escape') { event.stopPropagation(); finish(); } } },
    h('header.onb-head', h('span.onb-eyebrow', icon('sparkle'), 'Welcome to CodaClauda'), counter, iconButton('close', 'Close the tour', () => finish(), 'onb-close')),
    heading, lead, body,
    h('footer.onb-foot', dots, h('div.onb-buttons', back, next)));

  function finish({ silent = false } = {}) {
    if (closed) return;
    closed = true;
    store.setPref(PREF, true);
    card.classList.add('leaving');
    setTimeout(() => card.remove(), 220);
    if (!silent) toast('Tour closed. Agent setup, Projects and Chat are always in the left rail.', { timeout: 4200 });
  }
  function go(index) {
    step = Math.max(0, Math.min(STEPS.length - 1, index));
    render();
    if (STEPS[step].id === 'clis' && !state.clis) loadClis();
    if (STEPS[step].id === 'projects' && !state.found) loadFound();
  }
  async function advance() {
    const id = STEPS[step].id;
    if (id === 'access') { if (!(await applyAccess())) return; }
    if (id === 'chat') { finish({ silent: true }); navigate('chat'); return; }
    go(step + 1);
  }

  async function loadClis(force = false) {
    if (state.clis === 'checking' && !force) return;
    state.clis = 'checking'; state.clisError = ''; render();
    try {
      const result = await bridge.rpc('discover');
      state.clis = summarize(result?.agents);
    } catch (error) { state.clis = []; state.clisError = String(error?.message || error).replace(/\s+/g, ' ').slice(0, 160); }
    if (!closed) render();
  }
  async function loadFound() {
    state.found = 'checking'; render();
    try {
      const result = await store.discoverDesktop();
      const linked = new Set(store.projects.map(p => String(p.path || '').replaceAll('\\', '/').toLowerCase()).filter(Boolean));
      state.found = (Array.isArray(result?.projects) ? result.projects : []).filter(p => p && p.path && !linked.has(String(p.path).replaceAll('\\', '/').toLowerCase()));
    } catch { state.found = []; }
    if (!closed) render();
  }
  /** Step 3: Full for your own projects is already the default; Read only everywhere sets every
   *  project linked now to Read only. Returns false to stay on the step. */
  async function applyAccess() {
    store.setPref('onboardingAccess', state.choice);
    if (state.choice !== 'read') return true;
    const projects = store.projects;
    if (!projects.length) return true;
    state.applying = true; render();
    try {
      await store.setProjectAccessMany(projects.map(p => [p.id, { level: 'read' }]));
      toast(`${projects.length} project${projects.length === 1 ? ' is' : 's are'} now Read only.`, { kind: 'success', timeout: 3200 });
      return true;
    } catch (error) { toast(error?.message || String(error), { kind: 'error' }); return false; }
    finally { state.applying = false; if (!closed) render(); }
  }

  function renderClis() {
    if (!state.clis || state.clis === 'checking') return [h('div.onb-checking', h('span.spinner'), 'Looking for the CLIs and their sign-in…')];
    const rows = state.clis.map(c => h(`div.onb-row.provider-${c.agent}`,
      h(`span.onb-glyph.${c.agent}`, c.agent === 'codex' ? 'Cx' : 'C'),
      h('div.onb-row-text', h('strong', NAMES[c.agent]), h('span.muted', c.detail)),
      pill(c.status, c.kind)));
    const ready = state.clis.filter(c => c.kind === 'success').length;
    return [
      state.clisError ? h('p.onb-note.bad', `Detection couldn't finish: ${state.clisError}`) : null,
      ...rows,
      h('p.onb-note', ready ? `${ready === 2 ? 'Both are' : 'One is'} ready. CodaClauda never asks for API keys: it uses the sign-in the CLI already has.` : 'Install or sign in, then rescan. Agent setup has the details.'),
      h('div.onb-inline', h('button.btn.small', { type: 'button', onclick: () => loadClis(true) }, icon('refresh'), 'Rescan'), h('button.btn.small.ghost', { type: 'button', onclick: () => navigate('connect') }, icon('agentAdd'), 'Agent setup')),
    ];
  }
  function renderProjects() {
    const linked = store.projects;
    const found = Array.isArray(state.found) ? state.found : [];
    const names = linked.slice(0, 6).map(p => h('span.onb-chip', { title: p.path || p.repo?.full_name || p.name }, p.name));
    return [
      h('div.onb-stat', h('strong', String(linked.length)), linked.length === 1 ? ' project linked' : ' projects linked'),
      names.length ? h('div.onb-chips', names, linked.length > 6 ? h('span.onb-chip.more', `+${linked.length - 6}`) : null) : h('p.onb-note', 'Nothing linked yet. Link a Desktop folder or your GitHub repos.'),
      state.found === 'checking' ? h('div.onb-checking', h('span.spinner'), 'Checking your Desktop for project folders…')
        : found.length ? h('p.onb-note', `${found.length} more folder${found.length === 1 ? '' : 's'} on your Desktop look${found.length === 1 ? 's' : ''} like project${found.length === 1 ? '' : 's'}: ${found.slice(0, 3).map(p => p.name || String(p.path).split(/[\\/]/).pop()).join(', ')}${found.length > 3 ? '…' : ''}`) : null,
      h('div.onb-inline', h('button.btn.small', { type: 'button', onclick: () => navigate('projects') }, icon('projects'), linked.length ? 'Manage projects' : 'Link projects')),
    ];
  }
  function renderAccess() {
    const own = store.projects.filter(ownedByBen).length, all = store.projects.length;
    const option = (id, title, text) => h(`label.onb-option${state.choice === id ? '.on' : ''}`,
      h('input', { type: 'radio', name: 'onb-access', value: id, checked: state.choice === id, onchange: () => { state.choice = id; for (const el of body.querySelectorAll('.onb-option')) el.classList.toggle('on', el.querySelector('input').checked); } }),
      h('span.onb-option-text', h('strong', title), h('span.muted', text)));
    return [
      option('own', 'Full for my own projects (recommended)', `Your local folders and delores88 repos${all ? ` (${own} of ${all} now)` : ''}: agents work without permission prompts. Anything else is Read only.`),
      option('read', 'Read only everywhere', `Agents can read, search and explain, but not change files, commit or push.${all ? ` Sets the ${all} project${all === 1 ? '' : 's'} linked now; new projects you own still start at Full.` : ''}`),
      h('p.onb-note', ACCESS_NOTE),
    ];
  }
  function renderChat() {
    return [
      h('ol.onb-list', h('li', 'Open Chat and press New chat.'), h('li', 'Choose a project and Claude Code or Codex.'), h('li', 'Type what you want done. Replies stream in; Stop is always there.')),
      h('p.onb-note', 'The City shows every agent at work: drag one onto a building to give it a task there.'),
    ];
  }
  function render() {
    if (closed) return;
    const s = STEPS[step];
    heading.textContent = s.title;
    lead.textContent = s.lead;
    counter.textContent = `${step + 1} of ${STEPS.length}`;
    [...dots.children].forEach((dot, k) => dot.classList.toggle('on', k <= step));
    back.hidden = step === 0;
    next.disabled = state.applying;
    next.textContent = s.id === 'chat' ? 'Start a chat' : s.id === 'access' ? (state.applying ? 'Saving…' : 'Use this') : 'Next';
    clear(body, ...(s.id === 'clis' ? renderClis() : s.id === 'projects' ? renderProjects() : s.id === 'access' ? renderAccess() : renderChat()));
  }

  document.body.append(card);
  ensureStyles().then(() => {
    if (closed) return;
    card.hidden = false;
    go(0);
    requestAnimationFrame(() => next.focus({ preventScroll: true }));
  });
  // Projects linked while the tour is open show up on its projects step (re-rendered only when they change).
  let projectSig = '';
  const off = store.on('change', () => {
    if (closed) { off(); return; }
    const sig = store.projects.map(p => p.id).join('|');
    if (sig !== projectSig) { projectSig = sig; if (STEPS[step].id === 'projects' || STEPS[step].id === 'access') render(); }
  });
  return { close: () => finish({ silent: true }) };
}
