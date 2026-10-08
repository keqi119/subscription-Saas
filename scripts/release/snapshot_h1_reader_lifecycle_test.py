"""Bounded regression for the initial attempt's actual authority boundary.

Only the external STS/authority processes, filesystem and clocks are simulated.
No cloud requests, real credentials or real TTL sleeps are used.
"""
import datetime
import importlib.util
import json
import os
import stat
import threading
import types
import unittest
from unittest.mock import patch


PATH = os.path.join(os.path.dirname(__file__), 'snapshot-h1-attempt.py')


class ReaderLifecycleTests(unittest.TestCase):
    def setUp(self):
        spec = importlib.util.spec_from_file_location('reader_lifecycle_tested', PATH)
        self.m = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.m)
        self.wall = 1791388800.0
        self.mono = 100.0
        self.session = None
        self.issues = 0
        self.calls = []
        self.inode = 30
        self.failure = False

    def iso(self, value):
        return datetime.datetime.fromtimestamp(value, datetime.timezone.utc).isoformat(
            timespec='milliseconds').replace('+00:00', 'Z')

    def advance(self, seconds):
        self.wall += seconds
        self.mono += seconds

    def info(self, *args, **kwargs):
        if self.session is None:
            raise FileNotFoundError()
        return types.SimpleNamespace(st_dev=1, st_ino=self.inode, st_mode=stat.S_IFREG | 0o600,
            st_uid=0, st_gid=0, st_nlink=1, st_size=len(self.m.canonical(self.session)),
            st_mtime_ns=self.inode, st_ctime_ns=self.inode)

    def read(self, *args, **kwargs):
        self.info()
        return self.m.canonical(self.session)

    def external(self, argv, **kwargs):
        request = json.loads(kwargs['input'])
        operation = request['operation']
        self.calls.append(operation)
        if operation == 'prepare-dispatch-reader':
            self.issues += 1
            if self.failure:
                raise self.m.subprocess.TimeoutExpired(argv, 120)
            self.session = {
                'arn': 'acs:ram::1457643390906675:role/subscription-saas-stage1-archive-reader/test',
                'accessKeyId': 'STS.test', 'accessKeySecret': 'private', 'stsToken': 'private-token',
                'issuedAt': self.iso(self.wall), 'expiresAt': self.iso(self.wall + 899)}
            self.inode += 1
            value = {'status': 'READER_SESSION_READY', 'issuedAt': self.session['issuedAt'],
                     'expiresAt': self.session['expiresAt'],
                     'sessionDigest': self.m.digest(self.m.canonical(self.session))}
        elif self.session is None or self.wall >= self.m._publisher_time(self.session['expiresAt']):
            return types.SimpleNamespace(returncode=1, stdout=b'')
        else:
            value = {'status': 'ACTUAL_BOUNDARY_ACCEPTED'}
        return types.SimpleNamespace(returncode=0, stdout=self.m.canonical(value))

    def context(self):
        from contextlib import ExitStack
        stack = ExitStack()
        for target, name, options in [
            (self.m, '_installation', {'return_value': {'controlBundleDigest': 'sha256:' + 'a' * 64}}),
            (self.m, '_load', {'return_value': types.SimpleNamespace()}),
            (self.m, '_file', {'side_effect': self.read}),
            (self.m.os, 'lstat', {'side_effect': self.info}),
            (self.m.os.path, 'lexists', {'side_effect': lambda p: self.session is not None}),
            (self.m.subprocess, 'run', {'side_effect': self.external}),
            (self.m.time, 'time', {'side_effect': lambda: self.wall}),
            (self.m.time, 'monotonic', {'side_effect': lambda: self.mono}),
            (self.m.time, 'sleep', {'side_effect': self.advance})]:
            stack.enter_context(patch.object(target, name, **options))
        return stack

    def attempt(self):
        return self.m.H1SnapshotAttempt({'selection': {}, 'approvalSelection': {}})

    def removed(self, manager):
        self.assertEqual(manager.before.st_ino, self.inode)
        self.session = None
        manager.before = manager.session_digest = None

    def test_initial_authority_prepares_absent_reader_without_caller_credential(self):
        with self.context():
            attempt = self.attempt()
            try:
                result = attempt._authority('admit', attempt.request)
            except RuntimeError as error:
                self.fail('initial admit lacked its live Reader session: ' + str(error))
            self.assertEqual(result['status'], 'ACTUAL_BOUNDARY_ACCEPTED')
            self.assertEqual(self.issues, 1)
            self.assertNotIn('private', repr(result))

    def test_late_seal_renews_and_close_waits_for_every_issued_session(self):
        with self.context():
            attempt = self.attempt()
            manager = attempt.reader_session
            with patch.object(manager, '_remove', side_effect=lambda: self.removed(manager)):
                attempt._authority('admit', attempt.request)
                self.advance(1000)
                self.assertEqual(attempt._authority('seal', {})['status'], 'ACTUAL_BOUNDARY_ACCEPTED')
                self.assertEqual(self.issues, 2)
                before = self.mono
                manager.close()
                self.assertIsNone(self.session)
                self.assertGreaterEqual(self.mono - before, 900)
                with self.assertRaisesRegex(RuntimeError, 'READER_SESSION_CLOSED'):
                    attempt._authority('recheck', {})

    def test_concurrent_recheck_and_seal_cannot_replace_a_readers_inode(self):
        with self.context():
            attempt = self.attempt()
            manager = attempt.reader_session
            attempt._authority('admit', attempt.request)
            self.advance(600)
            entered, release, second_started = threading.Event(), threading.Event(), threading.Event()
            failures = []
            def external(argv, **kwargs):
                operation = json.loads(kwargs['input'])['operation']
                if operation == 'recheck':
                    original = self.inode
                    entered.set()
                    if not release.wait(2): raise AssertionError('test synchronization timeout')
                    if self.inode != original: raise AssertionError('inode replaced during read')
                return self.external(argv, **kwargs)
            def call(operation):
                try:
                    if operation == 'seal': second_started.set()
                    attempt._authority(operation, {})
                except BaseException as error:
                    failures.append(error)
            with patch.object(manager, '_remove', side_effect=lambda: self.removed(manager)), \
                 patch.object(self.m.subprocess, 'run', side_effect=external):
                first = threading.Thread(target=call, args=('recheck',))
                second = threading.Thread(target=call, args=('seal',))
                first.start()
                try:
                    self.assertTrue(entered.wait(2))
                    second.start()
                    self.assertTrue(second_started.wait(2))
                    self.assertNotIn('seal', self.calls)
                finally:
                    release.set()
                    first.join(2)
                    if second.ident is not None: second.join(2)
                self.assertFalse(first.is_alive() or second.is_alive())
                self.assertEqual(failures, [])
                self.assertEqual(self.issues, 2)

    def test_unknown_issuance_is_not_retried_and_waits_the_full_ttl(self):
        with self.context():
            attempt = self.attempt()
            self.failure = True
            with self.assertRaises(self.m.subprocess.TimeoutExpired):
                attempt._authority('admit', attempt.request)
            with self.assertRaisesRegex(RuntimeError, 'READER_SESSION_CLOSED'):
                attempt._authority('admit', attempt.request)
            self.assertEqual(self.issues, 1)
            before = self.mono
            attempt.reader_session.close()
            self.assertGreaterEqual(self.mono - before, 900)

    def test_preexisting_or_changed_session_is_never_replaced(self):
        with self.context():
            attempt = self.attempt()
            self.session = {'historical': True}
            with self.assertRaisesRegex(RuntimeError, 'READER_SESSION_PRESENT'):
                attempt._authority('admit', attempt.request)
            self.assertEqual(self.issues, 0)
            with self.assertRaisesRegex(RuntimeError, 'READER_SESSION_UNKNOWN'):
                attempt.reader_session.close()
            self.assertEqual(self.session, {'historical': True})
            self.session = None
            attempt = self.attempt()
            attempt._authority('admit', attempt.request)
            self.inode += 1
            with self.assertRaisesRegex(RuntimeError, 'READER_SESSION_CHANGED'):
                attempt._authority('seal', {})
            self.assertEqual(self.issues, 1)

    def test_already_expired_session_can_close_after_a_late_failure(self):
        with self.context():
            attempt = self.attempt()
            manager = attempt.reader_session
            attempt._authority('admit', attempt.request)
            self.advance(1200)
            with patch.object(manager, '_remove', side_effect=lambda: self.removed(manager)):
                manager.close()
            self.assertIsNone(self.session)

    def test_initial_run_disposes_reader_even_when_attempt_raises(self):
        with self.context():
            attempt = self.attempt()
            with patch.object(attempt, '_run', side_effect=RuntimeError('H1_INITIAL_FAILURE')), \
                 patch.object(attempt.reader_session, 'close') as closed:
                with self.assertRaisesRegex(RuntimeError, 'H1_INITIAL_FAILURE'):
                    attempt.run()
                closed.assert_called_once_with()


if __name__ == '__main__':
    unittest.main()
