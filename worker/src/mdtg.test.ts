import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mdToTg } from './mdtg.ts';

test('headers, bold, italic, code and links become the HTML subset Telegram accepts', () => {
  const r = mdToTg('# Title\nsome **bold** and *it* and `x < y` and [a link](https://example.com/p?q=1&r=2)');
  assert.equal(r.pm, '<b>Title</b>\nsome <b>bold</b> and <i>it</i> and <code>x &lt; y</code> and <a href="https://example.com/p?q=1&amp;r=2">a link</a>');
});

test('a pipe table becomes bullets and a fence becomes a pre block, escaped', () => {
  const r = mdToTg('| name | size |\n|---|---|\n| a | 1 |\n| b | 2 |\n\n```\n<tag> & more\n```');
  assert.match(r.pm, /• <b>a<\/b> — size: 1\n• <b>b<\/b> — size: 2/);
  assert.match(r.pm, /<pre>&lt;tag&gt; &amp; more<\/pre>/);
});

test('lists and quotes; an unclosed fence runs to the end instead of breaking the message', () => {
  assert.equal(mdToTg('- one\n  - two\n> quote').pm, '• one\n  • two\n<blockquote>quote</blockquote>');
  assert.match(mdToTg('```\nnever closed').pm, /<pre>never closed<\/pre>/);
});

test('mis-nested emphasis falls back to the escaped plain text rather than a message Telegram would refuse', () => {
  const r = mdToTg('**a *b** c*');
  assert.ok(!/<b>.*<i>.*<\/b>/.test(r.pm));
});

test('raw HTML in the model\'s text is escaped, never passed through', () => {
  assert.equal(mdToTg('<script>alert(1)</script> & <b>x</b>').pm, '&lt;script&gt;alert(1)&lt;/script&gt; &amp; &lt;b&gt;x&lt;/b&gt;');
});
