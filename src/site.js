// Per-house settings. Everything else in src/ is the same for every tour.
// All positions are glTF metres: x = Blender x, y = Blender z (up), z = −Blender y (north is −z).

// Menu and map names for tour-camera labels that need spaces (Tour_NN_<Label> in Blender).
export const ROOM_NAMES = {
  WineRoom: 'Wine room',
  MainBed: 'Main bedroom',
  EnSuite: 'En-suite',
  Bed2: 'Bedroom 2',
  Bed3: 'Bedroom 3',
  GuestLoo: 'Guest loo',
};

// Aerial view orbits round this point (roughly the middle of house + pool).
export const SITE_CENTRE = [3, -0.5, -9];

// Floor-plan map: the area shown (house, pool, decks, a little garden) and its resolution.
// z0 is the north edge. Labels outside it sit on the edge.
export const PLAN = { x0: -12.5, x1: 20.5, z0: -23, z1: 9, ppm: 40 };

// Invisible boxes for gaps in the exported collision mesh: [x, y, z centre, width, height, depth].
export const COLLISION_PATCHES = [
  [12.68, -0.17, -4.91, 0.8, 0.34, 0.2], // slot between the garage step and the lobby slab at the fire door
];
