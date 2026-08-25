const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { isDeveloperIdSigned, notarytoolCredentialArgs } = require('./mac-signing');

/**
 * electron-builder `afterAllArtifactBuild` hook.
 *
 * `afterSign` notarizes and staples the .app, which covers the zip the updater
 * downloads, because the zip is made from an already stapled bundle. The dmg is
 * a separate artifact that was never submitted, and Gatekeeper evaluates it on
 * its own when someone mounts a copy that arrived from another machine. Apple's
 * instruction for disk-image distribution is to notarize the dmg too and staple
 * the ticket to it, so that is what this does.
 *
 * Skipped, with the reason printed, when the packaged app is not signed with a
 * Developer ID certificate: the notary service refuses an ad-hoc signature, and
 * `afterSign` will already have skipped for the same reason.
 */
exports.default = async function notarizeArtifacts({ outDir, artifactPaths }) {
  const dmgs = (artifactPaths ?? []).filter((artifact) => artifact.endsWith('.dmg'));
  if (dmgs.length === 0) return [];

  const apps = findPackagedApps(outDir);
  if (apps.length === 0 || !apps.every(isDeveloperIdSigned)) {
    console.warn(
      'Skipping dmg notarization: the packaged app is not signed with a Developer ID ' +
        'certificate. The dmg will be refused by Gatekeeper on every Mac but this one.'
    );
    return [];
  }

  for (const dmg of dmgs) {
    console.log(`Notarizing ${path.basename(dmg)}...`);
    run('xcrun', ['notarytool', 'submit', dmg, ...notarytoolCredentialArgs(), '--wait']);
    run('xcrun', ['stapler', 'staple', dmg]);
    run('xcrun', ['stapler', 'validate', dmg]);
    console.log(`${path.basename(dmg)} notarized and stapled`);
  }

  return [];
};

/** The `mac`, `mac-arm64` and `mac-universal` directories electron-builder writes. */
function findPackagedApps(outDir) {
  return fs
    .readdirSync(outDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('mac'))
    .flatMap((entry) =>
      fs
        .readdirSync(path.join(outDir, entry.name))
        .filter((name) => name.endsWith('.app'))
        .map((name) => path.join(outDir, entry.name, name))
    );
}

function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit' });
  if (result.status !== 0) {
    throw new Error(`${command} ${args[0]} ${args[1]} failed with status ${result.status}`);
  }
}
