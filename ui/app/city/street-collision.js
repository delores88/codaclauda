/* Shared collision bounds for street walking and camera zoom. Homes expose their
 * separate wall blocks so the open spaces between their wings remain usable. */
export function buildingStreetBoxes(building, radius, groundY) {
  const { origin, size } = building, home = building.collisionBoxes;
  if (home) {
    const scale = building.tower?.scale || { x: 1, y: 1, z: 1 };
    return home.map(box => ({
      // Cover the settled walls and the currently animated walls. This also
      // prevents clipping when a large home is shrinking to a smaller footprint.
      x0: Math.min(box.x0, origin.x + (box.x0 - origin.x) * scale.x) - radius,
      x1: Math.max(box.x1, origin.x + (box.x1 - origin.x) * scale.x) + radius,
      z0: Math.min(box.z0, origin.z + (box.z0 - origin.z) * scale.z) - radius,
      z1: Math.max(box.z1, origin.z + (box.z1 - origin.z) * scale.z) + radius,
      y0: Math.min(box.y0, box.y0 * scale.y) - radius,
      y1: Math.max(box.y1, box.y1 * scale.y) + radius,
    }));
  }
  // Downtown, Spark and contributor buildings retain their existing margins.
  const hw = size.W / 2 + 0.14 + radius, hd = size.D / 2 + 0.14 + radius;
  return [{ x0: origin.x - hw, x1: origin.x + hw, z0: origin.z - hd, z1: origin.z + hd, y0: -Infinity, y1: groundY + size.H + 0.6 }];
}

export function buildingSolidAt(building, point, radius, groundY) {
  return buildingStreetBoxes(building, radius, groundY).some(box => point.y > box.y0 && point.y < box.y1
    && point.x > box.x0 && point.x < box.x1 && point.z > box.z0 && point.z < box.z1);
}
