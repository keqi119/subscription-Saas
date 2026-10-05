"""Bounded tests for the root-only H1 channel, not production admission evidence."""
import importlib.util
import json
import os
import subprocess
import threading
import unittest

REFERENCE = 'sha256:' + 'a' * 64


class Operations:
    def __init__(self):
        self.events = []
        self.authorized = True
        self.control = None

    def verify_admission(self):
        self.events.append('verify')
        return self.authorized

    def prepare_job(self):
        self.events.append('prepare')
        return True

    def verify_job_peer(self, peer):
        self.events.append('peer')
        return peer == (123, 65533, 65533)

    def produce(self):
        self.events.append('produce')
        return True

    def run_job(self):
        self.events.append('run')
        response = self.control.handle('job', (123, 65533, 65533),
                                       {'command': 'produce', 'admissionRef': REFERENCE})
        return response['status'] == 'SUCCEEDED'

    def cleanup_job(self):
        self.events.append('cleanup')
        return True


class ControlTests(unittest.TestCase):
    def setUp(self):
        filename = os.path.join(os.path.dirname(__file__), 'snapshot-h1-control.py')
        self.assertTrue(os.path.isfile(filename), 'root H1 control implementation is missing')
        spec = importlib.util.spec_from_file_location('h1_control', filename)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        self.module = module
        self.ops = Operations()
        self.control = module.H1SnapshotControl(REFERENCE, '/attempt/runner', self.ops)
        self.ops.control = self.control

    def management(self, command, **extra):
        packet = {'command': command, 'admissionRef': REFERENCE}
        packet.update(extra)
        return self.control.handle('management', (42, 992, 988), packet)

    def test_once_only_production_requires_peer_and_fresh_admission(self):
        self.assertEqual(self.management('prepare_job')['status'], 'PREPARED')
        self.assertEqual(self.management('run_script_step')['status'], 'SUCCEEDED')
        self.assertEqual(self.ops.events,
                         ['verify', 'prepare', 'verify', 'run', 'peer', 'verify', 'produce'])
        self.assertEqual(self.management('run_script_step')['status'], 'FAILED')
        self.assertEqual(self.control.handle('job', (123, 65533, 65533),
                         {'command': 'produce', 'admissionRef': REFERENCE})['status'], 'FAILED')
        self.assertEqual(self.ops.events.count('produce'), 1)
        self.assertEqual(self.management('cleanup_job')['status'], 'CLEANED')
        self.assertEqual(self.management('cleanup_job')['status'], 'FAILED')
        self.assertEqual(self.ops.events.count('cleanup'), 1)

    def test_wrong_identity_reference_and_extra_commands_cannot_reach_operations(self):
        requests = [
            ('management', (42, 0, 0), {'command': 'prepare_job', 'admissionRef': REFERENCE}),
            ('job', (42, 992, 988), {'command': 'produce', 'admissionRef': REFERENCE}),
            ('management', (42, 992, 988), {'command': 'prepare_job', 'admissionRef': 'secret'}),
            ('management', (42, 992, 988), {'command': 'run_container_step', 'admissionRef': REFERENCE}),
            ('management', (42, 992, 988), {'command': 'prepare_job', 'admissionRef': REFERENCE,
                                         'sql': 'SECRET_SQL'})]
        for kind, peer, request in requests:
            self.assertEqual(self.control.handle(kind, peer, request),
                             {'status': 'FAILED', 'code': 'H1_CONTROL_REJECTED'})
        self.assertEqual(self.ops.events, [])
        self.assertEqual(self.control.phase, 'NEW')

    def test_revocation_or_failed_cleanup_never_claims_success(self):
        self.ops.authorized = False
        self.assertEqual(self.management('prepare_job')['status'], 'FAILED')
        self.assertEqual(self.ops.events, ['verify'])
        self.assertEqual(self.control.phase, 'FAILED')
        self.ops.cleanup_job = lambda: False
        self.assertEqual(self.management('cleanup_job')['status'], 'FAILED')
        self.assertNotEqual(self.control.phase, 'CLEANED')

    def test_cancellation_drains_active_producer_without_reporting_run_success(self):
        entered, released = threading.Event(), threading.Event()
        results = []

        def produce():
            entered.set()
            return released.wait(2)

        def cleanup():
            released.set()
            return True

        self.ops.produce, self.ops.cleanup_job = produce, cleanup
        self.assertEqual(self.management('prepare_job')['status'], 'PREPARED')
        runner = threading.Thread(target=lambda: results.append(self.management('run_script_step')))
        runner.start()
        self.assertTrue(entered.wait(1))
        self.assertEqual(self.management('cleanup_job')['status'], 'CLEANED')
        runner.join(2)
        self.assertFalse(runner.is_alive())
        self.assertEqual(results, [{'status': 'FAILED', 'code': 'H1_CONTROL_REJECTED'}])
        self.assertFalse(self.control.producer_done)
        self.assertEqual(self.control.active_operations, 0)

    def test_failed_create_cannot_claim_or_delete_a_foreign_matching_container(self):
        job = object.__new__(self.module.H1FixedJobContainer)
        job.creation_attempted, job.container_id = True, None
        job.name, job.reference = 'stage1-snapshot-job-collision', REFERENCE
        job._cleanup_producer = lambda: True
        foreign = {'present': True}
        record = {'Id': 'f' * 64, 'Name': '/' + job.name, 'Config': {
            'Image': self.module.IMAGE, 'User': '65533:65533',
            'Labels': {'stage1.admission': REFERENCE}}}

        def docker(args, timeout=30):
            if args[0] == 'rm':
                foreign['present'] = False
                return subprocess.CompletedProcess(args, 0, b'', b'')
            if foreign['present']:
                return subprocess.CompletedProcess(args, 0, json.dumps([record]).encode(), b'')
            return subprocess.CompletedProcess(args, 1, b'', b'No such container')

        job._docker = docker
        cleaned = job.cleanup_job()
        self.assertTrue(foreign['present'], 'failed create must not adopt a container by name')
        self.assertFalse(cleaned, 'missing create identity is UNKNOWN, not confirmed cleanup')


if __name__ == '__main__':
    unittest.main()
