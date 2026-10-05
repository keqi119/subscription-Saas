"""HTTP-boundary tests for binding a running data job to its created JIT runner."""
import datetime
import importlib.util
import os
import unittest
from unittest.mock import patch


class RunningJobBindingTests(unittest.TestCase):
    def setUp(self):
        path = os.path.join(os.path.dirname(__file__), 'snapshot-h1-github.py')
        spec = importlib.util.spec_from_file_location('h1_github_job_binding', path)
        self.module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.module)
        self.calls = []
        self.repo = {'id': 1253231368, 'full_name': 'keqi119/subscription-Saas',
                     'owner': {'id': 275060624, 'login': 'keqi119'}}
        self.responses = {}
        self.run_id = '36805384635'
        self.job_id = '901'
        self.source_sha = 'a' * 40
        self.nonce = 'c' * 32
        self.runner_id = 987654321
        self.runner_name = 'stage1-snapshot-' + self.nonce
        self.labels = self.module._jit_labels(self.run_id, self.nonce)
        prefix = '/repos/' + self.module.REPOSITORY
        self.run_route = prefix + '/actions/runs/' + self.run_id + '/attempts/1'
        self.current_run_route = prefix + '/actions/runs/' + self.run_id
        self.jobs_route = prefix + '/actions/runs/' + self.run_id + '/attempts/1/jobs?per_page=100'
        self.runner_route = prefix + '/actions/runners/' + str(self.runner_id)
        self.run = {
            'id': int(self.run_id), 'run_attempt': 1, 'head_sha': self.source_sha,
            'status': 'in_progress', 'repository': self.repo, 'head_repository': self.repo,
            'actor': {'id': self.module.OWNER_ID, 'login': 'keqi119'},
            'head_branch': 'main', 'event': 'workflow_dispatch', 'path': self.module.WORKFLOW
        }
        self.job = {
            'id': int(self.job_id), 'run_id': int(self.run_id), 'head_sha': self.source_sha,
            'name': 'snapshot-data', 'status': 'in_progress', 'conclusion': None,
            'runner_id': self.runner_id, 'runner_name': self.runner_name,
            'runner_group_id': 1, 'labels': list(self.labels)
        }
        self.runner = {
            'id': self.runner_id, 'name': self.runner_name, 'os': 'linux',
            'status': 'online', 'busy': True,
            'labels': [{'name': label} for label in self.labels]
        }
        self.responses[self.run_route] = self.run
        self.responses[self.current_run_route] = self.run
        self.responses[self.jobs_route] = {'total_count': 1, 'jobs': [self.job]}
        self.responses[self.runner_route] = self.runner

    def api(self, method, route, credential, body=None, expected=(200,)):
        self.calls.append((method, route, credential, body, expected))
        if route in self.responses:
            value = self.responses[route]
            if isinstance(value, Exception):
                raise value
            return value
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
            expires = datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(minutes=59)
            return {'token': 'ghs_' + 'synthetic_secret_' * 3,
                    'expires_at': expires.strftime('%Y-%m-%dT%H:%M:%SZ'),
                    'permissions': body['permissions'], 'repository_selection': 'selected'}
        if route == '/installation/repositories?per_page=100':
            return {'total_count': 1, 'repositories': [self.repo]}
        if route == '/installation/token' and method == 'DELETE':
            return None
        raise AssertionError('unexpected route: ' + route)

    def session(self):
        session = self.module.H1SnapshotJitGitHub(lambda: 'signed.synthetic.jwt')
        return session

    def select(self, **updates):
        value = {'runId': self.run_id, 'jobId': self.job_id,
                 'sourceSha': self.source_sha, 'routeNonce': self.nonce}
        value.update(updates)
        return value

    def test_returns_only_actual_bound_run_job_and_runner_facts(self):
        with patch.object(self.module, '_api', self.api):
            with self.session() as github:
                github._created_runner_id = self.runner_id
                github._created_runner_name = self.runner_name
                github._created_runner_labels = self.labels
                actual = github.read_running_job(self.select())
        self.assertEqual(set(actual), {'run', 'job', 'runner'})
        self.assertEqual(actual['run']['id'], self.run_id)
        self.assertEqual(actual['job']['id'], self.job_id)
        self.assertEqual(actual['runner']['id'], self.runner_id)
        routes = [call[1] for call in self.calls]
        self.assertIn(self.run_route, routes)
        self.assertIn(self.current_run_route, routes)
        self.assertIn(self.jobs_route, routes)
        self.assertIn(self.runner_route, routes)
        self.assertEqual(len([call for call in self.calls if call[0:2] ==
                              ('DELETE', '/installation/token')]), 1)

    def test_rejects_other_runner_job_rerun_sha_or_labels(self):
        cases = [
            ('job_runner_id', self.runner_id + 1),
            ('job_runner_name', 'different-runner'),
            ('runner_group_id', 2),
            ('job_name', 'export'),
            ('run_attempt', 2),
            ('job_head_sha', 'b' * 40),
            ('run_head_sha', 'b' * 40),
            ('job_labels', ['self-hosted', 'linux', 'x64', self.module.ENVIRONMENT]),
            ('runner_labels', [{'name': label} for label in self.labels[:-1]]),
            ('actual_runner_id', self.runner_id + 1),
            ('actual_runner_status', 'offline'),
            ('actual_runner_busy', False),
            ('actual_runner_os', 'unknown')
        ]
        for key, value in cases:
            with self.subTest(key=key):
                self.responses[self.run_route] = dict(self.run)
                self.responses[self.current_run_route] = dict(self.run)
                self.responses[self.jobs_route] = {'total_count': 1, 'jobs': [dict(self.job)]}
                self.responses[self.runner_route] = dict(self.runner)
                if key == 'run_attempt':
                    self.responses[self.current_run_route]['run_attempt'] = value
                elif key == 'run_head_sha':
                    self.responses[self.run_route]['head_sha'] = value
                    self.responses[self.current_run_route]['head_sha'] = value
                elif key == 'job_labels':
                    self.responses[self.jobs_route]['jobs'][0]['labels'] = value
                elif key == 'job_head_sha':
                    self.responses[self.jobs_route]['jobs'][0]['head_sha'] = value
                elif key == 'runner_labels':
                    self.responses[self.runner_route]['labels'] = value
                elif key == 'actual_runner_id':
                    self.responses[self.runner_route]['id'] = value
                elif key.startswith('actual_runner_'):
                    self.responses[self.runner_route][key[len('actual_runner_'):]] = value
                elif key.startswith('job_runner_'):
                    self.responses[self.jobs_route]['jobs'][0][key[len('job_'):]] = value
                elif key == 'job_name':
                    self.responses[self.jobs_route]['jobs'][0]['name'] = value
                else:
                    self.responses[self.jobs_route]['jobs'][0][key] = value
                with patch.object(self.module, '_api', self.api):
                    with self.session() as github:
                        github._created_runner_id = self.runner_id
                        github._created_runner_name = self.runner_name
                        github._created_runner_labels = self.labels
                        with self.assertRaises(self.module.GitHubFailure):
                            github.read_running_job(self.select())

    def test_rejects_caller_runner_fields_and_unknown_or_missing_runner_facts(self):
        with patch.object(self.module, '_api', self.api):
            with self.session() as github:
                github._created_runner_id = self.runner_id
                github._created_runner_name = self.runner_name
                github._created_runner_labels = self.labels
                with self.assertRaises(self.module.GitHubFailure):
                    github.read_running_job(self.select(runnerId=str(self.runner_id)))

        for field, value in (('runner_id', None), ('runner_name', None),
                             ('runner_group_id', None), ('labels', [])):
            with self.subTest(field=field):
                self.responses[self.jobs_route] = {'total_count': 1, 'jobs': [dict(self.job)]}
                self.responses[self.jobs_route]['jobs'][0][field] = value
                with patch.object(self.module, '_api', self.api):
                    with self.session() as github:
                        github._created_runner_id = self.runner_id
                        github._created_runner_name = self.runner_name
                        github._created_runner_labels = self.labels
                        with self.assertRaises(self.module.GitHubFailure):
                            github.read_running_job(self.select())


if __name__ == '__main__':
    unittest.main()
