import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { AssetSource, Progress, parseGLB } from './loader.js';
import { Body, buildOctree, collisionPatches } from './collision.js';
import { Controls, SPEEDS } from './controls.js';
import { PLAN, ROOM_NAMES, SITE_CENTRE as CENTRE } from './site.js';
import './style.css';

const $ = (id) => document.getElementById(id);
const touch = matchMedia('(pointer: coarse)').matches;
// Dev server reads plaintext from ../export; add ?enc to test the encrypted files instead.
const plain = import.meta.env.DEV && !new URLSearchParams(location.search).has('enc');

const VARIANTS = {
  furnished: { label: 'Furnished', house: 'house_furnished.glb', collision: ['collision.glb', 'collision_furniture.glb'] },
  unfurnished: { label: 'Unfurnished', house: 'house_unfurnished.glb', collision: ['collision.glb'] },
};

// Texture detail. The 4k bakes need ~1.3 GB of GPU memory, which crashes phones and many laptops,
// so phones start on 1k and computers on 2k (texture_tiers.py makes the _1k/_2k GLBs).
const DETAILS = [
  { label: 'Low', suffix: '_1k', side: 1024 },
  { label: 'Standard', suffix: '_2k', side: 2048 },
  { label: 'High', suffix: '', side: 4096 },
];


// ---------- renderer ----------
const renderer = new THREE.WebGLRenderer({ antialias: !touch, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, touch ? 1.5 : 2));
renderer.setSize(innerWidth, innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.NoToneMapping; // bakes are already tone-mapped sRGB
$('app').appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xcfe0ee);
// Only the live PBR materials (glass, mirror, water, leaves) use this; baked meshes are unlit.
scene.environment = new THREE.PMREMGenerator(renderer).fromScene(new RoomEnvironment(), 0.04).texture;

const camera = new THREE.PerspectiveCamera(65, innerWidth / innerHeight, 0.05, 500);
camera.rotation.order = 'YXZ';

// Zoom narrows or widens the walking view: 1 = normal, up to 4× in, out to 0.75×.
// In the aerial view it moves the camera nearer or further instead.
const ZOOM_MIN = 0.75;
const ZOOM_MAX = 4;
let zoom = 1;

function resize() {
  const aspect = innerWidth / innerHeight;
  camera.aspect = aspect;
  // 65° vertical on landscape; on portrait phones about 60° across, capped at 90° vertical.
  const portrait = THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(30)) / aspect));
  const base = aspect >= 1 ? 65 : Math.min(90, Math.max(65, portrait));
  const z = orbit ? 1 : zoom;
  camera.fov = THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(base / 2)) / z));
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
}
addEventListener('resize', resize);

// ---------- state ----------
const body = new Body();
const controls = new Controls(camera, renderer.domElement, { touch });
const wish = new THREE.Vector3();
let source;
let spawns = [];
let walkthrough = []; // boxes where collision is dropped (door leaves, floor plants)
let currentSpawn;
let lastInside = null; // pose to come back to from outside
let lastOutside = null;
let inside = true;
let variant;
let house; // the scene object currently shown
let octree;
let orbit = null; // aerial view state while it's on
resize();
let switching = false;
let detail = touch ? 0 : 1;
const houseBytes = new Map(); // decrypted GLBs, so switching back skips the download
const collisionScenes = new Map();
const octrees = new Map();

// ---------- loading ----------
function showLoading(text, fraction) {
  $('loading').hidden = false;
  $('loading-text').textContent = text;
  $('loading-bar').style.width = `${Math.round((fraction ?? 0) * 100)}%`;
}

function hideLoading() {
  $('loading').hidden = true;
}

async function loadCollision(name, track) {
  if (!collisionScenes.has(name)) collisionScenes.set(name, (await parseGLB(await source.bytes(name, track))).scene);
  return collisionScenes.get(name);
}

async function loadOctree(v, progress) {
  if (!octrees.has(v)) {
    const scenes = await Promise.all(VARIANTS[v].collision.map((n) => loadCollision(n, progress.track(n))));
    octrees.set(v, buildOctree([...scenes, collisionPatches()], walkthrough));
  }
  return octrees.get(v);
}

function houseFile(v) {
  return VARIANTS[v].house.replace('.glb', `${DETAILS[detail].suffix}.glb`);
}

// Downloads (or takes from the cache) the house bytes; null in dev when the GLBs aren't exported yet.
async function houseData(v, progress) {
  const name = houseFile(v);
  if (!houseBytes.has(name)) {
    try {
      houseBytes.set(name, await source.bytes(name, progress.track(name)));
    } catch (err) {
      if (!(plain && err.status === 404)) throw err;
      return null;
    }
  }
  return houseBytes.get(name);
}

async function parseHouse(data) {
  if (!data) return collisionPreview();
  const gltf = await parseGLB(data);
  prepareHouse(gltf.scene);
  return gltf.scene;
}

// Upload the textures now and drop the decoded copies, so each image isn't held twice in memory.
function uploadTextures(root) {
  root.traverse((o) => {
    if (!o.isMesh) return;
    for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
      for (const t of Object.values(m)) {
        if (!t?.isTexture || !(t.image instanceof ImageBitmap)) continue;
        renderer.initTexture(t);
        t.image.close();
      }
    }
  });
}

function prepareHouse(root) {
  const aniso = renderer.capabilities.getMaxAnisotropy();
  root.traverse((o) => {
    if (!o.isMesh) return;
    for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
      if (m.isMeshBasicMaterial) {
        // KHR_materials_unlit bake: already in the right form; sharpen floors at grazing angles.
        if (m.map) m.map.anisotropy = Math.min(8, aniso);
      } else if (m.name === 'LIVE_Leaves') {
        // Exported as BLEND, but a cutout sorts correctly against itself.
        m.transparent = false;
        m.alphaTest = 0.5;
        m.depthWrite = true;
      } else if (m.transparent || m.opacity < 1) {
        m.depthWrite = false;
      }
    }
  });
}

function collisionPreview() {
  const root = collisionScenes.get('collision.glb').clone();
  const mat = new THREE.MeshNormalMaterial({ flatShading: true, side: THREE.DoubleSide }); // collision GLB has no normals
  root.traverse((o) => o.isMesh && (o.material = mat));
  root.userData.disposable = false; // shares geometry with the cached collision scene
  $('dev-note').hidden = false;
  return root;
}

function disposeTree(root) {
  root.traverse((o) => {
    if (!o.isMesh) return;
    o.geometry.dispose();
    for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
      for (const v of Object.values(m)) if (v?.isTexture) v.dispose();
      m.dispose();
    }
  });
}

// Swap the visible house and collision; the player keeps position and view.
// Only one variant stays on the GPU (4k bakes are large); the other is kept as bytes.
async function setVariant(v, { reload = false } = {}) {
  if (switching || (v === variant && !reload)) return;
  switching = true;
  $('toggle').disabled = true;
  try {
    const what = `${VARIANTS[v].label.toLowerCase()} house`;
    const progress = new Progress((f) =>
      showLoading(f < 1 ? `Loading ${what}… ${Math.round(f * 100)}%` : `Unpacking ${what}…`, f),
    );
    showLoading(`Loading ${what}…`, 0);
    const nextOctree = await loadOctree(v, progress); // small; the dev preview below reuses it
    const data = await houseData(v, progress);
    // Free the old house before unpacking the new one, so the two are never in memory together.
    if (house) {
      scene.remove(house);
      if (house.userData.disposable !== false) disposeTree(house);
      house = null;
    }
    house = await parseHouse(data);
    uploadTextures(house);
    scene.add(house);
    octree = nextOctree;
    variant = v;
    const other = v === 'furnished' ? 'unfurnished' : 'furnished';
    $('toggle').textContent = `Show ${VARIANTS[other].label.toLowerCase()}`;
    $('toggle').dataset.next = other;
    hideLoading();
  } catch (err) {
    console.error(err);
    showLoading(`Could not load the house (${err.message}). Refresh to try again.`, 0);
  } finally {
    switching = false;
    $('toggle').disabled = false;
  }
}

// ---------- rooms ----------
function roomName(s) {
  return ROOM_NAMES[s.label] ?? s.label;
}

// Outdoor viewpoints come without a floor height; stand on whatever is under them.
function floorAt(x, z) {
  const hit = octree?.rayIntersect(new THREE.Ray(new THREE.Vector3(x, 2.2, z), new THREE.Vector3(0, -1, 0)));
  return hit ? 2.2 - hit.distance : 0;
}

function place(s) {
  if (orbit) setAerial(false);
  currentSpawn = s;
  controls.target = null;
  body.placeAt(s.eye[0], s.floor_y ?? floorAt(s.eye[0], s.eye[2]), s.eye[2]);
  camera.rotation.set(s.pitch, s.yaw, 0);
  camera.position.copy(body.eye);
  updateInside();
}

// Jump with a short fade, so the cut doesn't disorient.
let fading = false;
async function fadeTo(change) {
  if (fading) return;
  fading = true;
  $('fade').classList.add('on');
  await new Promise((r) => setTimeout(r, 220));
  change();
  $('fade').classList.remove('on');
  fading = false;
}

function goTo(s) {
  return fadeTo(() => place(s));
}

function pose() {
  return { eye: [body.eye.x, 0, body.eye.z], floor_y: body.feetY, yaw: camera.rotation.y, pitch: camera.rotation.x, group: inside ? 'inside' : 'outside' };
}

function menuButton(s) {
  const b = document.createElement('button');
  b.textContent = roomName(s);
  b.addEventListener('click', () => {
    goTo(s);
    setMenu(false);
  });
  return b;
}

function buildMenu() {
  buildPlanLabels();
  const groups = [
    ['Inside', spawns.filter((s) => s.group !== 'outside')],
    ['Outside', spawns.filter((s) => s.group === 'outside')],
  ].filter(([, list]) => list.length);
  $('rooms').replaceChildren(
    ...groups.map(([title, list]) => {
      const section = document.createElement('section');
      const h = document.createElement('h2');
      h.textContent = title;
      section.append(h, ...list.map(menuButton));
      if (title === 'Outside') {
        const aerial = document.createElement('button');
        aerial.textContent = 'Aerial view (whole house)';
        aerial.addEventListener('click', () => !orbit && toggleAerial());
        h.after(aerial);
      }
      return section;
    }),
  );
  $('inout').hidden = !spawns.some((s) => s.group === 'outside');
}

// Inside = under one of the interior chunks' ceilings (the braai lean-to and pergola count as outside).
const INTERIOR = /^House_(MainSuite|Bedrooms|Living|Dining|Kitchen|Service|Garage)$/;
const AROUND = [[0, 0], [0.4, 0], [-0.4, 0], [0, 0.4], [0, -0.4]];
const upRay = new THREE.Raycaster(new THREE.Vector3(), new THREE.Vector3(0, 1, 0), 0, 6);
function updateInside() {
  if (!house || orbit) return;
  const ceilings = [];
  house.traverse((o) => o.isMesh && INTERIOR.test(o.name) && ceilings.push(o));
  // A few spots around the eye, so standing in a doorway (under the door head) still counts.
  inside = !ceilings.length || AROUND.some(([dx, dz]) => {
    upRay.ray.origin.set(body.eye.x + dx, body.eye.y, body.eye.z + dz);
    return upRay.intersectObjects(ceilings, false).length > 0;
  });
  if (inside) lastInside = pose();
  else lastOutside = pose();
  $('inout').textContent = inside ? 'Go outside' : 'Go inside';
}

function toggleInOut() {
  if (orbit) return goTo(lastInside ?? spawns[0]);
  updateInside();
  if (inside) goTo(lastOutside ?? spawns.find((s) => s.group === 'outside'));
  else goTo(lastInside ?? spawns[0]);
}

function setMenu(open) {
  $('menu').hidden = !open;
  $('menu-btn').setAttribute('aria-expanded', String(open));
}

function setHelp(open) {
  $('help').hidden = !open;
  $('help-btn').setAttribute('aria-expanded', String(open));
}

$('menu-btn').addEventListener('click', () => {
  setHelp(false);
  setMenu($('menu').hidden);
});
$('help-btn').addEventListener('click', () => {
  setMenu(false);
  setHelp($('help').hidden);
});
$('toggle').addEventListener('click', () => setVariant($('toggle').dataset.next));
$('inout').addEventListener('click', toggleInOut);
addEventListener('keydown', (e) => {
  if (!controls.enabled || e.target instanceof HTMLInputElement || e.metaKey || e.ctrlKey) return;
  if (e.code === 'KeyF') setVariant(variant === 'furnished' ? 'unfurnished' : 'furnished');
  if (e.code === 'KeyR') setMenu($('menu').hidden);
  if (e.code === 'KeyM') setMap($('map').hidden);
  if (e.code === 'KeyV') toggleAerial();
  if (e.code === 'Equal' || e.code === 'NumpadAdd') setZoom(1.4);
  if (e.code === 'Minus' || e.code === 'NumpadSubtract') setZoom(1 / 1.4);
  if (e.code === 'Digit1' || e.code === 'Digit2' || e.code === 'Digit3') setSpeed(Number(e.code.at(-1)) - 1);
  if (e.code === 'KeyO') toggleInOut();
  if (e.code === 'KeyL') setDetail(detail + 1);
  if (e.code === 'Slash' || e.code === 'KeyH') setHelp($('help').hidden);
  if (e.code === 'Escape') {
    setMenu(false);
    setHelp(false);
    setMap(false);
  }
});

// ---------- click / tap to walk ----------
const ray = new THREE.Ray();
const ndc = new THREE.Vector2();
const normal = new THREE.Vector3();
const MAX_GLIDE = 30; // m

// Where a click lands: a floor spot to walk to, or null.
function pick(x, y) {
  if (!octree) return null;
  ndc.set((x / innerWidth) * 2 - 1, -(y / innerHeight) * 2 + 1);
  ray.origin.copy(camera.position);
  ray.direction.set(ndc.x, ndc.y, 0.5).unproject(camera).sub(camera.position).normalize();
  const hit = octree.rayIntersect(ray);
  if (!hit || (!orbit && hit.distance > MAX_GLIDE)) return null;
  hit.triangle.getNormal(normal);
  // Floors, treads and decks, not table tops or the far side of a wall: within a step of where you stand.
  if (Math.abs(normal.y) < 0.8 || (!orbit && Math.abs(hit.position.y - body.feetY) > 1.5)) return null;
  return hit.position;
}

const marker = new THREE.Mesh(
  new THREE.RingGeometry(0.16, 0.22, 40).rotateX(-Math.PI / 2),
  new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85, depthTest: false }),
);
marker.renderOrder = 10;
marker.visible = false;
scene.add(marker);

controls.addEventListener('hover', (e) => {
  const p = e.x == null ? null : pick(e.x, e.y);
  marker.visible = !!p;
  if (p) marker.position.copy(p).setY(p.y + 0.01);
  renderer.domElement.style.cursor = p ? 'pointer' : '';
});
controls.addEventListener('tap', (e) => {
  setMenu(false);
  setHelp(false);
  const p = pick(e.x, e.y);
  if (!p) return;
  if (orbit) {
    // Land on foot where you clicked, facing the way the aerial camera looks.
    const yaw = Math.atan2(-(p.x - camera.position.x), -(p.z - camera.position.z));
    goTo({ eye: [p.x, 0, p.z], floor_y: p.y, yaw, pitch: 0 });
    return;
  }
  controls.target = p.clone();
  glide.best = Infinity;
  glide.stuck = 0;
  marker.position.copy(p).setY(p.y + 0.01);
  marker.visible = true;
  dismissHint();
});
controls.addEventListener('input', dismissHint);

// ---------- zoom, speed ----------
function setZoom(z) {
  if (orbit) {
    orbit.dist = THREE.MathUtils.clamp(orbit.dist / z, 12, 120);
    return;
  }
  zoom = THREE.MathUtils.clamp(zoom * z, ZOOM_MIN, ZOOM_MAX);
  resize();
  $('zoom-level').textContent = `${zoom.toFixed(zoom < 1 ? 2 : 1).replace(/\.0+$/, '')}×`;
}
controls.addEventListener('zoom', (e) => setZoom(e.factor));
$('zoom-in').addEventListener('click', () => setZoom(1.4));
$('zoom-out').addEventListener('click', () => setZoom(1 / 1.4));

function setSpeed(i) {
  controls.speed = (i + SPEEDS.length) % SPEEDS.length;
  $('speed').textContent = `Speed: ${SPEEDS[controls.speed].label}`;
}
$('speed').addEventListener('click', () => setSpeed(controls.speed + 1));
setSpeed(1);

// High is left out where the GPU can't take 4096 textures.
function detailLevels() {
  return DETAILS.filter((d) => d.side <= renderer.capabilities.maxTextureSize).length;
}

function showDetail() {
  $('detail').textContent = `Detail: ${DETAILS[detail].label}`;
}

async function setDetail(i) {
  if (switching) return;
  detail = (i + detailLevels()) % detailLevels();
  showDetail();
  const keep = new Set(Object.keys(VARIANTS).map(houseFile)); // other levels' bytes aren't needed now
  for (const name of [...houseBytes.keys()]) if (!keep.has(name)) houseBytes.delete(name);
  if (variant) await setVariant(variant, { reload: true });
}
$('detail').addEventListener('click', () => setDetail(detail + 1));
detail = Math.min(detail, detailLevels() - 1);
showDetail();

// ---------- aerial view ----------
// Orbit around the whole site: drag to spin, zoom to come closer, click the ground to walk there.
const SITE_CENTRE = new THREE.Vector3(...CENTRE);
let walkPose = null;

function setAerial(on) {
  if (!!orbit === on) return;
  if (on) {
    walkPose = pose();
    controls.target = null;
    orbit = {
      theta: -0.6, // from the south-west
      phi: 0.6,
      dist: 48,
      rotate(dx, dy) {
        this.theta -= dx;
        this.phi = THREE.MathUtils.clamp(this.phi + dy, 0.08, 1.45);
      },
    };
    controls.orbit = orbit;
  } else {
    orbit = null;
    controls.orbit = null;
  }
  document.body.classList.toggle('aerial', on);
  $('inout').textContent = on || !inside ? 'Go inside' : 'Go outside';
  $('aerial').textContent = on ? 'Walk' : 'Aerial';
  $('aerial-note').hidden = !on;
  resize();
}

function updateOrbitCamera() {
  const { theta, phi, dist } = orbit;
  camera.position.set(
    SITE_CENTRE.x + Math.sin(theta) * Math.cos(phi) * dist,
    SITE_CENTRE.y + Math.sin(phi) * dist,
    SITE_CENTRE.z + Math.cos(theta) * Math.cos(phi) * dist,
  );
  camera.lookAt(SITE_CENTRE);
}

function toggleAerial() {
  setMenu(false);
  setHelp(false);
  setMap(false);
  if (!orbit) return fadeTo(() => setAerial(true));
  fadeTo(() => {
    setAerial(false);
    if (walkPose) place(walkPose);
  });
}
$('aerial').addEventListener('click', toggleAerial);
$('aerial-walk').addEventListener('click', toggleAerial);

// ---------- floor-plan map ----------
// Rendered from the loaded house: a top-down orthographic shot with the roof hidden and ceilings
// back-face culled. North is up. Rooms and outdoor spots are buttons; click anywhere else to go there.
let planFor = null; // variant the plan image was made from

function renderPlan() {
  const { x0, x1, z0, z1, ppm } = PLAN;
  const w = Math.round((x1 - x0) * ppm);
  const h = Math.round((z1 - z0) * ppm);
  const cam = new THREE.OrthographicCamera(-(x1 - x0) / 2, (x1 - x0) / 2, (z1 - z0) / 2, -(z1 - z0) / 2, 1, 100);
  cam.position.set((x0 + x1) / 2, 40, (z0 + z1) / 2);
  cam.up.set(0, 0, -1);
  cam.lookAt((x0 + x1) / 2, 0, (z0 + z1) / 2);

  const rt = new THREE.WebGLRenderTarget(w, h);
  rt.texture.colorSpace = THREE.SRGBColorSpace;
  const sides = new Map();
  house.traverse((o) => {
    if (!o.isMesh) return;
    for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
      sides.set(m, m.side);
      m.side = THREE.FrontSide; // ceilings face down, so they drop out from above
    }
  });
  const roof = house.getObjectByName('House_Roof');
  const background = scene.background;
  if (roof) roof.visible = false;
  marker.visible = false;
  scene.background = new THREE.Color(0x2b2e33);
  renderer.setRenderTarget(rt);
  renderer.render(scene, cam);
  renderer.setRenderTarget(null);
  scene.background = background;
  if (roof) roof.visible = true;
  for (const [m, side] of sides) m.side = side;

  const pixels = new Uint8Array(w * h * 4);
  renderer.readRenderTargetPixels(rt, 0, 0, w, h, pixels);
  rt.dispose();
  const canvas = $('plan');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(w, h);
  for (let y = 0; y < h; y++) img.data.set(pixels.subarray((h - 1 - y) * w * 4, (h - y) * w * 4), y * w * 4); // GL rows are bottom-up
  ctx.putImageData(img, 0, 0);
  planFor = variant;
  $('plan-wrap').style.setProperty('--plan-aspect', w / h);
}

// Percent across and down the plan; spots beyond it (street, back garden) sit on the edge.
const toPlan = (x, z) => [
  THREE.MathUtils.clamp(((x - PLAN.x0) / (PLAN.x1 - PLAN.x0)) * 100, 4, 96),
  THREE.MathUtils.clamp(((z - PLAN.z0) / (PLAN.z1 - PLAN.z0)) * 100, 3, 97),
];

function buildPlanLabels() {
  $('plan-labels').replaceChildren(
    ...spawns.map((s) => {
      const b = document.createElement('button');
      const [left, top] = toPlan(...(s.map ?? [s.eye[0], s.eye[2]]));
      b.textContent = roomName(s);
      b.className = s.group === 'outside' ? 'out' : '';
      b.style.left = `${left}%`;
      b.style.top = `${top}%`;
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        setMap(false);
        goTo(s);
      });
      return b;
    }),
  );
}

function updateYouAreHere() {
  const p = orbit ? walkPose : pose();
  if (!p) return;
  const [left, top] = toPlan(p.eye[0], p.eye[2]);
  const you = $('you');
  you.style.left = `${left}%`;
  you.style.top = `${top}%`;
  you.style.transform = `translate(-50%, -50%) rotate(${-p.yaw}rad)`;
}

function setMap(open) {
  if (open && house && planFor !== variant) renderPlan();
  if (open) updateYouAreHere();
  $('map').hidden = !open;
  $('map-btn').setAttribute('aria-expanded', String(open));
}

$('map-btn').addEventListener('click', () => {
  setMenu(false);
  setHelp(false);
  setMap($('map').hidden);
});
$('map-close').addEventListener('click', () => setMap(false));
$('map').addEventListener('click', (e) => e.target === $('map') && setMap(false));
$('plan-wrap').addEventListener('click', (e) => {
  // Anywhere on the plan: stand there (on whatever floor is under that spot), keeping the view direction.
  const r = $('plan-wrap').getBoundingClientRect();
  const x = PLAN.x0 + ((e.clientX - r.left) / r.width) * (PLAN.x1 - PLAN.x0);
  const z = PLAN.z0 + ((e.clientY - r.top) / r.height) * (PLAN.z1 - PLAN.z0);
  const hit = octree?.rayIntersect(new THREE.Ray(new THREE.Vector3(x, 2.2, z), new THREE.Vector3(0, -1, 0)));
  if (!hit) return;
  setMap(false);
  const yaw = orbit ? walkPose?.yaw ?? 0 : camera.rotation.y;
  goTo({ eye: [x, 0, z], floor_y: 2.2 - hit.distance + 0.02, yaw, pitch: 0 });
});

// The hint goes once you've moved; ? brings the full help back.
function dismissHint() {
  $('hint').classList.add('gone');
}

// ---------- start ----------
async function start(password) {
  source = new AssetSource({ plain, password });
  const doc = await source.json('spawns.json'); // wrong password fails here, before the big downloads
  spawns = doc.spawns;
  walkthrough = doc.walkthrough ?? [];
  $('gate').hidden = true;
  $('hud').hidden = false;
  if (touch) document.body.classList.add('touch');
  buildMenu();
  place(spawns[0]);
  await setVariant('furnished');
  updateInside();
  controls.enabled = true;
}

$('gate').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $('password');
  const button = e.submitter ?? $('gate').querySelector('button');
  $('gate-error').textContent = '';
  button.disabled = true;
  button.textContent = 'Unlocking…';
  try {
    await start(input.value);
    input.value = '';
  } catch (err) {
    console.error(err);
    $('gate-error').textContent =
      err.name === 'OperationError' ? 'Incorrect password.' : 'Could not reach the tour files. Check your connection and try again.';
  } finally {
    button.disabled = false;
    button.textContent = 'Enter';
  }
});

if (plain) start(null);
else $('password').focus();

// ---------- loop ----------
const SUBSTEPS = 5;
const glide = { best: Infinity, stuck: 0 }; // stop a click-walk that runs into something
let insideClock = 0;
const timer = new THREE.Timer();
timer.connect(document); // no huge delta after the tab was hidden
renderer.setAnimationLoop((time) => {
  timer.update(time);
  const dt = Math.min(timer.getDelta(), 0.05);
  if (orbit) {
    controls.update(dt); // Q/E spin the orbit
    updateOrbitCamera();
  } else if (octree && !switching) {
    controls.update(dt);
    controls.wish(wish, body.eye);
    for (let i = 0; i < SUBSTEPS; i++) body.step(dt / SUBSTEPS, wish, octree);
    if (body.eye.y < -15) place(currentSpawn); // fell through somewhere
    if (controls.target) {
      const d = Math.hypot(controls.target.x - body.eye.x, controls.target.z - body.eye.z);
      if (d < glide.best - 0.02) {
        glide.best = d;
        glide.stuck = 0;
      } else if ((glide.stuck += dt) > 0.5) controls.target = null;
    }
    if (!controls.target && !controls.drag && marker.visible && touch) marker.visible = false;
    if ((insideClock += dt) > 0.4) {
      insideClock = 0;
      updateInside();
    }
    // Ease the eye height so stair steps and step-ups don't jolt the view.
    const y = camera.position.y + (body.eye.y - camera.position.y) * (1 - Math.exp(-18 * dt));
    camera.position.set(body.eye.x, Math.abs(body.eye.y - y) > 0.5 ? body.eye.y : y, body.eye.z);
  }
  renderer.render(scene, camera);
});

// Handy in the console while testing: tour.goTo(tour.spawns[3]), tour.body.eye
if (import.meta.env.DEV) window.tour = { THREE, scene, body, camera, goTo, place, controls, pick, get inside() { return inside; }, get spawns() { return spawns; }, get octree() { return octree; }, setVariant };
