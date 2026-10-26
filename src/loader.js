import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { decrypt } from './crypto.js';

const gltfLoader = new GLTFLoader();
gltfLoader.setMeshoptDecoder(MeshoptDecoder);

export function parseGLB(buffer) {
  return gltfLoader.parseAsync(buffer, '');
}

// Fetch with byte progress: onProgress(loaded, total). total is 0 when the server doesn't send a length.
export async function fetchBytes(url, onProgress) {
  const res = await fetch(url);
  if (!res.ok) {
    const err = new Error(`${url}: HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  const total = Number(res.headers.get('Content-Length')) || 0;
  if (!res.body || !onProgress) return res.arrayBuffer();

  const reader = res.body.getReader();
  const chunks = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;
    onProgress(loaded, total);
  }
  const out = new Uint8Array(loaded);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out.buffer;
}

// Where the tour files come from:
//  - plain (dev server only): ../export via the /__export/ middleware in vite.config.js
//  - encrypted: public/models/<name>.enc and public/spawns.json.enc
export class AssetSource {
  constructor({ plain, password }) {
    this.plain = plain;
    this.password = password;
  }

  url(name) {
    if (this.plain) return `__export/${name}`;
    return name.endsWith('.json') ? `${name}.enc` : `models/${name}.enc`;
  }

  async bytes(name, onProgress) {
    const data = await fetchBytes(this.url(name), onProgress);
    return this.plain ? data : decrypt(data, this.password);
  }

  async json(name) {
    return JSON.parse(new TextDecoder().decode(await this.bytes(name)));
  }
}

// Sums byte progress over several downloads into one 0..1 figure.
export class Progress {
  constructor(onChange) {
    this.files = new Map();
    this.onChange = onChange;
  }

  track(name) {
    this.files.set(name, { loaded: 0, total: 0 });
    return (loaded, total) => {
      this.files.set(name, { loaded, total });
      let l = 0;
      let t = 0;
      for (const f of this.files.values()) {
        l += f.loaded;
        t += Math.max(f.total, f.loaded);
      }
      this.onChange(t ? l / t : 0, l);
    };
  }
}
