"""Exercise two real CLI MCP processes with synthetic identities, no provider jobs.

This is transport integration evidence, NOT Claude/Codex model acceptance.
Private capabilities remain in memory and temporary child environments.
"""
import argparse
import json
import os
from pathlib import Path
import queue
import subprocess
import tempfile
import threading
import time
import uuid


class Client:
    def __init__(self, cli, board, registration, capability, channel=False):
        env = os.environ.copy()
        env.pop('CODACLAUDA_CAPABILITY', None)
        env['CLAUDACODA_SESSION_CAPABILITY'] = capability
        argv = [str(cli), '--state-dir', str(board), 'session-mcp', '--registration', registration]
        if channel:
            argv.append('--claude-channel')
        self.process = subprocess.Popen(argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                        stderr=subprocess.DEVNULL, text=True, encoding='utf-8', env=env)
        self.events = queue.Queue(maxsize=100)
        self.notifications = []
        self.next_id = 0
        threading.Thread(target=self._read, daemon=True).start()
        result = self.call('initialize', {'protocolVersion': '2025-03-26', 'capabilities': {},
                                        'clientInfo': {'name': 'claudacoda-fixture', 'version': '1'}})
        assert bool(result['capabilities'].get('experimental')) == channel
        self.notify('notifications/initialized')

    def _read(self):
        for line in self.process.stdout:
            self.events.put(json.loads(line))

    def notify(self, method, params=None):
        self.process.stdin.write(json.dumps({'jsonrpc': '2.0', 'method': method, 'params': params or {}}) + '\n')
        self.process.stdin.flush()

    def call(self, method, params):
        self.next_id += 1
        self.process.stdin.write(json.dumps({'jsonrpc': '2.0', 'id': self.next_id, 'method': method, 'params': params}) + '\n')
        self.process.stdin.flush()
        until = time.monotonic() + 10
        while True:
            response = self.events.get(timeout=max(0.01, until - time.monotonic()))
            if response.get('id') == self.next_id:
                assert 'error' not in response, 'Unexpected MCP protocol error'
                return response['result']
            self.notifications.append(response)

    def tool(self, name, args):
        response = self.call('tools/call', {'name': name, 'arguments': args})
        assert not response['isError'], f'{name} rejected fixture operation'
        return response['structuredContent']['data']

    def close(self):
        if self.process.poll() is None:
            self.process.stdin.close()
            try:
                self.process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait(timeout=5)
        assert self.process.returncode == 0, 'MCP process did not shut down cleanly'


def run(cli):
    root = Path(__file__).resolve().parent.parent
    scratch = root / 'local' / 'session-transport-tests'
    scratch.mkdir(parents=True, exist_ok=True)
    env = os.environ.copy()
    env.pop('CODACLAUDA_CAPABILITY', None)
    env.pop('CLAUDACODA_SESSION_CAPABILITY', None)
    clients = []
    with tempfile.TemporaryDirectory(dir=scratch) as directory:
        board = Path(directory) / 'board'
        project = Path(directory) / 'project'
        project.mkdir()

        def owner(op, body):
            result = subprocess.run([str(cli), '--state-dir', str(board), 'api', op],
                                    input=json.dumps(body), capture_output=True, text=True,
                                    encoding='utf-8', env=env, timeout=12)
            assert result.returncode == 0, f'Owner fixture {op} failed'
            value = json.loads(result.stdout)
            assert value['ok']
            return value['data']

        try:
            registrations = []
            for provider, mode in [('codex', 'inbox'), ('claude', 'claude-channel')]:
                registrations.append(owner('session-register', {'id': provider + '-fixture', 'provider': provider,
                    'chat_id': str(uuid.uuid4()), 'label': provider + ' synthetic transport fixture',
                    'project': str(project), 'mode': mode, 'expires_seconds': 300}))
            pair = owner('session-conversation', {'id': 'pair-fixture', 'registrations': [r['registration']['id'] for r in registrations],
                'max_messages': 4, 'max_hops': 3, 'expires_seconds': 300})
            for index, registration in enumerate(registrations):
                clients.append(Client(cli, board, registration['registration']['id'], registration['capability'], index == 1))
            codex, claude = clients
            assert codex.tool('context', {})['registration']['id'] == 'codex-fixture'
            payload = {'id': 'question-fixture', 'conversation_id': pair['id'], 'body': 'Fixture question\n<unsafe-markup> stays text.'}
            sent = codex.tool('send', payload)
            duplicate = codex.tool('send', payload)
            assert sent['id'] == duplicate['id']
            notification = claude.events.get(timeout=10)
            assert notification['method'] == 'notifications/claude/channel'
            assert notification['params']['meta']['message_id'] == sent['id']
            assert notification['params']['content'] == payload['body']
            ack = claude.tool('ack', {'id': sent['id']})
            assert ack['phase'] == 'acknowledged'
            reply = claude.tool('reply', {'id': 'reply-fixture', 'message_id': sent['id'], 'body': 'Fixture answer from the existing MCP process.'})
            inbox = codex.tool('inbox', {'after': 0, 'limit': 20})
            assert [m['id'] for m in inbox['messages']] == [reply['id']]
            codex.tool('ack', {'id': reply['id']})
            completed = codex.tool('wait', {'id': sent['id'], 'timeout': 0})
            assert completed['message']['phase'] == 'replied' and completed['reply']['id'] == reply['id']
            public = owner('session-list', {'conversation_id': pair['id']})
            assert len(public['messages']) == 2
            for registration in registrations:
                assert registration['capability'] not in json.dumps(public)
            forbidden = claude.call('tools/call', {'name': 'send', 'arguments': {**payload, 'sender': 'codex-fixture'}})
            assert forbidden['isError']
            owner('session-revoke', {'registration_id': 'claude-fixture'})
            assert claude.call('tools/call', {'name': 'context', 'arguments': {}})['isError']
        finally:
            for client in clients:
                client.close()
    print(json.dumps({'passed': True, 'layer': 'real-local-stdio-processes-with-synthetic-identities',
        'checks': ['two session-bound MCP processes', 'Claude channel notification', 'explicit acknowledgment',
                   'reply routes to original sender', 'stable retry avoids duplicate', 'private capability absent from board projection',
                   'sender spoof rejected', 'revocation enforced', 'clean shutdown'],
        'provider_models_used': False, 'existing_provider_chat_delivery_verified': False}))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--cli', type=Path, required=True)
    arguments = parser.parse_args()
    run(arguments.cli.resolve(strict=True))
