const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const destination = path.join(root, '.artifacts', 'delivery');
const excluded = new Set(['node_modules', '.artifacts', 'project.private.config.json', 'config.local.js']);
function collect(directory, prefix = '') {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    if (excluded.has(entry.name)) return [];
    const relative = path.posix.join(prefix, entry.name);
    return entry.isDirectory() ? collect(path.join(directory, entry.name), relative) : entry.isFile() ? [relative] : [];
  });
}
const files = collect(root); fs.mkdirSync(destination, { recursive: true });
for (const relative of files) {
  const target = path.join(destination, relative); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.copyFileSync(path.join(root, relative), target);
}
const manifest = files.map(file => ({ file, sha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex') }));
fs.writeFileSync(path.join(destination, 'FILE-MANIFEST.json'), JSON.stringify({ backendBase: 'f8ed944030646bb697c4724e9071b1151e64e5ef', files: manifest }, null, 2) + '\n');
console.log(JSON.stringify({ directory: destination, files: files.length, excluded: [...excluded] }));
