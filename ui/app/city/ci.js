/* Ambient CI in the City (0.5), from ci_status (gh run list for each project's GitHub repo):
 *   - light rain from a small dark cloud over a building whose latest finished run failed;
 *   - a brief fireworks burst over a building when a run newly succeeds on its default branch.
 * Polled every 5 minutes while the City is on screen (and once when it opens, if older than that).
 * Layered per building on top of the city-wide weather (city/weather.js), never replacing it.
 * Reduced motion: the cloud and rain stand still, and there are no fireworks. Home city only. */
import { THREE, toonMaterial } from './toon.js';
import { ciSummary, newlyPassed, repoOf } from './agents-extra.js';

export const CI_POLL_MS = 5 * 60e3;
const MAX_REPOS = 24;          // per poll
const DROPS = 46;              // rain streaks per cloud
const FIREWORK_COLORS = [['#ff6b3d', '#ffd36b', '#fff4c2'], ['#3ccf8e', '#bfffe0', '#ffffff'], ['#8b7bff', '#ff6fae', '#ffffff'], ['#5aa9ff', '#bfefff', '#fff2a8']];

let shared = null;
function parts() {
  if (shared) return shared;
  const puff = new THREE.IcosahedronGeometry(1, 1);
  const cloud = toonMaterial('#5b6273', { cache: false });
  cloud.userData.shared = true;
  const rain = new THREE.LineBasicMaterial({ color: '#a9c8ff', transparent: true, opacity: 0.62, depthWrite: false });
  rain.userData.shared = true;
  shared = { puff, cloud, rain };
  return shared;
}

class RainCloud {
  constructor(building) {
    const { puff, cloud, rain } = parts();
    this.building = building;
    this.group = new THREE.Group(); this.group.name = `ci-rain:${building.id}`;
    const W = Math.max(1.6, building.size?.W || 2.4), D = Math.max(1.6, building.size?.D || 2.4);
    this.w = W; this.d = D;
    this.cloud = new THREE.Group();
    for (const [x, y, z, r] of [[-0.42, 0, 0, 0.62], [0.12, 0.16, 0.1, 0.78], [0.62, -0.02, -0.06, 0.56], [-0.05, -0.08, -0.38, 0.5], [0.05, -0.1, 0.4, 0.52]]) {
      const m = new THREE.Mesh(puff, cloud);
      m.position.set(x * W * 0.62, y, z * D * 0.62); m.scale.setScalar(r * Math.min(1.5, 0.55 + W * 0.18));
      m.raycast = () => {};
      this.cloud.add(m);
    }
    this.group.add(this.cloud);
    this.span = 2.4;   // fall height below the cloud
    this.drops = Array.from({ length: DROPS }, () => ({ x: (Math.random() - 0.5) * W * 0.95, z: (Math.random() - 0.5) * D * 0.95, y: -Math.random() * this.span, v: 7 + Math.random() * 3 }));
    this.positions = new Float32Array(DROPS * 6);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3).setUsage(THREE.DynamicDrawUsage));
    this.lines = new THREE.LineSegments(geometry, rain);
    this.lines.frustumCulled = false; this.lines.raycast = () => {};
    this.group.add(this.lines);
    this.writeDrops();
    this.place();
  }
  place() {
    const top = this.building.topPoint();
    this.group.position.set(top.x, top.y + 2.6, top.z);
  }
  writeDrops() {
    const p = this.positions;
    this.drops.forEach((d, i) => { p.set([d.x, d.y, d.z, d.x - 0.04, d.y - 0.36, d.z], i * 6); });
    this.lines.geometry.attributes.position.needsUpdate = true;
  }
  update(dt, elapsed, reduced) {
    this.place();
    if (reduced) return;
    this.cloud.position.y = Math.sin(elapsed * 0.8 + this.w) * 0.06;
    for (const d of this.drops) { d.y -= d.v * dt; if (d.y < -this.span) d.y += this.span; }
    this.writeDrops();
  }
  dispose() { this.group.removeFromParent(); this.lines.geometry.dispose(); }
}

export class CityCi {
  /** env: { world, buildings, caller() → (args → Promise<{ runs }>) | null (feature-detected each time),
   *  projects() → visible home projects, home() → at home, reducedMotion(), onChange() } */
  constructor(env) {
    this.env = env;
    this.results = new Map();   // projectId → { repo, summary, at, error }
    this.seen = new Map();      // projectId → key of the newest finished default-branch run already seen
    this.clouds = new Map();    // projectId → RainCloud
    this.timer = 0; this.polling = null; this.lastPoll = 0;
  }
  get available() { return typeof this.env.caller() === 'function'; }
  start() {
    if (!this.available || this.timer) return;
    if (Date.now() - this.lastPoll >= CI_POLL_MS) this.poll();
    this.timer = setInterval(() => this.poll(), CI_POLL_MS);
  }
  stop() { clearInterval(this.timer); this.timer = 0; }
  status(projectId) { return this.results.get(projectId) || null; }

  async poll() {
    if (!this.available || this.polling) return this.polling;
    this.polling = (async () => {
      this.lastPoll = Date.now();
      const call = this.env.caller();
      const todo = this.env.projects().map(p => ({ p, repo: repoOf(p) })).filter(x => x.repo).slice(0, MAX_REPOS);
      for (const { p, repo } of todo) {
        let data = null, error = '';
        try { data = await call({ projectId: p.id, repo }); }
        catch (e) { error = e?.message || String(e); }
        const summary = ciSummary(data?.runs, p.repo?.default_branch || '');
        this.results.set(p.id, { repo, summary, at: Date.now(), error, runs: Array.isArray(data?.runs) ? data.runs.slice(0, 5) : [] });
        if (!error) {
          if (newlyPassed(this.seen.get(p.id), summary)) this.fireworks(p.id);
          this.seen.set(p.id, summary.key);
        }
      }
      this.sync();
      this.env.onChange?.();
    })().finally(() => { this.polling = null; });
    return this.polling;
  }

  /** Rain clouds follow the results and the buildings standing now. */
  sync() {
    const { buildings, world } = this.env, home = this.env.home();
    const want = new Set();
    if (home) for (const [id, r] of this.results) if (r.summary?.failing && buildings.get(id)) want.add(id);
    for (const [id, cloud] of this.clouds) if (!want.has(id) || cloud.building !== buildings.get(id)) { cloud.dispose(); this.clouds.delete(id); }
    for (const id of want) if (!this.clouds.has(id)) { const cloud = new RainCloud(buildings.get(id)); world.city.add(cloud.group); this.clouds.set(id, cloud); }
  }
  update(dt, elapsed) {
    if (!this.clouds.size) return;
    const reduced = this.env.reducedMotion();
    for (const cloud of this.clouds.values()) cloud.update(dt, elapsed, reduced);
  }
  /** A short burst of three shells over the building (skipped with reduced motion). */
  fireworks(projectId) {
    const b = this.env.buildings.get(projectId), particles = this.env.world.particles;
    if (!b || this.env.reducedMotion() || !this.env.home() || !particles?.enabled) return;
    const top = b.topPoint();
    for (let k = 0; k < 3; k++) {
      setTimeout(() => {
        if (!this.env.buildings.get(projectId)) return;
        const at = { x: top.x + (Math.random() - 0.5) * 2, y: top.y + 3 + Math.random() * 2.2, z: top.z + (Math.random() - 0.5) * 2 };
        particles.emit('spark', { x: top.x, y: top.y + 0.5, z: top.z }, 10, { spread: 0.2 });
        particles.emit('sparkle', at, 70, { spread: 0.35, speed: 2.1, scale: 1.25, colors: FIREWORK_COLORS[(k + Math.floor(Math.random() * 4)) % 4] });
      }, k * 420);
    }
  }
  dispose() { this.stop(); for (const cloud of this.clouds.values()) cloud.dispose(); this.clouds.clear(); }
}
