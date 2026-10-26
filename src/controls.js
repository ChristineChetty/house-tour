// Walking speeds (m/s) for the speed setting; Shift runs at 1.8×, click-to-walk glides at 1.2×.
export const SPEEDS = [
  { label: 'Slow', walk: 1.5 },
  { label: 'Normal', walk: 3 },
  { label: 'Fast', walk: 5 },
];
const TURN_RATE = 1.8; // rad/s for Q/E, ←/→ and the stick
const MAX_PITCH = Math.PI / 2 - 0.05;
const DRAG_PX = 6; // movement before a press counts as a drag rather than a click

// Drag anywhere to look (Street View style: the view follows the finger or mouse).
// Click or tap the floor to glide there. Keys: W/S or ↑/↓ walk, A/D step sideways,
// Q/E or ←/→ turn, Shift faster. Touch: one stick, up/down walks and left/right turns.
// Mouse wheel and two-finger pinch zoom. With `orbit` set (aerial view), dragging and turning
// go to orbit.rotate() instead and walking is off.
// Emits 'tap' ({ x, y } in client pixels), 'hover' ({ x, y } or null), 'zoom' ({ factor }, >1 = closer)
// and 'input' (any manual move).
export class Controls extends EventTarget {
  constructor(camera, canvas, { touch }) {
    super();
    this.camera = camera;
    this.canvas = canvas;
    this.touch = touch;
    this.enabled = false;
    this.keys = new Set();
    this.moveStick = { x: 0, y: 0 };
    this.target = null; // glide destination (THREE.Vector3, world), set by main.js
    this.drag = null;
    this.speed = 1; // index into SPEEDS
    this.orbit = null;
    const pinch = new Map(); // pointerId -> { x, y } while two fingers are down
    let pinchDist = 0;

    if (touch) new Joystick(document.getElementById('joy-move'), this.moveStick, () => this.dispatchEvent(new Event('input')));

    canvas.addEventListener('pointerdown', (e) => {
      if (!this.enabled || e.button > 0) return;
      pinch.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pinch.size === 2) {
        const [a, b] = [...pinch.values()];
        pinchDist = Math.hypot(a.x - b.x, a.y - b.y);
        if (this.drag) this.drag.moved = true; // a pinch is never a tap
      }
      if (this.drag) return;
      this.drag = { id: e.pointerId, x: e.clientX, y: e.clientY, moved: false };
      try {
        canvas.setPointerCapture(e.pointerId);
      } catch {
        // pointer already gone; pointerup/cancel still ends the drag
      }
    });
    canvas.addEventListener('pointermove', (e) => {
      if (pinch.has(e.pointerId)) pinch.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pinch.size === 2) {
        const [a, b] = [...pinch.values()];
        const dist = Math.hypot(a.x - b.x, a.y - b.y);
        if (pinchDist > 0) this.dispatchEvent(Object.assign(new Event('zoom'), { factor: dist / pinchDist }));
        pinchDist = dist;
        if (this.drag && e.pointerId === this.drag.id) {
          this.drag.x = e.clientX;
          this.drag.y = e.clientY;
        }
        return;
      }
      const d = this.drag;
      if (!d || e.pointerId !== d.id) {
        if (!d && !touch && this.enabled) this.dispatchEvent(Object.assign(new Event('hover'), { x: e.clientX, y: e.clientY }));
        return;
      }
      const dx = e.clientX - d.x;
      const dy = e.clientY - d.y;
      if (!d.moved && Math.hypot(dx, dy) < DRAG_PX) return;
      if (!d.moved) {
        d.moved = true;
        document.body.classList.add('dragging');
        this.dispatchEvent(Object.assign(new Event('hover'), { x: null, y: null }));
      }
      // One pixel = one pixel's worth of view angle, so the scene stays under the pointer.
      const k = (this.camera.fov * Math.PI) / 180 / innerHeight;
      this.look(dx * k, dy * k);
      d.x = e.clientX;
      d.y = e.clientY;
    });
    const end = (e) => {
      pinch.delete(e.pointerId);
      pinchDist = 0;
      const d = this.drag;
      if (!d || e.pointerId !== d.id) return;
      this.drag = null;
      document.body.classList.remove('dragging');
      if (!d.moved && e.type === 'pointerup') this.dispatchEvent(Object.assign(new Event('tap'), { x: e.clientX, y: e.clientY }));
    };
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);
    canvas.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        if (this.enabled) this.dispatchEvent(Object.assign(new Event('zoom'), { factor: Math.exp(-e.deltaY * 0.0015) }));
      },
      { passive: false },
    );
    canvas.addEventListener('pointerleave', () => !this.drag && this.dispatchEvent(Object.assign(new Event('hover'), { x: null, y: null })));

    addEventListener('keydown', (e) => {
      if (e.target instanceof HTMLInputElement || e.metaKey || e.ctrlKey) return;
      this.keys.add(e.code);
      if (MOVE_KEYS.has(e.code)) {
        e.preventDefault(); // arrows would scroll the menu
        this.dispatchEvent(new Event('input'));
      }
    });
    addEventListener('keyup', (e) => this.keys.delete(e.code));
    addEventListener('blur', () => this.keys.clear());
  }

  // Turn the view: yaw left by dx, pitch up by dy (radians).
  look(dx, dy) {
    if (this.orbit) return this.orbit.rotate(dx, dy);
    const r = this.camera.rotation;
    r.y += dx;
    r.x = Math.max(-MAX_PITCH, Math.min(MAX_PITCH, r.x + dy));
  }

  // Applies key and stick turning; call once per frame.
  update(dt) {
    if (!this.enabled) return;
    const k = this.keys;
    let turn = -this.moveStick.x * Math.abs(this.moveStick.x);
    if (k.has('KeyQ') || k.has('ArrowLeft')) turn += 1;
    if (k.has('KeyE') || k.has('ArrowRight')) turn -= 1;
    if (turn) this.look(turn * TURN_RATE * dt, 0);
  }

  // Desired horizontal velocity in world space (y stays 0). `from` is the body's eye, for gliding.
  wish(out, from) {
    out.set(0, 0, 0);
    if (!this.enabled || this.orbit) return out;
    const k = this.keys;
    let f = this.moveStick.y;
    let s = 0;
    if (k.has('KeyW') || k.has('ArrowUp')) f += 1;
    if (k.has('KeyS') || k.has('ArrowDown')) f -= 1;
    if (k.has('KeyD')) s += 1;
    if (k.has('KeyA')) s -= 1;
    if (f || s) {
      this.target = null;
      const len = Math.hypot(f, s);
      if (len > 1) {
        f /= len;
        s /= len;
      }
      const speed = SPEEDS[this.speed].walk * (k.has('ShiftLeft') || k.has('ShiftRight') ? 1.8 : 1);
      const yaw = this.camera.rotation.y;
      const sin = Math.sin(yaw);
      const cos = Math.cos(yaw);
      return out.set((-sin * f + cos * s) * speed, 0, (-cos * f - sin * s) * speed);
    }
    if (this.target) {
      out.set(this.target.x - from.x, 0, this.target.z - from.z);
      const dist = out.length();
      if (dist < 0.08) {
        this.target = null;
        return out.set(0, 0, 0);
      }
      out.setLength(Math.min(SPEEDS[this.speed].walk * 1.2, dist * 3)); // ease in to the stop
    }
    return out;
  }
}

const MOVE_KEYS = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);

// On-screen stick. Writes x (right +) and y (up +) in -1..1 into `out`.
class Joystick {
  constructor(el, out, onInput) {
    this.el = el;
    this.knob = el.querySelector('.knob');
    this.out = out;
    this.id = null;
    el.addEventListener('pointerdown', (e) => {
      this.id = e.pointerId;
      this.move(e);
      onInput();
      try {
        el.setPointerCapture(e.pointerId);
      } catch {
        // pointer already gone; the stick still resets on pointerup/cancel
      }
    });
    el.addEventListener('pointermove', (e) => e.pointerId === this.id && this.move(e));
    const end = (e) => {
      if (e.pointerId !== this.id) return;
      this.id = null;
      out.x = out.y = 0;
      this.knob.style.transform = '';
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
  }

  move(e) {
    const r = this.el.getBoundingClientRect();
    const radius = r.width / 2;
    let dx = (e.clientX - (r.left + radius)) / radius;
    let dy = (e.clientY - (r.top + radius)) / radius;
    const len = Math.hypot(dx, dy);
    if (len > 1) {
      dx /= len;
      dy /= len;
    }
    // Small dead zone on turning, so pushing straight up walks straight.
    this.out.x = Math.abs(dx) < 0.15 ? 0 : dx;
    this.out.y = -dy;
    this.knob.style.transform = `translate(${dx * radius * 0.6}px, ${dy * radius * 0.6}px)`;
  }
}
