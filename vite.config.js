import { defineConfig } from 'vite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Plaintext stage 5 output. Only the dev server reads it (served at /__export/);
// builds use the encrypted copies in public/.
const EXPORT_DIR = fileURLToPath(new URL('../export', import.meta.url));

function devExport() {
  return {
    name: 'dev-export',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__export', (req, res) => {
        const file = path.join(EXPORT_DIR, path.basename(decodeURIComponent(req.url.split('?')[0])));
        if (!fs.existsSync(file)) {
          res.statusCode = 404;
          return res.end();
        }
        res.setHeader('Content-Type', file.endsWith('.json') ? 'application/json' : 'model/gltf-binary');
        res.setHeader('Content-Length', fs.statSync(file).size);
        res.setHeader('Cache-Control', 'no-store');
        fs.createReadStream(file).pipe(res);
      });
    },
  };
}

export default defineConfig({
  // Relative base works for any GitHub Pages project URL (https://<user>.github.io/<repo>/).
  base: './',
  plugins: [devExport()],
  build: { target: 'es2022', chunkSizeWarningLimit: 800 }, // three.js is ~660 kB
  // Localhost only: the dev server hands out the plaintext models. For a phone test on the
  // same Wi-Fi, run `npm run dev -- --host` briefly.
});
