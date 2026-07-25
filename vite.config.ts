import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';

/**
 * Dev-only sink for canvas captures. The stage only draws inside a compositing
 * tab, so visual checks drive it manually and POST the frame here to be written
 * out for inspection. Not part of the production bundle or the deployed site.
 */
function frameCapture(): Plugin {
  return {
    name: 'stagelight-frame-capture',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__shot', (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405;
          res.end();
          return;
        }
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => {
          try {
            const { name, dataUrl } = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            const base64 = String(dataUrl).replace(/^data:image\/\w+;base64,/, '');
            const out = resolve(server.config.root, '.dev-shots', `${String(name).replace(/[^\w.-]/g, '_')}.png`);
            mkdirSync(dirname(out), { recursive: true });
            writeFileSync(out, Buffer.from(base64, 'base64'));
            res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify({ ok: true, out }));
          } catch (err) {
            res.statusCode = 400;
            res.end(String(err));
          }
        });
      });
    },
  };
}

export default defineConfig({
  plugins: [frameCapture()],
  build: {
    target: 'es2022',
    outDir: 'dist',
    assetsInlineLimit: 0,
  },
  worker: {
    format: 'es',
  },
});
