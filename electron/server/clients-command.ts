import { addClient, listClients, revokeClient } from '../services/cloud/clients';
import { serverIdentity } from '../services/cloud/server-identity';

/**
 * tars-server clients add | list | revoke <id>. Run over a desktop's SSH
 * session or on the server itself: SSH access is the authority that mints.
 * Each writes one JSON line through `out` (stdout) and nothing else; errors
 * go to stderr. `add` reads `{ name, kind, scopes, days? }` from stdin, never
 * from the command line, so no name ever reaches a remote shell.
 *
 * Exit codes: 0 done, 1 refused (unknown id, a bad input), 2 usage.
 */
export function runClientsCommand(
  args: string[],
  stdin: string,
  files: { clientsFile: string; serverFile: string },
  out: (line: string) => void,
): number {
  const [verb, ...rest] = args;
  try {
    if (verb === 'add') {
      const input = JSON.parse(stdin || '{}') as Parameters<typeof addClient>[1];
      const { client, credential } = addClient(files.clientsFile, input);
      out(JSON.stringify({ id: client.id, credential, serverId: serverIdentity(files.serverFile).id }));
      return 0;
    }
    if (verb === 'list') {
      out(JSON.stringify({ clients: listClients(files.clientsFile) }));
      return 0;
    }
    if (verb === 'revoke') {
      const id = rest.find(a => !a.startsWith('--'));
      if (!id || !/^c_[0-9a-f]{8}$/.test(id)) {
        process.stderr.write('usage: tars-server clients revoke c_<8 hex>\n');
        return 2;
      }
      const revoked = revokeClient(files.clientsFile, id);
      out(JSON.stringify({ revoked }));
      return revoked ? 0 : 1;
    }
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n`);
    return 1;
  }
  process.stderr.write('usage: tars-server clients add --json < input | list --json | revoke <id>\n');
  return 2;
}
