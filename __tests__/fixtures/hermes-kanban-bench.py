"""A real Hermes kanban, in a throwaway HERMES_HOME: its own HTTP router and its own
dispatcher, ticking. Usage: python hermes_bench.py <hermes tree> <home> <port> <log.jsonl> [tick_s]
Every tick appends one JSON line: what the dispatcher spawned, promoted and skipped,
which tasks the auto-decomposer would take (triage), and every task's status."""
import os, sys, json, threading, time, importlib.util, traceback

tree, home, port, log_path = sys.argv[1], sys.argv[2], int(sys.argv[3]), sys.argv[4]
tick_s = float(sys.argv[5]) if len(sys.argv) > 5 else 1.0
os.makedirs(home, exist_ok=True)
os.environ['HERMES_HOME'] = home
os.environ['HERMES_KANBAN_DB'] = os.path.join(home, 'kanban.db')
sys.path.insert(0, tree)

from hermes_cli import __version__ as VERSION
from hermes_cli import kanban_db
try:
    from hermes_cli import kanban_db_connect as kbc
    connect = kbc.connect
except ImportError:
    connect = kanban_db.connect
from hermes_cli import kanban_db_dispatch as kd
from hermes_cli import kanban_decompose

spec = importlib.util.spec_from_file_location('kanban_plugin_api', os.path.join(tree, 'plugins/kanban/dashboard/plugin_api.py'))
api = importlib.util.module_from_spec(spec)
sys.modules['kanban_plugin_api'] = api
spec.loader.exec_module(api)

from fastapi import FastAPI
import uvicorn

app = FastAPI()
app.include_router(api.router, prefix='/api/plugins/kanban')

@app.get('/api/status')
def status():
    return {'version': VERSION, 'auth_required': False}

spawned_all = []

def spawn_fn(task, workspace, board=None):
    spawned_all.append(task.id)
    return os.getpid()

def ticker():
    n = 0
    while True:
        n += 1
        line = {'tick': n, 't': time.time(), 'version': VERSION}
        try:
            kanban_db.init_db()
            conn = connect()
            try:
                res = kd.dispatch_once(conn, spawn_fn=spawn_fn, default_assignee=None)
                line.update({
                    'spawned': [s[0] for s in res.spawned],
                    'promoted': res.promoted,
                    'skipped_nonspawnable': list(res.skipped_nonspawnable),
                    'skipped_unassigned': list(res.skipped_unassigned),
                    'auto_assigned_default': list(getattr(res, 'auto_assigned_default', []) or []),
                })
                rows = conn.execute('SELECT id, status, assignee FROM tasks').fetchall()
                line['tasks'] = {r[0]: [r[1], r[2]] for r in rows}
            finally:
                conn.close()
            line['triage'] = kanban_decompose.list_triage_ids()
        except Exception as exc:
            line['error'] = ''.join(traceback.format_exception_only(type(exc), exc)).strip()
        with open(log_path, 'a') as f:
            f.write(json.dumps(line) + '\n')
        time.sleep(tick_s)

kanban_db.init_db()
threading.Thread(target=ticker, daemon=True).start()
uvicorn.run(app, host='127.0.0.1', port=port, log_level='warning')
