// Run with Electron: resize a PNG to 256x256 (used by install.sh for the menu icon).
const { app, nativeImage } = require('electron');
const fs = require('fs');
app.whenReady().then(() => {
  const [src, dst] = process.argv.slice(-2);
  const img = nativeImage.createFromPath(src).resize({ width: 256, height: 256, quality: 'best' });
  if (img.isEmpty()) app.exit(1);
  fs.writeFileSync(dst, img.toPNG());
  app.exit(0);
});
