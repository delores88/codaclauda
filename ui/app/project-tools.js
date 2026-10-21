/* Per-project tools (0.5), opened from Projects and from Chat's connected-resources panel:
 *   openInstructions  edit CLAUDE.md and AGENTS.md at the project root only (200 KB cap), through
 *                     project_instructions_read / project_instructions_write;
 *   openMcpTools      bring-your-own MCP servers { name, command, args, env } through mcp_servers_get / _set.
 *                     The engine passes them only to sessions started at Full access. CodaClauda never
 *                     downloads or installs them; the presets are install instructions as text.
 * File text is rendered only as a textarea value; nothing here uses innerHTML. */
import { has, call, PROJECT_FILES, INSTRUCTIONS_LIMIT, utf8Length, parseServers, UNSUPPORTED_TEXT } from './features.js';

export const MCP_NOTE = 'Full access only: sessions started at Full access in this project get these tools; Read only sessions never do. CodaClauda never downloads or installs them; you install each one yourself.';

/* Checked 2026-10-20: @playwright/mcp 0.0.83 on the npm registry (Apache-2.0) has bin { "playwright-mcp": "cli.js" };
 * the CursorTouch/Windows-MCP README (MIT) needs Python 3.14+ and uv and documents `uvx windows-mcp serve`, which
 * downloads the package on first use. This preset never uses uvx: the owner installs it with `uv tool install
 * windows-mcp` (its windows-mcp command) and ticks "I installed it myself" before Add is enabled. */
export const MCP_PRESETS = [
  {
    id: 'playwright', name: 'playwright', title: 'Playwright MCP', by: 'Microsoft · Apache-2.0',
    command: 'playwright-mcp', args: [],
    install: ['npm i -g @playwright/mcp'],
    text: 'Browser automation through the page structure. Install it once in a terminal with the command below; it adds a playwright-mcp command (the package bin, checked on the npm registry for 0.0.83).',
  },
  {
    id: 'windows', name: 'windows-mcp', title: 'Windows-MCP', by: 'CursorTouch · MIT · third-party',
    command: 'windows-mcp', args: ['serve'],
    install: ['uv tool install windows-mcp'],
    confirm: 'I installed it myself',
    text: 'Windows desktop control (UI Automation, screenshots, mouse and keyboard). Install it yourself first in a terminal with the command below (its README also needs Python 3.14+ and uv); that adds a windows-mcp command, which this preset runs as "windows-mcp serve". If it is not on your PATH, put its full path in Command ("uv tool dir --bin" shows the folder). CodaClauda never runs uvx and never downloads or installs it. Its README warns it has full system access and can do irreversible things; it takes over the mouse and keyboard while it works, and on-screen text is untrusted.',
  },
];

const fileTabs = (h, current, onpick) => {
  const buttons = PROJECT_FILES.map(file => h('button', { type: 'button', 'aria-pressed': String(file === current), onclick: () => onpick(file) }, file));
  return h('div.segmented.pt-tabs', { role: 'group', 'aria-label': 'Instruction file' }, buttons);
};

/** CLAUDE.md / AGENTS.md editor for one project with a local folder. */
export function openInstructions({ ui }, project) {
  const { h, icon, modal, toast, formatBytes } = ui;
  if (!project?.path) { toast(`${project?.name || 'This project'} has no local folder, so it has no instruction files here.`, { kind: 'error' }); return; }
  if (!has('instructionsRead')) {
    modal({ title: 'Project instructions', body: h('div.pt-body', h('p', `${UNSUPPORTED_TEXT}.`), h('p.field-hint', 'This build cannot read or write CLAUDE.md and AGENTS.md.')) });
    return;
  }
  const files = new Map(PROJECT_FILES.map(f => [f, { state: 'idle', text: '', original: '', exists: false, error: '' }]));
  let current = 'CLAUDE.md', saving = false;
  const tabsHost = h('div.pt-tabs-host');
  const textarea = h('textarea.input.pt-text', {
    spellcheck: 'false', rows: 18, 'aria-label': 'File text',
    oninput: event => { files.get(current).text = event.currentTarget.value; renderMeta(); },
    onkeydown: event => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); save(); } },
  });
  const status = h('span.pt-status', { role: 'status' });
  const size = h('span.pt-size');
  const saveBtn = h('button.btn.primary.small', { type: 'button', onclick: () => save() }, icon('check'), 'Save');
  const where = h('code.pt-where');
  function renderMeta() {
    const f = files.get(current);
    const bytes = utf8Length(f.text);
    const over = bytes > INSTRUCTIONS_LIMIT;
    size.textContent = `${formatBytes(bytes)} of ${formatBytes(INSTRUCTIONS_LIMIT)}`;
    size.classList.toggle('over', over);
    const dirty = f.state === 'loaded' && f.text !== f.original;
    saveBtn.disabled = saving || f.state !== 'loaded' || !dirty || over;
    status.textContent = f.state === 'loading' ? 'Reading…' : f.state === 'error' ? `Couldn't read: ${f.error}`
      : over ? 'Too large: the limit is 200 KB.' : dirty ? 'Unsaved changes' : f.exists ? 'Saved' : 'No file yet: saving creates it';
    status.classList.toggle('bad', f.state === 'error' || over);
  }
  function render() {
    const f = files.get(current);
    tabsHost.replaceChildren(fileTabs(h, current, file => { current = file; render(); load(file); }));
    where.textContent = `${String(project.path).replace(/[\\/]+$/, '')}\\${current}`;
    textarea.value = f.text;
    textarea.readOnly = f.state !== 'loaded';
    textarea.placeholder = f.state === 'loaded' && !f.exists ? `${current} does not exist yet. Write instructions for ${current === 'CLAUDE.md' ? 'Claude Code' : 'Codex and other agents'} here.` : '';
    renderMeta();
  }
  async function load(file) {
    const f = files.get(file);
    if (f.state === 'loading' || f.state === 'loaded') return;
    f.state = 'loading'; if (file === current) render();
    try {
      const data = await call('instructionsRead', { projectId: project.id, cwd: project.path, file });
      f.text = f.original = typeof data?.text === 'string' ? data.text : '';
      f.exists = data?.exists === true; f.state = 'loaded'; f.error = '';
    } catch (error) { f.state = 'error'; f.error = error?.message || String(error); }
    if (file === current) render();
  }
  async function save() {
    const f = files.get(current), file = current;
    if (saving || f.state !== 'loaded' || f.text === f.original || utf8Length(f.text) > INSTRUCTIONS_LIMIT) return;
    saving = true; renderMeta();
    const text = f.text;
    try {
      await call('instructionsWrite', { projectId: project.id, cwd: project.path, file, text });
      f.original = text; f.exists = true;
      toast(`${file} saved in ${project.name}. New turns read it; a running turn keeps what it read.`, { kind: 'success', timeout: 4200 });
    } catch (error) { toast(`Couldn't save ${file}: ${error?.message || error}`, { kind: 'error', timeout: 8000 }); }
    finally { saving = false; renderMeta(); }
  }
  render(); load(current);
  modal({
    title: `Instructions · ${project.name}`, wide: true,
    body: h('div.pt-body',
      h('div.pt-bar', tabsHost, h('span.pt-spacer'), size, saveBtn),
      textarea,
      h('div.pt-foot', status, h('span.pt-path', 'Project root only: ', where)),
      h('p.field-hint', 'CLAUDE.md is read by Claude Code and AGENTS.md by Codex. Only these two files at the project root can be opened here.')),
    actions: [{ label: 'Close', kind: 'ghost' }],
  });
  requestAnimationFrame(() => textarea.focus({ preventScroll: true }));
}

/** Bring-your-own MCP servers for one project; onSaved(servers) runs after a successful save. */
export function openMcpTools({ ui, store }, project, { onSaved } = {}) {
  const { h, icon, iconButton, modal, toast, copyText } = ui;
  if (!project) return;
  let rows = [], loaded = false, saving = false, dialog = null;
  const installed = new Set();   // presets the owner confirmed they installed themselves (this dialog only)
  if (!has('mcpGet') || !has('mcpSet')) {
    modal({ title: 'MCP tools', body: h('div.pt-body', h('p', `${UNSUPPORTED_TEXT}.`), h('p.field-hint', 'This build cannot attach your own MCP servers to sessions.'), h('p.mcp-note', icon('shield'), h('span', MCP_NOTE)), presetList()) });
    return;
  }
  const listHost = h('div.mcp-rows');
  const errorLine = h('p.newchat-error', { role: 'alert', hidden: true });
  const saveBtn = h('button.btn.primary', { type: 'button', onclick: () => save() }, icon('check'), 'Save tools');
  const level = store?.projectAccess?.(project.id)?.level;
  const readOnly = level === 'read';

  function presetList() {
    return h('div.mcp-presets', MCP_PRESETS.map(p => h('section.mcp-preset',
      h('header', h('strong', p.title), h('span.muted', p.by),
        loaded ? h('button.btn.small', { type: 'button', disabled: rows.some(r => r.name === p.name) || (p.confirm && !installed.has(p.id)), title: p.confirm && !installed.has(p.id) ? `Install it yourself first, then tick "${p.confirm}"` : '', onclick: () => addRow({ name: p.name, command: p.command, args: p.args.join('\n'), env: '' }) }, icon('plus'), 'Add') : null),
      h('p.field-hint', p.text),
      p.confirm && loaded ? h('label.checkbox-label', h('input', { type: 'checkbox', checked: installed.has(p.id), onchange: event => { if (event.currentTarget.checked) installed.add(p.id); else installed.delete(p.id); render(); } }), h('span', `${p.confirm} with ${p.install.join(' / ')}`)) : null,
      h('div.mcp-install', icon('terminal'), h('span', 'You run:'),
        ...p.install.map(cmd => h('code', cmd)),
        ...p.install.map(cmd => iconButton('copy', `Copy ${cmd}`, () => copyText(cmd, 'Command copied')))),
      h('div.mcp-install', h('span', 'Command:'), h('code', [p.command, ...p.args].join(' '))))));
  }
  function addRow(row) { rows.push({ name: '', command: '', args: '', env: '', ...row }); render(); listHost.querySelector('.mcp-row:last-child input')?.focus(); }
  function render() {
    if (!loaded) { listHost.replaceChildren(h('div.view-loading', h('span.spinner'), 'Loading tools…')); return; }
    listHost.replaceChildren(
      ...(rows.length ? rows.map((row, i) => {
        const field = (label, key, attrs = {}) => {
          const control = h(attrs.multiline ? 'textarea.input' : 'input.input', {
            spellcheck: 'false', autocomplete: 'off', rows: attrs.rows || null, placeholder: attrs.placeholder || '', 'aria-label': `${label} for server ${i + 1}`,
            oninput: event => { row[key] = event.currentTarget.value; },
          });
          control.value = row[key] ?? '';   // set as a property: a textarea ignores a value attribute
          return h('label.field', h('span', label), control);
        };
        return h('div.mcp-row',
          h('div.mcp-row-head', h('strong', row.name || `Server ${i + 1}`), iconButton('trash', `Remove ${row.name || `server ${i + 1}`}`, () => { rows.splice(i, 1); render(); })),
          h('div.mcp-grid',
            field('Name', 'name', { placeholder: 'playwright' }),
            field('Command', 'command', { placeholder: 'playwright-mcp' }),
            field('Arguments (one per line)', 'args', { multiline: true, rows: 2 }),
            field('Environment (NAME=value per line; saved as plaintext)', 'env', { multiline: true, rows: 2, placeholder: 'Do not enter credentials here' })));
      }) : [h('p.muted.mcp-empty', 'No MCP tools for this project. Add one, or start from a preset below.')]),
      h('div.res-actions', h('button.btn.small', { type: 'button', onclick: () => addRow({}) }, icon('plus'), 'Add server')));
    const presets = dialog?.querySelector('.mcp-presets');
    if (presets) presets.replaceWith(presetList());
    saveBtn.disabled = saving;
  }
  async function load() {
    try {
      const data = await call('mcpGet', { projectId: project.id });
      rows = (Array.isArray(data?.servers) ? data.servers : []).map(s => ({
        name: String(s?.name ?? ''), command: String(s?.command ?? ''),
        args: (Array.isArray(s?.args) ? s.args : []).map(String).join('\n'),
        env: Object.entries(s?.env && typeof s.env === 'object' ? s.env : {}).map(([k, v]) => `${k}=${v}`).join('\n'),
      }));
    } catch (error) { errorLine.hidden = false; errorLine.textContent = `Couldn't read this project's tools: ${error?.message || error}`; rows = []; }
    loaded = true; render();
  }
  async function save() {
    const parsed = parseServers(rows);
    if (!parsed.ok) { errorLine.hidden = false; errorLine.textContent = parsed.error; return false; }
    saving = true; errorLine.hidden = true; render();
    try {
      const data = await call('mcpSet', { projectId: project.id, servers: parsed.servers });
      const saved = Array.isArray(data?.servers) ? data.servers : parsed.servers;
      const n = saved.length;
      try { onSaved?.(saved); } catch { /* the caller's refresh is best effort */ }
      toast(`${project.name}: ${n ? `${n} MCP tool${n === 1 ? '' : 's'}` : 'no MCP tools'}. Applies to the next Full access session started there.`, { kind: 'success', timeout: 5000 });
      dialog?.close();
    } catch (error) { errorLine.hidden = false; errorLine.textContent = `Couldn't save: ${error?.message || error}`; }
    finally { saving = false; if (dialog?.open) render(); }
    return false;
  }
  render(); load();
  dialog = modal({
    title: `MCP tools · ${project.name}`, wide: true,
    body: h('div.pt-body',
      h('p.mcp-note', icon('shield'), h('span', MCP_NOTE)),
      readOnly ? h('p.res-pending', `${project.name} is Read only, so its sessions get none of these tools until it is set to Full access.`) : null,
      listHost, errorLine,
      h('h4.mcp-presets-title', 'Presets'),
      presetList()),
    actions: [{ label: 'Cancel', kind: 'ghost' }],
  });
  dialog.querySelector('.modal-actions')?.append(saveBtn);
}
