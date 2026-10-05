"""Fixed JIT transport tests; the HTTP boundary supplies synthetic GitHub facts."""
import base64
import datetime
import importlib.util
import os
import unittest
from unittest.mock import patch


class JitTests(unittest.TestCase):
    def setUp(self):
        path = os.path.join(os.path.dirname(__file__), 'snapshot-h1-github.py')
        spec = importlib.util.spec_from_file_location('h1_github_jit', path)
        self.github = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.github)
        self.calls = []
        self.overrides = {}
        self.token = 'ghs_' + 'private_token_' * 3
        self.nonce = 'a' * 32
        self.name = 'stage1-snapshot-' + self.nonce
        self.labels = ['self-hosted', 'linux', 'x64', 'stage1-snapshot-export',
                       'stage1-snapshot-export-123-' + self.nonce]
        self.runner = {'id': 456, 'name': self.name, 'os': 'unknown', 'status': 'offline',
                       'busy': False, 'labels': [{'name': label, 'type': 'custom'}
                                                  for label in self.labels]}
        self.repo = {'id': 1253231368, 'full_name': 'keqi119/subscription-Saas',
                     'owner': {'id': 275060624, 'login': 'keqi119'}}
        self.prefix = '/repos/keqi119/subscription-Saas/actions/runners'
        self.secret = base64.b64encode(b'private jit config').decode('ascii')

    def api(self, method, route, credential, body=None, expected=(200,)):
        self.calls.append((method, route, credential, body, expected))
        key = (method, route)
        if key in self.overrides:
            answer = self.overrides[key]
            if isinstance(answer, Exception):
                raise answer
            return answer
        if route == '/app':
            return {'id': 5196151, 'slug': 'keqi119-stage1-snapshot-jit',
                    'owner': self.repo['owner'], 'permissions': self.github.APP_PERMISSIONS,
                    'events': []}
        if route == '/repos/keqi119/subscription-Saas/installation':
            return {'id': 168113687, 'app_id': 5196151,
                    'app_slug': 'keqi119-stage1-snapshot-jit', 'account': self.repo['owner'],
                    'target_id': 275060624, 'target_type': 'User',
                    'repository_selection': 'selected',
                    'permissions': self.github.APP_PERMISSIONS, 'events': [],
                    'suspended_at': None, 'suspended_by': None}
        if route == '/app/installations/168113687/access_tokens':
            expiry = datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(minutes=59)
            return {'token': self.token, 'expires_at': expiry.strftime('%Y-%m-%dT%H:%M:%SZ'),
                    'permissions': body['permissions'], 'repository_selection': 'selected'}
        if key == ('GET', '/installation/repositories?per_page=100'):
            return {'total_count': 1, 'repositories': [self.repo]}
        if key == ('DELETE', '/installation/token'):
            return None
        if key == ('GET', self.prefix + '?per_page=100'):
            return {'total_count': 0, 'runners': []}
        if key == ('POST', self.prefix + '/generate-jitconfig'):
            return {'runner': self.runner, 'encoded_jit_config': self.secret}
        if key == ('GET', self.prefix + '/456'):
            if any(call[:2] == ('DELETE', self.prefix + '/456') for call in self.calls):
                return None
            return self.runner
        if key == ('DELETE', self.prefix + '/456'):
            return None
        raise AssertionError('unexpected GitHub route: ' + route)

    def jit(self):
        return self.github.H1SnapshotJitGitHub(lambda: 'signed.synthetic.jwt')

    def calls_for(self, method, route):
        return [call for call in self.calls if call[:2] == (method, route)]

    def test_jit_subset_is_distinct_from_unchanged_read_session(self):
        with patch.object(self.github, '_api', self.api):
            with self.github.H1SnapshotGitHub(lambda: 'signed.synthetic.jwt'):
                pass
            with self.jit():
                pass
        requests = self.calls_for('POST', '/app/installations/168113687/access_tokens')
        self.assertEqual(requests[0][3], {'repository_ids': [1253231368], 'permissions': {
            'administration': 'read', 'actions': 'read', 'contents': 'read',
            'deployments': 'read', 'metadata': 'read'}})
        self.assertEqual(requests[1][3], {'repository_ids': [1253231368], 'permissions': {
            'administration': 'write', 'actions': 'read', 'metadata': 'read'}})
        self.assertEqual(len(self.calls_for('DELETE', '/installation/token')), 2)

    def test_create_uses_exact_route_and_verified_readback(self):
        with patch.object(self.github, '_api', self.api):
            with self.jit() as session:
                created = session.create_jit('123', self.nonce)
                self.assertEqual(created, {'runner': self.runner,
                                           'encoded_jit_config': self.secret})
                self.assertNotIn(self.secret, repr(session))
        self.assertEqual(self.calls_for('POST', self.prefix + '/generate-jitconfig')[0][3], {
            'name': self.name, 'runner_group_id': 1, 'labels': self.labels,
            'work_folder': '_work'})
        self.assertEqual(len(self.calls_for('GET', self.prefix + '?per_page=100')), 1)
        self.assertEqual(len(self.calls_for('GET', self.prefix + '/456')), 1)
        self.assertEqual(len(self.calls_for('DELETE', '/installation/token')), 1)

    def test_duplicate_and_invalid_response_fail_closed_and_revoke(self):
        cases = [
            (('GET', self.prefix + '?per_page=100'),
             {'total_count': 1, 'runners': [self.runner]}, 0),
            (('POST', self.prefix + '/generate-jitconfig'),
             {'runner': dict(self.runner, name='foreign-runner'),
              'encoded_jit_config': self.secret}, 1),
            (('POST', self.prefix + '/generate-jitconfig'),
             {'runner': self.runner, 'encoded_jit_config': 'private_invalid!'}, 1),
        ]
        for key, answer, post_count in cases:
            with self.subTest(key=key, answer=answer):
                self.calls.clear()
                self.overrides = {key: answer}
                with patch.object(self.github, '_api', self.api):
                    with self.assertRaises(self.github.GitHubFailure) as failure:
                        with self.jit() as session:
                            session.create_jit('123', self.nonce)
                self.assertNotIn('private_invalid!', str(failure.exception))
                self.assertEqual(len(self.calls_for('POST', self.prefix + '/generate-jitconfig')),
                                 post_count)
                self.assertEqual(len(self.calls_for('DELETE', '/installation/token')), 1)

    def test_unknown_post_is_never_retried_even_on_same_session(self):
        self.overrides[('POST', self.prefix + '/generate-jitconfig')] = \
            self.github.GitHubFailure('H1_GITHUB_REQUEST_FAILED')
        with patch.object(self.github, '_api', self.api):
            with self.jit() as session:
                with self.assertRaisesRegex(self.github.GitHubFailure, 'UNKNOWN'):
                    session.create_jit('123', self.nonce)
                with self.assertRaises(self.github.GitHubFailure):
                    session.create_jit('123', self.nonce)
                with self.assertRaises(self.github.GitHubFailure):
                    session.remove_created_runner()
        self.assertEqual(len(self.calls_for('POST', self.prefix + '/generate-jitconfig')), 1)
        self.assertEqual(len(self.calls_for('DELETE', self.prefix + '/456')), 0)

    def test_remove_uses_saved_identity_then_requires_404(self):
        with patch.object(self.github, '_api', self.api):
            with self.jit() as session:
                session.create_jit('123', self.nonce)
                self.overrides[('DELETE', self.prefix + '/456')] = None
                self.assertTrue(session.remove_created_runner())
        self.assertEqual(len(self.calls_for('DELETE', self.prefix + '/456')), 1)
        self.assertEqual(len(self.calls_for('GET', self.prefix + '/456')), 3)

    def test_remove_refuses_foreign_runner_and_secret_errors_do_not_leak(self):
        with patch.object(self.github, '_api', self.api):
            with self.jit() as session:
                session.create_jit('123', self.nonce)
                self.overrides[('GET', self.prefix + '/456')] = dict(self.runner, name='foreign')
                with self.assertRaises(self.github.GitHubFailure) as failure:
                    session.remove_created_runner()
                self.assertNotIn(self.secret, str(failure.exception))
        self.assertEqual(len(self.calls_for('DELETE', self.prefix + '/456')), 0)


if __name__ == '__main__':
    unittest.main()
