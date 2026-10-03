// Quake Town — the dev server for tests: the shell's config with the scratch public dir
// (tools/test/test-public.mjs). Copyright (C) 2026 Quake Town contributors. GPL-2.0-or-later.
import base from '../../vite.config.js';
export default { ...base, publicDir: '.cache/test-public', server: { ...base.server, port: 5191, fs: { allow: ['..', '../../arrr-mono'] } } };
