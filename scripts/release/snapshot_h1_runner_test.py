"""Focused boundary tests for the fixed H1 Docker runner lifecycle."""
import importlib.util
import json
import os
import unittest
from unittest.mock import patch


class Result:
    def __init__(self, code=0, out=b'', err=b''):
        self.returncode, self.stdout, self.stderr = code, out, err


class RunnerTests(unittest.TestCase):
    def setUp(self):
        path = os.path.join(os.path.dirname(__file__), 'snapshot-h1-runner.py')
        spec = importlib.util.spec_from_file_location('h1_runner', path)
        self.module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.module)
        self.attempt = '11111111-2222-4333-8444-555555555555'
        self.ref = 'sha256:' + 'a' * 64
        self.digests = {name: 'b' * 64 for name in (
            'snapshot-h1-runner-entry.mjs', 'snapshot-h1-container-hook.js',
            'snapshot-h1-job-client.mjs')}
        self.cid = 'c' * 64
        self.nid = 'e' * 64
        self.calls = []
        self.exists = False
        self.network_exists = False
        self.status = 'created'
        self.foreign = False
        self.foreign_network = False
        self.create_unknown = False
        self.network_create_unknown = False

    def container(self):
        return self.module.H1FixedRunnerContainer(self.attempt, self.ref,
                                                  self.digests, 'd' * 64)

    def checked(self):
        stack = [patch.object(self.module, name, return_value=None) for name in
                 ('_host_preflight', '_verify_volume', '_verify_runner_directory',
                  '_create_runner_directory', '_verify_distribution', '_verify_entries',
                  '_verify_management')]
        for item in stack:
            item.start()
            self.addCleanup(item.stop)

    def record(self, instance):
        value = {'Id': self.cid, 'Name': '/' + instance.name,
                 'Config': {'Image': self.module.IMAGE, 'User': '992:988',
                            'Labels': {'stage1.attempt': self.attempt},
                            'OpenStdin': True, 'Tty': False,
                            'Entrypoint': ['/entry/node'],
                            'Cmd': ['/entry/snapshot-h1-runner-entry.mjs']},
                 'HostConfig': {'NetworkMode': self.nid, 'ReadonlyRootfs': True,
                                'CapDrop': ['ALL'], 'SecurityOpt': ['no-new-privileges'],
                                'Memory': 402653184, 'MemorySwap': 402653184,
                                'PidsLimit': 128, 'LogConfig': {'Type': 'none'},
                                'RestartPolicy': {'Name': 'no'},
                                'Ulimits': [{'Name': 'core', 'Soft': 0, 'Hard': 0}]},
                 'Mounts': [{'Type': 'bind', 'Source': source, 'Destination': target,
                             'RW': writable}
                            for source, target, writable in instance._expected_mounts()]
                 + [{'Type': 'tmpfs', 'Destination': '/tmp'},
                    {'Type': 'tmpfs', 'Destination': '/var/lib/postgresql/data'}],
                 'State': {'Status': self.status, 'ExitCode': 0,
                           'OOMKilled': False},
                 'NetworkSettings': {'Networks': {instance.network_name:
                     {'NetworkID': self.nid}}}}
        if self.foreign:
            value['Config']['Labels']['stage1.attempt'] = 'foreign'
        return value

    def network_record(self, instance):
        return {'Id': self.nid, 'Name': instance.network_name,
                'Driver': 'bridge', 'Scope': 'local', 'Internal': False,
                'Labels': {'stage1.attempt': 'foreign' if self.foreign_network else self.attempt},
                'Containers': {self.cid: {} } if self.exists else {}}

    def docker(self, argv, timeout=30, input_bytes=None, discard=False):
        self.calls.append((argv, timeout, input_bytes, discard))
        if argv[:2] == ['network', 'inspect']:
            target = argv[2]
            exists = self.network_exists if target in (self.nid, self.instance.network_name) else False
            return Result(0, json.dumps([self.network_record(self.instance)]).encode()) if exists else \
                Result(1, err=b'No such network')
        if argv[:2] == ['network', 'create']:
            if self.network_create_unknown:
                return Result(1, err=b'unexpected daemon result')
            self.network_exists = True
            return Result(0, (self.nid + '\n').encode())
        if argv[:2] == ['network', 'rm']:
            self.network_exists = False
            return Result(0, (self.nid + '\n').encode())
        if argv[:2] == ['container', 'inspect']:
            target = argv[2]
            exists = self.exists if target in (self.cid, self.name) else False
            return Result(0, json.dumps([self.record(self.instance)]).encode()) if exists else \
                Result(1, err=b'No such container')
        if argv[0] == 'create':
            if self.create_unknown:
                return Result(1, err=b'unexpected daemon result')
            self.exists = True
            return Result(0, (self.cid + '\n').encode())
        if argv[:3] == ['start', '--attach', '--interactive']:
            self.status = 'exited'
            return Result()
        if argv[:3] == ['rm', '--force', '--volumes']:
            self.exists = False
            return Result()
        self.fail('unexpected Docker command')

    def setup_docker(self):
        self.checked()
        self.instance = self.container()
        self.assertEqual(self.instance.prepare_directory(),
                         '/var/lib/subscription-saas/snapshot-volumes/' + self.attempt + '.mnt/runner')
        self.name = self.instance.name
        self.patcher = patch.object(self.instance, '_docker', self.docker)
        self.patcher.start()
        self.addCleanup(self.patcher.stop)

    def test_prepare_creates_only_fixed_confined_container_and_saves_cid(self):
        self.setup_docker()
        self.assertTrue(self.instance.prepare())
        create = next(call[0] for call in self.calls if call[0][0] == 'create')
        self.assertEqual(self.instance.container_id, self.cid)
        self.assertEqual(self.instance.network_id, self.nid)
        network_create = next(call[0] for call in self.calls if call[0][:2] == ['network', 'create'])
        self.assertEqual(network_create, ['network', 'create', '--driver', 'bridge',
                         '--label', 'stage1.attempt=' + self.attempt,
                         self.instance.network_name])
        for pair in (('--user', '992:988'), ('--network', self.nid),
                     ('--memory', '384m'), ('--pids-limit', '128'),
                     ('--log-driver', 'none'), ('--restart', 'no')):
            self.assertEqual(create[create.index(pair[0]) + 1], pair[1])
        self.assertIn('--read-only', create)
        self.assertIn('--interactive', create)
        self.assertIn('--cap-drop', create)
        self.assertIn('--tmpfs', create)
        self.assertNotIn('/var/run/docker.sock', ' '.join(create))
        with self.assertRaises(self.module.RunnerFailure):
            self.instance.prepare()

    def test_unknown_create_is_not_retried_or_removed_by_name(self):
        self.setup_docker()
        before = self.container()
        self.assertTrue(before.cleanup())
        self.create_unknown = True
        with self.assertRaises(self.module.RunnerFailure):
            self.instance.prepare()
        with self.assertRaises(self.module.RunnerFailure):
            self.instance.prepare()
        with self.assertRaises(self.module.RunnerFailure):
            self.instance.cleanup()
        self.assertEqual(sum(argv[0] == 'create' for argv, _, _, _ in self.calls), 1)
        self.assertFalse(any(argv[0] == 'rm' for argv, _, _, _ in self.calls))
        self.assertFalse(self.network_exists)

    def test_run_passes_only_private_frame_on_stdin_and_discards_output(self):
        self.setup_docker()
        self.instance.prepare()
        frame = {'attemptId': self.attempt, 'admissionRef': self.ref, 'runnerId': '456',
                 'routeNonce': 'e' * 32, 'encodedJitConfig': 'Y29uZmln'}
        self.assertEqual(self.instance.run(frame), {'exitCode': 0})
        start = next(call for call in self.calls if call[0][0] == 'start')
        self.assertEqual(start[0], ['start', '--attach', '--interactive', self.cid])
        self.assertEqual(start[1], 1200)
        self.assertEqual(json.loads(start[2]), frame)
        self.assertTrue(start[3])
        self.assertNotIn('Y29uZmln', ' '.join(start[0]))

    def test_cleanup_refuses_foreign_cid_and_confirmed_absence(self):
        self.setup_docker()
        self.instance.prepare()
        self.foreign = True
        with self.assertRaises(self.module.RunnerFailure):
            self.instance.cleanup()
        self.assertFalse(any(argv[0] == 'rm' for argv, _, _, _ in self.calls))
        self.foreign = False
        self.assertTrue(self.instance.cleanup())
        self.assertEqual(sum(argv[0] == 'rm' for argv, _, _, _ in self.calls), 1)
        self.assertEqual(sum(argv[:2] == ['network', 'rm'] for argv, _, _, _ in self.calls), 1)
        self.assertTrue(self.instance.cleanup())

    def test_unknown_network_creation_is_not_guessed_or_retried(self):
        self.setup_docker()
        self.network_create_unknown = True
        with self.assertRaises(self.module.RunnerFailure):
            self.instance.prepare()
        with self.assertRaises(self.module.RunnerFailure):
            self.instance.prepare()
        with self.assertRaises(self.module.RunnerFailure):
            self.instance.cleanup()
        self.assertEqual(sum(argv[:2] == ['network', 'create'] for argv, _, _, _ in self.calls), 1)
        self.assertFalse(any(argv[0] == 'create' for argv, _, _, _ in self.calls))
        self.assertFalse(any(argv[:2] == ['network', 'rm'] for argv, _, _, _ in self.calls))

    def test_run_rejects_extra_fields_without_starting(self):
        self.setup_docker()
        self.instance.prepare()
        frame = {'attemptId': self.attempt, 'admissionRef': self.ref, 'runnerId': '456',
                 'routeNonce': 'e' * 32, 'encodedJitConfig': 'Y29uZmln',
                 'command': 'unexpected'}
        with self.assertRaises(self.module.RunnerFailure):
            self.instance.run(frame)
        self.assertFalse(any(argv[0] == 'start' for argv, _, _, _ in self.calls))


if __name__ == '__main__':
    unittest.main()
