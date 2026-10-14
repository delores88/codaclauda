/* Safe Markdown → DOM for untrusted agent/mailbox text.
 * marked (GFM) + KaTeX math (MathML output, no fonts/inline CSS) + highlight.js,
 * sanitized by DOMPurify. Remote images are dropped; links open externally. */
import { Marked } from '../vendor/marked/marked.esm.js';
import DOMPurify from '../vendor/dompurify/purify.es.js';
import katex from '../vendor/katex/katex.js';
import hljs from '../vendor/highlight/highlight.min.js';
import { h, icon, copyText } from './ui.js';
import { desktop } from './bridge.js';

const tex = (source, displayMode) => {
  try { return katex.renderToString(source, { output: 'mathml', displayMode, throwOnError: false, strict: 'ignore', trust: false }); }
  catch { return `<code>${source.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))}</code>`; }
};

const mathExtension = {
  extensions: [
    { name: 'blockMath', level: 'block',
      start: src => src.match(/^\s*(\$\$|\\\[)/m)?.index,
      tokenizer(src) { const m = /^\s*(?:\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\])[^\S\n]*(?:\n|$)/.exec(src); if (m) return { type: 'blockMath', raw: m[0], text: (m[1] ?? m[2]).trim() }; },
      renderer: token => `<div class="math-block">${tex(token.text, true)}</div>` },
    { name: 'inlineMath', level: 'inline',
      start: src => { const i = src.search(/\$|\\\(/); return i < 0 ? undefined : i; },
      tokenizer(src) {
        let m = /^\$\$([^$\n]+?)\$\$/.exec(src) || /^\\\(([\s\S]+?)\\\)/.exec(src);
        if (m) return { type: 'inlineMath', raw: m[0], text: m[1].trim(), display: m[0].startsWith('$$') };
        m = /^\$(?![\s$])((?:\\\$|[^$\n])+?)(?<![\s\\])\$(?!\d)/.exec(src);
        if (m) return { type: 'inlineMath', raw: m[0], text: m[1], display: false };
      },
      renderer: token => `<span class="math-inline">${tex(token.text, token.display)}</span>` },
  ],
};

const marked = new Marked({ gfm: true, breaks: true }, mathExtension, {
  renderer: {
    code({ text, lang }) {
      const language = String(lang || '').trim().split(/\s+/)[0].toLowerCase();
      let html;
      try {
        if (language && hljs.getLanguage(language)) html = hljs.highlight(text, { language, ignoreIllegals: true }).value;
        else if (text.length < 6000) { const auto = hljs.highlightAuto(text); html = auto.value; }
      } catch { html = null; }
      html ??= text.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
      const label = (language || '').replace(/[^a-z0-9+#.-]/gi, '') || 'text';
      return `<div class="code-block" data-lang="${label}"><pre><code class="hljs">${html}</code></pre></div>`;
    },
  },
});

const PURIFY = {
  USE_PROFILES: { html: true, mathMl: true },
  FORBID_TAGS: ['style', 'form', 'input', 'button', 'textarea', 'select', 'iframe', 'object', 'embed', 'video', 'audio', 'source', 'svg'],
  FORBID_ATTR: ['style', 'srcset'],
  ALLOW_DATA_ATTR: true,
  ADD_TAGS: ['input'], // task-list checkboxes (re-checked below)
};

/** Render untrusted Markdown to a detached <div class="md"> element. */
export function renderMarkdown(text, { compact = false } = {}) {
  const root = h(`div.md${compact ? '.compact' : ''}`);
  let html = '';
  try { html = marked.parse(String(text ?? '')); } catch { html = ''; }
  const clean = DOMPurify.sanitize(html, { ...PURIFY, FORBID_TAGS: PURIFY.FORBID_TAGS.filter(t => t !== 'input'), RETURN_DOM_FRAGMENT: true });
  root.append(clean);
  enhance(root);
  return root;
}

function enhance(root) {
  for (const input of root.querySelectorAll('input')) {
    if (input.type !== 'checkbox') { input.remove(); continue; }
    input.disabled = true; input.classList.add('task-check');
  }
  for (const img of root.querySelectorAll('img')) {
    if (!/^data:image\/(png|jpe?g|gif|webp);/i.test(img.getAttribute('src') || '')) img.replaceWith(h('span.md-image-blocked', `[image: ${img.alt || 'remote image not loaded'}]`));
  }
  for (const link of root.querySelectorAll('a')) {
    const href = link.getAttribute('href') || '';
    link.removeAttribute('target');
    link.title = href;
    link.addEventListener('click', event => {
      event.preventDefault();
      if (/^https?:\/\//i.test(href)) desktop.openExternal?.(href).catch(() => copyText(href, 'Link copied'));
      else copyText(href, 'Link copied');
    });
  }
  for (const table of root.querySelectorAll('table')) table.replaceWith(h('div.table-scroll', table.cloneNode(true)));
  for (const block of root.querySelectorAll('.code-block')) {
    const code = block.querySelector('code');
    const lines = code.textContent.split('\n').length;
    block.prepend(h('div.code-head', h('span.code-lang', block.dataset.lang), h('button.code-copy', { type: 'button', title: 'Copy code', onclick: async event => {
      const btn = event.currentTarget;
      if (await copyText(code.textContent.replace(/\n$/, ''), 'Code copied')) { btn.classList.add('copied'); btn.replaceChildren(icon('check'), 'Copied'); setTimeout(() => { btn.classList.remove('copied'); btn.replaceChildren(icon('copy'), 'Copy'); }, 1600); }
    } }, icon('copy'), 'Copy')));
    if (lines > 40) block.classList.add('tall');
  }
}

/** Markdown → short plain text for previews and notifications. */
export function plainText(text, limit = 160) {
  const stripped = String(text ?? '')
    .replace(/```[\s\S]*?```/g, ' [code] ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\$\$[\s\S]*?\$\$/g, ' [math] ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*_~>#|-]+/g, ' ')
    .replace(/\s+/g, ' ').trim();
  return stripped.length > limit ? `${stripped.slice(0, limit - 1)}…` : stripped;
}
