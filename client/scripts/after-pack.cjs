// electron-builder's own exe editing needs symlink rights on Windows: use rcedit.
const path = require('node:path');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') return;
  const { rcedit } = await import('rcedit');
  const app = context.packager.appInfo;
  const exe = path.join(context.appOutDir, `${app.productFilename}.exe`);
  await rcedit(exe, {
    icon: path.join(__dirname, '..', 'build', 'icon.ico'),
    'file-version': app.shortVersion || app.version,
    'product-version': app.shortVersion || app.version,
    'version-string': {
      ProductName: app.productName,
      FileDescription: app.productName,
      CompanyName: 'TolkTak',
      LegalCopyright: app.copyright,
      OriginalFilename: `${app.productFilename}.exe`,
    },
  });
};
