const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { compile, filesBelow } = require('./compile-templates.cjs');
const ROOT = path.resolve(__dirname, '../src');
const PREVIEW = path.join(__dirname, 'preview');

function buildBundle(root = ROOT) {
  const compiled = compile(root);
  const files = filesBelow(root);
  const configs = Object.fromEntries(
    files
      .filter((file) => file.endsWith('.json'))
      .map((file) => [file, JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'))]),
  );
  const modules = files
    .filter((file) => file.endsWith('.js'))
    .map(
      (file) =>
        `${JSON.stringify(file)}:function(require,module,exports,wx,Page,Component,App,getApp,getCurrentPages){\n${fs.readFileSync(path.join(root, file), 'utf8')}\n}`,
    )
    .join(',\n');
  return `window.__preview={configs:${JSON.stringify(configs)},modules:{${modules}},wxml:function(global){${compiled.wxml}},wxss:function(global){${compiled.wxss}}};`;
}

function createServer(root = ROOT) {
  // Compile at explicit startup. There is no API proxy or outbound network call.
  const bundle = buildBundle(root);
  return http.createServer((request, response) => {
    const send = (status, type, body) => {
      response.writeHead(status, {
        'Content-Type': type,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy':
          "default-src 'self'; script-src 'self' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'none'; frame-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'",
      });
      response.end(body);
    };
    if (request.method !== 'GET')
      return send(405, 'text/plain; charset=utf-8', 'Read-only preview server');
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
    } catch {
      return send(400, 'text/plain', 'Bad URL');
    }
    if (pathname === '/bundle.js') return send(200, 'text/javascript; charset=utf-8', bundle);
    const allowed = {
      '/': 'shell.html',
      '/phone': 'phone.html',
      '/bridge.js': 'bridge.js',
      '/preview.css': 'preview.css',
    };
    if (allowed[pathname])
      return send(
        200,
        pathname.endsWith('.js')
          ? 'text/javascript; charset=utf-8'
          : pathname.endsWith('.css')
            ? 'text/css; charset=utf-8'
            : 'text/html; charset=utf-8',
        fs.readFileSync(path.join(PREVIEW, allowed[pathname])),
      );
    if (pathname.startsWith('/assets/')) {
      const asset = path.resolve(root, '.' + pathname);
      const assetRoot = path.join(root, 'assets') + path.sep;
      if (
        asset.startsWith(assetRoot) &&
        fs.existsSync(asset) &&
        fs.statSync(asset).isFile() &&
        /\.(png|jpe?g|webp|svg)$/i.test(asset)
      ) {
        const type = {
          '.png': 'image/png',
          '.jpg': 'image/jpeg',
          '.jpeg': 'image/jpeg',
          '.webp': 'image/webp',
          '.svg': 'image/svg+xml',
        }[path.extname(asset).toLowerCase()];
        return send(200, type, fs.readFileSync(asset));
      }
    }
    send(404, 'text/plain; charset=utf-8', 'Not found');
  });
}

async function start(port = 18931) {
  const server = createServer();
  // Increment only within this small local port range, never bind a LAN address.
  for (let attempt = port; attempt < port + 10; attempt++) {
    try {
      await new Promise((resolve, reject) => {
        const failed = (error) => {
          server.off('listening', ready);
          reject(error);
        };
        const ready = () => {
          server.off('error', failed);
          resolve();
        };
        server.once('error', failed);
        server.once('listening', ready);
        server.listen(attempt, '127.0.0.1');
      });
      console.log(`Source preview: http://127.0.0.1:${attempt}`);
      console.log(
        'Real WXML/WXSS compilation + Page/Component/service JS; limited browser wx bridge. Not WeChat DevTools or a WeChat simulator. Outbound requests are blocked; all operations use local Mock data.',
      );
      return server;
    } catch (error) {
      if (error.code !== 'EADDRINUSE') throw error;
    }
  }
  throw new Error('No free local preview port in the requested range.');
}
if (require.main === module)
  start(Number(process.env.PREVIEW_PORT) || 18931).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
module.exports = { createServer, buildBundle, start };
