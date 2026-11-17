import type { FastifyInstance } from 'fastify';

export const MANIFEST = {
  id: 'com.custom.losslesscloud',
  name: 'Lossless Cloud Audio',
  version: '1.0.0',
  resources: ['search', 'stream', 'isrc', 'resolve', 'settings', 'notifications'],
  types: ['track', 'album'],
  contentType: 'music',
  settings: [
    { key: 'torboxKey', type: 'text', label: 'TorBox API Key' },
    { key: 'cachedOnly', type: 'toggle', label: 'Instant Cache Only', default: true },
    { key: 'preferHiRes', type: 'toggle', label: 'Prefer 24-bit Hi-Res FLAC', default: true },
  ],
};

export async function manifestRoutes(app: FastifyInstance) {
  app.get('/manifest.json', async () => MANIFEST);
}
