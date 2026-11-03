// A stand-in for the system `ssh` in the cloud link's tests: it records the
// arguments it was started with, as JSON, in the file FAKE_SSH_ARGV_FILE
// names, and exits 0. No test reaches a real host.
const fs = require('fs');

if (process.env.FAKE_SSH_ARGV_FILE) fs.writeFileSync(process.env.FAKE_SSH_ARGV_FILE, JSON.stringify(process.argv.slice(2)));
