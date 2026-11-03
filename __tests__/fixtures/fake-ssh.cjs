// A stand-in for the system `ssh` in the cloud link's tests. No test reaches a
// real host. What it does is told by its environment:
//   FAKE_SSH_ARGV_FILE   write the arguments it was started with there, as JSON
//   FAKE_SSH_PID_FILE    write its pid there
//   FAKE_SSH_STDIN_FILE  read stdin to its end first, and write what came there
//   FAKE_SSH_STDOUT      write this on stdout
//   FAKE_SSH_BIG_LINE    then write a JSON line of about this many bytes on stdout
//   FAKE_SSH_STDERR      write this on stderr
//   FAKE_SSH_EXIT        exit with this code (default 0)
//   FAKE_SSH_HANG        '1': never exit, as a hung connection would
const fs = require('fs');

const env = process.env;
if (env.FAKE_SSH_ARGV_FILE) fs.writeFileSync(env.FAKE_SSH_ARGV_FILE, JSON.stringify(process.argv.slice(2)));
if (env.FAKE_SSH_PID_FILE) fs.writeFileSync(env.FAKE_SSH_PID_FILE, String(process.pid));

function answer() {
  if (env.FAKE_SSH_STDOUT) process.stdout.write(env.FAKE_SSH_STDOUT);
  if (env.FAKE_SSH_BIG_LINE) process.stdout.write(`${JSON.stringify({ x: 'x'.repeat(Number(env.FAKE_SSH_BIG_LINE)) })}\n`);
  if (env.FAKE_SSH_STDERR) process.stderr.write(env.FAKE_SSH_STDERR);
  if (env.FAKE_SSH_HANG === '1') setInterval(() => {}, 1000);
  else process.exitCode = Number(env.FAKE_SSH_EXIT || 0);
}

if (env.FAKE_SSH_STDIN_FILE) {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => { input += chunk; });
  process.stdin.on('end', () => {
    fs.writeFileSync(env.FAKE_SSH_STDIN_FILE, input);
    answer();
  });
} else {
  answer();
}
