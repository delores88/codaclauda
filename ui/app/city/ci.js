/* CI in the City, from ci_status (gh run list for each project's GitHub repo):
 *   - a red rooftop beacon on a building whose latest finished run failed;
 *   - a brief fireworks burst over a building when a run newly succeeds on its default branch.
 * Polled every 5 minutes while the City is on screen (and once when it opens, if older than that).
 * Weather belongs only to city/weather.js. Reduced motion: the beacon stays lit
 * and there are no fireworks. Home city only. */
import { THREE, toonMaterial, disposeObject } from './toon.js';
import { ciSummary, newlyPassed, repoOf } from './agents-extra.js';

export const CI_POLL_MS = 5 * 60e3;
const MAX_REPOS = 24;          // per poll
const FIREWORK_COLORS = [['#ff6b3d', '#ffd36b', '#fff4c2'], ['#3ccf8e', '#bfffe0', '#ffffff'], ['#8b7bff', '#ff6fae', '#ffffff'], ['#5aa9ff', '#bfefff', '#fff2a8']];

/** Pure selection, shared with the ticker and deterministic tests. */
export function ciMarker(summary) { return summary?.failing === true ? 'beacon' : null; }

export class CiBeacon {
  constructor(building) {
    this.building = building;
    this.group = new THREE.Group(); this.group.name = `ci-beacon:${building.id}`;
    this.group.position.copy(building.rooftopPoint());
    const base = new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.3, 0.18, 8), toonMaterial('#4c5665'));
    base.position.y = 0.09;
    const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.1, 0.44, 6), toonMaterial('#697687'));
    stem.position.y = 0.36;
    this.material = toonMaterial('#ff4a56', { emissive: '#ff263c', emissiveIntensity: 0.9, cache: false });
    const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.26, 10, 8), this.material);
    lamp.position.y = 0.72;
    this.group.add(base, stem, lamp);
    this.group.traverse(node => { node.raycast = () => {}; });
    building.tower.add(this.group);
  }
  update(dt, elapsed, reduced) {
    this.material.emissiveIntensity = reduced ? 0.9 : 0.65 + 0.45 * (0.5 + 0.5 * Math.sin(elapsed * 3));
  }
  dispose() { this.group.removeFromParent(); disposeObject(this.group); }
}

export class CityCi {
  /** env: { world, buildings, caller() → (args → Promise<{ runs }>) | null (feature-detected each time),
   *  projects() → visible home projects, home() → at home, reducedMotion(), onChange() } */
  constructor(env) {
    this.env = env;
    this.results = new Map();   // projectId → { repo, summary, at, error }
    this.seen = new Map();      // projectId → key of the newest finished default-branch run already seen
    this.beacons = new Map();   // projectId → CiBeacon
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

  /** Beacons stay attached to the current roof, including rebuilds and grow/sink animation. */
  sync() {
    const { buildings } = this.env, home = this.env.home();
    const want = new Set();
    if (home) for (const [id, r] of this.results) if (ciMarker(r.summary) && buildings.get(id)) want.add(id);
    for (const [id, beacon] of this.beacons) if (!want.has(id) || beacon.building !== buildings.get(id) || beacon.group.parent !== buildings.get(id)?.tower) { beacon.dispose(); this.beacons.delete(id); }
    for (const id of want) if (!this.beacons.has(id)) this.beacons.set(id, new CiBeacon(buildings.get(id)));
  }
  update(dt, elapsed) {
    if (!this.beacons.size) return;
    const reduced = this.env.reducedMotion();
    for (const beacon of this.beacons.values()) beacon.update(dt, elapsed, reduced);
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
  dispose() { this.stop(); for (const beacon of this.beacons.values()) beacon.dispose(); this.beacons.clear(); }
}
