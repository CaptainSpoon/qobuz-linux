// Apply exact-string patches to the minified Qobuz main bundle.
// Each patch must match exactly `count` times (default 1) or the build fails,
// so a Qobuz update that changes the code is caught instead of silently skipped.
const fs = require('fs');
const file = process.argv[2];
let src = fs.readFileSync(file, 'utf8');

const patches = require('./patches.js');

for (const p of patches) {
  const n = src.split(p.find).length - 1;
  const want = p.count ?? 1;
  if (n !== want) {
    console.error(`patch "${p.name}": expected ${want} match(es), found ${n}`);
    process.exit(1);
  }
  src = src.split(p.find).join(p.replace);
  console.log(`patched: ${p.name}`);
}
fs.writeFileSync(file, src);
