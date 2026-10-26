/* Agents as little NPCs walking the city, plus the owner's avatar.
 *   offline → walks to a bench at its home lot (or the HQ plaza) and sits, grey gem + z's
 *   idle    → strolls the sidewalk loop of its current/home lot; waves/talks when it meets someone
 *   active  → walks the roads to its current project's door and works facing the building
 * People come from ./people.js (createPerson); a simple stand-in is used if it fails to load. */
import { THREE, toonMaterial, addOutline } from './toon.js';
import { planPath, perimeterPoint, perimeterParam, perimeterRoute, cellOf } from './layout.js';
import { HQ, GROUND_Y } from './scenery.js';
import { hash, defaultAvatar, normalizeAvatar } from '../avatar/spec.js';
import { disposeAll } from './fx.js';
import { bridgeHeight } from './river-path.js';
import { riverRoute, riverStep } from './river-navigation.js';

const SPEED = { work: 2.2, stroll: 1.05, roam: 1.6, sit: 1.4, rest: 1.4, owner: 3.0 };
const SIDEWALK_Y = GROUND_Y + 0.06;

export function groundY(x, z) { return Math.hypot(x, z) < 5.55 ? GROUND_Y + 0.14 : SIDEWALK_Y; }

/* STREET-MOVE-BEGIN (pure: checked headless) */
/** Street view walking: move (x, z) by (dx, dz) inside |x|, |z| <= limit and outside every box
 * ({ x0, x1, z0, z1 }, already grown by the walker's radius). Each axis is tried on its own, so a
 * walker pushing into a wall at an angle slides along it instead of stopping dead. A box the walker
 * already stands inside never traps it (it can walk out). Returns { x, z, blocked }. */
export function streetMove(x, z, dx, dz, { limit = Infinity, boxes = [] } = {}) {
  const inside = (px, pz, b) => px > b.x0 && px < b.x1 && pz > b.z0 && pz < b.z1;
  const solid = boxes.filter(b => !inside(x, z, b));
  const clamp = v => Math.max(-limit, Math.min(limit, v));
  const free = (px, pz) => !solid.some(b => inside(px, pz, b));
  let nx = clamp(x + dx), nz = z;
  if (!free(nx, nz)) nx = x;
  let tz = clamp(z + dz);
  if (!free(nx, tz)) tz = z;
  nz = tz;
  const blocked = Math.abs(nx - (x + dx)) > 1e-9 || Math.abs(nz - (z + dz)) > 1e-9;
  return { x: nx, z: nz, blocked };
}
/* STREET-MOVE-END */

let createPersonImpl = null;
let peopleModule = {};
/** Ground speed that matches one walk cycle per second in people.js (feet don't slide). */
const walkSpeed = () => peopleModule.WALK_SPEED || 0.85;
/** Forward the reduced-motion preference to people.js (gem bobbing, idle sway). */
export function setPeopleReducedMotion(on) { try { peopleModule.setReducedMotion?.(on); } catch { /* optional */ } }
/** Resolve createPerson from people.js once; falls back to stand-ins. */
export async function loadPeople() {
  if (createPersonImpl) return createPersonImpl;
  try {
    const mod = await import('./people.js');
    peopleModule = mod;
    createPersonImpl = typeof mod.createPerson === 'function' ? mod.createPerson : createStandIn;
  } catch (error) {
    console.warn('City: people.js unavailable, using stand-in figures.', error);
    createPersonImpl = createStandIn;
  }
  return createPersonImpl;
}

class Npc {
  constructor(agent, person, quality, surfaceY = groundY) {
    this.id = agent.id;
    this.agent = agent;
    this.person = person;
    this.quality = quality;
    this.surfaceY = surfaceY;
    this.lookSig = JSON.stringify(agent.look);
    this.status = undefined;
    const h = hash(agent.id);
    this.lane = { x: h & 1 ? 1 : -1, z: h & 2 ? 1 : -1 };
    this.path = [];
    this.goal = null; this.goalKey = '';
    this.action = null;
    this.pause = 0; this.pauseAction = null;
    this.wait = 0;
    this.social = 6 + (h % 9);
    this.lookTimer = 0;
  }
  get pos() { return this.person.object.position; }
  setAction(action) { if (this.action !== action) { this.action = action; this.person.setAction(action); } }
  place(x, z) { this.pos.set(x, this.surfaceY(x, z), z); }
  get moving() { return this.path.length > 0 && this.pause <= 0 && !this.held; }
  get anchored() { return this.held || (!this.path.length && this.goal && (this.goal.type === 'sit' || this.goal.type === 'work')); }
}

export class NpcManager {
  constructor(parent, { buildings, particles, reducedMotion, river = () => null }) {
    this.parent = parent;
    this.buildings = buildings;
    this.particles = particles;
    this.reducedMotion = reducedMotion;
    this.river = river;
    this.npcs = new Map();
    this.owner = null;
    this.ownerSig = '';
    this.create = createStandIn;
    this.first = true;
    this.socialTimer = 0;
    this.marker = new THREE.Mesh(new THREE.RingGeometry(0.35, 0.5, 32), new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0, depthWrite: false }));
    this.marker.rotation.x = -Math.PI / 2; this.marker.raycast = () => {};
    parent.add(this.marker);
  }
  setCreate(fn) { this.create = fn || createStandIn; }
  surfaceY(x, z) { return this.river() ? bridgeHeight(x, z, this.river().crossings) ?? groundY(x, z) : groundY(x, z); }
  route(from, points) { return this.river() ? riverRoute(from, points, this.river().crossings) : points; }
  /** createPerson with a per-person fallback so one bad spec can't empty the city. */
  makePerson(spec, options) {
    let person;
    try { person = this.create(spec, options); }
    catch (error) { console.error('City: createPerson failed; using a stand-in.', error); person = createStandIn(spec, options); }
    // Real shadows in high quality; the soft blob shadow only when shadows are off.
    if (person.shadow) person.shadow.visible = options.quality === 'low';
    return person;
  }

  /* ---------- sync from store ---------- */
  sync(agents, { avatar, quality = 'high' } = {}) {
    const seen = new Set();
    for (const agent of agents) {
      seen.add(agent.id);
      let npc = this.npcs.get(agent.id);
      if (npc && npc.quality !== quality) { this.removeNpc(npc, false); npc = null; }
      if (!npc) {
        const person = this.makePerson(agent.look, { role: 'agent', provider: agent.provider || 'other', quality });
        npc = new Npc(agent, person, quality, (x, z) => this.surfaceY(x, z));
        this.tagPickables(person, { kind: 'agent', id: agent.id });
        this.parent.add(person.object);
        this.npcs.set(agent.id, npc);
        npc.fresh = true;
      }
      npc.agent = agent;
      const sig = JSON.stringify(agent.look);
      if (sig !== npc.lookSig) { npc.lookSig = sig; npc.person.setSpec(agent.look); this.tagPickables(npc.person, { kind: 'agent', id: agent.id }); }
      if (npc.status !== agent.status) { npc.status = agent.status; npc.person.setStatus(agent.status || 'idle'); }
    }
    for (const npc of [...this.npcs.values()]) if (!seen.has(npc.id)) this.removeNpc(npc, true);
    this.assignGoals();
    this.syncOwner(avatar, quality);
    // Agents present when the board first loads appear in place; later arrivals walk out of HQ.
    if (agents.length) this.first = false;
  }
  tagPickables(person, tag) { for (const m of person.pickable || []) { m.userData.person = person; m.userData.cityTarget = tag; } }
  removeNpc(npc, poof) {
    if (poof && this.particles && !this.reducedMotion()) this.particles.emit('sparkle', { x: npc.pos.x, y: npc.pos.y + 1, z: npc.pos.z }, 14, { spread: 0.6 });
    npc.person.object.removeFromParent();
    npc.person.dispose();
    this.npcs.delete(npc.id);
  }
  syncOwner(avatar, quality) {
    const spec = avatar || { ...defaultAvatar(), name: 'You' };
    const sig = JSON.stringify([spec, quality]);
    if (sig === this.ownerSig) return;
    this.ownerSig = sig;
    let position = null, path = [];
    if (this.owner) { position = this.owner.person.object.position.clone(); path = this.owner.path; this.owner.person.object.removeFromParent(); this.owner.person.dispose(); }
    const person = this.makePerson(spec, { role: 'owner', provider: 'other', quality });
    person.setStatus(null);
    this.tagPickables(person, { kind: 'owner' });
    this.parent.add(person.object);
    const manager = this;
    this.owner = { person, path, action: null, name: spec.name || 'You', get pos() { return person.object.position; }, setAction(action) { manager.ownerAction(action); } };
    if (position) person.object.position.copy(position);
    else { person.object.position.set(HQ.owner.x, groundY(HQ.owner.x, HQ.owner.z), HQ.owner.z); person.lookAt(HQ.owner.x, HQ.owner.z + 10); }
    this.ownerAction(path.length ? 'walk' : 'stand');
  }
  ownerAction(action) { if (this.owner && this.owner.action !== action) { this.owner.action = action; this.owner.person.setAction(action); } }

  /** Decide where every agent wants to be. Stable: same inputs → same seat/slot. */
  assignGoals() {
    const list = [...this.npcs.values()].sort((a, b) => a.id.localeCompare(b.id));
    const usedSeats = new Set(), slotCount = new Map();
    let restCount = 0;
    for (const npc of list) {
      const a = npc.agent;
      const current = this.buildings.get(a.currentProjectId);
      const home = this.buildings.get(a.homeProjectId);
      let goal;
      if (a.status === 'offline') {
        const seats = [...(home ? home.seats.map((s, k) => ({ ...s, key: `lot:${home.id}:${k}` })) : []), ...HQ.seats.map((s, k) => ({ ...s, key: `hq:${k}` }))];
        const seat = seats.find(s => !usedSeats.has(s.key));
        if (seat) { usedSeats.add(seat.key); goal = { type: 'sit', key: `sit:${seat.key}`, point: seat, face: { x: seat.x + seat.fx * 4, z: seat.z + seat.fz * 4 } }; }
        else {
          const k = restCount++, a2 = k * 0.9;
          const p = { x: Math.sin(a2) * 2.1, z: 2.2 + Math.cos(a2) * 2.1 };
          goal = { type: 'rest', key: `rest:${k}`, point: p, face: { x: 0, z: 2.2 } };
        }
      } else if (a.status === 'active') {
        const where = current || home;
        const slotKey = where ? where.id : 'hq';
        const k = slotCount.get(slotKey) || 0; slotCount.set(slotKey, k + 1);
        const spot = where ? where.workSpot(k) : { ...HQ.work[k % HQ.work.length], z: HQ.work[0].z + Math.floor(k / HQ.work.length) * 0.9 };
        goal = { type: 'work', key: `work:${slotKey}:${k}`, point: spot, face: { x: spot.x + spot.fx * 4, z: spot.z + spot.fz * 4 } };
      } else {
        const where = current || home;
        const cell = where ? where.cell : { i: 0, j: 0 };
        goal = { type: 'stroll', key: `stroll:${cell.i},${cell.j}`, cell };
      }
      if (goal.key === npc.goalKey) { npc.goal = goal; continue; }
      const previous = npc.goal;
      npc.goal = goal; npc.goalKey = goal.key;
      if (goal.type === 'stroll') goal.point = perimeterPoint(goal.cell.i, goal.cell.j, (hash(npc.id) % 400) / 100);
      if (this.first) { npc.place(goal.point.x, goal.point.z); this.arrive(npc); }
      else {
        if (npc.fresh) npc.place(HQ.door.x + (Math.random() - 0.5), HQ.door.z + 0.4);
        npc.path = this.route(npc.pos, planPath({ x: npc.pos.x, z: npc.pos.z }, goal.point, npc.lane));
        npc.roaming = goal.type === 'stroll';
        npc.wait = 0;
        if (npc.pause <= 0 && !npc.held) npc.setAction('walk');
        if (previous?.type === 'sit' || previous?.type === 'work') npc.pause = 0;
      }
      npc.fresh = false;
    }
  }

  arrive(npc) {
    const g = npc.goal;
    if (!g) return;
    if (g.type === 'sit') { npc.place(g.point.x, g.point.z); npc.person.lookAt(g.face.x, g.face.z); npc.setAction('sit'); }
    else if (g.type === 'work') { npc.person.lookAt(g.face.x, g.face.z); npc.setAction('work'); }
    else if (g.type === 'rest') { npc.person.lookAt(g.face.x, g.face.z); npc.setAction('stand'); }
    else { npc.setAction('stand'); npc.wait = 1.5 + Math.random() * 4; }
  }

  /* ---------- per-frame ---------- */
  update(dt, elapsed, env) {
    for (const npc of this.npcs.values()) {
      if (npc.held) { npc.person.update(dt, elapsed); continue; }   // talk mode: stays put (see hold)
      if (npc.pause > 0) {
        npc.pause -= dt;
        if (npc.pause <= 0) { npc.pause = 0; if (npc.path.length) npc.setAction('walk'); else this.arrive(npc); }
      } else if (npc.path.length) {
        this.step(npc, npc.path, SPEED[npc.goal?.type === 'stroll' ? (npc.roaming ? 'roam' : 'stroll') : npc.goal?.type] || 1.5, dt);
        if (!npc.path.length) { npc.roaming = false; this.arrive(npc); }
      } else if (npc.goal?.type === 'stroll') {
        npc.wait -= dt;
        if (npc.wait <= 0) {
          const { i, j } = npc.goal.cell;
          const here = cellOf(npc.pos.x, npc.pos.z);
          if (here.i !== i || here.j !== j) { npc.roaming = true; npc.path = this.route(npc.pos, planPath({ x: npc.pos.x, z: npc.pos.z }, perimeterPoint(i, j, Math.random() * 4), npc.lane)); }
          else {
            const t0 = perimeterParam(i, j, npc.pos);
            const t1 = t0 + (Math.random() < 0.5 ? -1 : 1) * (0.35 + Math.random() * 1.2);
            npc.path = this.route(npc.pos, [perimeterPoint(i, j, t0), ...perimeterRoute(i, j, t0, t1)]);
          }
          npc.setAction('walk');
        }
      }
      npc.person.update(dt, elapsed);
    }
    this.separate();
    this.socialTimer -= dt;
    if (this.socialTimer <= 0) { this.socialTimer = 0.6; this.socialize(); }
    for (const npc of this.npcs.values()) npc.social -= dt;
    if (this.owner) {
      const o = this.owner;
      if (o.path.length) {
        this.step(o, o.path, o.speed || SPEED.owner, dt);
        if (!o.path.length) { o.speed = 0; this.ownerAction('stand'); }
      }
      o.person.update(dt, elapsed);
    }
    if (this.marker.material.opacity > 0) {
      this.marker.material.opacity = Math.max(0, this.marker.material.opacity - dt * 0.7);
      if (!env.reducedMotion) this.marker.scale.setScalar(1 + (1 - this.marker.material.opacity) * 0.8);
    }
  }
  step(npc, path, speed, dt) {
    const pos = npc.pos, target = path[0];
    const dx = target.x - pos.x, dz = target.z - pos.z, d = Math.hypot(dx, dz);
    const stride = speed * dt;
    if (d <= stride || d < 0.02) {
      pos.x = target.x; pos.z = target.z; path.shift();
      if (path.length) npc.person.lookAt(path[0].x, path[0].z);
    } else {
      pos.x += dx / d * stride; pos.z += dz / d * stride;
      if (npc.action !== 'walk') npc.person.lookAt(target.x, target.z);
      npc.setAction('walk');
    }
    if ('walkCadence' in npc.person) npc.person.walkCadence = Math.max(0.6, Math.min(3, speed / walkSpeed()));
    pos.y = this.surfaceY(pos.x, pos.z);
  }
  /** Soft separation so walkers don't overlap; seated/working agents act as fixed posts. */
  separate() {
    const list = [...this.npcs.values()];
    if (this.owner) list.push({ pos: this.owner.person.object.position, anchored: !this.owner.path.length, owner: true });
    for (let a = 0; a < list.length; a++) for (let b = a + 1; b < list.length; b++) {
      const p = list[a], q = list[b];
      const dx = q.pos.x - p.pos.x, dz = q.pos.z - p.pos.z, d = Math.hypot(dx, dz), min = 0.72;
      if (d >= min || (p.anchored && q.anchored)) continue;
      // Push apart with a sideways bias so head-on walkers sidestep and pass instead of deadlocking.
      const bx = d > 1e-4 ? dx / d : 1, bz = d > 1e-4 ? dz / d : 0;
      const sx = bx - bz * 0.9, sz = bz + bx * 0.9, sl = Math.hypot(sx, sz);
      const nx = sx / sl, nz = sz / sl, push = (min - d);
      const wp = p.anchored ? 0 : q.anchored ? 1 : 0.5, wq = 1 - wp;
      for (const [person, weight, direction] of [[p, wp, -1], [q, wq, 1]]) {
        if (person.anchored) continue;
        const next = { x: person.pos.x + direction * nx * push * weight, z: person.pos.z + direction * nz * push * weight };
        const safe = this.river() ? riverStep(person.pos, next, this.river().crossings) : next;
        person.pos.set(safe.x, this.surfaceY(safe.x, safe.z), safe.z);
      }
    }
  }
  /** Idle agents who bump into each other stop for a wave and a chat. */
  socialize() {
    const idle = [...this.npcs.values()].filter(n => n.goal?.type === 'stroll' && n.pause <= 0 && n.social <= 0 && !n.held);
    for (let a = 0; a < idle.length; a++) for (let b = a + 1; b < idle.length; b++) {
      const p = idle[a], q = idle[b];
      if (p.pause > 0 || q.pause > 0) continue;
      if (Math.hypot(p.pos.x - q.pos.x, p.pos.z - q.pos.z) > 2.4) continue;
      for (const [me, other, action] of [[p, q, 'wave'], [q, p, 'talk']]) {
        me.pause = 3.2; me.social = 25 + Math.random() * 20;
        me.person.lookAt(other.pos.x, other.pos.z); me.setAction(action);
      }
    }
  }

  /* ---------- interaction ---------- */
  pickables() {
    const out = [];
    for (const npc of this.npcs.values()) out.push(...(npc.person.pickable || []));
    if (this.owner) out.push(...(this.owner.person.pickable || []));
    return out;
  }
  /** Resolve a raycast hit object to { kind: 'agent', id } | { kind: 'owner' }. */
  targetOf(object) {
    for (let node = object; node; node = node.parent) if (node.userData?.cityTarget) return node.userData.cityTarget;
    const person = object.userData?.person;
    if (person && this.owner?.person === person) return { kind: 'owner' };
    for (const npc of this.npcs.values()) if (npc.person === person) return { kind: 'agent', id: npc.id };
    return null;
  }
  greet(id, camera) {
    const npc = this.npcs.get(id);
    if (!npc) return;
    npc.pause = 2.8;
    npc.person.lookAt(camera.x, camera.z);
    npc.setAction('wave');
  }
  greetOwner(camera) {
    if (!this.owner) return;
    this.owner.path = [];
    this.owner.person.lookAt(camera.x, camera.z);
    this.ownerAction('wave');
    clearTimeout(this.ownerWaveTimer);
    this.ownerWaveTimer = setTimeout(() => { if (this.owner && !this.owner.path.length) this.ownerAction('stand'); }, 2400);
  }
  /** Walk your avatar to (x, z): straight there when close (or direct), else along the roads.
   *  speed: units/s (talk mode walks briskly); marker: the ring where you'll stop (double-click walks). */
  walkOwner(x, z, { speed = 0, marker = true, direct = false } = {}) {
    if (!this.owner) return;
    const pos = this.owner.person.object.position;
    direct ||= Math.hypot(x - pos.x, z - pos.z) < 7;
    this.owner.path = this.route(pos, direct ? [{ x, z }] : planPath({ x: pos.x, z: pos.z }, { x, z }, { x: 1, z: 1 }));
    this.owner.speed = speed;
    this.owner.person.lookAt(this.owner.path[0].x, this.owner.path[0].z);
    this.ownerAction('walk');
    if (!marker) return;
    const end = this.owner.path.at(-1);
    this.marker.position.set(end.x, this.surfaceY(end.x, end.z) + 0.03, end.z);
    this.marker.material.opacity = 0.9; this.marker.scale.setScalar(1);
  }
  /** Talk mode: an agent stops where it is (no wandering, no chats with passers-by) until released;
   *  then it carries on toward whatever it was doing. */
  hold(id, on) {
    const npc = this.npcs.get(id);
    if (!npc || Boolean(npc.held) === Boolean(on)) return;
    npc.held = Boolean(on);
    if (on) { if (npc.action === 'walk' || npc.action === 'wave') npc.setAction('stand'); return; }
    npc.pause = 0;
    if (npc.path.length) npc.setAction('walk');
    else if (npc.goal?.type === 'stroll') { npc.setAction('stand'); npc.wait = Math.min(npc.wait || 0, 1.2); }
    else this.arrive(npc);
  }
  /** Is this agent sitting (on a bench)? Seated people are not turned around or animated. */
  seated(id) { return this.npcs.get(id)?.action === 'sit'; }
  /** Set a person's animation (talk mode: 'talk', 'wave', 'stand'); a seated agent stays seated. */
  act(target, action) {
    if (target?.kind === 'owner') { this.ownerAction(action); return; }
    const npc = this.npcs.get(target?.id);
    if (npc && npc.action !== 'sit') npc.setAction(action);
  }
  /** Turn a person toward (x, z) (island space). */
  face(target, x, z) { this.personOf(target)?.lookAt(x, z); }
  /** A person's facing (island-space yaw: forward is (sin, cos)). */
  yaw(target) { return this.personOf(target)?.object.rotation.y || 0; }
  /** Height of a person's face above the ground they stand on (lower when seated). */
  faceHeight(target) {
    const person = this.personOf(target), head = Number(person?.headCenterY), drop = Number(person?.body?.sitDrop);
    const sitting = target?.kind === 'agent' && this.seated(target.id);
    return (Number.isFinite(head) && head > 0.5 ? head : 1.35) + (sitting && Number.isFinite(drop) ? drop : 0);
  }
  /** Height of the top of a person's head (standing). */
  topHeight(target) { const top = Number(this.personOf(target)?.topY); return Number.isFinite(top) && top > 0.5 ? top : 1.8; }
  personOf(target) { return target?.kind === 'owner' ? this.owner?.person : this.npcs.get(target?.id)?.person; }
  /** Street view: put the owner at (x, z) (island space) facing `heading` (yaw: forward is
   *  (sin, cos)), walking at `speed` or standing. Cancels any double-click walk. */
  driveOwner(x, z, heading, moving, speed = 2.4) {
    const o = this.owner;
    if (!o) return;
    o.path = [];
    const person = o.person, pos = person.object.position;
    const safe = this.river() ? moving ? riverStep(pos, { x, z }, this.river().crossings)
      : riverRoute(pos, [{ x, z }], this.river().crossings).at(-1) : { x, z };
    pos.x = safe.x; pos.z = safe.z; pos.y = this.surfaceY(safe.x, safe.z);
    if ('_yawTarget' in person) person._yawTarget = heading;   // people.js: parent-space yaw (island space here)
    else person.lookAt(x + Math.sin(heading) * 4, z + Math.cos(heading) * 4);
    if (moving && 'walkCadence' in person) person.walkCadence = Math.max(0.6, Math.min(3, speed / walkSpeed()));
    this.ownerAction(moving ? 'walk' : 'stand');
  }
  /** The owner's facing (island-space yaw). */
  get ownerHeading() { return this.owner ? this.owner.person.object.rotation.y : 0; }
  setHighlight(target, on) {
    const person = target?.kind === 'owner' ? this.owner?.person : this.npcs.get(target?.id)?.person;
    person?.setHighlight(on);
  }
  position(target) {
    const person = target?.kind === 'owner' ? this.owner?.person : this.npcs.get(target?.id)?.person;
    return person ? person.object.position : null;
  }
  get ownerPosition() { return this.owner?.person.object.position || null; }
  /** Height above the feet where labels/bubbles should start (just over the status gem). */
  headroom(target) {
    const person = target?.kind === 'owner' ? this.owner?.person : this.npcs.get(target?.id)?.person;
    const top = Number(person?.topY);
    return (Number.isFinite(top) && top > 0.5 ? top : 1.8) + 0.62;
  }
  entries() { return [...this.npcs.values()]; }
  dispose() {
    for (const npc of [...this.npcs.values()]) this.removeNpc(npc, false);
    if (this.owner) { this.owner.person.object.removeFromParent(); this.owner.person.dispose(); this.owner = null; }
    clearTimeout(this.ownerWaveTimer);
    disposeAll(this.marker); this.marker.removeFromParent();
  }
}

/* ---------- stand-in figure (only if people.js cannot load) ---------- */
const GEM = { active: '#3ccf8e', idle: '#f5b544', offline: '#7d8299' };
export function createStandIn(specInput, { role = 'agent' } = {}) {
  const object = new THREE.Group();
  const rig = new THREE.Group(); object.add(rig);
  let spec = normalizeAvatar(specInput);
  const bodyMat = toonMaterial(spec.top.color, { cache: false }), skinMat = toonMaterial(spec.skin, { cache: false }), hairMat = toonMaterial(spec.hair.color, { cache: false });
  const legs = new THREE.Mesh(new THREE.CapsuleGeometry(0.2, 0.32, 4, 8), toonMaterial(spec.bottom.color, { cache: false })); legs.position.y = 0.36;
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.3, 0.3, 4, 10), bodyMat); body.position.y = 0.8;
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.36, 16, 12), skinMat); head.position.y = 1.32;
  const hair = new THREE.Mesh(new THREE.SphereGeometry(0.38, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2.2), hairMat); hair.position.y = 1.36;
  const eyes = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.07, 0.04), toonMaterial('#231915')); eyes.position.set(0, 1.34, 0.34);
  rig.add(legs, body, head, hair, eyes);
  addOutline(rig, { thickness: 0.03 });
  const gem = new THREE.Mesh(new THREE.OctahedronGeometry(0.14, 0), toonMaterial('#3ccf8e', { emissive: '#3ccf8e', emissiveIntensity: 0.6, cache: false }));
  gem.position.y = 1.95; object.add(gem);
  const pickable = [legs, body, head, hair];
  let status = role === 'owner' ? null : 'idle', action = 'stand', yaw = 0, targetYaw = 0, t = 0;
  const person = {
    object, pickable,
    setStatus(next) { status = next; gem.visible = !!next; if (next) { gem.material.color.set(GEM[next] || GEM.idle); gem.material.emissive.set(GEM[next] || GEM.idle); gem.material.emissiveIntensity = next === 'offline' ? 0.1 : 0.6; } },
    setAction(next) { action = next; },
    setHighlight(on) { bodyMat.emissive.set(on ? '#6c5cf0' : '#000000'); bodyMat.emissiveIntensity = on ? 0.5 : 1; },
    lookAt(x, z) { targetYaw = Math.atan2(x - object.position.x, z - object.position.z); },
    update(dt) {
      t += dt;
      let d = targetYaw - yaw; while (d > Math.PI) d -= Math.PI * 2; while (d < -Math.PI) d += Math.PI * 2;
      yaw += d * Math.min(1, dt * 8); object.rotation.y = yaw;
      rig.position.y = action === 'walk' ? Math.abs(Math.sin(t * 9)) * 0.08 : action === 'sit' ? -0.3 : 0;
      rig.rotation.z = action === 'wave' || action === 'talk' ? Math.sin(t * 6) * 0.08 : 0;
      if (status) { gem.rotation.y += dt * (status === 'active' ? 2.5 : 0.8); }
    },
    setSpec(next) { spec = normalizeAvatar(next); bodyMat.color.set(spec.top.color); skinMat.color.set(spec.skin); hairMat.color.set(spec.hair.color); },
    dispose() { disposeAll(object); },
  };
  for (const m of pickable) m.userData.person = person;
  person.setStatus(status);
  return person;
}
