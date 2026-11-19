// Claude answers in Markdown; Telegram renders only its own HTML subset. Pure converter: markdown in, parse_mode=HTML out.
// Tables become bullets (a pipe table wraps into noise on a phone), headers become bold, fences become <pre>.
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function inline(line: string): string {
  const codes: string[] = [];
  let s = line.replace(/`([^`\n]+)`/g, (_m, c: string) => { codes.push(`<code>${esc(c)}</code>`); return `\u0000${codes.length - 1}\u0000`; });
  s = esc(s);
  s = s.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (_m, t: string, u: string) => `<a href="${u.replace(/"/g, '&quot;')}">${t}</a>`);
  s = s.replace(/\*\*([^*\n]+?)\*\*/g, '<b>$1</b>').replace(/__([^_\n]+?)__/g, '<b>$1</b>');
  s = s.replace(/(^|[\s(])\*([^\s*][^*\n]*?)\*(?=$|[\s).,;:!?])/g, '$1<i>$2</i>');
  return s.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => codes[Number(i)]);
}

const isRow = (l: string) => /^\s*\|.*\|\s*$/.test(l);
const isSep = (l: string) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l) && l.includes('-');
const cells = (l: string) => l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());

/** `pm`: Telegram HTML for sendMessage; `text`: the readable plain twin. */
export function mdToTg(md: string): { pm: string; text: string } {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [], plain: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const fence = /^\s*```/.exec(l);
    if (fence) {
      const body: string[] = [];
      for (i++; i < lines.length && !/^\s*```/.test(lines[i]); i++) body.push(lines[i]);   // an unclosed fence runs to the end
      out.push(`<pre>${esc(body.join('\n'))}</pre>`); plain.push(...body);
      continue;
    }
    if (isRow(l) && i + 1 < lines.length && isSep(lines[i + 1])) {
      const head = cells(l);
      for (i += 2; i < lines.length && isRow(lines[i]); i++) {
        const c = cells(lines[i]);
        out.push(`• <b>${inline(c[0] ?? '')}</b>${c.length > 1 ? ' — ' + c.slice(1).map((x, k) => (head[k + 1] && x ? `${esc(head[k + 1])}: ` : '') + inline(x)).filter(Boolean).join(' · ') : ''}`);
        plain.push(`• ${c.join(' · ')}`);
      }
      i--;
      continue;
    }
    const h = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/.exec(l);
    if (h) { out.push(`<b>${inline(h[1])}</b>`); plain.push(h[1]); continue; }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(l)) { out.push(''); plain.push(''); continue; }   // horizontal rule
    const q = /^\s*>\s?(.*)$/.exec(l);
    if (q) {
      const body = [q[1]];
      while (i + 1 < lines.length && /^\s*>/.test(lines[i + 1])) body.push(lines[++i].replace(/^\s*>\s?/, ''));
      out.push(`<blockquote>${body.map(inline).join('\n')}</blockquote>`); plain.push(...body.map(b => `> ${b}`));
      continue;
    }
    const b = /^(\s*)[-*+]\s+(.*)$/.exec(l);
    if (b) { out.push(`${b[1].length >= 2 ? '  ' : ''}• ${inline(b[2])}`); plain.push(`• ${b[2].replace(/\*\*|`/g, '')}`); continue; }
    out.push(inline(l)); plain.push(l.replace(/\*\*|`/g, ''));
  }
  const text = plain.join('\n').replace(/\n{3,}/g, '\n\n').trim(), pm = out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return { pm: nested(pm) ? pm : esc(text), text };   // mis-nested tags (**a *b** c*) would make Telegram refuse the whole message
}

function nested(html: string): boolean {
  const stack: string[] = [];
  for (const m of html.matchAll(/<(\/?)(b|i|code|pre|a|blockquote)\b[^>]*>/g)) {
    if (!m[1]) stack.push(m[2]);
    else if (stack.pop() !== m[2]) return false;
  }
  return stack.length === 0;
}
