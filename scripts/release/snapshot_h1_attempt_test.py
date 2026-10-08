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
        attempt.reader_session = types.SimpleNamespace(close=lambda: None)
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
        publisher.session = {'path': module.PUBLISHER_SESSION}
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

    def _archive_observed(self, operation):
        profile = ('archive-create-only-writer' if operation == 'archive-write'
                   else 'archive-readback-reader')
        role = ('subscription-saas-stage1-archive-writer' if operation == 'archive-write'
                else 'subscription-saas-stage1-archive-reader')
        return {'status': 'ARCHIVE_IO_OBSERVED',
                'authorizationDigest': 'sha256:' + 'a' * 64,
                'profile': profile, 'operationId': 'archive-operation-1',
                'session': {'arn': 'acs:ram::1457643390906675:assumed-role/' + role + '/session_1',
                            'issuedAt': '2026-10-06T00:00:00.000Z',
                            'expiresAt': '2026-10-06T00:00:01.000Z',
                            'fingerprint': 'sha256:' + 'b' * 64},
                'ioDigest': 'sha256:' + 'c' * 64,
                'observedAt': '2026-10-06T00:00:00.200Z'}

    def test_archive_writer_and_reader_route_to_fixed_sessions_and_authority(self):
        module = self.module
        for operation, session_path in (
                ('archive-write', module.ARCHIVE_WRITER_SESSION),
                ('archive-read', module.ARCHIVE_READER_SESSION)):
            with self.subTest(operation=operation):
                events = []
                observed = self._archive_observed(operation)
                request = {'operation': operation, 'authorizationDigest': 'sha256:' + 'a' * 64}
                def authority(instance, selected, body):
                    self.assertEqual(selected, operation)
                    self.assertEqual(body, {'authorizationDigest': request['authorizationDigest']})
                    events.append('authority')
                    return observed
                def remove(instance):
                    events.append('remove')
                    instance.session.update({'removed': True, 'absent': True,
                                             'removedAt': '2026-10-06T00:00:00.400Z'})
                with patch.object(module, '_installation', return_value={
                        'controlBundleDigest': 'sha256:' + 'd' * 64}), \
                     patch.object(module.H1EvidenceArchiveOperation, '_lock',
                                  lambda instance: events.append('lock')), \
                     patch.object(module.H1EvidenceArchiveOperation, '_observe_session',
                                  lambda instance: events.append('observe')), \
                     patch.object(module.H1EvidenceArchiveOperation, '_authority', authority), \
                     patch.object(module.H1EvidenceArchiveOperation, '_remove_session', remove), \
                     patch.object(module.H1EvidenceArchiveOperation, '_session_absent',
                                  lambda instance: True), \
                     patch.object(module.H1EvidenceArchiveOperation, '_wait_expiry',
                                  lambda instance, session, start: events.append('wait') or
                                  '2026-10-06T00:00:01.000Z'), \
                     patch.object(module.H1EvidenceArchiveOperation, '_write_record',
                                  lambda instance, name, value: events.append(name) or
                                  module.digest(module.canonical(value))), \
                     patch.object(module, '_safe_root_directory'), \
                     patch.object(module, '_file', return_value='c' * 64), \
                     patch.object(module, '_publisher_utc', side_effect=[
                         '2026-10-06T00:00:00.100Z', '2026-10-06T00:00:00.300Z']):
                    archive = module.H1EvidenceArchiveOperation(request)
                    self.assertEqual(archive.session['path'], session_path)
                    self.assertEqual(archive.LOCK_NAME, 'archive.lock')
                    result = archive.run()
                self.assertEqual(events, ['lock', 'observe', 'authority', 'remove',
                                          'wait', 'archive-terminal.json'])
                self.assertEqual(result['status'], 'ARCHIVE_TERMINAL_OBSERVED')
                self.assertEqual(result['profile'], observed['profile'])

    def test_archive_rejects_wrong_role_and_io_digest(self):
        module = self.module
        request = {'operation': 'archive-read', 'authorizationDigest': 'sha256:' + 'a' * 64}
        with patch.object(module, '_installation', return_value={
                'controlBundleDigest': 'sha256:' + 'd' * 64}), \
             patch.object(module, '_safe_root_directory'), \
             patch.object(module, '_file', return_value='c' * 64):
            archive = module.H1EvidenceArchiveOperation(request)
            archive.authority.update({'startedAt': '2026-10-06T00:00:00.100Z',
                                      'finishedAt': '2026-10-06T00:00:00.300Z'})
            observed = self._archive_observed('archive-read')
            observed['session']['arn'] = observed['session']['arn'].replace(
                'archive-reader', 'archive-writer')
            with self.assertRaisesRegex(RuntimeError, 'ARCHIVE_RESULT_INVALID'):
                archive._validate_io(observed)
            observed = self._archive_observed('archive-read')
            observed['ioDigest'] = 'sha256:' + 'e' * 64
            with self.assertRaisesRegex(RuntimeError, 'ARCHIVE_IO_CHANGED'):
                archive._validate_io(observed)

    def test_archive_failure_removes_session_and_writes_no_terminal(self):
        module = self.module
        events = []
        request = {'operation': 'archive-write', 'authorizationDigest': 'sha256:' + 'a' * 64}
        def fail(*args):
            events.append('authority')
            raise RuntimeError('H1_ATTEMPT_AUTHORITY_REJECTED')
        with patch.object(module, '_installation', return_value={
                'controlBundleDigest': 'sha256:' + 'd' * 64}), \
             patch.object(module.H1EvidenceArchiveOperation, '_lock',
                          lambda instance: events.append('lock')), \
             patch.object(module.H1EvidenceArchiveOperation, '_observe_session',
                          lambda instance: events.append('observe')), \
             patch.object(module.H1EvidenceArchiveOperation, '_authority', fail), \
             patch.object(module.H1EvidenceArchiveOperation, '_remove_session',
                          lambda instance: events.append('remove')), \
             patch.object(module.H1EvidenceArchiveOperation, '_write_record',
                          lambda instance, name, value: events.append(name)), \
             patch.object(module, '_publisher_utc', return_value='2026-10-06T00:00:00.100Z'):
            with self.assertRaisesRegex(RuntimeError, 'AUTHORITY_REJECTED'):
                module.H1EvidenceArchiveOperation(request).run()
        self.assertEqual(events, ['lock', 'observe', 'authority', 'remove',
                                  'archive-failure.json'])

    def test_archive_sealing_does_not_repeat_io(self):
        module = self.module
        for operation in ('archive-write', 'archive-read'):
            request = {'operation': operation, 'authorizationDigest': 'sha256:' + 'a' * 64}
            profile = ('archive-create-only-writer' if operation == 'archive-write'
                       else 'archive-readback-reader')
            sealed = {'status': 'ARCHIVE_ACCESS_SEALED', 'authorizationDigest': request['authorizationDigest'],
                      'profile': profile, 'proofDigest': 'sha256:' + 'b' * 64,
                      'receiptDigest': 'sha256:' + 'c' * 64,
                      'custodyDigest': 'sha256:' + 'e' * 64 if operation == 'archive-read' else None}
            with patch.object(module, '_installation', return_value={'controlBundleDigest': 'sha256:' + 'd' * 64}), \
                 patch.object(module, '_safe_root_directory'), \
                 patch.object(module.H1EvidenceArchiveOperation, '_authority', return_value=sealed) as authority, \
                 patch.object(module.H1EvidenceArchiveOperation, '_run_locked') as run:
                archive = module.H1EvidenceArchiveOperation(request)
                self.assertEqual(archive.seal_access(), sealed)
                authority.assert_called_once_with(operation.replace('archive-', 'archive-seal-'),
                                                  {'authorizationDigest': request['authorizationDigest']})
                run.assert_not_called()
                sealed['authorizationDigest'] = 'sha256:' + 'e' * 64
                with self.assertRaisesRegex(RuntimeError, 'ARCHIVE_RESULT_INVALID'):
                    archive.seal_access()

    def _final_readback_observed(self):
        return {'status': 'SNAPSHOT_FINAL_READBACK_OBSERVED',
                'releaseAttemptId': '11111111-2222-4333-8444-555555555555',
                'snapshotRunId': '123',
                'session': {'arn': 'acs:ram::1457643390906675:assumed-role/subscription-saas-stage1-snapshot-consumer/session_1',
                            'issuedAt': '2026-10-06T00:00:00.000Z',
                            'expiresAt': '2026-10-06T00:00:01.000Z',
                            'fingerprint': 'sha256:' + 'b' * 64},
                'readbackDigest': 'sha256:' + 'c' * 64,
                'observedAt': '2026-10-06T00:00:00.200Z'}

    def test_final_readback_uses_fixed_reader_and_terminal_lifecycle(self):
        module = self.module
        observed = self._final_readback_observed()
        request = {'operation': 'snapshot-final-readback',
                   'releaseAttemptId': observed['releaseAttemptId'], 'snapshotRunId': '123'}
        events = []
        def authority(instance, operation, body):
            self.assertEqual(operation, 'snapshot-final-readback')
            self.assertEqual(body, {key: request[key] for key in ('releaseAttemptId', 'snapshotRunId')})
            events.append('authority')
            return observed
        def remove(instance):
            events.append('remove')
            instance.session.update({'removed': True, 'absent': True,
                                     'removedAt': '2026-10-06T00:00:00.400Z'})
        with patch.object(module, '_installation', return_value={
                'controlBundleDigest': 'sha256:' + 'd' * 64}), \
             patch.object(module.H1SnapshotFinalReadback, '_lock',
                          lambda instance: events.append('lock')), \
             patch.object(module.H1SnapshotFinalReadback, '_observe_session',
                          lambda instance: events.append('observe')), \
             patch.object(module.H1SnapshotFinalReadback, '_authority', authority), \
             patch.object(module.H1SnapshotFinalReadback, '_remove_session', remove), \
             patch.object(module.H1SnapshotFinalReadback, '_session_absent',
                          lambda instance: True), \
             patch.object(module.H1SnapshotFinalReadback, '_wait_expiry',
                          lambda instance, session, start: events.append('wait') or
                          '2026-10-06T00:00:01.000Z'), \
             patch.object(module.H1SnapshotFinalReadback, '_write_record',
                          lambda instance, name, value: events.append(name) or
                          module.digest(module.canonical(value))), \
             patch.object(module, '_safe_root_directory'), \
             patch.object(module, '_file', return_value='c' * 64), \
             patch.object(module, '_publisher_utc', side_effect=[
                 '2026-10-06T00:00:00.100Z', '2026-10-06T00:00:00.300Z']):
            reader = module.H1SnapshotFinalReadback(request)
            self.assertEqual(reader.LOCK_NAME, 'snapshot-final-readback.lock')
            self.assertEqual(reader.session['path'], module.SNAPSHOT_FINAL_READER_SESSION)
            result = reader.run()
        self.assertEqual(events, ['lock', 'observe', 'authority', 'remove', 'wait',
                                  'snapshot-final-reader-terminal.json'])
        self.assertEqual(result['status'], 'SNAPSHOT_FINAL_READER_TERMINAL_OBSERVED')

    def test_final_readback_rejects_wrong_role_and_file_digest(self):
        module = self.module
        observed = self._final_readback_observed()
        request = {'operation': 'snapshot-final-readback',
                   'releaseAttemptId': observed['releaseAttemptId'], 'snapshotRunId': '123'}
        with patch.object(module, '_installation', return_value={
                'controlBundleDigest': 'sha256:' + 'd' * 64}), \
             patch.object(module, '_safe_root_directory'), \
             patch.object(module, '_file', return_value='c' * 64):
            reader = module.H1SnapshotFinalReadback(request)
            reader.authority.update({'startedAt': '2026-10-06T00:00:00.100Z',
                                     'finishedAt': '2026-10-06T00:00:00.300Z'})
            observed['session']['arn'] = observed['session']['arn'].replace(
                'snapshot-consumer', 'archive-reader')
            with self.assertRaisesRegex(RuntimeError, 'FINAL_READBACK_RESULT_INVALID'):
                reader._validate_readback(observed)
            observed = self._final_readback_observed()
            observed['readbackDigest'] = 'sha256:' + 'e' * 64
            with self.assertRaisesRegex(RuntimeError, 'FINAL_READBACK_FILE_CHANGED'):
                reader._validate_readback(observed)

    def test_final_readback_failure_removes_session_without_terminal(self):
        module = self.module
        observed = self._final_readback_observed()
        request = {'operation': 'snapshot-final-readback',
                   'releaseAttemptId': observed['releaseAttemptId'], 'snapshotRunId': '123'}
        events = []
        def fail(*args):
            events.append('authority')
            raise RuntimeError('H1_ATTEMPT_AUTHORITY_REJECTED')
        with patch.object(module, '_installation', return_value={
                'controlBundleDigest': 'sha256:' + 'd' * 64}), \
             patch.object(module.H1SnapshotFinalReadback, '_lock',
                          lambda instance: events.append('lock')), \
             patch.object(module.H1SnapshotFinalReadback, '_observe_session',
                          lambda instance: events.append('observe')), \
             patch.object(module.H1SnapshotFinalReadback, '_authority', fail), \
             patch.object(module.H1SnapshotFinalReadback, '_remove_session',
                          lambda instance: events.append('remove')), \
             patch.object(module.H1SnapshotFinalReadback, '_write_record',
                          lambda instance, name, value: events.append(name)), \
             patch.object(module, '_publisher_utc', return_value='2026-10-06T00:00:00.100Z'):
            with self.assertRaisesRegex(RuntimeError, 'AUTHORITY_REJECTED'):
                module.H1SnapshotFinalReadback(request).run()
        self.assertEqual(events, ['lock', 'observe', 'authority', 'remove',
                                  'snapshot-final-readback-failure.json'])

    def test_seal_completion_validates_exact_response_without_reader_lifecycle(self):
        module = self.module
        observed = self._final_readback_observed()
        request = {'operation': 'seal-completion',
                   'releaseAttemptId': observed['releaseAttemptId'], 'snapshotRunId': '123'}
        sealed = {'status': 'SNAPSHOT_COMPLETION_SEALED',
                  'releaseAttemptId': request['releaseAttemptId'], 'snapshotRunId': '123',
                  'completionDigest': 'sha256:' + 'a' * 64,
                  'custodyDigest': 'sha256:' + 'b' * 64,
                  'readbackDigest': 'sha256:' + 'c' * 64}
        with patch.object(module, '_installation', return_value={
                'controlBundleDigest': 'sha256:' + 'd' * 64}), \
             patch.object(module.H1SnapshotAttempt, '_authority', return_value=sealed) as authority, \
             patch.object(module.H1SnapshotFinalReadback, 'run') as run:
            self.assertEqual(module._seal_completion(request), sealed)
            authority.assert_called_once_with('seal-completion', {
                'releaseAttemptId': request['releaseAttemptId'], 'snapshotRunId': '123'})
            run.assert_not_called()
            sealed['custodyDigest'] = 'sha256:' + 'X' * 64
            with self.assertRaisesRegex(RuntimeError, 'COMPLETION_RESULT_INVALID'):
                module._seal_completion(request)

    def test_seal_producer_terminal_routes_fixed_spool_and_validates_response(self):
        module = self.module
        request = {'operation': 'seal-producer-terminal',
                   'releaseAttemptId': '11111111-2222-4333-8444-555555555555',
                   'snapshotRunId': '123', 'archiveAuthorizationDigest': 'sha256:' + 'a' * 64}
        sealed = {'status': 'SNAPSHOT_PRODUCER_TERMINAL_SEALED',
                  'releaseAttemptId': request['releaseAttemptId'], 'snapshotRunId': '123',
                  'completionDigest': 'sha256:' + 'b' * 64,
                  'terminalDigest': 'sha256:' + 'c' * 64}
        with patch.object(module, '_installation', return_value={
                'controlBundleDigest': 'sha256:' + 'd' * 64}), \
             patch.object(module, '_safe_root_directory') as directory, \
             patch.object(module.H1SnapshotAttempt, '_authority', return_value=sealed) as authority:
            self.assertEqual(module._seal_producer_terminal(request), sealed)
            authority.assert_called_once_with('seal-producer-terminal', {
                'releaseAttemptId': request['releaseAttemptId'], 'snapshotRunId': '123',
                'archiveAuthorizationDigest': request['archiveAuthorizationDigest']})
            self.assertEqual([call[0][0] for call in directory.call_args_list], [
                module.OUTPUT, module.OUTPUT + '/' + request['releaseAttemptId']])
            sealed['terminalDigest'] = 'sha256:' + 'X' * 64
            with self.assertRaisesRegex(RuntimeError, 'PRODUCER_TERMINAL_RESULT_INVALID'):
                module._seal_producer_terminal(request)
            request['archiveAuthorizationDigest'] = 'sha256:' + 'X' * 64
            with self.assertRaisesRegex(RuntimeError, 'INPUT_INVALID'):
                module._seal_producer_terminal(request)


if __name__ == '__main__':
    unittest.main()
