'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createSandbox, loadPlugin } = require('./mv-sandbox');

function bootBridge(search = '') {
  const { sandbox } = createSandbox({ search });
  loadPlugin(sandbox, 'NpcK8sPluginCommand.js');
  return sandbox.NpcK8sBridge;
}

const CJK_RE = /[ᄀ-ᇿ⺀-꓏가-힣豈-﫿︰-﹏＀-￯]/;

function displayWidth(line) {
  let width = 0;
  for (const ch of line) width += CJK_RE.test(ch) ? 2 : 1;
  return width;
}

test('ascii text wraps at word boundaries within the width limit', () => {
  const bridge = bootBridge();
  const text =
    'Create a Deployment named inn in namespace village using nginx and keep it running forever';
  const lines = bridge.wrapText(text).split('\n');
  assert.ok(lines.length > 1);
  for (const line of lines)
    assert.ok(displayWidth(line) <= 55, `too wide: ${line}`);
  assert.equal(lines.join(' '), text);
});

test('chinese text wraps by display width instead of never wrapping', () => {
  const bridge = bootBridge();
  const text =
    '请在集群里创建一个名为村庄的命名空间然后部署三个副本的旅店服务并保证服务端口八十可以访问'.repeat(
      2,
    );
  const lines = bridge.wrapText(text).split('\n');
  assert.ok(lines.length > 1, 'CJK text should wrap onto multiple lines');
  for (const line of lines)
    assert.ok(displayWidth(line) <= 55, `too wide: ${line}`);
  assert.equal(
    lines.join(''),
    text,
    'no characters lost and no spaces injected',
  );
});

test('mixed chinese and english keeps english words intact', () => {
  const bridge = bootBridge();
  const text =
    '请把 inn Deployment 扩容到三个副本然后创建一个名为 inn-service 的服务指向它';
  const lines = bridge.wrapText(text).split('\n');
  for (const line of lines)
    assert.ok(displayWidth(line) <= 55, `too wide: ${line}`);
  const rejoined = lines.join('');
  assert.ok(rejoined.includes('Deployment'));
  assert.ok(rejoined.includes('inn-service'));
});

test('a single overlong word is kept intact on its own line', () => {
  const bridge = bootBridge();
  const word = 'a'.repeat(70);
  const lines = bridge.wrapText(`start ${word} end`).split('\n');
  assert.ok(lines.some((line) => line === word));
});

test('legacy mode requires all three query parameters', () => {
  assert.equal(bootBridge().isLegacyMode(), false);
  assert.equal(bootBridge('?baseUrl=x&apiKey=y').isLegacyMode(), false);
  assert.equal(bootBridge('?baseUrl=x&apiKey=y&game=z').isLegacyMode(), true);
});
