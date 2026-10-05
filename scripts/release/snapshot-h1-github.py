"""Fixed GitHub read session for the H1 root controller (Python 3.6+).

The trusted caller supplies a short-lived App JWT from the protected key process.
There is no CLI, job input, environment token, arbitrary URL or runner registration
interface. API observations remain raw facts; they are not signed admission.
"""
import base64
import copy
import datetime
import hashlib
import json
import re
import ssl
import urllib.error
import urllib.request


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
MAX_BYTES = 1048576


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

    def read_approvals(self, run_id):
        value = self._get(PREFIX + '/actions/runs/' + _id(run_id) + '/approvals')
        require(type(value) is list and len(value) <= 100 and
                all(type(row) is dict for row in value), 'RESPONSE_INVALID')
        return value

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
