const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { filesBelow } = require('./compile-templates.cjs');

function check(root = path.resolve(__dirname, '../src')) {
  const errors = [];
  const files = filesBelow(root);
  const exists = (file) => fs.existsSync(path.join(root, file));
  const json = {};
  for (const file of files) {
    const text = fs.readFileSync(path.join(root, file), 'utf8');
    if (file.endsWith('.json')) {
      try {
        json[file] = JSON.parse(text);
      } catch (error) {
        errors.push(`${file}: ${error.message}`);
      }
    }
    if (file.endsWith('.js')) {
      try {
        new vm.Script(text, { filename: file });
      } catch (error) {
        errors.push(`${file}: ${error.message}`);
      }
      for (const match of text.matchAll(/require\(['"](\.[^'"]+)['"]\)/g)) {
        const relative = path.posix.normalize(path.posix.join(path.posix.dirname(file), match[1]));
        if (![relative, relative + '.js', relative + '.json', relative + '/index.js'].some(exists))
          errors.push(`${file}: missing module ${match[1]}`);
      }
    }
  }
  const app = json['app.json'];
  if (!app || !Array.isArray(app.pages)) return [...errors, 'app.json must register pages'];
  const registered = new Set(app.pages);
  if (registered.size !== app.pages.length) errors.push('app.json: duplicate page registration');
  for (const page of app.pages) {
    for (const extension of ['.js', '.json', '.wxml', '.wxss'])
      if (!exists(page + extension)) errors.push(`Missing ${page + extension}`);
  }
  for (const [file, value] of Object.entries(json)) {
    for (const component of Object.values(value.usingComponents || {})) {
      const base = component.startsWith('/')
        ? component.slice(1)
        : path.posix.join(path.posix.dirname(file), component);
      for (const extension of ['.js', '.json', '.wxml', '.wxss'])
        if (!exists(base + extension))
          errors.push(`${file}: missing component ${base + extension}`);
    }
  }
  for (const tab of app.tabBar?.list || []) {
    if (!registered.has(tab.pagePath)) errors.push(`Unregistered tab route: ${tab.pagePath}`);
    for (const asset of [tab.iconPath, tab.selectedIconPath].filter(Boolean))
      if (!exists(asset)) errors.push(`Missing tab asset: ${asset}`);
  }
  if (app.sitemapLocation && !exists(app.sitemapLocation)) errors.push('Missing sitemap');
  for (const file of files.filter((file) => /\.(js|wxml|wxss)$/.test(file))) {
    const text = fs.readFileSync(path.join(root, file), 'utf8');
    for (const route of text.matchAll(/['"]\/?(pages\/[\w/-]+)(?:\?[^'"\s]*)?['"]/g)) {
      if (!registered.has(route[1])) errors.push(`${file}: unregistered route ${route[1]}`);
    }
    for (const asset of text.matchAll(/['"]\/?(assets\/[\w./-]+\.(?:png|jpg|jpeg|webp|svg))['"]/g))
      if (!exists(asset[1])) errors.push(`${file}: missing asset ${asset[1]}`);
    if (!file.endsWith('.wxml')) continue;
    const script = exists(file.replace('.wxml', '.js'))
      ? fs.readFileSync(path.join(root, file.replace('.wxml', '.js')), 'utf8')
      : '';
    for (const event of text.matchAll(/\b(?:bind|catch):?[\w-]+\s*=\s*['"]([\w$]+)['"]/g)) {
      if (!new RegExp('(?:\\b' + event[1] + '\\s*\\(|\\b' + event[1] + '\\s*:)').test(script))
        errors.push(`${file}: missing event handler ${event[1]}`);
    }
    for (const directive of text.matchAll(/wx:(if|elif|for)\s*=\s*['"]([^'"]*)['"]/g)) {
      if (!directive[2].includes('{{'))
        errors.push(
          `${file}: wx:${directive[1]} must use a {{expression}}, received ${directive[2]}`,
        );
    }
  }
  return [...new Set(errors)];
}
if (require.main === module) {
  const errors = check();
  if (errors.length) {
    console.error(errors.join('\n'));
    process.exitCode = 1;
  } else
    console.log(
      'Source checks passed: JSON/JS syntax, registered pages, component files, local modules, event handlers, routes and static asset paths.',
    );
}
module.exports = { check };
