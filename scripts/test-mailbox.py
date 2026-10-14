"""Real passive mailbox CLI processes, isolated board, no provider sessions.

Receipt labels are self-asserted fixtures, not proof Claude participated. Optional
--expiry performs a real one-minute TTL test; the core suite also tests its clock.
"""
import argparse
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
import os
from pathlib import Path
import subprocess
import threading
import time
import uuid


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--cli', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--expiry', action='store_true')
    args = parser.parse_args()
    root = args.output.resolve() / str(uuid.uuid4())
    root.mkdir(parents=True)
    board = root / 'board'
    board.mkdir()
    # Mailbox operations must not even rewrite a legacy board they do not own.
    legacy = board / 'state.json'
    legacy.write_text('{"schema_version":1,"preservation_fixture":true}\n', encoding='utf-8')
    legacy_hash = hashlib.sha256(legacy.read_bytes()).hexdigest()
    env = dict(os.environ)
    env.pop('CODACLAUDA_CAPABILITY', None)
    env.pop('CLAUDACODA_SESSION_CAPABILITY', None)
    base = [str(args.cli.resolve()), '--state-dir', str(board), '--json']
    receipt = {'layer': 'real-cli-processes-with-self-asserted-fixture-addresses',
               'provider_sessions_started': 0, 'existing_claude_participation': False,
               'native_ui_verified': False, 'checks': [], 'passed': False}
    evidence_lock = threading.Lock()
    calls = []

    def run(*argv, code=0, timeout=15):
        result = subprocess.run(base + list(argv), env=env, capture_output=True,
                                text=True, encoding='utf-8', timeout=timeout)
        value = json.loads(result.stdout)
        with evidence_lock:
            calls.append({'argv': list(argv), 'exit_code': result.returncode, 'result': value})
        assert result.returncode == code, (argv, result.returncode, value)
        assert bool(value['ok']) == (code == 0), value
        return value.get('data') if code == 0 else value

    def post(sender, recipient, kind, identity, text='Fixture coordination only.', **extra):
        path = root / f'{identity}.txt'
        path.write_text(text, encoding='utf-8')
        argv = ['post', '--from', sender, '--to', recipient, '--kind', kind,
                '--subject', 'Mailbox acceptance', '--body-file', str(path), '--id', identity]
        for key, value in extra.items():
            argv.extend(['--' + key.replace('_', '-'), str(value)])
        return argv

    try:
        for name, label in [('claude-phaseforge', 'Claude Code PhaseForge release session'),
                            ('codex-claudacoda', 'CodaClauda Codex chat')]:
            run('mailbox', 'register', name, '--label', label)
        question = post('claude-phaseforge', 'codex-claudacoda', 'question', 'roundtrip-question')
        original = run(*question)
        duplicate = run(*question)
        assert original == duplicate
        page = run('inbox', 'codex-claudacoda', '--unread', '--limit', '20')
        assert [m['id'] for m in page['messages']] == ['roundtrip-question']
        run('ack', 'codex-claudacoda', 'roundtrip-question')
        assert not run('inbox', 'codex-claudacoda', '--unread')['messages']
        assert run('wait-reply', 'roundtrip-question', '--timeout', '0')['timed_out']
        waiter = subprocess.Popen(base + ['wait-reply', 'roundtrip-question', '--timeout', '10'],
                                  env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                  text=True, encoding='utf-8')
        run(*post('codex-claudacoda', 'claude-phaseforge', 'reply', 'roundtrip-reply',
                  reply_to='roundtrip-question'))
        stdout, stderr = waiter.communicate(timeout=15)
        waited = json.loads(stdout)
        assert waiter.returncode == 0 and waited['data']['reply']['id'] == 'roundtrip-reply', stderr
        assert not waited['data']['timed_out']
        receipt['wait_result'] = waited
        receipt['checks'].extend(['CLI question/inbox/reply/wait round trip', 'idempotent post',
                                  'explicit acknowledgment/unread', 'timeout is success'])

        # Start two separate processes together; a mutex held inside one process
        # would not protect this test. No user Marketplace window is touched.
        claim_a = post('codex-claudacoda', 'owner', 'claim', 'claim-a',
                       resource='marketplace-ui', ttl=1)
        claim_b = post('claude-phaseforge', 'owner', 'claim', 'claim-b',
                       resource='marketplace-ui', ttl=1)
        barrier = threading.Barrier(2)

        def contender(argv):
            barrier.wait(timeout=5)
            result = subprocess.run(base + argv, env=env, capture_output=True,
                                    text=True, encoding='utf-8', timeout=15)
            return {'exit_code': result.returncode, 'result': json.loads(result.stdout)}

        with ThreadPoolExecutor(max_workers=2) as pool:
            a = pool.submit(contender, claim_a)
            b = pool.submit(contender, claim_b)
            outcomes = [a.result(), b.result()]
        assert sorted(x['exit_code'] for x in outcomes) == [0, 3], outcomes
        conflict = next(x for x in outcomes if x['exit_code'] == 3)
        assert conflict['result']['error']['current_holder'], conflict
        claims = run('claims', '--resource', 'marketplace-ui')['claims']
        assert len(claims) == 1
        holder = claims[0]['holder']
        other = 'claude-phaseforge' if holder == 'codex-claudacoda' else 'codex-claudacoda'
        receipt['concurrent_claims'] = outcomes
        run(*post(holder, 'owner', 'release', 'release-a', resource='marketplace-ui'))
        run(*post(other, 'owner', 'claim', 'claim-after-release', resource='marketplace-ui', ttl=1))
        assert run('claims', '--resource', 'marketplace-ui')['claims'][0]['holder'] == other
        receipt['checks'].extend(['two simultaneous CLI claims: exactly one winner',
                                  'exit 3 includes holder', 'release permits other holder'])

        # Every invocation is a new process; reopen retained state again.
        assert run('inbox', 'claude-phaseforge')['messages'][0]['id'] == 'roundtrip-reply'
        assert len(run('claims', '--resource', 'marketplace-ui')['claims']) == 1
        receipt['checks'].append('messages and claims survive process restart')
        if args.expiry:
            expiry = run('claims', '--resource', 'marketplace-ui')['claims'][0]['expires_at']
            while time.time() <= expiry:
                time.sleep(min(1, max(0.05, expiry - time.time() + 0.05)))
            run(*post(holder, 'owner', 'claim', 'claim-after-expiry', resource='marketplace-ui', ttl=1))
            receipt['checks'].append('real one-minute TTL expiration permits other holder')
        else:
            receipt['real_ttl_expiry'] = 'not requested; see core clock-controlled tests'

        fake = 'sk-proj-' + 'THISISONLYAFAKEACCEPTANCEKEY0123456789' * 2
        secret_args = post('claude-phaseforge', 'owner', 'notice', 'refused-secret',
                           text='api_key=' + fake)
        failure = run(*secret_args, code=2)
        assert fake not in json.dumps(failure)
        assert fake not in (board / 'mailbox.json').read_text(encoding='utf-8')
        receipt['checks'].append('fake credential refused and absent from mailbox/error')
        assert hashlib.sha256(legacy.read_bytes()).hexdigest() == legacy_hash
        receipt['checks'].append('legacy state bytes untouched')
        receipt['legacy_sha256'] = legacy_hash
        receipt['passed'] = True
    finally:
        receipt['calls'] = calls
        (root / 'receipt.json').write_text(json.dumps(receipt, indent=2), encoding='utf-8')
        print(json.dumps({'passed': receipt['passed'], 'receipt': str(root / 'receipt.json'),
                          'checks': receipt['checks'], 'provider_sessions_started': 0,
                          'existing_claude_participation': False, 'native_ui_verified': False}))


if __name__ == '__main__':
    main()
