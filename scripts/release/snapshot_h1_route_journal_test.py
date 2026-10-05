"""Local POSIX tests for the fixed, private route nonce journal."""
import importlib.util
import os
import stat
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import patch


class RouteJournalTests(unittest.TestCase):
    def setUp(self):
        path = os.path.join(os.path.dirname(__file__), 'snapshot-h1-route-journal.py')
        self.assertTrue(os.path.isfile(path), 'fixed route journal is missing')
        spec = importlib.util.spec_from_file_location('h1_route_journal', path)
        self.module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.module)
        # POSIX I/O and ancestor modes stay real. Only root UID/ownership are
        # substituted to run under the local non-root WSL account.
        self.temp = tempfile.TemporaryDirectory(dir=os.path.expanduser('~'))
        self.addCleanup(self.temp.cleanup)
        self.state = os.path.join(self.temp.name, 'snapshot-root-state')
        os.mkdir(self.state, 0o700)
        self.path_patch = patch.object(self.module, 'STATE_DIR', self.state)
        self.owner_patch = patch.object(self.module, '_require_root_owner', lambda unused: None)
        self.uid_patch = patch.object(self.module.os, 'geteuid', return_value=0)
        self.path_patch.start()
        self.owner_patch.start()
        self.uid_patch.start()
        self.addCleanup(self.path_patch.stop)
        self.addCleanup(self.owner_patch.stop)
        self.addCleanup(self.uid_patch.stop)
        self.nonce = 'a' * 32
        self.digest = 'sha256:' + 'b' * 64

    def test_initialize_is_explicit_then_claim_is_create_once_even_under_race(self):
        with self.assertRaises(self.module.JournalFailure):
            self.module.read_used_route_nonces()
        with self.assertRaises(self.module.JournalFailure):
            self.module.claim(self.nonce, '123', '456', self.digest)
        self.module.initialize()
        self.assertEqual(stat.S_IMODE(os.stat(os.path.join(self.state, 'route-nonces')).st_mode),
                         0o700)
        def attempt(_):
            try:
                self.module.claim(self.nonce, '123', '456', self.digest)
                return 'claimed'
            except self.module.JournalFailure:
                return 'rejected'
        with ThreadPoolExecutor(max_workers=2) as pool:
            self.assertEqual(sorted(pool.map(attempt, range(2))), ['claimed', 'rejected'])
        self.assertEqual(self.module.read_used_route_nonces(), [self.nonce])
        record = os.path.join(self.state, 'route-nonces', self.nonce + '.json')
        self.assertEqual(stat.S_IMODE(os.stat(record).st_mode), 0o600)
        with self.assertRaises(self.module.JournalFailure):
            self.module.claim(self.nonce, '123', '456', self.digest)
        with self.assertRaises(self.module.JournalFailure):
            self.module.initialize()

    def test_corrupt_or_unknown_records_fail_closed_without_reuse(self):
        self.module.initialize()
        self.module.claim(self.nonce, '123', '456', self.digest)
        folder = os.path.join(self.state, 'route-nonces')
        with open(os.path.join(folder, 'unknown'), 'wb') as output:
            output.write(b'{}')
        with self.assertRaises(self.module.JournalFailure):
            self.module.read_used_route_nonces()
        with self.assertRaises(self.module.JournalFailure):
            self.module.claim('c' * 32, '123', '457', self.digest)
        os.unlink(os.path.join(folder, 'unknown'))
        record = os.path.join(folder, self.nonce + '.json')
        with open(record, 'wb') as output:
            output.write(b'{"nonce":"wrong"}')
        with self.assertRaises(self.module.JournalFailure):
            self.module.read_used_route_nonces()
        with self.assertRaises(self.module.JournalFailure):
            self.module.claim(self.nonce, '123', '456', self.digest)
        self.assertFalse(os.path.exists(os.path.join(folder, 'c' * 32 + '.json')))

        with open(record, 'wb') as output:
            output.write(b'{"nonce":"' + self.nonce.encode('ascii') + b'","run_id":"123","job_id":"456","admission_digest":"' + self.digest.encode('ascii') + b'"}')
        with patch.object(self.module, 'MAX_RECORDS', 1):
            with self.assertRaises(self.module.JournalFailure):
                self.module.claim('d' * 32, '123', '457', self.digest)

    def test_validation_rejects_bad_ids_and_symlink_record(self):
        self.module.initialize()
        for bad in ('0', '01', '-1', 123, '1/2'):
            with self.assertRaises(self.module.JournalFailure):
                self.module.claim(self.nonce, bad, '456', self.digest)
        with self.assertRaises(self.module.JournalFailure):
            self.module.claim(self.nonce, '123', '456', 'sha256:' + 'B' * 64)
        folder = os.path.join(self.state, 'route-nonces')
        os.symlink(self.state, os.path.join(folder, self.nonce + '.json'))
        with self.assertRaises(self.module.JournalFailure):
            self.module.read_used_route_nonces()

    def test_initialize_sets_mode_even_with_restrictive_umask(self):
        previous = os.umask(0o777)
        try:
            self.module.initialize()
        finally:
            os.umask(previous)
        folder = os.path.join(self.state, 'route-nonces')
        self.assertEqual(stat.S_IMODE(os.stat(folder).st_mode), 0o700)


if __name__ == '__main__':
    unittest.main()
