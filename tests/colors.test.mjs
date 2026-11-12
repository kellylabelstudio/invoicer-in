import test from 'node:test';
import assert from 'node:assert/strict';
import { accentTokens, contrastRatio, normalizeColor } from '../web/colors.mjs';

test('custom colors normalize valid hex and reject CSS, URLs and alpha values',()=>{
  assert.equal(normalizeColor(' #AbC '),'#aabbcc');
  assert.equal(normalizeColor('#086E66'),'#086e66');
  for(const value of ['red','rgba(1,2,3,.1)','#ffffff00','#fff; color:red','url(x)',null,42]) assert.equal(normalizeColor(value),null);
});

test('very pale, bright and dark custom accents retain readable labels and focus edges',()=>{
  for(const theme of ['light','dark']) for(const color of ['#ffffff','#000000','#ffff00','#00ffff','#ff0000','#0000ff','#808080','#0a223e','#7050d3','#66dbc9']) {
    const tokens=accentTokens(color,theme),background=theme==='dark'?'#111113':'#ffffff';
    assert.equal(tokens['--accent'],color);
    assert.ok(contrastRatio(tokens['--accent-text'],color)>=4.5,`${theme} ${color} button label`);
    assert.ok(contrastRatio(tokens['--accent-ink'],tokens['--accent-soft'])>=4.5,`${theme} ${color} tinted label`);
    assert.ok(contrastRatio(tokens['--focus'],background)>=3,`${theme} ${color} focus edge`);
  }
});
