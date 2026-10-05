"""Bounded HTTP-boundary tests; synthetic API facts are not admission evidence."""
import base64
import datetime
import hashlib
import importlib.util
import io
import os
import stat
import unittest
import urllib.error
import zipfile
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

    def terminal_fixture(self):
        sha = 'a' * 40
        selection = {'repository': {'id': '1253231368', 'name': 'keqi119/subscription-Saas'},
                     'runId': '123', 'runAttempt': 1, 'sourceSha': sha,
                     'admissionJobId': '700', 'jobId': '701', 'custodyJobId': '702'}
        run = {'id': 123, 'run_attempt': 1, 'head_sha': sha, 'repository': self.repo,
               'head_repository': self.repo, 'actor': self.repo['owner'],
               'head_branch': 'main', 'event': 'workflow_dispatch',
               'path': '.github/workflows/sanitized-snapshot.yml',
               'status': 'completed', 'conclusion': 'success',
               'created_at': '2026-10-01T00:00:00Z', 'updated_at': '2026-10-01T00:04:00Z'}
        def job(id, name, start, end, labels, runner):
            return {'id': id, 'run_id': 123, 'run_attempt': 1, 'head_sha': sha,
                    'name': name, 'status': 'completed', 'conclusion': 'success',
                    'started_at': start, 'completed_at': end, 'labels': labels,
                    'runner_id': id + 1000, 'runner_name': runner,
                    'runner_group_id': 1 if name == 'snapshot-data' else None}
        nonce = 'b' * 32
        jobs = [job(700, 'admission', '2026-10-01T00:00:10Z', '2026-10-01T00:01:00Z',
                    ['ubuntu-latest'], 'GitHub Actions 1'),
                job(701, 'snapshot-data', '2026-10-01T00:01:10Z', '2026-10-01T00:02:00Z',
                    ['STAGE1-SNAPSHOT-EXPORT-123-' + nonce, 'x64', 'SELF-HOSTED',
                     'stage1-snapshot-export', 'Linux'], 'stage1-snapshot-' + nonce),
                job(702, 'snapshot-custody', '2026-10-01T00:02:10Z', '2026-10-01T00:03:00Z',
                    ['ubuntu-latest'], 'GitHub Actions 2')]
        base = '/repos/keqi119/subscription-Saas/actions/runs/123'
        self.responses[base + '/attempts/1'] = run
        self.responses[base + '/attempts/1/jobs?per_page=100'] = {'total_count': 3, 'jobs': jobs}
        self.responses[base] = dict(run)
        return selection, run, jobs

    def test_terminal_inputs_retains_three_actual_completed_jobs(self):
        selection, run, jobs = self.terminal_fixture()
        with patch.object(self.module, '_api', self.api):
            with self.session() as github:
                value = github.read_terminal_inputs(selection)
        self.assertEqual(value['selection'], selection)
        self.assertEqual(value['run'], run)
        self.assertEqual(value['jobs'], jobs)
        self.assertIn('observedAt', value)
        self.assertEqual(len(self.revocations()), 1)

    def test_terminal_inputs_rejects_wrong_or_failed_job(self):
        selection, _, jobs = self.terminal_fixture()
        route = '/repos/keqi119/subscription-Saas/actions/runs/123/attempts/1/jobs?per_page=100'
        for changed in ({'id': 999}, {'conclusion': 'failure'}, {'run_id': 456}):
            bad = [dict(item) for item in jobs]
            bad[2].update(changed)
            self.responses[route] = {'total_count': 3, 'jobs': bad}
            with patch.object(self.module, '_api', self.api):
                with self.session() as github:
                    with self.assertRaises(self.module.GitHubFailure):
                        github.read_terminal_inputs(selection)

    def test_terminal_inputs_rejects_run_change_between_reads(self):
        selection, _, _ = self.terminal_fixture()
        route = '/repos/keqi119/subscription-Saas/actions/runs/123'
        self.responses[route]['run_attempt'] = 2
        with patch.object(self.module, '_api', self.api):
            with self.session() as github:
                with self.assertRaises(self.module.GitHubFailure):
                    github.read_terminal_inputs(selection)

    def active_fixture(self):
        prefix = '/repos/keqi119/subscription-Saas/actions/runs'
        statuses = ('in_progress', 'queued', 'requested', 'waiting', 'pending')
        for status in statuses:
            self.responses[prefix + '?status=' + status + '&per_page=100'] = {
                'total_count': 0, 'workflow_runs': []}
        other_workflow = {'id': 123, 'run_attempt': 1, 'head_sha': 'a' * 40,
                          'status': 'in_progress', 'repository': self.repo,
                          'head_repository': self.repo, 'name': 'other-workflow'}
        fork_rerun = {'id': 456, 'run_attempt': 3, 'head_sha': 'b' * 40,
                      'status': 'waiting', 'repository': self.repo,
                      'head_repository': {'id': 999, 'full_name': 'fork/project'},
                      'name': 'fork-rerun'}
        self.responses[prefix + '?status=in_progress&per_page=100'] = {
            'total_count': 1, 'workflow_runs': [other_workflow]}
        self.responses[prefix + '?status=waiting&per_page=100'] = {
            'total_count': 1, 'workflow_runs': [fork_rerun]}
        jobs = {
            prefix + '/123/attempts/1/jobs?per_page=100':
                {'total_count': 1, 'jobs': [{'id': 700, 'run_id': 123, 'head_sha': 'a' * 40}]},
            prefix + '/456/attempts/3/jobs?per_page=100':
                {'total_count': 1, 'jobs': [{'id': 701, 'run_id': 456, 'head_sha': 'b' * 40}]}}
        self.responses.update(jobs)
        return prefix, statuses, other_workflow, fork_rerun

    def test_active_jobs_scans_all_five_statuses_and_actual_rerun_attempt(self):
        prefix, statuses, other_workflow, fork_rerun = self.active_fixture()
        with patch.object(self.module, '_api', self.api):
            with self.session() as github:
                observed = github.read_active_jobs()
        self.assertEqual([item['run'] for item in observed], [other_workflow, fork_rerun])
        self.assertEqual([item['jobs'][0]['id'] for item in observed], [700, 701])
        routes = [call[1] for call in self.calls]
        for status in statuses:
            self.assertIn(prefix + '?status=' + status + '&per_page=100', routes)
        self.assertIn(prefix + '/456/attempts/3/jobs?per_page=100', routes)
        self.assertEqual(len(self.revocations()), 1)

    def test_active_jobs_rejects_conflicting_duplicate_and_truncated_list(self):
        prefix, _, run, _ = self.active_fixture()
        duplicate = dict(run, status='queued')
        self.responses[prefix + '?status=queued&per_page=100'] = {
            'total_count': 1, 'workflow_runs': [duplicate]}
        with patch.object(self.module, '_api', self.api):
            with self.session() as github:
                with self.assertRaisesRegex(self.module.GitHubFailure,
                                            '^H1_GITHUB_ACTIVE_RUN_INVALID$'):
                    github.read_active_jobs()
        self.responses[prefix + '?status=queued&per_page=100'] = {
            'total_count': 2, 'workflow_runs': [run]}
        with patch.object(self.module, '_api', self.api):
            with self.session() as github:
                with self.assertRaisesRegex(self.module.GitHubFailure,
                                            '^H1_GITHUB_LIST_INCOMPLETE$'):
                    github.read_active_jobs()

    def test_active_jobs_rejects_duplicate_job_and_cross_run_binding(self):
        prefix, _, _, _ = self.active_fixture()
        route = prefix + '/456/attempts/3/jobs?per_page=100'
        original = self.responses[route]
        for bad_job in ({'id': 700, 'run_id': 456, 'head_sha': 'b' * 40},
                        {'id': 702, 'run_id': 123, 'head_sha': 'b' * 40}):
            self.responses[route] = {'total_count': 1, 'jobs': [bad_job]}
            with patch.object(self.module, '_api', self.api):
                with self.session() as github:
                    with self.assertRaisesRegex(self.module.GitHubFailure,
                                                '^H1_GITHUB_ACTIVE_JOB_INVALID$'):
                        github.read_active_jobs()
        self.responses[route] = original

    def test_active_jobs_rejects_invalid_ids_and_global_job_limit(self):
        prefix, _, run, _ = self.active_fixture()
        run['id'] = True
        with patch.object(self.module, '_api', self.api):
            with self.session() as github:
                with self.assertRaisesRegex(self.module.GitHubFailure,
                                            '^H1_GITHUB_ACTIVE_RUN_INVALID$'):
                    github.read_active_jobs()
        run['id'] = 123
        first = prefix + '/123/attempts/1/jobs?per_page=100'
        self.responses[first] = {'total_count': 100, 'jobs': [
            {'id': 1000 + number, 'run_id': 123, 'head_sha': 'a' * 40}
            for number in range(100)]}
        with patch.object(self.module, '_api', self.api):
            with self.session() as github:
                with self.assertRaisesRegex(self.module.GitHubFailure,
                                            '^H1_GITHUB_ACTIVE_JOB_LIMIT$'):
                    github.read_active_jobs()

    def test_active_jobs_merges_identical_run_seen_in_two_status_queries(self):
        prefix, _, run, _ = self.active_fixture()
        self.responses[prefix + '?status=queued&per_page=100'] = {
            'total_count': 1, 'workflow_runs': [dict(run)]}
        with patch.object(self.module, '_api', self.api):
            with self.session() as github:
                observed = github.read_active_jobs()
        self.assertEqual(len(observed), 2)
        self.assertEqual(len([call for call in self.calls if
                             call[1] == prefix + '/123/attempts/1/jobs?per_page=100']), 1)

    def artifact_fixture(self, contents=b'{"schema":"snapshot-admission.v1"}'):
        archive = io.BytesIO()
        with zipfile.ZipFile(archive, 'w', zipfile.ZIP_DEFLATED) as output:
            output.writestr('snapshot-admission.v1.json', contents)
        raw = archive.getvalue()
        prefix = '/repos/keqi119/subscription-Saas'
        self.responses[prefix + '/actions/runs/123/attempts/1'] = {
            'id': 123, 'run_attempt': 1, 'head_sha': 'a' * 40,
            'repository': self.repo, 'head_repository': self.repo}
        artifact = {'id': 456, 'name': 'snapshot-admission', 'expired': False,
                    'size_in_bytes': len(raw), 'digest': 'sha256:' + hashlib.sha256(raw).hexdigest(),
                    'workflow_run': {'id': 123, 'repository_id': 1253231368,
                                     'head_sha': 'a' * 40}}
        self.responses[prefix + '/actions/runs/123/artifacts?per_page=100'] = {
            'total_count': 1, 'artifacts': [artifact]}
        return raw, artifact

    def test_private_collector_binds_selected_run_and_keeps_binary_members(self):
        selection = {'repository': {'id': '1253231368', 'name': 'keqi119/subscription-Saas'},
                     'runId': '123', 'runAttempt': 1, 'sourceSha': 'a' * 40,
                     'admissionJobId': '77', 'jobId': '99', 'artifactId': '456',
                     'artifactName': 'snapshot-admission'}
        run = {'id': 123, 'run_attempt': 1, 'head_sha': 'a' * 40,
               'repository': self.repo, 'head_repository': self.repo,
               'actor': self.repo['owner'], 'event': 'workflow_dispatch',
               'head_branch': 'main', 'path': self.module.WORKFLOW, 'status': 'in_progress'}
        jobs = [{'id': 77, 'run_id': 123}, {'id': 99, 'run_id': 123}]
        original = {'metadata': {'id': 456}, 'bytes': b'{}'}
        with patch.object(self.module, '_api', self.api):
            with self.session() as github:
                with patch.object(github, 'read_run', return_value=run), \
                     patch.object(github, 'read_workflow', return_value=b'name: snapshot\n'), \
                     patch.object(github, 'read_admission_artifact', return_value=original), \
                     patch.object(github, 'read_environment', return_value={'id': 1}), \
                     patch.object(github, 'read_branch_policies', return_value=[]), \
                     patch.object(github, 'read_approvals', return_value=[]), \
                     patch.object(github, 'read_job_deployment', return_value={'job': jobs[1], 'checkRun': {}}), \
                     patch.object(github, 'read_active_jobs', return_value=[{'run': run, 'jobs': jobs}]) as active:
                    value = github.read_admission_inputs(selection)
                    self.assertEqual(value['artifact']['bytes'], b'{}')
                    self.assertEqual(value['workflowBytes'], b'name: snapshot\n')
                    self.assertEqual(value['jobs'], jobs)
                    self.assertNotIn(self.token, repr(value))
                    active.return_value = []
                    with self.assertRaisesRegex(self.module.GitHubFailure, '^H1_GITHUB_ACTIVE_RUN_INVALID$'):
                        github.read_admission_inputs(selection)
                    with self.assertRaisesRegex(self.module.GitHubFailure, '^H1_GITHUB_INPUT_INVALID$'):
                        github.read_admission_inputs(dict(selection, url='https://invalid.example'))
        self.assertEqual(len(self.revocations()), 1)

    def download_transport(self, archive, location='https://results-receiver.actions.githubusercontent.com/download?sig=fake'):
        requests = []
        class Response:
            status = 200
            def __init__(self, raw):
                self.body = io.BytesIO(raw)
            def read(self, count):
                return self.body.read(count)
            def read1(self, count):
                return self.body.read(count)
            def __enter__(self):
                return self
            def __exit__(self, *args):
                self.body.close()
        class Opener:
            def open(self, request, timeout):
                requests.append(request)
                if len(requests) == 1:
                    raise urllib.error.HTTPError(request.full_url, 302, 'Found',
                                                 {'Location': location}, io.BytesIO())
                return Response(archive)
        return Opener(), requests

    def test_admission_artifact_download_checks_identity_digest_and_strips_token(self):
        archive, artifact = self.artifact_fixture()
        opener, requests = self.download_transport(archive)
        with patch.object(self.module, '_api', self.api), \
             patch.object(self.module.urllib.request, 'build_opener', return_value=opener):
            with self.session() as github:
                result = github.read_admission_artifact('123', '456')
        self.assertIs(result['metadata'], artifact)
        self.assertEqual(result['bytes'], b'{"schema":"snapshot-admission.v1"}')
        self.assertEqual(len(requests), 2)
        self.assertEqual(requests[0].get_header('Authorization'), 'Bearer ' + self.token)
        self.assertIsNone(requests[1].get_header('Authorization'))
        self.assertEqual(len(self.revocations()), 1)

    def test_admission_artifact_rejects_digest_mismatch_and_foreign_redirect(self):
        archive, artifact = self.artifact_fixture()
        artifact['digest'] = 'sha256:' + '0' * 64
        opener, requests = self.download_transport(archive)
        with patch.object(self.module, '_api', self.api), \
             patch.object(self.module.urllib.request, 'build_opener', return_value=opener):
            with self.session() as github:
                with self.assertRaises(self.module.GitHubFailure):
                    github.read_admission_artifact('123', '456')
        self.assertEqual(len(requests), 2)
        artifact['digest'] = 'sha256:' + hashlib.sha256(archive).hexdigest()
        opener, requests = self.download_transport(archive, 'https://attacker.example/steal')
        with patch.object(self.module, '_api', self.api), \
             patch.object(self.module.urllib.request, 'build_opener', return_value=opener):
            with self.session() as github:
                with self.assertRaises(self.module.GitHubFailure):
                    github.read_admission_artifact('123', '456')
        self.assertEqual(len(requests), 1)

    def test_admission_artifact_rejects_wrong_run_and_unsafe_zip_member(self):
        archive, artifact = self.artifact_fixture()
        artifact['workflow_run']['id'] = 999
        opener, requests = self.download_transport(archive)
        with patch.object(self.module, '_api', self.api), \
             patch.object(self.module.urllib.request, 'build_opener', return_value=opener):
            with self.session() as github:
                with self.assertRaises(self.module.GitHubFailure):
                    github.read_admission_artifact('123', '456')
        self.assertEqual(requests, [])
        artifact['workflow_run']['id'] = 123
        for name in ('../snapshot-admission.v1.json', 'nested/snapshot-admission.v1.json'):
            buffer = io.BytesIO()
            with zipfile.ZipFile(buffer, 'w') as output:
                output.writestr(name, b'{}')
            archive = buffer.getvalue()
            artifact['size_in_bytes'] = len(archive)
            artifact['digest'] = 'sha256:' + hashlib.sha256(archive).hexdigest()
            opener, _ = self.download_transport(archive)
            with patch.object(self.module, '_api', self.api), \
                 patch.object(self.module.urllib.request, 'build_opener', return_value=opener):
                with self.session() as github:
                    with self.assertRaises(self.module.GitHubFailure):
                        github.read_admission_artifact('123', '456')

    def test_admission_artifact_rejects_symlink_and_oversize_member(self):
        _, artifact = self.artifact_fixture()
        symlink = zipfile.ZipInfo('snapshot-admission.v1.json')
        symlink.create_system = 3
        symlink.external_attr = (stat.S_IFLNK | 0o777) << 16
        archives = []
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, 'w') as output:
            output.writestr(symlink, b'target')
        archives.append(buffer.getvalue())
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, 'w', zipfile.ZIP_DEFLATED) as output:
            output.writestr('snapshot-admission.v1.json', b'a' * (1048576 + 1))
        archives.append(buffer.getvalue())
        for archive in archives:
            artifact['size_in_bytes'] = len(archive)
            artifact['digest'] = 'sha256:' + hashlib.sha256(archive).hexdigest()
            opener, _ = self.download_transport(archive)
            with patch.object(self.module, '_api', self.api), \
                 patch.object(self.module.urllib.request, 'build_opener', return_value=opener):
                with self.session() as github:
                    with self.assertRaisesRegex(self.module.GitHubFailure,
                                                '^H1_GITHUB_ARTIFACT_ZIP_INVALID$'):
                        github.read_admission_artifact('123', '456')

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
