"""Exercise the signed host with fictional profiles, outside the checkout.

Run after build:desktop --sidecar-only, with the desktop app stopped.
"""
import http.client
import json
import os
from pathlib import Path
import secrets
import select
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[3]
HOST = ROOT / 'apps/desktop/src-tauri/resources/superlocal-host'
ASSETS = ROOT / 'apps/web/dist'


def start(profile, data):
    token = secrets.token_urlsafe(32)
    env = {'HOME': str(profile), 'PATH': '/usr/bin:/bin', 'SUPERLOCAL_DESKTOP': '1',
           'SUPERLOCAL_DESKTOP_SUPERVISED': '1', 'SUPERLOCAL_CONFIG': str(profile / 'config.json'),
           'SUPERLOCAL_DATA_DIR': str(data), 'SUPERLOCAL_DESKTOP_ASSETS': str(ASSETS)}
    proc = subprocess.Popen([str(HOST)], cwd=profile, env=env, stdin=subprocess.PIPE,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    proc.stdin.write(json.dumps({'version': 1, 'bootstrapToken': token}) + '\n')
    proc.stdin.flush()
    ready, _, _ = select.select([proc.stdout, proc.stderr], [], [], 35)
    if not ready:
        proc.kill()
        raise AssertionError('host startup timed out')
    return proc, token, ready


def stop(proc):
    proc.stdin.close()
    proc.wait(timeout=15)


with tempfile.TemporaryDirectory(prefix='superlocal-host-qa-') as temporary:
    base = Path(temporary)
    for marker in ('git-file', 'git-dir', 'bundle'):
        profile = base / marker
        profile.mkdir(mode=0o700)
        parent = profile / ('Fictional.app' if marker == 'bundle' else 'worktree')
        parent.mkdir()
        if marker == 'git-file':
            (parent / '.git').write_text('gitdir: fictional\n')
        if marker == 'git-dir':
            (parent / '.git').mkdir()
        proc, _, readable = start(profile, parent / 'data')
        assert proc.stderr in readable and 'LOCAL_DATA_DIR_IN_CHECKOUT' in proc.stderr.readline(), marker
        stop(proc)
        assert not (parent / 'data' / 'mock' / 'host.sqlite').exists()
    profile = base / 'valid'
    profile.mkdir(mode=0o700)
    proc, token, readable = start(profile, profile / 'data')
    try:
        assert proc.stdout in readable, proc.stderr.readline()
        readiness = json.loads(proc.stdout.readline())
        assert readiness['pid'] == proc.pid and readiness['mode'] == 'mock'
        port = readiness['apiPort']
        headers = {'Origin': f'http://localhost:{port}', 'Host': f'localhost:{port}',
                   'X-Superlocal': '1', 'Content-Type': 'application/json'}
        conn = http.client.HTTPConnection('127.0.0.1', port, timeout=5)
        payload = json.dumps({'token': token})
        conn.request('POST', '/host/desktop/bootstrap', payload, headers)
        response = conn.getresponse()
        assert response.status == 204
        cookie = response.getheader('Set-Cookie').split(';', 1)[0]
        response.read()
        conn.request('POST', '/host/desktop/bootstrap', payload, headers)
        response = conn.getresponse()
        assert response.status == 409
        response.read()
        conn.request('GET', '/v1/accounts', headers={'Host': f'localhost:{port}', 'Cookie': cookie})
        response = conn.getresponse()
        assert response.status == 200
        response.read()
        conn.close()
    finally:
        stop(proc)
    assert proc.returncode == 0
print('standalone host: containment, bootstrap, replay, authenticated API, EOF shutdown passed')
