'use strict';

// Append-only runtime log. Captures every console method used by the bot so
// Termux output survives restarts and can be reviewed from one file.
const fs = require('fs');
const path = require('path');

let installed = false;
let logFile = null;
const ORIGINALS = {};

function redact(value) {
  let text;
  if (value instanceof Error) text = value.stack || `${value.name}: ${value.message}`;
  else if (typeof value === 'string') text = value;
  else {
    try { text = JSON.stringify(value); }
    catch (_) { text = String(value); }
  }
  return String(text)
    .replace(/(TELEGRAM_BOT_TOKEN\s*[=:]\s*)[^\s,;]+/gi, '$1[REDACTED]')
    .replace(/(BOT_TOKEN\s*[=:]\s*)[^\s,;]+/gi, '$1[REDACTED]')
    .replace(/(api[_-]?key\s*[=:]\s*)[^\s,;]+/gi, '$1[REDACTED]')
    .replace(/(api[_-]?secret\s*[=:]\s*)[^\s,;]+/gi, '$1[REDACTED]')
    .replace(/(password\s*[=:]\s*)[^\s,;]+/gi, '$1[REDACTED]');
}

function append(level, args) {
  if (!logFile) return;
  const entry = {
    time: new Date().toISOString(),
    level,
    message: args.map(redact).join(' ')
  };
  try { fs.appendFileSync(logFile, `${JSON.stringify(entry)}\n`, { encoding: 'utf8', mode: 0o600 }); }
  catch (err) {
    // Avoid using console here: that would recurse. Preserve app operation if
    // storage becomes unavailable; the original terminal output still works.
    try { process.stderr.write(`[runtimeLogger] log yazılamadı: ${err.message}\n`); } catch (_) {}
  }
}

function install(dataDir) {
  if (installed) return logFile;
  const dir = path.resolve(dataDir || path.join(process.cwd(), 'data'));
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  logFile = path.join(dir, 'bot.log');
  for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
    ORIGINALS[level] = console[level].bind(console);
    console[level] = (...args) => {
      append(level === 'log' ? 'info' : level, args);
      ORIGINALS[level](...args);
    };
  }
  installed = true;
  append('info', ['Runtime logging started', `file=${logFile}`]);
  return logFile;
}

module.exports = { install, redact };
