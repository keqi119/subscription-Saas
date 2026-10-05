"""Failure boundaries for the owned, fixed H1 attempt volume lifecycle."""
import importlib.util
import os
import types
import unittest
from unittest.mock import patch


class VolumeTests(unittest.TestCase):
    def setUp(self):
        path = os.path.join(os.path.dirname(__file__), 'snapshot-h1-volume.py')
        spec = importlib.util.spec_from_file_location('h1_volume', path)
        self.module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.module)
        self.volume = self.module.H1SnapshotAttemptVolume('11111111-2222-4333-8444-555555555555')

    def test_untrusted_attempt_cannot_select_an_existing_disk(self):
        for value in ('../../main', '/dev/sda', '11111111-2222-3333-8444-555555555555', None):
            with self.assertRaises(self.module.VolumeFailure):
                self.module.H1SnapshotAttemptVolume(value)

    def test_unknown_keyslot_output_never_counts_as_erased(self):
        valid = 'Version:       2\nKeyslots:\nTokens:\nDigests:\n'
        with patch.object(self.module, '_run', return_value=types.SimpleNamespace(stdout=valid.encode())):
            self.assertEqual(self.volume._keyslots(), [])
        for body in ('Version: 1\nKeyslots:\nTokens:\n',
                     'Version: 2\nKeyslots:\n  0: future-slot\nTokens:\n',
                     'Version: 2\nKeyslots:\n  0: luks2\n  1: future-slot\nTokens:\n'):
            with patch.object(self.module, '_run', return_value=types.SimpleNamespace(stdout=body.encode())):
                with self.assertRaises(self.module.VolumeFailure):
                    self.volume._keyslots()

    def test_replaced_backing_cannot_be_erased(self):
        self.volume._owned = (1, 2)
        wrong = types.SimpleNamespace(st_dev=1, st_ino=3, st_mode=0o100600, st_nlink=1, st_uid=0, st_gid=0)
        with patch.object(self.module.os, 'lstat', return_value=wrong), \
             patch.object(self.module, '_run') as command:
            with self.assertRaises(self.module.VolumeFailure):
                self.volume._destroy()
            command.assert_not_called()

    def test_busy_volume_preserves_protections_and_key_for_cleanup(self):
        self.volume._started = True
        self.volume._key = bytearray(b'k' * 64)
        with patch.object(self.volume, '_destroy', side_effect=self.module.VolumeFailure('BUSY')), \
             patch.object(self.volume, '_restore') as restore, \
             patch.object(self.volume, '_release_lock') as unlock:
            with self.assertRaises(self.module.VolumeFailure):
                self.volume.cleanup()
            restore.assert_not_called()
            unlock.assert_not_called()
            self.assertEqual(self.volume._key, bytearray(b'k' * 64))
            self.assertFalse(self.volume.observation.get('destroyed', False))

    def test_destroy_checks_old_key_and_loop_absence_before_unlink(self):
        self.volume._owned = (1, 2)
        self.volume._key = bytearray(b'k' * 64)
        events = []

        def command(argv, data=None, allowed=(0,)):
            events.append(argv)
            if argv[1] == 'isLuks':
                return types.SimpleNamespace(returncode=0, stdout=b'', stderr=b'')
            if '--test-passphrase' in argv:
                self.assertEqual(data, b'k' * 64)
                self.assertNotIn('k' * 64, ' '.join(argv))
                return types.SimpleNamespace(returncode=1, stdout=b'',
                    stderr=b'Keyslot open failed.\nNo usable keyslot is available.\n')
            return types.SimpleNamespace(returncode=0, stdout=b'', stderr=b'')

        with patch.object(self.volume, '_same_backing'), \
             patch.object(self.volume, '_keyslots', return_value=[]), \
             patch.object(self.module.os.path, 'ismount', return_value=False), \
             patch.object(self.module.os.path, 'lexists', return_value=False), \
             patch.object(self.module, '_run', side_effect=command), \
             patch.object(self.module.os, 'unlink', side_effect=lambda path: events.append(['unlink', path])):
            self.volume._destroy()
        self.assertEqual([x[1] for x in events[:-1]], ['isLuks', 'luksErase', 'open', '-j'])
        self.assertEqual(events[-1], ['unlink', self.volume.backing])
        self.assertTrue(self.volume.observation['oldKeyRejected'])

    def test_failed_mount_directory_removal_keeps_backing_owned_for_retry(self):
        self.volume._owned = (1, 2)
        self.volume._mount_owned = (1, 3)
        info = types.SimpleNamespace(st_dev=1, st_ino=3, st_mode=0o40700)
        empty = types.SimpleNamespace(returncode=1, stdout=b'', stderr=b'')
        with patch.object(self.volume, '_same_backing'), \
             patch.object(self.module.os.path, 'ismount', return_value=False), \
             patch.object(self.module.os.path, 'lexists', return_value=False), \
             patch.object(self.module.os, 'lstat', return_value=info), \
             patch.object(self.module, '_run', return_value=empty), \
             patch.object(self.module.os, 'rmdir', side_effect=OSError('busy')), \
             patch.object(self.module.os, 'unlink') as remove:
            with self.assertRaises(OSError):
                self.volume._destroy()
            remove.assert_not_called()
            self.assertEqual(self.volume._owned, (1, 2))

    def test_cleanup_zeroes_key_before_restoring_swap_and_is_idempotent(self):
        self.volume._started = True
        key = self.volume._key = bytearray(b'k' * 64)
        events = []

        def restore():
            self.assertEqual(key, bytearray(64))
            events.append('restore')

        with patch.object(self.volume, '_destroy', side_effect=lambda: events.append('destroy')), \
             patch.object(self.volume, '_restore', side_effect=restore), \
             patch.object(self.volume, '_release_lock', side_effect=lambda: events.append('unlock')):
            self.assertTrue(self.volume.cleanup())
            self.assertTrue(self.volume.cleanup())
        self.assertEqual(events, ['destroy', 'restore', 'unlock'])


if __name__ == '__main__':
    unittest.main()
