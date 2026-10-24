#!/usr/bin/env node
const auth = require('../src/auth');
try { auth.ensureConfigured(); console.log(JSON.stringify(auth.status(), null, 2)); }
catch (e) { console.error(e.message); process.exit(1); }
