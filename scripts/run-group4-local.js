#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
const requestedTimeout = Number(process.env.TEST_FILE_TIMEOUT_MS || 60000);
const timeout = Number.isInteger(requestedTimeout) && requestedTimeout >= 1000
  ? requestedTimeout : 60000;
const groupNames = ['group4'];
const groups = [];

for (const groupName of groupNames) {
  const listPath = path.join(root, groupName);
  if (!fs.existsSync(listPath)) {
    console.error(`Missing curated test list: ${groupName}`);
    process.exit(2);
  }

  const files = fs.readFileSync(listPath, 'utf8')
    .split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const missing = files.filter(file => !fs.existsSync(path.join(root, file)));

  if (missing.length) {
    console.error(`${groupName} references missing files: ${missing.join(', ')}`);
    process.exit(2);
  }
  groups.push({ name: groupName, files });
}

const listed = groups.flatMap(group => group.files);
if (new Set(listed).size !== listed.length) {
  console.error('A test file appears in more than one group.');
  process.exit(2);
}

const testDir = path.join(root, 'test');
const allTests = fs.readdirSync(testDir)
  .filter(name => name.endsWith('.test.js'))
  .map(name => `test/${name}`);
const missingTests = allTests.filter(file => !listed.includes(file));
const unknownTests = listed.filter(file => !allTests.includes(file));

if (groupNames.length === 7 && (missingTests.length || unknownTests.length)) {
  console.error(
    `Test lists mismatch. Missing: ${missingTests.join(', ') || 'none'}. ` +
    `Unknown: ${unknownTests.join(', ') || 'none'}.`
  );
  process.exit(2);
}

const totals = { files: 0, tests: 0, pass: 0, fail: 0, skipped: 0 };
const failures = [];

// Test files may launch CLI/server child processes that inherit stdout/stderr.
// Killing only the node --test parent can leave descendants alive and keep the
// pipe open, blocking the batch runner instead of advancing to the next file.
function terminateProcessTree(child, signal) {
  if (!child || !child.pid) return;
  if (process.platform === 'win32') {
    if (signal === 'SIGKILL' || signal === 'SIGTERM') {
      spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' });
    }
    return;
  }
  try { process.kill(-child.pid, signal); }
  catch (_) { try { child.kill(signal); } catch (_) { /* already exited */ } }
}

function runFile(file) {
  return new Promise(resolve => {
    const child = spawn(
      process.execPath,
      ['--test', '--test-concurrency=1', file],
      {
        cwd: root,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, BOT_DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'bot-test-data-')), NO_COLOR: '1', FORCE_COLOR: '0' }
      }
    );

    let output = '';
    let timedOut = false;
    let settled = false;
    let forceTimer;

    const finish = result => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (forceTimer) clearTimeout(forceTimer);
      resolve(result);
    };

    child.stdout.on('data', chunk => {
      const text = chunk.toString();
      output += text;
      process.stdout.write(text);
    });
    child.stderr.on('data', chunk => {
      const text = chunk.toString();
      output += text;
      process.stderr.write(text);
    });

    const timer = setTimeout(() => {
      timedOut = true;
      terminateProcessTree(child, 'SIGTERM');
      forceTimer = setTimeout(() => {
        terminateProcessTree(child, 'SIGKILL');
        // Some descendants may escape the original process group and keep the
        // inherited stdout/stderr pipes open. Do not wait forever for `close`:
        // close our pipe ends and settle the file as timed out deterministically.
        const number = name => {
          const regex = new RegExp('^(?:#|ℹ)\\s+' + name + '\\s+(\\d+)\\s*$', 'gm');
          const matches = [...output.matchAll(regex)];
          return matches.length ? Number(matches[matches.length - 1][1]) : 0;
        };
        const stats = { tests: number('tests'), pass: number('pass'), fail: number('fail'), skipped: number('skipped') };
        try { child.stdout.destroy(); } catch (_) {}
        try { child.stderr.destroy(); } catch (_) {}
        finish({ ok: false, reason: `timed out after ${timeout}ms (forced close)`, output, stats });
      }, 1500);
    }, timeout);

    child.once('error', error => {
      finish({ ok: false, reason: error.message, output });
    });

    child.once('close', (code, signal) => {
      const number = name => {
        const regex = new RegExp(
          '^(?:#|ℹ)\\s+' + name + '\\s+(\\d+)\\s*$',
          'gm'
        );
        const matches = [...output.matchAll(regex)];
        return matches.length ? Number(matches[matches.length - 1][1]) : 0;
      };

      const stats = {
        tests: number('tests'),
        pass: number('pass'),
        fail: number('fail'),
        skipped: number('skipped')
      };

      if (timedOut) {
        finish({ ok: false, reason: `timed out after ${timeout}ms`, output, stats });
      } else if (code !== 0) {
        finish({
          ok: false,
          reason: signal ? `terminated by ${signal}` : `exit code ${code}`,
          output,
          stats
        });
      } else if (stats.tests === 0) {
        finish({ ok: false, reason: 'test summary could not be parsed', output, stats });
      } else {
        finish({ ok: true, output, stats });
      }
    });
  });
}

async function main() {
  console.log(
    `Isolated batched test run: ${listed.length} files in ${groups.length} groups; ` +
    `timeout ${timeout}ms/file.`
  );

  for (const group of groups) {
    console.log(`\n===== ${group.name.toUpperCase()} (${group.files.length} files) =====`);

    for (const file of group.files) {
      console.log(`\n--- ${file} ---`);
      const result = await runFile(file);
      totals.files++;

      if (result.stats) {
        for (const key of ['tests', 'pass', 'fail', 'skipped']) {
          totals[key] += result.stats[key];
        }
      }

      if (!result.ok) {
        console.error(`${file} FAILED: ${result.reason}`);
        failures.push({ file, reason: result.reason });
      } else {
        console.log(
          `${file}: process passed; tests=${result.stats.tests}, ` +
          `pass=${result.stats.pass}, fail=${result.stats.fail}, ` +
          `skipped=${result.stats.skipped}`
        );
      }
    }
  }

  console.log(
    `\nTOTAL: files=${totals.files}/${listed.length}, tests=${totals.tests}, ` +
    `pass=${totals.pass}, fail=${totals.fail}, skipped=${totals.skipped}`
  );

  if (failures.length) {
    console.error(`ISOLATED BATCH FAILED: ${failures.length} file(s) failed or timed out.`);
    for (const item of failures) console.error(`- ${item.file}: ${item.reason}`);
    process.exitCode = 1;
  } else {
    console.log('ISOLATED BATCH COMPLETE: all test files exited successfully.');
  }
}

main().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
