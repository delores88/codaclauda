/* Individual Downtown planting footprints for conversation staging. Keeping these
 * separate preserves the open lawn between beds and leaves street walking alone. */
export function talkPlanterBoxes(buildings, clearance = .5) {
  const boxes = [];
  for (const building of buildings) {
    const scale = building.padGroup?.scale || { x: 1, z: 1 };
    for (const plant of building.downtownBase?.plants || []) {
      // Plant positions already include the tower's local Z offset. Apply only
      // the pad scale and building origin, exactly as the rendered landscape does.
      const x = building.origin.x + plant.x * scale.x;
      const z = building.origin.z + plant.z * scale.z;
      const hx = Math.max(plant.w / 2, plant.radius) * Math.abs(scale.x) + clearance;
      const hz = Math.max(plant.d / 2, plant.radius) * Math.abs(scale.z) + clearance;
      boxes.push({ x0: x - hx, x1: x + hx, z0: z - hz, z1: z + hz, low: true });
    }
  }
  return boxes;
}
