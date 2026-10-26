/* City navigation: pure ordering/filtering plus a small keyboard-friendly picker. */
import { h, icon, clear, toMs } from '../ui.js';
import { DOWNTOWN, districtOf, isUnbuilt, projectIds } from './districts.js';

const alphabetic = (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }) || a.id.localeCompare(b.id);
const recent = a => { const value = toMs(a.lastSeenAt ?? a.lastActivityAt); return Number.isFinite(value) ? value : 0; };
const textOf = value => String(value || '').trim();
const PROVIDERS = { claude: 'Claude', codex: 'Codex', other: 'Agent' };

/** Stable section order; filtering preserves the working-first order and uses project aliases.
 * Counts describe the filtered rows. Inputs are never sorted or changed in place. */
export function jumpToGroups({ projects = [], agents = [], runners = [], query = '' } = {}) {
  const words = textOf(query).toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const matches = values => { const haystack = values.join(' ').toLocaleLowerCase(); return words.every(word => haystack.includes(word)); };
  const byProject = new Map();
  for (const p of projects) for (const id of projectIds(p)) byProject.set(id, p);
  const location = a => byProject.get(a.currentProjectId || a.homeProjectId);
  const agentRows = agents.map(a => {
    const project = location(a), name = textOf(a.name || a.label) || 'Agent';
    return { id: a.id, name, target: { kind: 'agent', id: a.id }, provider: a.provider || 'other', status: a.status, at: recent(a), projectName: project?.name || textOf(a.projectHint) || (a.currentProjectId ? 'Unlisted project' : 'HQ'), agent: a };
  });
  const filteredAgents = agentRows.filter(a => matches([a.name, a.projectName, PROVIDERS[a.provider] || 'Agent']));
  const working = filteredAgents.filter(a => a.status === 'active').sort((a, b) => b.at - a.at || alphabetic(a, b));
  const awake = filteredAgents.filter(a => a.status !== 'active' && a.status !== 'offline').sort(alphabetic);
  const powered = filteredAgents.filter(a => a.status === 'offline').sort(alphabetic);
  const projectRows = projects.map(p => {
    const here = agentRows.filter(a => {
      const at = a.agent.status === 'offline' ? a.agent.homeProjectId : a.agent.currentProjectId;
      return byProject.get(at)?.id === p.id;
    });
    const working = here.filter(a => a.status === 'active').length;
    return { id: p.id, name: textOf(p.name) || p.id, target: { kind: 'building', id: p.id }, group: isUnbuilt(p) ? 'ghosts' : districtOf(p), working, agentCount: here.length, agents: here };
  }).filter(p => matches([p.name, ...p.agents.map(a => a.name)]))
    .sort((a, b) => Number(b.working > 0) - Number(a.working > 0) || alphabetic(a, b));
  const subgroups = [[DOWNTOWN, 'Downtown'], ['suburbs', 'Suburbs'], ['ghosts', 'Not on this PC']]
    .map(([id, label]) => ({ id, label, rows: projectRows.filter(p => p.group === id) })).filter(g => g.rows.length);
  const spark = runners.map(r => ({ id: r.id, name: r.crew ? 'Spark crew' : textOf(r.agent?.name) || 'Spark runner', projectName: r.crew ? 'Resting' : textOf(r.label || r.job?.label || r.job?.project || r.job?.projectId) || 'DGX Spark job', provider: r.agent?.provider || 'other', status: r.crew ? 'idle' : 'active', target: { kind: 'runner', id: r.id } }))
    .filter(r => matches([r.name, r.projectName])).sort(alphabetic);
  return [
    { id: 'working', label: 'Working now', rows: working },
    { id: 'projects', label: 'Projects', rows: subgroups.flatMap(g => g.rows), subgroups },
    { id: 'awake', label: 'Awake', rows: awake },
    { id: 'powered', label: 'Powered down', rows: powered, collapsed: true },
    { id: 'spark', label: 'DGX Spark', rows: spark },
  ].filter(g => g.rows.length).map(g => ({ ...g, count: g.rows.length }));
}

let pickerSequence = 0;
export class JumpToPicker {
  constructor({ onSelect = () => {}, onYou = () => {}, onHQ = () => {} } = {}) {
    this.onSelect = onSelect;
    this.onYou = onYou;
    this.onHQ = onHQ;
    this.data = {};
    this.poweredOpen = false;
    const panelId = `city-jumpto-${++pickerSequence}`;
    this.trigger = h('button.city-jumpto-trigger', { type: 'button', 'aria-haspopup': 'dialog', 'aria-expanded': 'false', 'aria-controls': panelId, onclick: () => this.opened ? this.close({ refocus: true }) : this.open() }, icon('search'), 'Jump to…', icon('arrowDown', 'city-jumpto-chevron'));
    this.root = h('div.city-jumpto', this.trigger);
    this.search = h('input.input.city-jumpto-search', { type: 'search', placeholder: 'Search agents or projects', 'aria-label': 'Search agents or projects', autocomplete: 'off', oninput: () => { this.poweredOpen = Boolean(this.search.value.trim()); this.render(); } });
    const shortcut = (name, label, run) => h('button.city-jumpto-shortcut', { type: 'button', onclick: () => { this.close(); run(); } }, icon(name), label);
    this.sparkShortcut = shortcut('bolt', 'Spark', () => this.onSelect({ kind: 'spark' }));
    this.sparkShortcut.hidden = true;
    this.list = h('div.city-jumpto-list');
    this.panel = h('div.city-jumpto-panel', { id: panelId, role: 'dialog', 'aria-label': 'Jump to a building or agent', hidden: true },
      h('div.city-jumpto-search-row', this.search, h('button.icon-btn.city-jumpto-close', { type: 'button', 'aria-label': 'Close Jump to', onclick: () => this.close({ refocus: true }) }, icon('close'))),
      h('div.city-jumpto-shortcuts', shortcut('avatar', 'You', this.onYou), shortcut('home', 'HQ', this.onHQ), this.sparkShortcut), this.list);
    this.onKey = event => this.keydown(event);
    this.root.addEventListener('keydown', this.onKey);
    this.panel.addEventListener('keydown', this.onKey);
    this.outside = event => { if (!this.root.contains(event.target) && !this.panel.contains(event.target)) this.close(); };
    this.reposition = () => this.position();
  }

  update(data) {
    this.data = data;
    this.sparkShortcut.hidden = !data.sparkEnabled;
    // City refreshes frequently. Avoid replacing focused rows when nothing displayed changed.
    const groups = jumpToGroups({ ...data, query: this.search.value });
    const signature = JSON.stringify(groups, (name, value) => name === 'agent' ? undefined : value);
    if (signature !== this.signature) { this.signature = signature; if (this.opened) this.render(groups); }
  }

  open() {
    if (this.opened) return;
    this.opened = true;
    this.root.classList.add('is-open');
    this.trigger.setAttribute('aria-expanded', 'true');
    // Mount beside the HUD: its backdrop filter would otherwise confine a mobile sheet.
    this.host = this.root.closest('.city-root') || this.root;
    this.host.append(this.panel);
    this.panel.hidden = false;
    this.search.value = '';
    this.poweredOpen = false;
    this.render();
    this.position();
    document.addEventListener('pointerdown', this.outside, true);
    document.addEventListener('focusin', this.outside);
    window.addEventListener('resize', this.reposition);
    this.search.focus({ preventScroll: true });
  }

  close({ refocus = false } = {}) {
    if (!this.opened) return;
    this.opened = false;
    this.panel.hidden = true;
    this.root.classList.remove('is-open');
    this.trigger.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', this.outside, true);
    document.removeEventListener('focusin', this.outside);
    window.removeEventListener('resize', this.reposition);
    if (refocus) this.trigger.focus({ preventScroll: true });
  }

  position() {
    if (!this.opened) return;
    const host = this.host.getBoundingClientRect(), anchor = this.trigger.getBoundingClientRect();
    const small = window.innerWidth <= 600 || host.width <= 600;
    const parent = small ? document.body : this.host;
    if (this.panel.parentElement !== parent) {
      const focused = this.panel.contains(document.activeElement) ? document.activeElement : null;
      parent.append(this.panel);
      focused?.focus({ preventScroll: true });
    }
    this.panel.classList.toggle('is-sheet', small);
    if (small) { this.panel.style.left = '0px'; this.panel.style.top = 'auto'; this.panel.style.maxHeight = `${Math.max(160, window.innerHeight - 12)}px`; }
    else {
      const width = Math.min(360, host.width - 24);
      this.panel.style.left = `${Math.max(12, Math.min(anchor.left - host.left, host.width - width - 12))}px`;
      const top = Math.max(12, anchor.bottom - host.top + 8);
      this.panel.style.top = `${top}px`;
      this.panel.style.maxHeight = `${Math.max(160, host.height - top - 12)}px`;
    }
  }

  render(groups = jumpToGroups({ ...this.data, query: this.search.value })) {
    const focusedId = document.activeElement?.dataset?.jumpId;
    clear(this.list);
    for (const group of groups) {
      const heading = h('span.city-jumpto-heading-text', group.label, h('span.city-jumpto-count', String(group.count)));
      const section = h('section.city-jumpto-group', { 'aria-label': group.label });
      if (group.collapsed) {
        const expanded = this.poweredOpen;
        section.append(h('button.city-jumpto-heading.city-jumpto-toggle', { type: 'button', 'aria-expanded': String(expanded), dataset: { jumpId: 'powered-toggle' }, onclick: () => { this.poweredOpen = !expanded; this.render(); } }, heading, icon(expanded ? 'arrowDown' : 'arrowRight')));
        if (!expanded) { this.list.append(section); continue; }
      } else section.append(h('div.city-jumpto-heading', heading));
      if (group.subgroups) for (const sub of group.subgroups) section.append(h('div.city-jumpto-subgroup', { role: 'group', 'aria-label': sub.label }, h('div.city-jumpto-subheading', sub.label, h('span.city-jumpto-count', String(sub.rows.length))), ...sub.rows.map(row => this.row(row))));
      else section.append(...group.rows.map(row => this.row(row)));
      this.list.append(section);
    }
    if (!groups.length) this.list.append(h('p.city-jumpto-empty', { role: 'status' }, this.search.value.trim() ? 'No agents or projects match.' : 'No agents or projects here yet.'));
    if (focusedId) {
      const replacement = [...this.list.querySelectorAll('[data-jump-id]')].find(node => node.dataset.jumpId === focusedId);
      (replacement || this.search).focus({ preventScroll: true });
    }
  }

  row(row) {
    const project = row.target.kind === 'building';
    const provider = ['claude', 'codex'].includes(row.provider) ? row.provider : 'other';
    const graphic = project ? icon(row.group === 'ghosts' ? 'github' : row.group === DOWNTOWN ? 'city' : 'home') : h(`span.city-jumpto-provider.${provider}`, { title: PROVIDERS[provider], 'aria-label': PROVIDERS[provider] }, icon(provider === 'claude' ? 'sparkle' : provider === 'codex' ? 'terminal' : 'avatar'));
    return h('button.city-jumpto-item', { type: 'button', dataset: { jumpId: `${row.target.kind}:${row.id}` }, onclick: () => { this.close(); this.onSelect(row.target); } },
      !project ? h(`span.city-jumpto-dot.${row.status === 'active' ? 'active' : row.status === 'offline' ? 'offline' : 'idle'}`, { title: row.status === 'active' ? 'Working now' : row.status === 'offline' ? 'Powered down' : 'Awake' }) : null,
      graphic,
      h('span.city-jumpto-text', h('span.city-jumpto-name', row.name), !project ? h('span.city-jumpto-location', row.projectName) : null),
      project ? h(`span.city-jumpto-badge${row.working ? '.is-working' : ''}`, { title: `${row.agentCount} agent${row.agentCount === 1 ? '' : 's'} here${row.working ? `, ${row.working} working` : ''}` }, icon('agents'), String(row.agentCount)) : null);
  }

  keydown(event) {
    if (event.key === 'Escape' && this.opened) { event.preventDefault(); event.stopPropagation(); this.close({ refocus: true }); return; }
    if (event.key === 'Enter' && this.opened && event.target === this.search) {
      const first = this.list.querySelector('.city-jumpto-item');
      if (first) { event.preventDefault(); event.stopPropagation(); first.click(); }
      return;
    }
    if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation();
    if (!this.opened) this.open();
    const rows = [...this.list.querySelectorAll('button')], at = rows.indexOf(document.activeElement);
    if (!rows.length) return;
    const next = event.key === 'ArrowDown' ? (at + 1) % rows.length : at < 0 ? rows.length - 1 : at - 1;
    if (next < 0) this.search.focus({ preventScroll: true });
    else { rows[next].focus({ preventScroll: true }); rows[next].scrollIntoView({ block: 'nearest' }); }
  }

  destroy() {
    this.close();
    this.root.removeEventListener('keydown', this.onKey);
    this.panel.removeEventListener('keydown', this.onKey);
    this.panel.remove();
    this.root.remove();
  }
}
