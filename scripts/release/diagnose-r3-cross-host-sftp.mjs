// Synthetic cross-host SFTP diagnostic. Never imports a real R3 operation.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import childProcess from 'node:child_process';
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

const BRANCH = 'refs/heads/codex/stage1-sftp-diagnostic-20261026';
const WORKFLOW = '.github/workflows/stage1-workspace-diagnostic.yml';
const REPOSITORY = 'keqi119/subscription-Saas';
const REPOSITORY_ID = '1253231368';
const ADAPTER_SHA = '677c32448e8e2fdcc2b3e69ca81630af87392e382a3677e22a978122e0f8d153';
const ADAPTER = new URL('./r3-hosted-evidence-delivery.mjs', import.meta.url);
const CODEC = new URL('./r3-evidence-delivery.mjs', import.meta.url);
const KEY_INPUT = new URL('./r3-operation-inputs.mjs', import.meta.url);
const CANONICAL = new URL('../../packages/release-foundation/src/canonical-json.mjs', import.meta.url);
const PAYLOAD = Buffer.from('{"kind":"synthetic-r3-sftp-creation","schemaVersion":"stage1-r3-sftp-diagnostic.v1"}');
const PAYLOAD_DIGEST = 'sha256:48bc8e7706de7e7eda14ce0ba5350385dfd61c78397affe866da2f913f36e164';
const OUTPUT = path.resolve('.release-output/r3-cross-host-sftp-diagnostic');
const SHA = /^[0-9a-f]{40}$/u;
const DECIMAL = /^[1-9][0-9]{0,19}$/u;
const sha = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const iso = date => new Date(date).toISOString().replace(/\.\d{3}Z$/u, '.000Z');
const safeError = error => {
  const code = typeof error?.code === 'string' ? error.code : '';
  return ['R3_HOSTED_EVIDENCE_DELIVERY_UNAVAILABLE','ERR_MODULE_NOT_FOUND',
    'UNEXPECTED_CODEC_CALL','ENOENT','EEXIST','EACCES','EPERM','ETIMEDOUT'].includes(code)
    ? code : 'OTHER';
};
const sftpCategory = chunk => {
  const value = Buffer.from(chunk).toString('utf8').toLowerCase();
  if (/permission denied \(publickey\)|authentication failed/u.test(value)) return 'AUTH_DENIED';
  if (/permission denied/u.test(value)) return 'REMOTE_PERMISSION_DENIED';
  if (/connection reset/u.test(value)) return 'CONNECTION_RESET';
  if (/broken pipe/u.test(value)) return 'BROKEN_PIPE';
  if (/connection closed|connection lost|closed by remote host/u.test(value)) return 'CLOSED';
  if (/timed out|timeout/u.test(value)) return 'TIMEOUT';
  if (/no such file|not found/u.test(value)) return 'NO_SUCH_FILE';
  if (/sftp|protocol/u.test(value)) return 'SFTP_PROTOCOL';
  return 'OTHER';
};
const writeOnce = async (file, value, mode = 0o600) => {
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`);
  const handle = await fs.open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
  try { await handle.writeFile(bytes); await handle.sync(); }
  finally { await handle.close(); }
  return sha(bytes);
};
const context = () => {
  const env = process.env;
  assert.equal(process.platform, 'linux');
  assert.equal(process.getuid?.(), 0);
  assert.equal(env.GITHUB_ACTIONS, 'true');
  assert.equal(env.RUNNER_ENVIRONMENT, 'github-hosted');
  assert.equal(env.GITHUB_REPOSITORY, REPOSITORY);
  assert.equal(env.GITHUB_REPOSITORY_ID, REPOSITORY_ID);
  assert.equal(env.GITHUB_REF, BRANCH);
  assert.equal(env.GITHUB_RUN_ATTEMPT, '1');
  assert.match(env.GITHUB_SHA ?? '', SHA);
  assert.match(env.GITHUB_RUN_ID ?? '', DECIMAL);
  assert.equal(env.GITHUB_WORKFLOW_REF,
    `${REPOSITORY}/${WORKFLOW}@${BRANCH}`);
  assert.equal(sha(PAYLOAD), PAYLOAD_DIGEST);
  return {
    runId: env.GITHUB_RUN_ID,
    sourceSha: env.GITHUB_SHA,
    directory: `/dev/shm/stage1-sftp-probe-${env.GITHUB_RUN_ID}-1`
  };
};
const files = ctx => ({
  intent: `${ctx.directory}/intent.json`,
  started: `${ctx.directory}/run.started`,
  key: `${ctx.directory}/forwarding.key`,
  publicKey: `${ctx.directory}/forwarding.key.pub`,
  transfer: `${ctx.directory}/transfer`,
  publicDescriptor: `${OUTPUT}/public-key.json`,
  summary: `${OUTPUT}/summary.json`,
  events: `${OUTPUT}/events.json`,
  cleanup: `${OUTPUT}/cleanup.json`
});
const readJson = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const fixedIntent = ctx => ({
  schemaVersion: 'stage1-r3-sftp-diagnostic-intent.v1', repositoryId: REPOSITORY_ID,
  workflowPath: WORKFLOW, ref: BRANCH, sourceSha: ctx.sourceSha, runId: ctx.runId,
  runAttempt: 1, endpoint: 'stage1-r3-evidence@139.196.227.195:22',
  payloadDigest: PAYLOAD_DIGEST
});
const readIntent = async (ctx, f) => {
  const value = await readJson(f.intent);
  assert.deepEqual(value, fixedIntent(ctx));
  return value;
};
const checkAdapter = async () => assert.equal(sha(await fs.readFile(ADAPTER)).slice(7), ADAPTER_SHA);

async function prepare(ctx) {
  const f = files(ctx);
  await checkAdapter();
  await fs.mkdir(ctx.directory, { mode: 0o700 });
  const stat = await fs.lstat(ctx.directory);
  assert(stat.isDirectory() && stat.uid === 0 && stat.gid === 0 && (stat.mode & 0o777) === 0o700);
  await writeOnce(f.intent, fixedIntent(ctx));
  await fs.mkdir(f.transfer, { mode: 0o700 });
  const generated = childProcess.spawnSync('/usr/bin/ssh-keygen',
    ['-q','-t','ed25519','-N','','-C','','-f',f.key],
    { encoding: 'buffer', timeout: 15000, maxBuffer: 4096, stdio: ['ignore','pipe','pipe'] });
  assert.equal(generated.status, 0);
  assert.equal(generated.signal, null);
  const privateStat = await fs.lstat(f.key);
  assert(privateStat.isFile() && privateStat.uid === 0 && privateStat.gid === 0 &&
    privateStat.nlink === 1 && (privateStat.mode & 0o777) === 0o600);
  const publicRaw = await fs.readFile(f.publicKey, 'utf8');
  const match = /^ssh-ed25519 ([A-Za-z0-9+/]+={0,2})(?:[ \t]*)\n$/u.exec(publicRaw);
  assert(match);
  const publicKey = `ssh-ed25519 ${match[1]}`;
  const normalized = Buffer.from(`${publicKey}\n`);
  await fs.writeFile(f.publicKey, normalized, { mode: 0o644 });
  const expiresAt = iso(Date.now() + 900000);
  await fs.mkdir(OUTPUT, { recursive: true, mode: 0o755 });
  const descriptor = {
    schemaVersion: 'stage1-r3-sftp-diagnostic-public-key.v1',
    repositoryId: REPOSITORY_ID, workflowPath: WORKFLOW, ref: BRANCH,
    sourceSha: ctx.sourceSha, runId: ctx.runId, runAttempt: 1,
    expiresAt, publicKey, publicKeyRawDigest: sha(normalized),
    payloadDigest: PAYLOAD_DIGEST
  };
  await writeOnce(f.publicDescriptor, descriptor, 0o644);
  process.stdout.write('DIAGNOSTIC_PUBLIC_KEY_PREPARED\n');
}

async function worker(ctx) {
  const f = files(ctx);
  const input = Buffer.from('{"synthetic":"scope"}');
  const emit = (stage, facts = {}) => process.send?.({ type: 'EVENT', stage, at: new Date().toISOString(), ...facts });
  let delivery, primary = null, mock, phase = 'BOOTSTRAP';
  const realSpawn = childProcess.spawn.bind(childProcess);
  const realLstat = fs.lstat.bind(fs);
  const realOpen = fs.open.bind(fs);
  const pathClass = value => {
    const name = String(value);
    if (name === f.transfer) return 'TRANSFER_DIR';
    if (name === `${f.transfer}/creation.bundle.json`) return 'LOCAL_BUNDLE';
    if (name.endsWith('/release/contracts/stage1-r3-h1-known-hosts')) return 'KNOWN_HOSTS';
    return 'OTHER';
  };
  try {
    emit('BOOTSTRAP_START');
    ({ mock } = await import('node:test'));
    const descriptor = await readJson(f.publicDescriptor);
    const scope = { operationRef: '00000000-0000-4000-8000-000000000001', expiresAt: descriptor.expiresAt };
    const unexpectedCodecCall = () => {
      throw Object.assign(new Error('UNEXPECTED_CODEC_CALL'), { code: 'UNEXPECTED_CODEC_CALL' });
    };
    await checkAdapter();
    mock.module(CODEC.href, { namedExports: {
      r3EvidenceScope: () => scope,
      decodeR3CleanupRequest: unexpectedCodecCall,
      decodeR3CleanupImported: unexpectedCodecCall,
      decodeR3Closed: unexpectedCodecCall,
      encodeR3ClosedReceived: unexpectedCodecCall
    }});
    mock.module(CANONICAL.href, { namedExports: {
      canonicalJson: unexpectedCodecCall
    }});
    mock.module(KEY_INPUT.href, { namedExports: {
      readR3HostedOperationKey: async ({ operationRef }) => {
        assert.equal(operationRef, scope.operationRef);
        return {
          creationSpecBytes: input, jobAdmissionBytes: input, sshPrivateKeyPath: f.key,
          recheck: async () => {
            const held = await realLstat(f.key);
            assert(held.isFile() && held.uid === 0 && held.gid === 0 &&
              held.nlink === 1 && (held.mode & 0o777) === 0o600);
            emit('KEY_RECHECK', { category: 'PASS' });
          },
          close: async () => emit('KEY_CLOSED')
        };
      }
    }});
    mock.method(fs, 'lstat', async (file, ...rest) => {
      const category = pathClass(file);
      try {
        const result = await realLstat(file, ...rest);
        if (category !== 'OTHER') emit('FS_LSTAT', { category, outcome: 'PASS' });
        return result;
      } catch (error) {
        if (category !== 'OTHER') emit('FS_LSTAT', { category, outcome: safeError(error) });
        throw error;
      }
    });
    mock.method(fs, 'open', async (file, ...rest) => {
      const category = pathClass(file);
      try {
        const result = await realOpen(file, ...rest);
        if (category !== 'OTHER') emit('FS_OPEN', { category, outcome: 'PASS' });
        return result;
      } catch (error) {
        if (category !== 'OTHER') emit('FS_OPEN', { category, outcome: safeError(error) });
        throw error;
      }
    });
    mock.method(childProcess, 'spawn', (file, args, options) => {
      assert.equal(file, '/usr/bin/sftp');
      assert.equal(args.at(-1), 'stage1-r3-evidence@139.196.227.195');
      assert(args.includes(`-oIdentityFile=${f.key}`));
      const child = realSpawn(file, args, options);
      emit('SFTP_SPAWN', { category: 'FIXED_ENDPOINT' });
      let stdoutBytes = 0, stderrBytes = 0, markerCount = 0, tail = '';
      const stderrCategories = new Set();
      let stderrTail = '';
      child.stdout.on('data', chunk => {
        stdoutBytes += chunk.length;
        const combined = tail + chunk.toString('utf8');
        const marker = /Remote working directory: \/\r?\n/gu;
        for (const hit of combined.matchAll(marker))
          if (hit.index + hit[0].length > tail.length) markerCount++;
        tail = combined.slice(-40);
        emit('SFTP_STDOUT', { category: 'COUNT_ONLY', bytes: stdoutBytes, pwdMarkers: markerCount });
      });
      child.stderr.on('data', chunk => {
        stderrBytes += chunk.length;
        const combined = stderrTail + chunk.toString('utf8');
        const category = sftpCategory(combined);
        stderrCategories.add(category);
        stderrTail = combined.slice(-128);
        emit('SFTP_STDERR', { category, bytes: stderrBytes });
      });
      child.once('close', (code, signal) => emit('SFTP_EXIT', {
        exitCode: Number.isInteger(code) ? code : null,
        signal: ['SIGTERM','SIGKILL'].includes(signal) ? signal : signal ? 'OTHER' : null,
        stdoutBytes, stderrBytes, pwdMarkers: markerCount,
        stderrCategories: [...stderrCategories].sort()
      }));
      return child;
    });
    phase = 'OPEN';
    emit('OPEN_START');
    const { openR3HostedEvidenceDelivery } = await import(`${ADAPTER.href}?cross-host-diagnostic=${ctx.runId}`);
    delivery = await openR3HostedEvidenceDelivery({ creationSpecBytes: input, jobAdmissionBytes: input });
    emit('OPENED');
    const start = performance.now();
    await new Promise(resolve => setTimeout(resolve, 300000));
    assert(performance.now() - start >= 300000);
    emit('IDLE_COMPLETE', { elapsedMs: Math.floor(performance.now() - start) });
    emit('SEND_START');
    const result = await delivery.sendCreation(PAYLOAD);
    assert.equal(result.digest, PAYLOAD_DIGEST);
    assert.equal(result.bytes, PAYLOAD.length);
    emit('SEND_COMPLETE', { category: 'ADAPTER_RETURNED' });
    await delivery.close();
    delivery = null;
    emit('CLOSED');
  } catch (error) {
    primary = error;
    emit(phase === 'BOOTSTRAP' ? 'BOOTSTRAP_FAILED' : 'FAILED', { category: safeError(error) });
  } finally {
    if (delivery) {
      try { await delivery.close(); emit('CLOSE_AFTER_FAILURE', { category: 'PASS' }); }
      catch (error) { emit('CLOSE_AFTER_FAILURE', { category: safeError(error) }); }
    }
    mock?.restoreAll();
  }
  if (primary) process.exitCode = 1;
}

async function run(ctx) {
  const f = files(ctx);
  await checkAdapter();
  await readIntent(ctx, f);
  const descriptor = await readJson(f.publicDescriptor);
  assert.deepEqual(Object.keys(descriptor).sort(), [
    'schemaVersion','repositoryId','workflowPath','ref','sourceSha','runId',
    'runAttempt','expiresAt','publicKey','publicKeyRawDigest','payloadDigest'
  ].sort());
  assert.equal(descriptor.schemaVersion, 'stage1-r3-sftp-diagnostic-public-key.v1');
  assert.equal(descriptor.repositoryId, REPOSITORY_ID);
  assert.equal(descriptor.workflowPath, WORKFLOW);
  assert.equal(descriptor.runAttempt, 1);
  assert.equal(descriptor.runId, ctx.runId);
  assert.equal(descriptor.sourceSha, ctx.sourceSha);
  assert.equal(descriptor.ref, BRANCH);
  assert.equal(descriptor.payloadDigest, PAYLOAD_DIGEST);
  assert.match(descriptor.expiresAt, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.000Z$/u);
  assert.match(descriptor.publicKey, /^ssh-ed25519 [A-Za-z0-9+/]+={0,2}$/u);
  assert.equal(sha(Buffer.from(`${descriptor.publicKey}\n`)), descriptor.publicKeyRawDigest);
  assert.equal(sha(await fs.readFile(f.publicKey)), descriptor.publicKeyRawDigest);
  assert(Date.now() + 540000 < Date.parse(descriptor.expiresAt));
  await writeOnce(f.started, { status: 'STARTED', at: new Date().toISOString() });
  const events = [];
  const child = childProcess.fork(fileURLToPath(import.meta.url), ['worker'], {
    silent: true, detached: true, env: process.env
  });
  let stage = 'OPEN_START', ready = false, readinessExpired = false, overallExpired = false;
  let stderrBytes = 0, stdoutBytes = 0;
  const started = performance.now();
  let droppedEvents = 0;
  const keyStages = new Set(['OPEN_START','OPENED','IDLE_COMPLETE','SEND_START','SEND_COMPLETE','CLOSED','FAILED','CLOSE_AFTER_FAILURE','SFTP_EXIT']);
  const push = event => {
    if (events.length < 4000) events.push(event);
    else if (keyStages.has(event.stage)) {
      const replace = events.findIndex(item => !keyStages.has(item.stage));
      if (replace >= 0) { events.splice(replace, 1); events.push(event); droppedEvents++; }
      else droppedEvents++;
    } else droppedEvents++;
  };
  const stopGroup = () => {
    if (!Number.isInteger(child.pid) || child.pid <= 0) return;
    try { process.kill(-child.pid, 'SIGTERM'); } catch {}
    setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 5000).unref();
  };
  const readiness = setTimeout(() => {
    readinessExpired = true; stopGroup();
  }, 180000);
  let overall = setTimeout(() => {
    overallExpired = true; stopGroup();
  }, 600000);
  child.stdout.on('data', chunk => { stdoutBytes += chunk.length; });
  child.stderr.on('data', chunk => { stderrBytes += chunk.length; });
  child.once('error', () => { stage = 'WORKER_SPAWN_FAILED'; });
  child.on('message', message => {
    if (!message || message.type !== 'EVENT' || typeof message.stage !== 'string') return;
    if (message.stage === 'OPENED' && !ready) {
      ready = true;
      clearTimeout(readiness);
      clearTimeout(overall);
      overall = setTimeout(() => { overallExpired = true; stopGroup(); }, 400000);
    }
    stage = message.stage;
    const { type, ...event } = message;
    push(event);
  });
  const exit = await new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
  clearTimeout(readiness);
  clearTimeout(overall);
  const groupGone = () => {
    if (!Number.isInteger(child.pid) || child.pid <= 0) return false;
    try { process.kill(-child.pid, 0); return false; }
    catch (error) { return error.code === 'ESRCH'; }
  };
  let processGroupGone = groupGone();
  for (let attempt = 0; !processGroupGone && attempt < 50; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 100));
    processGroupGone = groupGone();
  }
  if (!processGroupGone) {
    try { process.kill(-child.pid, 'SIGKILL'); } catch {}
    for (let attempt = 0; !processGroupGone && attempt < 10; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 100));
      processGroupGone = groupGone();
    }
  }
  const completed = exit.code === 0 && stage === 'CLOSED' && !readinessExpired && !overallExpired && processGroupGone;
  const summary = {
    schemaVersion: 'stage1-r3-cross-host-sftp-diagnostic.v1',
    status: completed ? 'ADAPTER_SEND_AND_CLOSE_RETURNED_H1_READBACK_PENDING' : 'UNKNOWN_SUBSTAGE',
    runId: ctx.runId, sourceSha: ctx.sourceSha, payloadDigest: PAYLOAD_DIGEST,
    stage, readinessExpired, overallExpired, opened: ready, processGroupGone, droppedEvents,
    childExitCode: Number.isInteger(exit.code) ? exit.code : null,
    childSignal: ['SIGKILL','SIGTERM'].includes(exit.signal) ? exit.signal : exit.signal ? 'OTHER' : null,
    stdoutBytes, stderrBytes, elapsedMs: Math.floor(performance.now() - started),
    observedAt: new Date().toISOString()
  };
  await writeOnce(f.events, { schemaVersion: 'stage1-r3-cross-host-sftp-events.v1', droppedEvents, events }, 0o644);
  await writeOnce(f.summary, summary, 0o644);
  if (!completed) process.exitCode = 1;
}

async function cleanup(ctx) {
  const f = files(ctx);
  let status = 'NO_PREPARED_KEY';
  try {
    const dir = await fs.lstat(ctx.directory);
    assert(dir.isDirectory() && dir.uid === 0 && dir.gid === 0 && (dir.mode & 0o777) === 0o700);
    await readIntent(ctx, f);
    const names = await fs.readdir(ctx.directory);
    assert(names.every(name => new Set([
      'intent.json','run.started','forwarding.key','forwarding.key.pub','transfer'
    ]).has(name)));
    for (const file of [f.key, f.publicKey]) {
      try {
        const held = await fs.lstat(file);
        assert(held.isFile() && held.uid === 0 && held.gid === 0 && held.nlink === 1);
        await fs.unlink(file);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
    status = 'FIXED_LOCAL_KEY_FILES_REMOVED';
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  await fs.mkdir(OUTPUT, { recursive: true, mode: 0o755 });
  await writeOnce(f.cleanup, { schemaVersion: 'stage1-r3-sftp-local-cleanup.v1',
    status, runId: ctx.runId, at: new Date().toISOString() }, 0o644);
  process.stdout.write(`${status}\n`);
}

try {
  assert.equal(process.argv.length, 3);
  const ctx = context();
  if (process.argv[2] === 'prepare') await prepare(ctx);
  else if (process.argv[2] === 'worker') await worker(ctx);
  else if (process.argv[2] === 'run') await run(ctx);
  else if (process.argv[2] === 'cleanup') await cleanup(ctx);
  else throw new Error('MODE_INVALID');
} catch (error) {
  if (process.argv[2] === 'run') {
    try {
      const ctx = context();
      await fs.mkdir(OUTPUT, { recursive: true, mode: 0o755 });
      const f = files(ctx);
      await writeOnce(f.events, {
        schemaVersion: 'stage1-r3-cross-host-sftp-events.v1', events: []
      }, 0o644).catch(() => {});
      await writeOnce(f.summary, {
        schemaVersion: 'stage1-r3-cross-host-sftp-diagnostic.v1',
        status: 'UNKNOWN_SUBSTAGE', stage: 'RUN_PREFLIGHT', category: safeError(error),
        runId: ctx.runId, sourceSha: ctx.sourceSha, payloadDigest: PAYLOAD_DIGEST,
        observedAt: new Date().toISOString()
      }, 0o644).catch(() => {});
    } catch {}
  }
  process.stderr.write(`DIAGNOSTIC_FAILED_${safeError(error)}\n`);
  process.exitCode = 1;
}
