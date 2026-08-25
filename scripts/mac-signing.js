const { spawnSync } = require('node:child_process');

/**
 * Shared by the two macOS release hooks: `afterSign` (scripts/notarize.js,
 * which notarizes and staples the .app) and `afterAllArtifactBuild`
 * (scripts/notarize-artifacts.js, which does the same for the dmg).
 */

/**
 * `codesign -dv` writes its description to stderr and exits non-zero on an
 * unsigned bundle, so both streams are read and the status ignored. An ad-hoc
 * signature reports the `adhoc` flag and no `TeamIdentifier`; a Developer ID
 * one reports the team.
 */
function isDeveloperIdSigned(appPath) {
  const result = spawnSync('codesign', ['-dv', '--verbose=4', appPath], { encoding: 'utf8' });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;

  if (/TeamIdentifier=not set/.test(output)) return false;
  if (/\badhoc\b/.test(output)) return false;
  return /TeamIdentifier=\S+/.test(output);
}

/**
 * The credentials notarytool is called with: explicit ones from the
 * environment, otherwise the keychain profile created once with
 * `xcrun notarytool store-credentials Tars`.
 */
function notarytoolCredentialArgs() {
  if (!process.env.APPLE_ID) return ['--keychain-profile', 'Tars'];
  return [
    '--apple-id',
    process.env.APPLE_ID,
    '--password',
    process.env.APPLE_APP_PASSWORD ?? '',
    '--team-id',
    process.env.APPLE_TEAM_ID ?? '',
  ];
}

exports.isDeveloperIdSigned = isDeveloperIdSigned;
exports.notarytoolCredentialArgs = notarytoolCredentialArgs;
