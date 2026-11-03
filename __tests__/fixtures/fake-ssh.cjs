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
// Started with -N (a forward), it listens on the local end of its -L as
// `ssh` would, says so on stderr as `ssh -v` does, and pipes each connection
// to 127.0.0.1:FAKE_SSH_FORWARD_TO (the test's door). A local end it cannot
// take ends it as ExitOnForwardFailure does. FAKE_SSH_HANG keeps it silent.
// eslint-disable-next-line @typescript-eslint/no-require-imports -- a fake ssh run by node is CommonJS
const fs = require('fs');
// eslint-disable-next-line @typescript-eslint/no-require-imports -- the same
const net = require('net');

const env = process.env;
const argv = process.argv.slice(2);
if (env.FAKE_SSH_ARGV_FILE) fs.writeFileSync(env.FAKE_SSH_ARGV_FILE, JSON.stringify(argv));
if (env.FAKE_SSH_PID_FILE) fs.writeFileSync(env.FAKE_SSH_PID_FILE, String(process.pid));

function forward() {
  const spec = argv[argv.indexOf('-L') + 1];
  const local = spec.startsWith('/')
    ? { path: spec.slice(0, spec.indexOf(':')) }
    : { host: spec.split(':')[0], port: Number(spec.split(':')[1]) };
  const server = net.createServer(socket => {
    const door = net.connect(Number(env.FAKE_SSH_FORWARD_TO), '127.0.0.1');
    socket.pipe(door).pipe(socket);
    door.on('error', () => socket.destroy());
    socket.on('error', () => door.destroy());
  });
  server.on('error', err => {
    process.stderr.write(`bind ${spec}: ${err.code === 'EADDRINUSE' ? 'Address already in use' : err.message}\r\nCould not request local forwarding.\r\n`);
    process.exit(255);
  });
  server.listen(local, () => {
    const where = local.path ? `path ${local.path}` : `${local.host} port ${local.port}`;
    process.stderr.write(`debug1: Authentication succeeded (publickey).\r\ndebug1: Local forwarding listening on ${where}.\r\n`);
  });
}

function answer() {
  if (env.FAKE_SSH_STDOUT) process.stdout.write(env.FAKE_SSH_STDOUT);
  if (env.FAKE_SSH_BIG_LINE) process.stdout.write(`${JSON.stringify({ x: 'x'.repeat(Number(env.FAKE_SSH_BIG_LINE)) })}\n`);
  if (env.FAKE_SSH_STDERR) process.stderr.write(env.FAKE_SSH_STDERR);
  if (env.FAKE_SSH_HANG === '1') setInterval(() => {}, 1000);
  else process.exitCode = Number(env.FAKE_SSH_EXIT || 0);
}

if (argv.includes('-N')) {
  if (env.FAKE_SSH_HANG === '1') setInterval(() => {}, 1000);
  else forward();
} else if (env.FAKE_SSH_STDIN_FILE) {
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
