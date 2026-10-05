import importlib.util
import copy
import os
import stat
import time
import types
import unittest
from unittest.mock import patch

PATH = os.path.join(os.path.dirname(__file__), 'snapshot-h1-attempt.py')


class AttemptTests(unittest.TestCase):
    def setUp(self):
        spec = importlib.util.spec_from_file_location('snapshot_h1_attempt_tested', PATH)
        self.module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.module)

    def test_foreign_command_does_not_load_root_configuration(self):
        with patch.object(self.module, '_installation') as installed:
            with self.assertRaisesRegex(RuntimeError, 'H1_ATTEMPT_INPUT_INVALID'):
                self.module.H1SnapshotAttempt({'command': 'shell'})
            installed.assert_not_called()

    def test_changed_admission_or_production_cannot_replace_prepared_attempt(self):
        original = {'admission': {'attempt': 'one'}, 'production': {'key': 'one'}}
        attempt = object.__new__(self.module.H1SnapshotAttempt)
        attempt.request = {'selection': {}, 'approvalSelection': {}}
        for field in ('admission', 'production'):
            attempt.admitted = copy.deepcopy(original)
            changed = copy.deepcopy(original)
            changed[field] = {'different': True}
            attempt._authority = lambda operation, request: changed
            with self.assertRaisesRegex(RuntimeError, 'ADMISSION_CHANGED'):
                attempt._readmit_before_jit()
            self.assertEqual(attempt.admitted, original)

    def test_nonce_is_consumed_only_after_late_admission_and_before_jit_post(self):
        events = []
        class Part:
            def __init__(self, *args): pass
            def prepare(self): events.append('prepare')
            def prepare_directory(self): return '/fixed/runner'
            def start(self): pass
            def cleanup(self): return True
            def __enter__(self): return self
            def create_jit(self, *args):
                events.append('jit')
                raise RuntimeError('synthetic post failure')
        module = self.module
        attempt = object.__new__(module.H1SnapshotAttempt)
        attempt.admitted = None
        attempt.request = {'selection': {'jobId': '1'}, 'approvalSelection': {}}
        attempt.adapter_digest = 'fixed'
        attempt.installation = {'entries': {}, 'runnerDistributionDigest': 'fixed'}
        attempt.jit_attempted = False
        admission = {'adapterDigest': 'fixed', 'releaseAttemptId': 'attempt',
                     'route': {'nonce': 'nonce'}, 'producerRun': {'runId': '2'}}
        packet = {'admission': admission, 'production': {'publicKey': 'public',
                  'authorization': {'bindings': {'cryptoExecutableDigest': module.WORKER}}}}
        def authority(operation, request):
            self.assertEqual(operation, 'admit')
            events.append('admit')
            return copy.deepcopy(packet)
        attempt._authority = authority
        attempt._fresh = lambda: time.time() * 1000 + 10000
        attempt.cleanup = lambda: events.append('cleanup') or True
        attempt.modules = {
            'snapshot-h1-volume.py': types.SimpleNamespace(H1SnapshotAttemptVolume=Part),
            'snapshot-h1-producer.py': types.SimpleNamespace(H1FixedSnapshotProducer=Part),
            'snapshot-h1-runner.py': types.SimpleNamespace(H1FixedRunnerContainer=Part),
            'snapshot-h1-control.py': types.SimpleNamespace(CLIENTS=(), H1FixedJobContainer=Part,
                                                           H1SnapshotControl=Part),
            'snapshot-h1-github.py': types.SimpleNamespace(H1SnapshotJitGitHub=Part),
            'snapshot-h1-route-journal.py': types.SimpleNamespace(
                claim=lambda *args: events.append('claim'))}
        with self.assertRaisesRegex(RuntimeError, 'EXECUTION_FAILED'):
            attempt.run()
        self.assertEqual(events, ['admit', 'prepare', 'prepare', 'admit', 'claim', 'jit', 'cleanup'])
        self.assertTrue(attempt.jit_attempted)

    def test_cleanup_preserves_volume_when_a_consumer_is_unknown(self):
        events = []
        class Part:
            def __init__(self, name, success=True): self.name, self.success = name, success
            def cleanup(self): events.append(self.name); return self.success
            def close(self): events.append(self.name); return self.success
            def remove_created_runner(self): events.append('github-runner'); return True
        attempt = object.__new__(self.module.H1SnapshotAttempt)
        attempt.runner = Part('runner', False)
        attempt.control = Part('control')
        attempt.producer = Part('producer')
        attempt.volume = Part('volume')
        attempt.github = Part('token')
        attempt.jit_attempted = True
        attempt.cleanup_facts = {}
        self.assertFalse(attempt.cleanup())
        self.assertNotIn('volume', events)
        self.assertEqual(events, ['runner', 'control', 'producer', 'github-runner', 'token'])

    def test_cleanup_destroys_volume_only_after_all_consumers_and_route_are_gone(self):
        events = []
        class Part:
            observation = {'destroyed': True}
            def __init__(self, name): self.name = name
            def cleanup(self): events.append(self.name); return True
            def close(self): events.append(self.name); return True
            def remove_created_runner(self): events.append('github-runner'); return True
        attempt = object.__new__(self.module.H1SnapshotAttempt)
        for name in ('runner', 'control', 'producer', 'volume'):
            setattr(attempt, name, Part(name))
        attempt.github = Part('token')
        attempt.jit_attempted = True
        attempt.cleanup_facts = {}
        self.assertTrue(attempt.cleanup())
        self.assertEqual(events, ['runner', 'control', 'producer', 'github-runner', 'token', 'volume'])
        self.assertTrue(attempt.cleanup_facts['volumeDestroyed'])

    def test_residual_scan_allows_only_bound_ciphertext_after_workspace_absence(self):
        module = self.module
        attempt = object.__new__(module.H1SnapshotAttempt)
        identity = '11111111-2222-4333-8444-555555555555'
        attempt.spool = module.OUTPUT + '/' + identity
        attempt.producer = types.SimpleNamespace(attempt_id=identity, cleanup_observation={},
            complete={'envelope': {'ciphertextDigest': 'sha256:' + 'a' * 64}})
        attempt.modules = {'snapshot-h1-producer.py': types.SimpleNamespace(_utc=lambda: '2026-10-06T00:00:00.000Z')}
        directory = types.SimpleNamespace(st_mode=stat.S_IFDIR | 0o700, st_uid=0, st_gid=0)
        with patch.object(module.os.path, 'lexists', return_value=False) as exists, \
             patch.object(module.os.path, 'realpath', side_effect=lambda p: p), \
             patch.object(module.os, 'lstat', return_value=directory), \
             patch.object(module.os, 'listdir', return_value=['snapshot.enc']) as listing, \
             patch.object(module, '_file', return_value='a' * 64):
            observed = attempt._observe_data_disposal()
            self.assertEqual(observed['residualScan']['plaintextArtifactsFound'], 0)
            self.assertEqual(observed['residualScan']['pathsChecked'][-1], attempt.spool)
            listing.return_value.append('plaintext.sql')
            with self.assertRaisesRegex(RuntimeError, 'PLAINTEXT_RESIDUAL'):
                attempt._observe_data_disposal()
            listing.return_value = ['snapshot.enc']
            exists.return_value = True
            with self.assertRaisesRegex(RuntimeError, 'PLAINTEXT_RESIDUAL'):
                attempt._observe_data_disposal()


if __name__ == '__main__':
    unittest.main()
