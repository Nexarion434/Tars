const { spawnSync } = require('node:child_process');

/**
 * electron-builder `afterSign` hook.
 *
 * Gatekeeper on another Mac rejects an app that is not notarized with
 * "Tars is damaged and can't be opened", so a release build has to go
 * through Apple's notary service before the dmg leaves this machine.
 *
 * Notarization requires a Developer ID signature: an ad-hoc signature, which
 * is what electron-builder falls back to when no certificate is installed, is
 * refused by the notary service. So a credential-less local build is skipped
 * with a warning rather than failed, and a real signed build that cannot be
 * notarized fails loudly.
 */
exports.default = async function notarizing(context) {
  const { electronPlatformName, appOutDir } = context;
  if (electronPlatformName !== 'darwin') return;

  const appName = context.packager.appInfo.productFilename;
  const appPath = `${appOutDir}/${appName}.app`;

  if (!isDeveloperIdSigned(appPath)) {
    console.warn(
      `Skipping notarization: ${appName}.app is not signed with a Developer ID ` +
        'certificate, and Apple will not notarize an ad-hoc signature. This build ' +
        'runs on this machine but Gatekeeper will call it damaged on any other one. ' +
        'Install a Developer ID Application certificate to publish it.'
    );
    return;
  }

  // Use the keychain profile if no explicit credentials are in the environment.
  const useKeychain = !process.env.APPLE_ID;

  console.log(`Notarizing ${appName}.app...`);

  const { notarize } = await import('@electron/notarize');

  try {
    if (useKeychain) {
      await notarize({ appPath, keychainProfile: 'Tars' });
    } else {
      await notarize({
        appPath,
        appleId: process.env.APPLE_ID,
        appleIdPassword: process.env.APPLE_APP_PASSWORD,
        teamId: process.env.APPLE_TEAM_ID,
      });
    }
  } catch (error) {
    console.error('Notarization failed:', error);
    throw error;
  }

  console.log('Notarization complete');
};

/**
 * `codesign -dv` writes to stderr. An ad-hoc signature reports the `adhoc`
 * flag and no `TeamIdentifier`; a Developer ID one reports the team.
 */
function isDeveloperIdSigned(appPath) {
  // codesign exits non-zero when the bundle is unsigned, and describes what it
  // found on stderr either way, so both streams are read and the status ignored.
  const result = spawnSync('codesign', ['-dv', '--verbose=4', appPath], { encoding: 'utf8' });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;

  if (/TeamIdentifier=not set/.test(output)) return false;
  if (/\badhoc\b/.test(output)) return false;
  return /TeamIdentifier=\S+/.test(output);
}
