"""Fixed GitHub read session for the H1 root controller (Python 3.6+).

The trusted caller supplies a short-lived App JWT from the protected key process.
There is no CLI, job input, environment token, arbitrary URL or runner registration
interface. API observations remain raw facts; they are not signed admission.
"""
import base64
import copy
import datetime
import hashlib
import io
import json
import re
import ssl
import stat
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile


REPOSITORY = 'keqi119/subscription-Saas'
REPO_ID = 1253231368
OWNER_ID = 275060624
APP_ID = 5196151
INSTALLATION_ID = 168113687
APP_SLUG = 'keqi119-stage1-snapshot-jit'
PREFIX = '/repos/' + REPOSITORY
WORKFLOW = '.github/workflows/sanitized-snapshot.yml'
ENVIRONMENT = 'stage1-snapshot-export'
ENVIRONMENT_ID = 23175152803
APP_PERMISSIONS = {'administration': 'write', 'actions': 'read',
                   'contents': 'read', 'deployments': 'read', 'metadata': 'read'}
READ_PERMISSIONS = dict(APP_PERMISSIONS, administration='read')
ACTIVE_RUN_STATUSES = ('in_progress', 'queued', 'requested', 'waiting', 'pending')
MAX_BYTES = 1048576
MAX_ARCHIVE_BYTES = 8 * MAX_BYTES
CHECK_DEPLOYMENT_QUERY = '''query($id:ID!) {
  node(id:$id) { ... on CheckRun {
    id databaseId name status
    repository { databaseId nameWithOwner }
    checkSuite { commit { oid } workflowRun { databaseId } }
    deployment { id databaseId environment commitOid createdAt latestStatus { state } }
    pendingDeploymentRequest { environment { id name } }
  } }
}'''


class GitHubFailure(Exception):
    """Only fixed, non-secret error codes cross the controller boundary."""


def require(condition, code):
    if not condition:
        raise GitHubFailure('H1_GITHUB_' + code)


def _frame(pairs):
    value = {}
    for key, item in pairs:
        require(key not in value, 'RESPONSE_INVALID')
        value[key] = item
    return value


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, msg, headers, url):
        raise GitHubFailure('H1_GITHUB_REDIRECT_REJECTED')


class StopRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, msg, headers, url):
        return None


def _artifact_storage_url(location):
    require(type(location) is str and len(location) <= 8192, 'ARTIFACT_REDIRECT_INVALID')
    try:
        parsed = urllib.parse.urlsplit(location)
        host = parsed.hostname
        valid_host = (host == 'results-receiver.actions.githubusercontent.com' or
                      re.fullmatch(r'[a-z0-9-]+\.blob\.core\.windows\.net', host or '') is not None)
        require(parsed.scheme == 'https' and valid_host and parsed.port is None and
                parsed.username is None and parsed.password is None and
                parsed.fragment == '' and parsed.path.startswith('/'),
                'ARTIFACT_REDIRECT_INVALID')
    except ValueError:
        raise GitHubFailure('H1_GITHUB_ARTIFACT_REDIRECT_INVALID') from None
    return location


def _download_artifact(artifact_id, token):
    # GitHub's fixed API route returns a 302. Inspect Location without allowing
    # urllib to carry the installation token to the storage host.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}),
        urllib.request.HTTPSHandler(context=ssl.create_default_context()), StopRedirect())
    headers = {'Accept': 'application/vnd.github+json',
               'X-GitHub-Api-Version': '2022-11-28',
               'User-Agent': 'stage1-h1-snapshot-root',
               'Authorization': 'Bearer ' + token}
    request = urllib.request.Request('https://api.github.com' + PREFIX +
                                     '/actions/artifacts/' + _id(artifact_id) + '/zip',
                                     headers=headers, method='GET')
    try:
        with opener.open(request, timeout=30) as response:
            raise GitHubFailure('H1_GITHUB_ARTIFACT_REDIRECT_INVALID')
    except urllib.error.HTTPError as cause:
        try:
            require(cause.code == 302, 'HTTP_' + str(cause.code))
            location = _artifact_storage_url(cause.headers.get('Location'))
        finally:
            cause.close()
    except (OSError, ValueError):
        raise GitHubFailure('H1_GITHUB_REQUEST_FAILED') from None
    # One credential-free hop; redirects at storage are rejected as well.
    storage_request = urllib.request.Request(location,
        headers={'User-Agent': 'stage1-h1-snapshot-root'}, method='GET')
    deadline = time.monotonic() + 30
    try:
        with opener.open(storage_request, timeout=30) as response:
            require(response.status == 200, 'HTTP_' + str(response.status))
            chunks = []
            size = 0
            while True:
                require(time.monotonic() < deadline, 'ARTIFACT_TIMEOUT')
                chunk = response.read1(min(65536, MAX_ARCHIVE_BYTES + 1 - size))
                size += len(chunk)
                require(size <= MAX_ARCHIVE_BYTES, 'ARTIFACT_TOO_LARGE')
                if not chunk:
                    break
                chunks.append(chunk)
            return b''.join(chunks)
    except urllib.error.HTTPError as cause:
        status = cause.code
        cause.close()
        raise GitHubFailure('H1_GITHUB_HTTP_' + str(status)) from None
    except (OSError, ValueError):
        raise GitHubFailure('H1_GITHUB_REQUEST_FAILED') from None


def _admission_member(archive):
    try:
        with zipfile.ZipFile(io.BytesIO(archive), 'r') as source:
            members = source.infolist()
            require(len(members) == 1, 'ARTIFACT_ZIP_INVALID')
            member = members[0]
            mode = member.external_attr >> 16
            require(member.filename == 'snapshot-admission.v1.json' and
                    not member.is_dir() and stat.S_IFMT(mode) in (0, stat.S_IFREG) and
                    not member.flag_bits & 1 and
                    member.compress_type in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED) and
                    0 < member.file_size <= MAX_BYTES and
                    member.compress_size <= MAX_ARCHIVE_BYTES, 'ARTIFACT_ZIP_INVALID')
            with source.open(member, 'r') as content:
                raw = content.read(MAX_BYTES + 1)
                require(len(raw) == member.file_size, 'ARTIFACT_ZIP_INVALID')
                return raw
    except (OSError, RuntimeError, ValueError, zipfile.BadZipFile, NotImplementedError):
        raise GitHubFailure('H1_GITHUB_ARTIFACT_ZIP_INVALID') from None


def _api(method, route, credential, body=None, expected=(200,)):
    # All callers below construct fixed routes. Never honor proxy environment or
    # forward Authorization to a redirect/download_url supplied by a response.
    require(route.startswith('/') and not route.startswith('//') and
            not any(char in route for char in ('\r', '\n', '#', '\\')), 'INPUT_INVALID')
    headers = {'Accept': 'application/vnd.github+json',
               'X-GitHub-Api-Version': '2022-11-28',
               'User-Agent': 'stage1-h1-snapshot-root',
               'Authorization': 'Bearer ' + credential}
    data = None
    if body is not None:
        headers['Content-Type'] = 'application/json'
        data = json.dumps(body, separators=(',', ':')).encode('ascii')
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}),
        urllib.request.HTTPSHandler(context=ssl.create_default_context()), NoRedirect())
    request = urllib.request.Request('https://api.github.com' + route,
                                    data=data, headers=headers, method=method)
    try:
        with opener.open(request, timeout=30) as response:
            require(response.status in expected, 'HTTP_' + str(response.status))
            raw = response.read(MAX_BYTES + 1)
            require(len(raw) <= MAX_BYTES, 'RESPONSE_TOO_LARGE')
            if response.status == 204:
                require(not raw, 'RESPONSE_INVALID')
                return None
        return json.loads(raw.decode('utf-8'), object_pairs_hook=_frame)
    except urllib.error.HTTPError as cause:
        status = cause.code
        cause.close()
        if status == 404 and 404 in expected:
            return None
        raise GitHubFailure('H1_GITHUB_HTTP_' + str(status)) from None
    except (OSError, ValueError, UnicodeError):
        raise GitHubFailure('H1_GITHUB_REQUEST_FAILED') from None


def _id(value):
    require(type(value) is str and re.fullmatch(r'[1-9][0-9]{0,18}', value) is not None,
            'INPUT_INVALID')
    return value


def _sha(value):
    require(type(value) is str and re.fullmatch(r'[a-f0-9]{40}', value) is not None,
            'INPUT_INVALID')
    return value


def _owner(value):
    return (type(value) is dict and value.get('id') == OWNER_ID and
            value.get('login') == 'keqi119')


def _repository(value):
    return (type(value) is dict and value.get('id') == REPO_ID and
            value.get('full_name') == REPOSITORY and _owner(value.get('owner')))


def _list(value, key):
    require(type(value) is dict and type(value.get('total_count')) is int and
            0 <= value['total_count'] <= 100 and type(value.get(key)) is list and
            len(value[key]) == value['total_count'] and
            all(type(row) is dict for row in value[key]), 'LIST_INCOMPLETE')
    return value[key]


class H1SnapshotGitHub:
    """One private read session. The token is revoked even when __enter__ fails."""
    def __init__(self, jwt_supplier):
        require(callable(jwt_supplier), 'INPUT_INVALID')
        self._jwt_supplier = jwt_supplier
        self._token = None
        self._used = False
        self._closed = False
        self._repository = None

    def __enter__(self):
        require(not self._used and not self._closed, 'SESSION_CLOSED')
        self._used = True
        try:
            jwt = self._jwt_supplier()
            require(type(jwt) is str and len(jwt) <= 4096 and
                    re.fullmatch(r'[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+', jwt),
                    'JWT_INVALID')
            app = _api('GET', '/app', jwt)
            require(type(app) is dict and app.get('id') == APP_ID and
                    app.get('slug') == APP_SLUG and _owner(app.get('owner')) and
                    app.get('permissions') == APP_PERMISSIONS and app.get('events') == [],
                    'APP_MISMATCH')
            installation = _api('GET', PREFIX + '/installation', jwt)
            require(type(installation) is dict and installation.get('id') == INSTALLATION_ID and
                    installation.get('app_id') == APP_ID and installation.get('app_slug') == APP_SLUG and
                    _owner(installation.get('account')) and installation.get('target_id') == OWNER_ID and
                    installation.get('target_type') == 'User' and
                    installation.get('repository_selection') == 'selected' and
                    installation.get('permissions') == APP_PERMISSIONS and
                    installation.get('events') == [] and installation.get('suspended_at') is None and
                    installation.get('suspended_by') is None, 'INSTALLATION_MISMATCH')
            created = _api('POST', '/app/installations/' + str(INSTALLATION_ID) + '/access_tokens',
                           jwt, {'repository_ids': [REPO_ID], 'permissions': dict(READ_PERMISSIONS)},
                           expected=(201,))
            require(type(created) is dict and type(created.get('token')) is str and
                    re.fullmatch(r'[\x21-\x7e]{1,16384}', created['token']), 'TOKEN_INVALID')
            self._token = created['token']
            # Capture first so all later validation failures also revoke it.
            # Installation tokens are opaque; GitHub's stateless format has dots
            # and is longer than the legacy token. Only bound header-safe bytes.
            require(re.fullmatch(r'[A-Za-z0-9._~+/=-]{20,16384}', self._token), 'TOKEN_INVALID')
            require(created.get('permissions') == READ_PERMISSIONS and
                    created.get('repository_selection') == 'selected', 'TOKEN_SCOPE_MISMATCH')
            try:
                expires = datetime.datetime.strptime(created['expires_at'], '%Y-%m-%dT%H:%M:%SZ')
                expires = expires.replace(tzinfo=datetime.timezone.utc)
                seconds = (expires - datetime.datetime.now(datetime.timezone.utc)).total_seconds()
            except (ValueError, KeyError, TypeError):
                raise GitHubFailure('H1_GITHUB_TOKEN_INVALID') from None
            require(60 <= seconds <= 3700, 'TOKEN_INVALID')
            rows = _list(self._get('/installation/repositories?per_page=100'), 'repositories')
            require(len(rows) == 1 and _repository(rows[0]), 'REPOSITORY_MISMATCH')
            self._repository = rows[0]
            return self
        except BaseException:
            self.close()
            raise
        finally:
            self._jwt_supplier = None

    def __exit__(self, exc_type, exc_value, traceback):
        self.close()
        return False

    def close(self):
        self._closed = True
        self._repository = None
        if self._token is None:
            return
        # One bounded retry for a transient network/service failure. On unknown
        # cleanup, keep only the private retry capability; reads stay closed.
        for attempt in range(2):
            try:
                _api('DELETE', '/installation/token', self._token, expected=(204,))
            except Exception:
                continue
            self._token = None
            return
        raise GitHubFailure('H1_GITHUB_TOKEN_REVOCATION_FAILED') from None

    def _get(self, route, expected=(200,)):
        require(self._token is not None and not self._closed, 'SESSION_CLOSED')
        return _api('GET', route, self._token, expected=expected)

    def repository(self):
        require(self._token is not None and not self._closed and self._repository is not None,
                'SESSION_CLOSED')
        return copy.deepcopy(self._repository)

    def read_run(self, run_id):
        value = self._get(PREFIX + '/actions/runs/' + _id(run_id) + '/attempts/1')
        require(type(value) is dict and value.get('id') == int(run_id) and
                value.get('run_attempt') == 1 and _repository(value.get('repository')) and
                _repository(value.get('head_repository')), 'RUN_MISMATCH')
        return value

    def read_jobs(self, run_id):
        return _list(self._get(PREFIX + '/actions/runs/' + _id(run_id) +
                              '/attempts/1/jobs?per_page=100'), 'jobs')

    def read_active_jobs(self):
        # These five fixed queries observe every active status in this repo.
        # The result is a bounded observation, not an atomic lease on runners.
        runs = {}
        for status in ACTIVE_RUN_STATUSES:
            rows = _list(self._get(PREFIX + '/actions/runs?status=' + status +
                                   '&per_page=100'), 'workflow_runs')
            for run in rows:
                run_id = run.get('id')
                attempt = run.get('run_attempt')
                sha = run.get('head_sha')
                require(type(run_id) is int and 0 < run_id < 10 ** 19 and
                        type(attempt) is int and 0 < attempt < 10 ** 19 and
                        type(sha) is str and re.fullmatch(r'[a-f0-9]{40}', sha) is not None and
                        _repository(run.get('repository')) and
                        run.get('status') in ACTIVE_RUN_STATUSES,
                        'ACTIVE_RUN_INVALID')
                if run_id in runs:
                    previous = runs[run_id]
                    require(all(previous.get(key) == run.get(key) for key in
                                ('run_attempt', 'head_sha', 'repository', 'status')),
                            'ACTIVE_RUN_INVALID')
                else:
                    runs[run_id] = run
                require(len(runs) <= 100, 'ACTIVE_RUN_LIMIT')
        observed = []
        job_ids = set()
        for run in runs.values():
            route = (PREFIX + '/actions/runs/' + str(run['id']) + '/attempts/' +
                     str(run['run_attempt']) + '/jobs?per_page=100')
            jobs = _list(self._get(route), 'jobs')
            for job in jobs:
                job_id = job.get('id')
                require(type(job_id) is int and 0 < job_id < 10 ** 19 and
                        job_id not in job_ids and
                        type(job.get('run_id')) is int and job['run_id'] == run['id'] and
                        job.get('head_sha') == run['head_sha'], 'ACTIVE_JOB_INVALID')
                job_ids.add(job_id)
                require(len(job_ids) <= 100, 'ACTIVE_JOB_LIMIT')
            observed.append({'run': run, 'jobs': jobs})
        return observed

    def read_admission_inputs(self, selection):
        # Private root selection, never job-provided facts or URLs. Binary values
        # remain bytes until the separate private pipe serializer encodes them.
        fields = {'repository', 'runId', 'runAttempt', 'sourceSha', 'admissionJobId',
                  'jobId', 'artifactId', 'artifactName'}
        require(type(selection) is dict and set(selection) == fields and
                selection['repository'] == {'id': str(REPO_ID), 'name': REPOSITORY} and
                selection['runAttempt'] == 1 and type(selection['runAttempt']) is int and
                selection['artifactName'] == 'snapshot-admission', 'INPUT_INVALID')
        for key in ('runId', 'admissionJobId', 'jobId', 'artifactId'):
            _id(selection[key])
        _sha(selection['sourceSha'])
        require(selection['admissionJobId'] != selection['jobId'], 'INPUT_INVALID')
        observed_at = datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
        run = self.read_run(selection['runId'])
        require(run.get('head_sha') == selection['sourceSha'], 'RUN_MISMATCH')
        workflow = self.read_workflow(selection['sourceSha'])
        artifact = self.read_admission_artifact(selection['runId'], selection['artifactId'])
        environment = self.read_environment()
        branches = self.read_branch_policies()
        reviews = self.read_approvals(selection['runId'])
        deployment = self.read_job_deployment(selection['runId'], selection['jobId'])
        active = self.read_active_jobs()
        selected = [group for group in active if group['run']['id'] == int(selection['runId'])]
        require(len(selected) == 1 and selected[0]['run']['run_attempt'] == 1 and
                selected[0]['run']['head_sha'] == selection['sourceSha'], 'ACTIVE_RUN_INVALID')
        final_run = self.read_run(selection['runId'])
        require(all(final_run.get(key) == run.get(key) for key in
                    ('id', 'run_attempt', 'head_sha', 'head_branch', 'repository',
                     'head_repository', 'actor', 'event', 'path')) and
                final_run.get('status') in ACTIVE_RUN_STATUSES, 'RUN_MISMATCH')
        return {'observedAt': observed_at, 'repository': self.repository(), 'run': final_run,
                'jobs': selected[0]['jobs'], 'environment': environment,
                'branchPolicies': branches, 'workflowBytes': workflow,
                'artifact': artifact, 'activeRuns': active,
                'deployment': deployment, 'reviews': reviews}

    def read_approvals(self, run_id):
        value = self._get(PREFIX + '/actions/runs/' + _id(run_id) + '/approvals')
        require(type(value) is list and len(value) <= 100 and
                all(type(row) is dict for row in value), 'RESPONSE_INVALID')
        return value

    def read_job_deployment(self, run_id, job_id):
        _id(run_id)
        _id(job_id)
        run = self.read_run(run_id)
        jobs = [job for job in self.read_jobs(run_id) if job.get('id') == int(job_id)]
        code = 'DEPLOYMENT_BINDING_INVALID'
        require(len(jobs) == 1 and jobs[0].get('run_id') == int(run_id) and
                jobs[0].get('head_sha') == run.get('head_sha'), code)
        job = jobs[0]
        link = job.get('check_run_url')
        match = re.fullmatch(r'https://api\.github\.com/repos/keqi119/subscription-Saas/check-runs/([1-9][0-9]*)',
                             link) if type(link) is str else None
        require(match is not None, code)
        checked = self._get(PREFIX + '/check-runs/' + _id(match.group(1)))
        require(type(checked) is dict and checked.get('id') == int(match.group(1)) and
                checked.get('head_sha') == run.get('head_sha') and
                checked.get('name') == job.get('name') and type(checked.get('node_id')) is str and
                1 <= len(checked['node_id']) <= 256, code)
        graph = _api('POST', '/graphql', self._token,
                     {'query': CHECK_DEPLOYMENT_QUERY, 'variables': {'id': checked['node_id']}})
        require(type(graph) is dict and not graph.get('errors'), code)
        try:
            item = graph['data']['node']
            require(type(item) is dict and item['id'] == checked['node_id'] and
                    item['databaseId'] == checked['id'] and item['name'] == job['name'] and
                    item['repository']['databaseId'] == REPO_ID and
                    item['repository']['nameWithOwner'] == REPOSITORY and
                    item['checkSuite']['workflowRun']['databaseId'] == run['id'] and
                    item['checkSuite']['commit']['oid'] == run['head_sha'] and
                    (item['deployment'] is None or type(item['deployment']) is dict) and
                    (item['pendingDeploymentRequest'] is None or
                     type(item['pendingDeploymentRequest']) is dict), code)
        except (KeyError, TypeError):
            raise GitHubFailure('H1_GITHUB_' + code) from None
        # Nullable deployment is returned honestly. The admission verifier must
        # still require a real deployment, matching policy and approval history.
        return {'job': job, 'checkRun': item}

    def read_environment(self):
        value = self._get(PREFIX + '/environments/' + ENVIRONMENT)
        require(type(value) is dict and value.get('id') == ENVIRONMENT_ID and
                value.get('name') == ENVIRONMENT, 'ENVIRONMENT_MISMATCH')
        return value

    def read_branch_policies(self):
        return _list(self._get(PREFIX + '/environments/' + ENVIRONMENT +
                              '/deployment-branch-policies?per_page=100'), 'branch_policies')

    def read_artifacts(self, run_id):
        return _list(self._get(PREFIX + '/actions/runs/' + _id(run_id) +
                              '/artifacts?per_page=100'), 'artifacts')

    def read_admission_artifact(self, run_id, artifact_id):
        _id(run_id)
        _id(artifact_id)
        run = self.read_run(run_id)
        candidates = [row for row in self.read_artifacts(run_id)
                      if row.get('name') == 'snapshot-admission']
        require(len(candidates) == 1 and candidates[0].get('id') == int(artifact_id),
                'ARTIFACT_MISMATCH')
        artifact = candidates[0]
        workflow_run = artifact.get('workflow_run')
        require(type(workflow_run) is dict and workflow_run.get('id') == run['id'] and
                workflow_run.get('repository_id') == REPO_ID and
                workflow_run.get('head_sha') == run.get('head_sha') and
                artifact.get('expired') is False and
                type(artifact.get('size_in_bytes')) is int and
                0 < artifact['size_in_bytes'] <= MAX_ARCHIVE_BYTES and
                type(artifact.get('digest')) is str and
                re.fullmatch(r'sha256:[a-f0-9]{64}', artifact['digest']) is not None,
                'ARTIFACT_MISMATCH')
        archive = _download_artifact(artifact_id, self._token)
        require(len(archive) == artifact['size_in_bytes'] and
                'sha256:' + hashlib.sha256(archive).hexdigest() == artifact['digest'],
                'ARTIFACT_DIGEST_MISMATCH')
        return {'metadata': artifact, 'bytes': _admission_member(archive)}

    def read_runners(self):
        return _list(self._get(PREFIX + '/actions/runners?per_page=100'), 'runners')

    def read_runner(self, runner_id):
        value = self._get(PREFIX + '/actions/runners/' + _id(runner_id), expected=(200, 404))
        require(value is None or type(value) is dict and value.get('id') == int(runner_id),
                'RUNNER_MISMATCH')
        return value

    def read_workflow(self, source_sha):
        value = self._get(PREFIX + '/contents/' + WORKFLOW + '?ref=' + _sha(source_sha))
        require(type(value) is dict and value.get('type') == 'file' and
                value.get('path') == WORKFLOW and value.get('encoding') == 'base64' and
                type(value.get('size')) is int and 0 < value['size'] <= MAX_BYTES and
                type(value.get('content')) is str, 'WORKFLOW_INVALID')
        try:
            raw = base64.b64decode(value['content'].replace('\n', ''), validate=True)
        except (ValueError, UnicodeError):
            raise GitHubFailure('H1_GITHUB_WORKFLOW_INVALID') from None
        blob = hashlib.sha1(b'blob ' + str(len(raw)).encode('ascii') + b'\0' + raw).hexdigest()
        require(len(raw) == value['size'] and blob == value.get('sha'), 'WORKFLOW_INVALID')
        return raw
