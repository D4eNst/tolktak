// The group's isometric house, drawn on the server stack and in the finale. Lengths are wall units along
// the isometric axes from `corner`, the top of the front corner; a window is [wall, from, width, top, height].
const iso = 0.866;

export function house({ name, corner: [x, y], left, right, height, rise, overhang, windows, door }, inside = '') {
  const walls = {
    left: (u, v) => [x - iso * (left - u), y - (left - u) / 2 + v],
    right: (u, v) => [x + iso * u, y - u / 2 + v],
  };
  const along = ([px, py], u) => [px + iso * u, py + u / 2];
  const points = list => list.map(([px, py]) => `${+px.toFixed(1)},${+py.toFixed(1)}`).join(' ');
  const quad = (at, u, v, w, h) => points([at(u, v), at(u + w, v), at(u + w, v + h), at(u, v + h)]);

  const drop = overhang * 1.4;
  const top = { back: walls.left(0, 0), front: [x, y], far: walls.right(right, 0) };
  const apex = walls.right(right / 2, -rise);
  const ridge = [along(apex, -left - overhang), along(apex, overhang)];
  const eave = { back: walls.left(-2 * overhang, drop), front: [x, y + drop], far: walls.right(right + 2 * overhang, drop) };
  const backSlope = [along(eave.far, -left - 2 * overhang), eave.far, ridge[1], ridge[0]];

  const panes = windows.map(([wall, u, w, v, h]) => ({ wall, points: quad(walls[wall], u, v, w, h), mull: points([walls[wall](u + w / 2, v), walls[wall](u + w / 2, v + h)]) }));
  const [doorAt, doorWidth, doorTop] = door;
  const doorPoints = quad(walls.left, doorAt, doorTop, doorWidth, height - doorTop);
  const people = inside && `<clipPath id="${name}-panes">${panes.map(p => `<polygon points="${p.points}"/>`).join('')}</clipPath><g clip-path="url(#${name}-panes)">${inside}</g>`;

  return `<g class="w-iso-house ${name}">
      <linearGradient id="${name}-glow" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffd27a"/><stop offset="1" stop-color="#ff8a4c"/></linearGradient>
      <polygon class="hs-wall-l" points="${points([top.back, top.front, [x, y + height], walls.left(0, height)])}"/>
      <polygon class="hs-wall-r" points="${points([top.far, top.front, [x, y + height], walls.right(right, height)])}"/>
      ${panes.map(p => `<polygon class="hs-win${p.wall === 'right' ? ' hs-win-r' : ''}" points="${p.points}" fill="url(#${name}-glow)"/><polyline class="hs-mull" points="${p.mull}"/>`).join('')}
      ${people}
      <polygon class="hs-door-light" points="${doorPoints}"/><polygon class="hs-door" points="${doorPoints}"/>
      <polygon class="hs-roof-b" points="${points(backSlope)}"/>
      <polygon class="hs-gable" points="${points([top.far, apex, top.front])}"/>
      <polygon class="hs-roof-f" points="${points([ridge[0], ridge[1], eave.front, eave.back])}"/>
      <polyline class="hs-roof-line" points="${points([eave.far, ridge[1], eave.front])}"/>
    </g>`;
}
