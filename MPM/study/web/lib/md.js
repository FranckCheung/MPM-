/* 轻量离线 Markdown 渲染器（无外部依赖）
 * 支持：标题、粗体、斜体、行内代码、代码块、引用、表格、
 *       有序/无序列表（缩进嵌套）、分割线、链接
 */
(function (global) {
  'use strict';

  function esc(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function inline(s) {
    s = esc(s);
    s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
    s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    return s;
  }

  function listItemDepth(line) {
    const m = /^(\s*)/.exec(line);
    return Math.floor(m[1].replace(/\t/g, '  ').length / 2);
  }

  function render(src) {
    if (!src) return '';
    const lines = src.replace(/\r\n?/g, '\n').split('\n');
    const out = [];
    let i = 0;

    while (i < lines.length) {
      const line = lines[i];

      // 代码块
      if (/^\s*```/.test(line)) {
        const lang = line.replace(/^\s*```/, '').trim();
        const buf = [];
        i++;
        while (i < lines.length && !/^\s*```/.test(lines[i])) buf.push(esc(lines[i++]));
        i++;
        out.push('<pre class="md-pre"' + (lang ? ' data-lang="' + esc(lang) + '"' : '') +
          '><code>' + buf.join('\n') + '</code></pre>');
        continue;
      }

      // 空行
      if (!line.trim()) { i++; continue; }

      // 注释
      if (/^\s*<!--/.test(line)) {
        while (i < lines.length && !/-->/.test(lines[i])) i++;
        i++;
        continue;
      }

      // 标题
      const h = /^(#{1,6})\s+(.*)$/.exec(line);
      if (h) {
        out.push('<h' + h[1].length + '>' + inline(h[2].trim()) + '</h' + h[1].length + '>');
        i++;
        continue;
      }

      // 分割线
      if (/^\s*([-*_])\s*\1\s*\1[\s\-*_]*$/.test(line)) { out.push('<hr>'); i++; continue; }

      // 表格
      if (/\|/.test(line) && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(lines[i + 1])) {
        const head = line.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map(function (c) { return c.trim(); });
        i += 2;
        const rows = [];
        while (i < lines.length && /\|/.test(lines[i]) && lines[i].trim()) {
          rows.push(lines[i].replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map(function (c) { return c.trim(); }));
          i++;
        }
        let html = '<div class="md-table-wrap"><table><thead><tr>' +
          head.map(function (c) { return '<th>' + inline(c) + '</th>'; }).join('') + '</tr></thead><tbody>';
        rows.forEach(function (r) {
          html += '<tr>' + r.map(function (c) { return '<td>' + inline(c) + '</td>'; }).join('') + '</tr>';
        });
        out.push(html + '</tbody></table></div>');
        continue;
      }

      // 引用
      if (/^\s*>/.test(line)) {
        const buf = [];
        while (i < lines.length && /^\s*>/.test(lines[i])) {
          buf.push(inline(lines[i].replace(/^\s*>\s?/, '')));
          i++;
        }
        out.push('<blockquote>' + buf.join('<br>') + '</blockquote>');
        continue;
      }

      // 列表
      const ul = /^(\s*)([-*+])\s+(.*)$/.exec(line);
      const ol = /^(\s*)(\d+)[.)]\s+(.*)$/.exec(line);
      if (ul || ol) {
        const ordered = !!ol && !ul;
        const items = [];
        while (i < lines.length) {
          const m = ordered
            ? /^(\s*)(\d+)[.)]\s+(.*)$/.exec(lines[i])
            : /^(\s*)([-*+])\s+(.*)$/.exec(lines[i]);
          if (!m) {
            // 列表项续行
            if (items.length && lines[i].trim() && /^\s{2,}/.test(lines[i])) {
              items[items.length - 1].text += ' ' + lines[i].trim();
              i++;
              continue;
            }
            break;
          }
          const depth = listItemDepth(lines[i]);
          items.push({ depth: depth, text: m[3] });
          i++;
        }
        out.push(buildList(items, ordered, 0, 0)[0]);
        continue;
      }

      // 段落
      const buf = [];
      while (i < lines.length && lines[i].trim() &&
        !/^(#{1,6}\s|\s*>|\s*```|\s*[-*+]\s|\s*\d+[.)]\s|\s*<!--)/.test(lines[i]) &&
        !/^\s*([-*_])\s*\1\s*\1[\s\-*_]*$/.test(lines[i])) {
        buf.push(inline(lines[i]));
        i++;
      }
      if (buf.length) out.push('<p>' + buf.join('<br>') + '</p>');
      else i++;
    }

    return out.join('\n');
  }

  function buildList(items, ordered, start, depth) {
    let html = '<' + (ordered ? 'ol' : 'ul') + '>';
    let i = start;
    while (i < items.length) {
      if (items[i].depth > depth) {
        const sub = buildList(items, ordered, i, items[i].depth);
        html = html.replace(/<\/li>$/, sub[0] + '</li>');
        i = sub[1];
        continue;
      }
      if (items[i].depth < depth) break;
      html += '<li>' + inline(items[i].text) + '</li>';
      i++;
    }
    return [html + '</' + (ordered ? 'ol' : 'ul') + '>', i];
  }

  global.MD = { render: render, escape: esc };
})(window);
