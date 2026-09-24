const fs = require('node:fs');
const path = require('node:path');
const compiler = require('miniprogram-compiler');

function filesBelow(root) {
  return fs
    .readdirSync(root, { withFileTypes: true })
    .flatMap((entry) =>
      entry.isDirectory()
        ? filesBelow(path.join(root, entry.name)).map((file) => entry.name + '/' + file)
        : [entry.name],
    );
}

function compile(root = path.resolve(__dirname, '../src')) {
  const files = filesBelow(root);
  const wxmlList = files.filter((file) => file.endsWith('.wxml'));
  const wxssList = files.filter((file) => file.endsWith('.wxss'));
  const options = { maxBuffer: 16 * 1024 * 1024 };
  const wxml = compiler.wxmlToJs(root, { ...options, wxmlList });
  let wxss;
  try {
    wxss = compiler.wxssToJs(root, { ...options, wxssList });
  } catch (error) {
    // Upstream's public wrapper tries to unescape a missing result on failure.
    // Ask the same bundled wcsc wrapper for its preserved compiler diagnostic.
    const diagnostic = require('miniprogram-compiler/src/wcsc')(
      root,
      wxssList.map((file) => file.slice(0, -5)),
      options,
    );
    throw new Error(
      'WXSS / wcsc compilation failed: ' +
        (diagnostic instanceof Error ? diagnostic.message : error.message),
      { cause: error },
    );
  }
  // The upstream wcsc wrapper returns Error as a value. Detect its empty
  // result here so invalid WXSS cannot be reported as a successful compile.
  if (
    !wxss.includes('var BASE_DEVICE_WIDTH') ||
    wxssList.some((file) => !wxss.includes("'" + file + "':"))
  ) {
    throw new Error('wcsc did not produce every requested WXSS stylesheet.');
  }
  new Function('global', wxml);
  new Function('global', wxss);
  return { wxml, wxss, counts: { wxml: wxmlList.length, wxss: wxssList.length } };
}

if (require.main === module) {
  try {
    const result = compile();
    const output = path.resolve(__dirname, '../.artifacts/compiler');
    fs.mkdirSync(output, { recursive: true });
    fs.writeFileSync(path.join(output, 'wxml.js'), result.wxml);
    fs.writeFileSync(path.join(output, 'wxss.js'), result.wxss);
    fs.writeFileSync(
      path.join(output, 'report.json'),
      JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          compilerPackage: 'miniprogram-compiler',
          version: require('miniprogram-compiler/package.json').version,
          wccVersion: result.wxml.match(/__wcc_version__='([^']+)'/)?.[1] || 'unreported',
          counts: result.counts,
          status: 'passed',
          scope:
            'WXML/WXSS template compilation only; not current WeChat DevTools, a device build, or a release package.',
        },
        null,
        2,
      ) + '\n',
    );
    console.log(
      `Official wcc/wcsc compiled ${result.counts.wxml} WXML and ${result.counts.wxss} WXSS files (miniprogram-compiler 0.2.3).`,
    );
    console.log(
      'This is template compilation, not WeChat DevTools, a device build, or a release package.',
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
module.exports = { compile, filesBelow };
