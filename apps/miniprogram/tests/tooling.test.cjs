const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { check } = require('../scripts/check.cjs');
const { compile } = require('../scripts/compile-templates.cjs');
const { createServer } = require('../scripts/preview.cjs');
const ARTIFACTS = path.resolve(__dirname, '../.artifacts/tooling-tests');

function fixture(t) {
  fs.mkdirSync(ARTIFACTS, { recursive: true });
  const root = fs.mkdtempSync(path.join(ARTIFACTS, 'case-'));
  t.after(() => {
    const resolved = fs.realpathSync(root);
    assert.ok(resolved.startsWith(fs.realpathSync(ARTIFACTS) + path.sep));
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  const put = (file, text) => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  };
  put(
    'app.json',
    JSON.stringify({ pages: ['pages/home/index'], window: {}, tabBar: { list: [] } }),
  );
  put('app.js', 'App({});');
  put('app.wxss', 'page {color: #222;}');
  put('pages/home/index.js', 'Page({data:{items:[]}, tap(){}});');
  put('pages/home/index.json', '{}');
  put(
    'pages/home/index.wxml',
    '<view wx:for="{{items}}" wx:key="id" bindtap="tap" data-id="{{item.id}}">{{item.name}}</view>',
  );
  put('pages/home/index.wxss', 'view {padding: 20rpx;}');
  return { root, put };
}

test('static checks detect routes, handlers, assets and literal WXML directives', (t) => {
  const { root, put } = fixture(t);
  assert.deepEqual(check(root), []);
  put(
    'pages/home/index.wxml',
    '<view wx:if="loading" bindtap="missing" data-url="/pages/nope/index"><image src="/assets/missing.png"/></view>',
  );
  const errors = check(root).join('\n');
  assert.match(errors, /wx:if must use/);
  assert.match(errors, /missing event handler missing/);
  assert.match(errors, /unregistered route pages\/nope\/index/);
  assert.match(errors, /missing asset assets\/missing.png/);
});

test('official wcc evaluates real conditions, loops and data bindings', (t) => {
  const { root } = fixture(t);
  const result = compile(root);
  const sandbox = { window: {}, console };
  const generate = vm.runInNewContext('(function(global){' + result.wxml + '})({})', sandbox);
  const tree = generate('pages/home/index.wxml')({ items: [{ id: 'car-1', name: '测试车辆' }] });
  const serialized = JSON.stringify(tree);
  assert.match(serialized, /测试车辆/);
  assert.match(serialized, /car-1/);
  assert.deepEqual(result.counts, { wxml: 1, wxss: 2 });
});

test('invalid WXML and invalid WXSS fail genuine compiler verification', (t) => {
  const { root, put } = fixture(t);
  put('pages/home/index.wxml', '<view wx:if="{{ foo ; bar }}"></view>');
  assert.throws(() => compile(root), /编译|unexpected/);
  put('pages/home/index.wxml', '<view>ok</view>');
  put('pages/home/index.wxss', '.broken { color:');
  assert.throws(() => compile(root), /wcsc|WXSS/);
});

test('preview serves only source bundle and allowlisted local assets, blocks writes and networking', async (t) => {
  const { root } = fixture(t);
  const server = createServer(root);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const shell = await fetch(base);
  assert.equal(shell.status, 200);
  assert.match(shell.headers.get('content-security-policy'), /connect-src 'none'/);
  assert.match(await shell.text(), /源码预览 · 非微信模拟器/);
  const bundle = await fetch(base + '/bundle.js');
  assert.match(await bundle.text(), /Page\(\{data/);
  assert.equal((await fetch(base + '/src/config.js')).status, 404);
  assert.equal((await fetch(base + '/assets/%2e%2e%2fapp.js')).status, 404);
  assert.equal((await fetch(base + '/', { method: 'POST', body: 'no' })).status, 405);
});
