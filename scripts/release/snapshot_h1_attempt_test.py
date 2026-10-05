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

    def test_publish_records_only_after_authority_exit_removal_and_expiry(self):
        module = self.module
        identity = '11111111-2222-4333-8444-555555555555'
        request = {'operation': 'publish', 'releaseAttemptId': identity, 'snapshotRunId': '123'}
        events = []
        prefix = 'snapshot-slots/v2/' + identity + '/123/'
        names = ['snapshot.enc', 'encryption-envelope.json', 'snapshot-proof.json',
                 'data-result.json', 'diagnostics.redacted.json']
        objects = [{'key': prefix + name, 'digest': 'sha256:' + 'a' * 64,
                    'sizeBytes': 1, 'requestId': 'request', 'etag': None,
                    'putObservation': {}} for name in names]
        published = {'status': 'PUBLISHED', 'releaseAttemptId': identity, 'snapshotRunId': '123',
                     'publicationDigest': 'sha256:' + 'a' * 64, 'objects': objects,
                     'writer': {'arn': 'acs:ram::1457643390906675:assumed-role/subscription-saas-stage1-snapshot-publisher/stage1-publisher-123-attempt-1',
                                'issuedAt': '2026-10-06T00:00:00.000Z',
                                'expiresAt': '2026-10-06T00:00:01.000Z'},
                     'publishedAt': '2026-10-06T00:00:00.100Z'}
        with patch.object(module, '_installation', return_value={'controlBundleDigest': 'sha256:' + 'b' * 64}), \
             patch.object(module.H1SnapshotPublisher, '_lock', lambda self: events.append('lock')), \
             patch.object(module.H1SnapshotPublisher, '_observe_session', lambda self: None), \
             patch.object(module.H1SnapshotPublisher, '_session_absent', lambda self: True), \
             patch.object(module.H1SnapshotPublisher, '_authority',
                          lambda self, op, req: events.append('authority') or published), \
             patch.object(module.H1SnapshotPublisher, '_remove_session',
                          lambda self: events.append('remove') or self.session.update({
                              'removed': True, 'absent': True,
                              'removedAt': '2026-10-06T00:00:00.200Z'})), \
             patch.object(module.H1SnapshotPublisher, '_wait_expiry',
                          lambda self, writer, start: events.append('wait') or '2026-10-06T00:00:01.000Z'), \
             patch.object(module.H1SnapshotPublisher, '_write_record',
                          lambda self, name, value: events.append(name) or module.digest(module.canonical(value))), \
             patch.object(module, '_publisher_utc', side_effect=[
                 '2026-10-06T00:00:00.000Z', '2026-10-06T00:00:00.150Z']):
            module.H1SnapshotPublisher(request)._validate_published(published)
            result = module.H1SnapshotPublisher(request).run()
        self.assertEqual(events, ['lock', 'authority', 'remove', 'wait', 'publisher-terminal.json'])
        self.assertRegex(result['observationDigest'], r'^sha256:[0-9a-f]{64}$')

    def test_publish_authority_failure_still_removes_session_without_terminal(self):
        module = self.module
        identity = '11111111-2222-4333-8444-555555555555'
        events = []
        request = {'operation': 'publish', 'releaseAttemptId': identity, 'snapshotRunId': '123'}
        def fail(*args):
            events.append('authority')
            raise RuntimeError('H1_ATTEMPT_AUTHORITY_REJECTED')
        with patch.object(module, '_installation', return_value={'controlBundleDigest': 'sha256:' + 'b' * 64}), \
             patch.object(module.H1SnapshotPublisher, '_lock', lambda self: events.append('lock')), \
             patch.object(module.H1SnapshotPublisher, '_observe_session', lambda self: None), \
             patch.object(module.H1SnapshotPublisher, '_authority', fail), \
             patch.object(module.H1SnapshotPublisher, '_remove_session',
                          lambda self: events.append('remove') or '2026-10-06T00:00:00.200Z'), \
             patch.object(module.H1SnapshotPublisher, '_write_record',
                          lambda self, name, value: events.append(name)):
            with self.assertRaisesRegex(RuntimeError, 'AUTHORITY_REJECTED'):
                module.H1SnapshotPublisher(request).run()
        self.assertEqual(events, ['lock', 'authority', 'remove', 'publisher-failure.json'])

    def test_expiry_requires_monotonic_ttl_even_after_wall_clock_leaps(self):
        module = self.module
        publisher = object.__new__(module.H1SnapshotPublisher)
        writer = {'issuedAt': '2026-10-06T00:00:00Z',
                  'expiresAt': '2026-10-06T00:00:01Z'}
        expired = module._publisher_time(writer['expiresAt'])
        with patch.object(module.time, 'monotonic', side_effect=[0, 1]), \
             patch.object(module.time, 'time', side_effect=[expired + 100, expired + 100]), \
             patch.object(module.time, 'sleep') as sleep, \
             patch.object(module, '_publisher_utc', return_value='2026-10-06T00:00:01.000Z'):
            self.assertEqual(publisher._wait_expiry(writer, 0), '2026-10-06T00:00:01.000Z')
            sleep.assert_called_once()
            self.assertLessEqual(sleep.call_args[0][0], 5)

    def test_changed_session_inode_is_never_unlinked(self):
        module = self.module
        publisher = object.__new__(module.H1SnapshotPublisher)
        publisher.session = {}
        original = types.SimpleNamespace(st_mode=stat.S_IFREG | 0o600, st_uid=0, st_gid=0,
            st_nlink=1, st_dev=1, st_ino=10, st_size=4, st_mtime_ns=1, st_ctime_ns=1)
        replaced = types.SimpleNamespace(**vars(original))
        replaced.st_ino = 11
        publisher.session_before = original
        directory = types.SimpleNamespace(st_mode=stat.S_IFDIR | 0o700, st_uid=0, st_gid=0,
            st_nlink=2, st_dev=1, st_ino=1, st_size=4096, st_mtime_ns=1, st_ctime_ns=1)
        with patch.object(module, '_safe_root_directory', return_value=directory), \
             patch.object(module.os, 'O_DIRECTORY', 0, create=True), \
             patch.object(module.os, 'O_NOFOLLOW', 0, create=True), \
             patch.object(module.os, 'O_NONBLOCK', 0, create=True), \
             patch.object(module.os, 'open', side_effect=[100, 101]), \
             patch.object(module.os, 'stat', side_effect=[original, replaced]), \
             patch.object(module.os, 'fstat', side_effect=[directory, original]), \
             patch.object(module.os, 'unlink') as unlink, \
             patch.object(module.os, 'close'):
            with self.assertRaisesRegex(RuntimeError, 'SESSION_CHANGED'):
                publisher._remove_session()
            unlink.assert_not_called()

    def test_existing_publish_lock_refuses_retry_before_authority(self):
        module = self.module
        publisher = object.__new__(module.H1SnapshotPublisher)
        publisher.spool = module.OUTPUT + '/11111111-2222-4333-8444-555555555555'
        publisher.request = {'releaseAttemptId': '11111111-2222-4333-8444-555555555555',
                             'snapshotRunId': '123'}
        info = types.SimpleNamespace(st_mode=stat.S_IFREG | 0o600, st_uid=0, st_gid=0,
            st_nlink=1, st_dev=1, st_ino=1, st_size=0, st_mtime_ns=1, st_ctime_ns=1)
        fake_fcntl = types.SimpleNamespace(flock=lambda *args: None, LOCK_EX=1, LOCK_NB=2)
        with patch.object(module, '_safe_root_directory'), \
             patch.object(module, 'fcntl', fake_fcntl), \
             patch.object(module.os, 'O_NOFOLLOW', 0, create=True), \
             patch.object(module.os, 'open', side_effect=[100, FileExistsError]), \
             patch.object(module.os, 'fstat', return_value=info), \
             patch.object(module.os, 'lstat', return_value=info), \
             patch.object(module.os, 'close'), \
             patch.object(publisher, '_authority') as authority:
            with self.assertRaises(FileExistsError):
                publisher.run()
            authority.assert_not_called()

    def test_destruction_sealing_uses_separate_authority_without_republishing(self):
        module = self.module
        request = {'operation': 'publish', 'releaseAttemptId': '11111111-2222-4333-8444-555555555555', 'snapshotRunId': '123'}
        sealed = {'receipt': {'releaseAttemptId': request['releaseAttemptId'], 'snapshotRunId': '123'},
                  'signature': {}, 'dataResultDigest': 'sha256:'+'a'*64, 'cryptoUseProofDigest': 'sha256:'+'b'*64,
                  'publicationDigest': 'sha256:'+'c'*64, 'publisherTerminalDigest': 'sha256:'+'d'*64}
        use = {'proof': {'releaseAttemptId': request['releaseAttemptId'], 'snapshotRunId': '123',
                        'dataResultDigest': sealed['dataResultDigest'],
                        'cryptoUseProofDigest': sealed['cryptoUseProofDigest'],
                        'publicationDigest': sealed['publicationDigest'],
                        'publisherTerminalDigest': sealed['publisherTerminalDigest']}, 'signature': {}}
        terminal = {'destructionProof': sealed, 'publisherUseProof': use}
        with patch.object(module, '_installation', return_value={'controlBundleDigest': 'sha256:'+'f'*64}), \
             patch.object(module, '_safe_root_directory'), \
             patch.object(module.H1SnapshotPublisher, '_authority', return_value=terminal) as authority, \
             patch.object(module.H1SnapshotPublisher, '_write_record', return_value='sha256:'+'e'*64) as write:
            publisher = module.H1SnapshotPublisher(request)
            result = publisher.seal_destruction()
            authority.assert_called_once_with('seal-destruction', {'releaseAttemptId': request['releaseAttemptId'], 'snapshotRunId': '123'})
            self.assertEqual(result['status'], 'DESTRUCTION_SEALED')
            self.assertEqual(result['publisherUseProofDigest'], module.digest(module.canonical(use['proof'])))
            self.assertEqual(result['publisherUseArchiveDigest'], 'sha256:'+'e'*64)
            self.assertEqual([call[0][0] for call in write.call_args_list], ['snapshot-destruction-proof.json', 'publisher-use-proof.json', 'snapshot-destruction-receipt.json'])
            write.reset_mock();use['proof']['publicationDigest']='sha256:'+'f'*64
            with self.assertRaisesRegex(RuntimeError, 'DESTRUCTION_RESULT_INVALID'):
                publisher.seal_destruction()
            write.assert_not_called();use['proof']['publicationDigest']=sealed['publicationDigest']
            write.reset_mock();sealed['receipt']['snapshotRunId']='124'
            with self.assertRaisesRegex(RuntimeError, 'DESTRUCTION_RESULT_INVALID'):
                publisher.seal_destruction()
            write.assert_not_called()


if __name__ == '__main__':
    unittest.main()
