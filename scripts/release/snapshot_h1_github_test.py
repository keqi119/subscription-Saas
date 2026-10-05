"""Bounded HTTP-boundary tests; synthetic API facts are not admission evidence."""
import base64
import datetime
import hashlib
import importlib.util
import os
import unittest
from unittest.mock import patch


class GitHubTests(unittest.TestCase):
    def setUp(self):
        path = os.path.join(os.path.dirname(__file__), 'snapshot-h1-github.py')
        self.assertTrue(os.path.isfile(path), 'fixed H1 GitHub transport is missing')
        spec = importlib.util.spec_from_file_location('h1_github', path)
        self.module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.module)
        self.calls = []
        self.repo = {'id': 1253231368, 'full_name': 'keqi119/subscription-Saas',
                     'owner': {'id': 275060624, 'login': 'keqi119'}}
        self.responses = {}
        self.token = 'ghs_' + 'synthetic_secret_' * 3

    def api(self, method, route, credential, body=None, expected=(200,)):
        self.calls.append((method, route, credential, body, expected))
        if route in self.responses:
            result = self.responses[route]
            if isinstance(result, Exception):
                raise result
            return result
        if route == '/app':
            return {'id': 5196151, 'slug': 'keqi119-stage1-snapshot-jit',
                    'owner': self.repo['owner'], 'permissions': self.module.APP_PERMISSIONS,
                    'events': []}
        if route.endswith('/installation'):
            return {'id': 168113687, 'app_id': 5196151,
                    'app_slug': 'keqi119-stage1-snapshot-jit', 'account': self.repo['owner'],
                    'target_id': 275060624, 'target_type': 'User',
                    'repository_selection': 'selected',
                    'permissions': self.module.APP_PERMISSIONS, 'events': [],
                    'suspended_at': None, 'suspended_by': None}
        if route.endswith('/access_tokens'):
            expiry = datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(minutes=59)
            return {'token': self.token, 'expires_at': expiry.strftime('%Y-%m-%dT%H:%M:%SZ'),
                    'permissions': self.module.READ_PERMISSIONS, 'repository_selection': 'selected'}
        if route == '/installation/repositories?per_page=100':
            return {'total_count': 1, 'repositories': [self.repo]}
        if route == '/installation/token' and method == 'DELETE':
            return None
        raise AssertionError('unexpected route: ' + route)

    def session(self):
        return self.module.H1SnapshotGitHub(lambda: 'signed.synthetic.jwt')

    def revocations(self):
        return [call for call in self.calls if call[0:2] == ('DELETE', '/installation/token')]

    def test_exact_repository_read_scope_and_final_revocation(self):
        with patch.object(self.module, '_api', self.api):
            with self.session() as github:
                self.assertEqual(github.repository(), self.repo)
                token_calls = [call for call in self.calls if call[1].endswith('/access_tokens')]
                self.assertEqual(token_calls[0][3], {
                    'repository_ids': [1253231368], 'permissions': self.module.READ_PERMISSIONS})
                self.assertEqual(token_calls[0][3]['permissions']['administration'], 'read')
            self.assertEqual(len(self.revocations()), 1)
            with self.assertRaisesRegex(self.module.GitHubFailure, '^H1_GITHUB_SESSION_CLOSED$'):
                github.read_run('36805384635')
        self.assertNotIn(self.token, repr(github))

    def test_partial_entry_failure_still_revokes_token(self):
        self.responses['/installation/repositories?per_page=100'] = {
            'total_count': 2, 'repositories': [self.repo, self.repo]}
        with patch.object(self.module, '_api', self.api):
            with self.assertRaisesRegex(self.module.GitHubFailure, '^H1_GITHUB_REPOSITORY_MISMATCH$'):
                with self.session():
                    self.fail('unexpected admission')
        self.assertEqual(len(self.revocations()), 1)

    def test_stateless_installation_token_is_opaque_and_revoked_on_invalid_metadata(self):
        self.token = 'ghs_5196151_' + ('a' * 600) + '.' + ('b' * 700) + '.c-d_e'
        with patch.object(self.module, '_api', self.api):
            with self.session():
                pass
        self.assertEqual(self.revocations()[0][2], self.token)
        self.calls.clear()
        route = '/app/installations/168113687/access_tokens'
        self.responses[route] = {'token': self.token, 'permissions': {'administration': 'write'}}
        with patch.object(self.module, '_api', self.api):
            with self.assertRaisesRegex(self.module.GitHubFailure, '^H1_GITHUB_TOKEN_SCOPE_MISMATCH$'):
                with self.session():
                    self.fail('invalid token metadata was accepted')
        self.assertEqual(self.revocations()[0][2], self.token)

    def test_workflow_is_fetched_at_exact_commit_without_following_download_url(self):
        sha = 'a' * 40
        path = '.github/workflows/sanitized-snapshot.yml'
        data = b'name: snapshot\n'
        blob = hashlib.sha1(b'blob ' + str(len(data)).encode('ascii') + b'\0' + data).hexdigest()
        route = '/repos/keqi119/subscription-Saas/contents/' + path + '?ref=' + sha
        self.responses[route] = {'type': 'file', 'path': path, 'encoding': 'base64',
                                 'size': len(data), 'sha': blob,
                                 'content': base64.b64encode(data).decode('ascii'),
                                 'download_url': 'https://invalid.example/secret'}
        with patch.object(self.module, '_api', self.api):
            with self.session() as github:
                self.assertEqual(github.read_workflow(sha), data)
                for invalid in ('main', '../secret', 'A' * 40):
                    with self.assertRaisesRegex(self.module.GitHubFailure, '^H1_GITHUB_INPUT_INVALID$'):
                        github.read_workflow(invalid)
                self.responses[route]['sha'] = 'b' * 40
                with self.assertRaisesRegex(self.module.GitHubFailure, '^H1_GITHUB_WORKFLOW_INVALID$'):
                    github.read_workflow(sha)
        self.assertFalse(any('invalid.example' in call[1] for call in self.calls))

    def test_bad_ids_and_truncated_job_lists_fail_without_inventing_facts(self):
        jobs = '/repos/keqi119/subscription-Saas/actions/runs/123/attempts/1/jobs?per_page=100'
        self.responses[jobs] = {'total_count': 101, 'jobs': []}
        with patch.object(self.module, '_api', self.api):
            with self.session() as github:
                before = len(self.calls)
                for bad in ('1/../../app', '0', '01', 123, True, '1?x=2'):
                    with self.assertRaisesRegex(self.module.GitHubFailure, '^H1_GITHUB_INPUT_INVALID$'):
                        github.read_jobs(bad)
                self.assertEqual(len(self.calls), before)
                with self.assertRaisesRegex(self.module.GitHubFailure, '^H1_GITHUB_LIST_INCOMPLETE$'):
                    github.read_jobs('123')
                self.responses[jobs] = {'total_count': 1, 'jobs': [{'id': 999, 'run_id': 123}]}
                self.assertEqual(github.read_jobs('123'), [{'id': 999, 'run_id': 123}])

    def test_job_deployment_uses_the_actual_check_run_link_and_graphql_identity(self):
        sha = 'a' * 40
        prefix = '/repos/keqi119/subscription-Saas'
        self.responses[prefix + '/actions/runs/123/attempts/1'] = {
            'id': 123, 'run_attempt': 1, 'head_sha': sha,
            'repository': self.repo, 'head_repository': self.repo}
        job = {'id': 999, 'run_id': 123, 'head_sha': sha, 'name': 'snapshot-data',
               'check_run_url': 'https://api.github.com' + prefix + '/check-runs/456'}
        self.responses[prefix + '/actions/runs/123/attempts/1/jobs?per_page=100'] = {
            'total_count': 1, 'jobs': [job]}
        self.responses[prefix + '/check-runs/456'] = {
            'id': 456, 'node_id': 'CR_fixed_node', 'head_sha': sha, 'name': 'snapshot-data'}
        node = {'id': 'CR_fixed_node', 'databaseId': 456, 'name': 'snapshot-data',
                'repository': {'databaseId': 1253231368, 'nameWithOwner': 'keqi119/subscription-Saas'},
                'checkSuite': {'commit': {'oid': sha}, 'workflowRun': {'databaseId': 123}},
                'deployment': {'databaseId': 789, 'environment': 'stage1-snapshot-export'},
                'pendingDeploymentRequest': None}
        self.responses['/graphql'] = {'data': {'node': node}}
        with patch.object(self.module, '_api', self.api):
            with self.session() as github:
                result = github.read_job_deployment('123', '999')
                self.assertEqual(result['checkRun']['deployment']['databaseId'], 789)
                graph_call = [call for call in self.calls if call[1] == '/graphql'][0]
                self.assertEqual(graph_call[3]['variables'], {'id': 'CR_fixed_node'})
                node['checkSuite']['workflowRun']['databaseId'] = 124
                with self.assertRaisesRegex(self.module.GitHubFailure, '^H1_GITHUB_DEPLOYMENT_BINDING_INVALID$'):
                    github.read_job_deployment('123', '999')
                job['check_run_url'] = 'https://invalid.example/check-runs/456'
                before = len(self.calls)
                with self.assertRaisesRegex(self.module.GitHubFailure, '^H1_GITHUB_DEPLOYMENT_BINDING_INVALID$'):
                    github.read_job_deployment('123', '999')
                self.assertEqual(len(self.calls) - before, 2)  # run and jobs only; no foreign request

    def test_failed_revocation_never_reports_success_or_leaks_response(self):
        self.responses['/installation/token'] = self.module.GitHubFailure('H1_GITHUB_HTTP_500')
        github = self.session()
        with patch.object(self.module, '_api', self.api):
            with self.assertRaisesRegex(self.module.GitHubFailure, '^H1_GITHUB_TOKEN_REVOCATION_FAILED$'):
                with github:
                    pass
            self.assertEqual(len(self.revocations()), 2)
            with self.assertRaisesRegex(self.module.GitHubFailure, '^H1_GITHUB_SESSION_CLOSED$'):
                github.read_run('36805384635')
            del self.responses['/installation/token']
            github.close()
            self.assertEqual(len(self.revocations()), 3)
        self.assertNotIn(self.token, repr(github))

    def test_transport_rejects_redirect_and_bounds_error_without_body(self):
        import urllib.error
        import io
        class Opener:
            def open(self, request, timeout):
                raise urllib.error.HTTPError(request.full_url, 403, 'sensitive-response', {},
                                             io.BytesIO(b'synthetic_secret_response'))
        with patch.object(self.module.urllib.request, 'build_opener', return_value=Opener()):
            with self.assertRaisesRegex(self.module.GitHubFailure, '^H1_GITHUB_HTTP_403$'):
                self.module._api('GET', '/app', self.token)
        with self.assertRaisesRegex(self.module.GitHubFailure, '^H1_GITHUB_REDIRECT_REJECTED$'):
            self.module.NoRedirect().redirect_request(None, None, 302, '', {}, 'https://invalid.example')


if __name__ == '__main__':
    unittest.main()
