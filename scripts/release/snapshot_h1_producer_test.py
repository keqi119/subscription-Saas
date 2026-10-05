"""Focused tests for the one-off private H1 Staging producer."""
import hashlib
import importlib.util
import json
import os
import io
import types
import unittest
from unittest.mock import patch


class Result:
    def __init__(self, output=b''):
        self.returncode, self.stdout, self.stderr = 0, output, b''


class ProducerTests(unittest.TestCase):
    def setUp(self):
        path = os.path.join(os.path.dirname(__file__), 'snapshot-h1-producer.py')
        spec = importlib.util.spec_from_file_location('h1_producer', path)
        self.module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.module)
        self.attempt = '11111111-2222-4333-8444-555555555555'
        self.public_key = '-----BEGIN PUBLIC KEY-----\nYWJj\n-----END PUBLIC KEY-----\n'
        self.authorization = {
            'schemaVersion': 'producer-crypto-run-authorization.v2',
            'repository': {'name': 'keqi119/subscription-Saas', 'id': '1253231368'},
            'snapshotRunId': '123', 'releaseAttemptId': self.attempt,
            'localKey': {'keyFingerprint': 'sha256:' + hashlib.sha256(b'abc').hexdigest()}
        }
        self.bundle_digest = self.module.BUNDLE_DIGEST

    def test_terminal_time_and_memory_observations_reject_invalid_host_facts(self):
        self.assertEqual(self.module._docker_time('2026-10-06T12:34:56.123456789Z'),
                         '2026-10-06T12:34:56.123Z')
        for value in (None, '', '0001-01-01T00:00:00Z', '2026-10-06T12:34:56Z'):
            with self.assertRaises(self.module.ProducerFailure):
                self.module._docker_time(value)
        swaps = b'Filename\tType\tSize\tUsed\tPriority\n'
        core = b'|/bin/false\n'
        limits = types.SimpleNamespace(RLIMIT_CORE=4, getrlimit=lambda _: (0, 0))
        with patch.object(self.module, 'resource', limits), \
             patch('builtins.open', side_effect=lambda path, mode: io.BytesIO(
                 swaps if path == '/proc/swaps' else core)):
            observed = self.module._memory_protection()
            self.assertTrue(observed['hostSwapDisabled'])
            self.assertEqual(observed['swapTableDigest'], self.module._digest(swaps))
            self.assertEqual(observed['coreLimit'], [0, 0])
            swaps += b'/swapfile\tfile\t1024\t0\t-2\n'
            with self.assertRaisesRegex(self.module.ProducerFailure, 'MEMORY_PROTECTION_CHANGED'):
                self.module._memory_protection()
            swaps = swaps.splitlines(keepends=True)[0]
            core = b'core.%p\n'
            with self.assertRaisesRegex(self.module.ProducerFailure, 'MEMORY_PROTECTION_CHANGED'):
                self.module._memory_protection()

    def producer(self):
        return self.module.H1FixedSnapshotProducer(self.attempt, self.authorization,
                                                    self.public_key, self.bundle_digest)

    def inspect_record(self, runtime, kind):
        target = kind == 'target'
        identity = 'd' * 64 if target else 'e' * 64
        runtime.source_id = 'c' * 64
        setattr(runtime, kind + '_id', identity)
        binds = ([(runtime.target_pgdata, '/var/lib/postgresql/data', True),
                  (runtime.target_secret, '/run/bootstrap-password', False)] if target else
                 [(self.module.BUNDLE, '/bundle', False),
                  (self.module.NODE, '/fixed-node', False),
                  (runtime.crypto, '/work/crypto', True)])
        tmpfs = ({'/var/run/postgresql':
                  'rw,nosuid,nodev,size=1m,mode=0700,uid=999,gid=999',
                  '/tmp': 'rw,nosuid,nodev,noexec,size=16m,mode=1777'} if target else
                 {'/var/lib/postgresql/data':
                  'rw,nosuid,nodev,noexec,size=64k,mode=000',
                  '/tmp': 'rw,nosuid,nodev,noexec,size=16m,mode=0700,uid=65532,gid=65532'})
        env = ['PATH=/usr/local/bin', 'POSTGRES_PASSWORD_FILE=/run/bootstrap-password',
               'POSTGRES_HOST_AUTH_METHOD=scram-sha-256',
               'POSTGRES_DB=' + self.module.TARGET_DATABASE] if target else \
              ['PATH=/usr/local/bin']
        return {'Id': identity, 'Name': '/' + getattr(runtime, kind + '_name'),
                'Image': 'sha256:' + 'a' * 64,
                'Config': {'Image': self.module.IMAGE,
                           'User': '999:999' if target else '65532:65532',
                           'Labels': {'stage1.attempt': self.attempt},
                           'OpenStdin': True, 'Tty': False, 'Env': env,
                           'Entrypoint': ['/usr/local/bin/docker-entrypoint.sh'] if target
                           else ['/fixed-node'],
                           'Cmd': ['postgres', '-p', '5433', '-c',
                                   'listen_addresses=127.0.0.1'] if target else
                                  ['/bundle/scripts/release/snapshot-h1-data-worker.mjs'],
                           'WorkingDir': '/bundle' if not target else ''},
                'HostConfig': {'NetworkMode': 'container:' + runtime.source_id,
                               'Tmpfs': tmpfs, 'ReadonlyRootfs': True,
                               'Privileged': False, 'CapDrop': ['ALL'],
                               'SecurityOpt': ['no-new-privileges:true'],
                               'Memory': self.module.TARGET_MEMORY,
                               'MemorySwap': self.module.TARGET_MEMORY,
                               'PidsLimit': 128,
                               'Ulimits': [{'Name': 'core', 'Soft': 0, 'Hard': 0}],
                               'LogConfig': {'Type': 'none'},
                               'RestartPolicy': {'Name': 'no'}},
                'Mounts': [{'Type': 'bind', 'Source': source,
                            'Destination': destination, 'RW': writable}
                           for source, destination, writable in binds]}

    def test_unsafe_inspect_blocks_credentials_but_owned_drift_can_be_removed(self):
        runtime = self.producer()
        target = self.inspect_record(runtime, 'target')
        worker = self.inspect_record(runtime, 'worker')
        worker['Mounts'][0]['RW'] = True
        runtime.worker_attempted = True
        records = {runtime.target_id: target, runtime.worker_id: worker}
        calls = []
        def docker(argv, data=None, timeout=30, discard=False):
            calls.append(argv)
            if argv[:2] == ['image', 'inspect']:
                return Result(json.dumps([{'Id': target['Image'],
                                           'Config': {'Env': ['PATH=/usr/local/bin']}}])
                              .encode('utf-8'))
            if argv[0] == 'rm':
                records.pop(argv[-1])
            return Result()
        with patch.object(runtime, '_inspect', side_effect=lambda identity: records.get(identity)), \
             patch.object(runtime, '_docker', side_effect=docker), \
             patch.object(runtime, '_spawn_worker') as spawn:
            with self.assertRaisesRegex(self.module.ProducerFailure,
                                        'WORKER_CONFINEMENT_INVALID'):
                runtime._worker_protocol('source', 'target')
            spawn.assert_not_called()
            self.assertTrue(runtime._remove_owned('worker'))
        self.assertEqual(calls[-1], ['rm', '--force', '--volumes', runtime.worker_id])

    def test_target_inspect_env_drift_fails_before_bootstrap(self):
        runtime = self.producer()
        target = self.inspect_record(runtime, 'target')
        target['Config']['Env'].append('LD_PRELOAD=/tmp/inject.so')
        with patch.object(runtime, '_inspect', return_value=target), \
             patch.object(runtime, '_docker', return_value=Result(json.dumps([{
                 'Id': target['Image'], 'Config': {'Env': ['PATH=/usr/local/bin']}}])
                 .encode('utf-8'))):
            with self.assertRaisesRegex(self.module.ProducerFailure,
                                        'TARGET_CONFINEMENT_INVALID'):
                runtime._confined('target')

    def test_explicit_environment_can_precede_image_defaults_without_duplicates(self):
        runtime = self.producer()
        target = self.inspect_record(runtime, 'target')
        env = target['Config']['Env']
        target['Config']['Env'] = env[1:] + env[:1]
        with patch.object(runtime, '_inspect', return_value=target), \
             patch.object(runtime, '_docker', return_value=Result(json.dumps([{
                 'Id': target['Image'], 'Config': {'Env': ['PATH=/usr/local/bin']}}])
                 .encode('utf-8'))):
            self.assertIs(runtime._confined('target'), target)
            target['Config']['Env'].append('PATH=/usr/local/bin')
            with self.assertRaisesRegex(self.module.ProducerFailure,
                                        'TARGET_CONFINEMENT_INVALID'):
                runtime._confined('target')

    def test_constructor_accepts_only_fixed_one_off_identity_without_side_effects(self):
        runtime = self.producer()
        self.assertEqual(runtime.attempt_id, self.attempt)
        self.assertEqual(runtime.mount,
                         '/var/lib/subscription-saas/snapshot-volumes/' + self.attempt + '.mnt')
        with self.assertRaises(self.module.ProducerFailure):
            self.module.H1FixedSnapshotProducer(self.attempt, self.authorization,
                                                self.public_key, 'sha256:' + '0' * 64)
        self.assertIsNone(runtime.source_id)
        self.assertIsNone(runtime.worker_id)
        self.assertIsNone(runtime.target_id)

    def test_source_readback_requires_pinned_physical_identity_and_dormant_role(self):
        runtime = self.producer()
        observed = {'databaseName': 'subscription_saas_staging', 'databaseOid': '16384',
                    'systemIdentifier': '7661173341297905697',
                    'readerOid': '85641', 'readerLogin': False,
                    'readerPasswordSet': False, 'readerSessions': 0,
                    'adminRole': 'subscription_saas', 'databaseBytes': 57382579,
                    'logStatement': 'none', 'logMinDuration': '-1',
                    'logDuration': 'off', 'sharedPreload': '', 'pgauditLog': None}
        with patch.object(runtime, '_sql', return_value=json.dumps(observed)):
            self.assertEqual(runtime._source_readback('c' * 64)['databaseOid'], '16384')
        observed['systemIdentifier'] = '7661173341297905698'
        with patch.object(runtime, '_sql', return_value=json.dumps(observed)):
            with self.assertRaises(self.module.ProducerFailure):
                runtime._source_readback('c' * 64)
        observed['systemIdentifier'] = '7661173341297905697'
        observed['readerLogin'] = True
        with patch.object(runtime, '_sql', return_value=json.dumps(observed)):
            with self.assertRaises(self.module.ProducerFailure):
                runtime._source_readback('c' * 64)

    def test_private_sql_guards_source_logging_and_targets_port_5433(self):
        runtime = self.producer()
        calls = []
        def docker(argv, data=None, timeout=30, discard=False):
            calls.append((argv, data))
            return Result(b'0\n')
        with patch.object(runtime, '_docker', docker):
            runtime._sql('c' * 64, "ALTER ROLE stage1_snapshot_reader LOGIN PASSWORD 'private';")
            runtime._sql('d' * 64, 'SELECT 0;', target=True)
        self.assertNotIn('private', ' '.join(calls[0][0]))
        self.assertIn(b"SET log_statement='none'", calls[0][1])
        self.assertIn(b"SET log_min_error_statement='panic'", calls[0][1])
        self.assertLess(calls[0][1].index(b'SET log_statement'), calls[0][1].index(b'private'))
        self.assertEqual(calls[1][0][calls[1][0].index('-p') + 1], '5433')

    def test_foreign_active_reader_preflight_never_alters_role(self):
        runtime = self.producer()
        observed = {'databaseName': 'subscription_saas_staging', 'databaseOid': '16384',
                    'systemIdentifier': '7661173341297905697', 'readerOid': '85641',
                    'readerLogin': True, 'readerPasswordSet': True, 'readerSessions': 1,
                    'adminRole': 'subscription_saas', 'databaseBytes': 57382579,
                    'logStatement': 'none', 'logMinDuration': '-1',
                    'logDuration': 'off', 'sharedPreload': '', 'pgauditLog': None}
        runtime.source_id = 'c' * 64
        with patch.object(runtime, '_sql', return_value=json.dumps(observed)), \
             patch.object(runtime, '_source_owned'), \
             patch.object(runtime, '_set_reader') as alter:
            with self.assertRaises(self.module.ProducerFailure):
                runtime._source_readback(runtime.source_id)
            with self.assertRaises(self.module.ProducerFailure):
                runtime.cleanup()
        alter.assert_not_called()

    def test_temporary_reader_login_expires_with_authorization(self):
        runtime = self.producer()
        runtime.source_id = 'c' * 64
        runtime.authorization['notAfter'] = '2026-10-06T12:34:56.000Z'
        statements = []
        with patch.object(runtime, '_source_owned'), \
             patch.object(runtime, '_source_readback', side_effect=[
                 {'readerLogin': False, 'readerPasswordSet': False},
                 {'readerLogin': True, 'readerPasswordSet': True}]), \
             patch.object(runtime, '_sql', side_effect=lambda _, sql: statements.append(sql)):
            runtime._set_reader(True)
        self.assertEqual(len(statements), 1)
        self.assertIn("VALID UNTIL '2026-10-06T12:34:56.000Z'", statements[0])
        self.assertTrue(runtime.role_touched)

    def test_authorization_expiry_uses_existing_validator_on_python36_host(self):
        runtime = self.producer()
        result = Result(b'1791288000000')
        with patch.object(self.module.subprocess, 'run', return_value=result):
            self.assertEqual(runtime._verify_authorization(), 1791288000)
        with patch.object(self.module.subprocess, 'run', return_value=Result(b'NaN')):
            with self.assertRaises(self.module.ProducerFailure):
                runtime._verify_authorization()

    def test_destroy_ack_waits_for_source_and_exact_target_absence(self):
        runtime = self.producer()
        runtime.source_id = 'c' * 64
        runtime.target_id = 'd' * 64
        runtime.target_attempted = True
        runtime._worker_process = type('Worker', (), {'stdin': io.BytesIO()})()
        events = []
        request = {'kind': 'workspace-destroy-request', 'snapshotRunId': '123',
                   'releaseAttemptId': self.attempt, 'backendPid': 321,
                   'nonce': 'a' * 32}
        with patch.object(runtime, '_source_owned', side_effect=lambda: events.append('source')), \
             patch.object(runtime, '_source_readback', side_effect=lambda *a, **k: events.append('sessions')), \
             patch.object(runtime, '_sql', side_effect=lambda *a, **k: events.append('backend') or '0'), \
             patch.object(runtime, '_set_reader', side_effect=lambda _: events.append('revoke')), \
             patch.object(runtime, '_remove_owned', side_effect=lambda _: events.append('remove')), \
             patch.object(runtime, '_inspect', side_effect=lambda _: events.append('absent') or None):
            runtime._destroy_ack(request)
        self.assertEqual(events, ['source', 'sessions', 'backend', 'revoke', 'remove', 'absent'])
        self.assertTrue(runtime._worker_process.stdin.closed)


if __name__ == '__main__':
    unittest.main()
