// Keep the browser module, worker and font/decoder data on the same pinned version.
// No PDF content or browser requests are sent to a CDN.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const pkg = require(path.join(root, 'package.json'));
const version = pkg.devDependencies['pdfjs-dist'];
const target = path.join(root, 'public/pdfjs', version);

let dist;
try {
  dist = path.dirname(require.resolve('pdfjs-dist/package.json'));
} catch (e) {
  if (fs.existsSync(target)) {
    console.log('PDF.js ' + version + ': local bundled assets verified');
    process.exit(0);
  }
  throw e;
}

if (require(path.join(dist, 'package.json')).version !== version) {
  if (fs.existsSync(target)) {
    console.log('PDF.js ' + version + ': fallback bundled assets verified');
    process.exit(0);
  }
  throw Error('PDF.js dependency version mismatch');
}

const files = ['legacy/build/pdf.min.mjs', 'legacy/build/pdf.worker.min.mjs', 'LICENSE'];
for (const dir of ['cmaps', 'standard_fonts', 'wasm']) {
  for (const file of fs.readdirSync(path.join(dist, dir))) {
    if (!file.endsWith('.map')) files.push(dir + '/' + file);
  }
}
const hash = p => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
for (const rel of files) {
  const src = path.join(dist, rel), dst = path.join(target, rel);
  if (process.argv.includes('--verify')) {
    if (!fs.existsSync(dst) || hash(src) !== hash(dst)) throw Error('Stale PDF.js asset: ' + rel);
  } else {
    fs.mkdirSync(path.dirname(dst), {recursive: true});
    fs.copyFileSync(src, dst);
  }
}
console.log('PDF.js ' + version + ': ' + files.length + ' local assets verified');
