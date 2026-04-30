// =============================================================================
// data.js — centralized definition of units, spells, and core constants.
// =============================================================================

const GAME_CONSTANTS = {
  CANVAS_W: 1280,
  CANVAS_H: 720,

  GROUND_Y: 480,
  GROUND_BAND_TOP: 400,
  GROUND_BAND_BOTTOM: 560,

  PLAYER_CASTLE_X: 130,
  ENEMY_CASTLE_X: 1150,
  // distance from a castle's center to its visible front wall — melee units
  // target the front wall (so they stop at the gate) while ranged units keep
  // targeting the castle center (preserving their normal stand-off range).
  CASTLE_FRONT_OFFSET: 100,

  CASTLE_MAX_HP: 2000,

  MAX_MANA: 10,
  START_MANA: 5,
  MANA_REGEN_PER_SEC: 0.49,

  HAND_SIZE: 5,
  MATCH_DURATION_SEC: 180,

  PLAYER_DEPLOY_ZONE: { x1: 0,   x2: 320 },
  ENEMY_DEPLOY_ZONE:  { x1: 960, x2: 1280 },

  SPEED_SCALE: 50,
};

// -----------------------------------------------------------------------------
// Sprite block helper. All 20 characters share the same animation file layout:
//   assets/units/charNN/{idle,walk,attack,death}/{Idle|Walk|Attack|Death}_K.png
// Frame counts came from the fixed sub-sampling step (8/8/12/16). Foot anchors
// were auto-detected from each idle_00 frame.
// -----------------------------------------------------------------------------
function mkSprite(id, footX, footY, drawHeight) {
  const dir = `assets/units/${id}`;
  return {
    id,
    idle:   { dir: `${dir}/idle`,   prefix: "Idle_",   count: 8,  fps: 8 },
    run:    { dir: `${dir}/walk`,   prefix: "Walk_",   count: 8,  fps: 12 },
    attack: { dir: `${dir}/attack`, prefix: "Attack_", count: 12, fps: 18, oneShot: true },
    death:  { dir: `${dir}/death`,  prefix: "Death_",  count: 16, fps: 14, oneShot: true },
    footAnchorX: footX,
    footAnchorY: footY,
    drawHeight,
  };
}

// -----------------------------------------------------------------------------
// UNITS — 20 cards built from the All Personnages pack.
// IDs match the asset folder names (char01..char20). Hero icon at
// assets/icons/NN.png is shown on the card.
// -----------------------------------------------------------------------------
const UNITS = {
  // 01 — Knight King: heavy melee tank
  char01: {
    id: "char01", name: "Knight King", type: "unit", role: "tank",
    roleLabel: "Tank", desc: "Royal armored melee.",
    manaCost: 5, hp: 280, damage: 24, attackCooldown: 1.5,
    moveSpeed: 0.7, range: 25, radius: 22,
    color: "#cf8a3a", accent: "#5a2510",
    icon: "assets/icons/01.png",
    sprite: mkSprite("char01", 0.487, 0.946, 110),
  },

  // 02 — Pirate: cheap melee
  char02: {
    id: "char02", name: "Pirate", type: "unit", role: "melee",
    roleLabel: "Melee", desc: "Quick blade for hire.",
    manaCost: 3, hp: 130, damage: 24, attackCooldown: 1.2,
    moveSpeed: 1.0, range: 22, radius: 18,
    color: "#d9a86a", accent: "#5a2510",
    icon: "assets/icons/02.png",
    sprite: mkSprite("char02", 0.584, 0.902, 110),
  },

  // 03 — Skeleton Soldier: very cheap, fragile, fast
  char03: {
    id: "char03", name: "Skeleton", type: "unit", role: "fast",
    roleLabel: "Fast", desc: "Cheap rabble. Dies easy.",
    manaCost: 2, hp: 70, damage: 13, attackCooldown: 0.9,
    moveSpeed: 1.3, range: 20, radius: 14,
    color: "#dadce0", accent: "#3a3f49",
    icon: "assets/icons/03.png",
    sprite: mkSprite("char03", 0.569, 0.867, 95),
  },

  // 04 — Skeleton on Snail: slow but tanky, spear gives a tiny reach bonus
  char04: {
    id: "char04", name: "Snail Knight", type: "unit", role: "tank",
    roleLabel: "Tank", desc: "Slow shell with a spear.",
    manaCost: 4, hp: 320, damage: 16, attackCooldown: 1.6,
    moveSpeed: 0.4, range: 40, radius: 22,
    color: "#84d266", accent: "#3d6f1f",
    icon: "assets/icons/04.png",
    sprite: mkSprite("char04", 0.565, 0.914, 115),
  },

  // 05 — Goblin King with mace: heavy hitter, bonus vs castle
  char05: {
    id: "char05", name: "Goblin King", type: "unit", role: "tank",
    roleLabel: "Tank", desc: "Smashes walls with a flail.",
    manaCost: 6, hp: 260, damage: 38, attackCooldown: 1.7,
    moveSpeed: 0.8, range: 25, radius: 20,
    color: "#bf3838", accent: "#3d0a0a",
    icon: "assets/icons/05.png",
    bonusVsCastle: 1.5,
    sprite: mkSprite("char05", 0.577, 0.892, 115),
  },

  // 06 — Zeus: legendary lightning mage (long-range, AoE bolts)
  char06: {
    id: "char06", name: "Zeus", type: "unit", role: "mage",
    roleLabel: "Mage", desc: "Lance des éclairs divins.",
    manaCost: 7, hp: 140, damage: 70, attackCooldown: 1.8,
    moveSpeed: 0.7, range: 200, radius: 18,
    color: "#fff28a", accent: "#a8771a",
    icon: "assets/icons/06.png",
    projectile: { speed: 760, color: "#fff58a", aoeRadius: 28 },
    sprite: mkSprite("char06", 0.496, 0.890, 110),
  },

  // 07 — Rhino Heavy Tank
  char07: {
    id: "char07", name: "Rhino Brute", type: "unit", role: "tank",
    roleLabel: "Tank", desc: "Massive armored brute.",
    manaCost: 6, hp: 380, damage: 28, attackCooldown: 1.6,
    moveSpeed: 0.6, range: 25, radius: 24,
    color: "#a4adb5", accent: "#3d4860",
    icon: "assets/icons/07.png",
    sprite: mkSprite("char07", 0.558, 0.908, 125),
  },

  // 08 — Wizard with book: ranged AoE caster
  char08: {
    id: "char08", name: "Wizard", type: "unit", role: "mage",
    roleLabel: "Mage", desc: "Slow caster, splash damage.",
    manaCost: 6, hp: 90, damage: 40, attackCooldown: 2.0,
    moveSpeed: 0.8, range: 170, radius: 16,
    color: "#5fb4ff", accent: "#1b3d80",
    icon: "assets/icons/08.png",
    projectile: { speed: 280, color: "#c8a5ff", aoeRadius: 24 },
    sprite: mkSprite("char08", 0.531, 0.900, 110),
  },

  // 09 — Goblin Archer: cheap ranged
  char09: {
    id: "char09", name: "Goblin Archer", type: "unit", role: "ranged",
    roleLabel: "Ranged", desc: "Quick & cheap arrows.",
    manaCost: 3, hp: 60, damage: 16, attackCooldown: 1.0,
    moveSpeed: 1.1, range: 180, radius: 14,
    color: "#7ec74a", accent: "#2d4d11",
    icon: "assets/icons/09.png",
    projectile: { speed: 380, color: "#a8f57a" },
    sprite: mkSprite("char09", 0.551, 0.916, 100),
  },

  // 10 — Rhino with sword: melee bruiser
  char10: {
    id: "char10", name: "Rhino Captain", type: "unit", role: "tank",
    roleLabel: "Tank", desc: "Sword-bearing rhino captain.",
    manaCost: 5, hp: 280, damage: 26, attackCooldown: 1.3,
    moveSpeed: 0.8, range: 22, radius: 22,
    color: "#cf8b5a", accent: "#5a2510",
    icon: "assets/icons/10.png",
    sprite: mkSprite("char10", 0.489, 0.856, 120),
  },

  // 11 — Dwarf
  char11: {
    id: "char11", name: "Dwarf", type: "unit", role: "melee",
    roleLabel: "Melee", desc: "Sturdy mountain warrior.",
    manaCost: 3, hp: 130, damage: 18, attackCooldown: 1.0,
    moveSpeed: 0.9, range: 20, radius: 14,
    color: "#d9a86a", accent: "#5a2510",
    icon: "assets/icons/11.png",
    sprite: mkSprite("char11", 0.537, 0.896, 95),
  },

  // 12 — Orc Zombie
  char12: {
    id: "char12", name: "Orc Brute", type: "unit", role: "melee",
    roleLabel: "Melee", desc: "Slow but heavy hitter.",
    manaCost: 4, hp: 180, damage: 28, attackCooldown: 1.4,
    moveSpeed: 0.7, range: 22, radius: 18,
    color: "#7ac44e", accent: "#2d4d11",
    icon: "assets/icons/12.png",
    sprite: mkSprite("char12", 0.451, 0.924, 110),
  },

  // 13 — Floating Eye: ranged mage
  char13: {
    id: "char13", name: "Eye Demon", type: "unit", role: "mage",
    roleLabel: "Mage", desc: "Levitating arcane gaze.",
    manaCost: 5, hp: 90, damage: 30, attackCooldown: 1.4,
    moveSpeed: 0.9, range: 180, radius: 14,
    color: "#c780ff", accent: "#3a1170",
    icon: "assets/icons/13.png",
    projectile: { speed: 340, color: "#d9a8ff", aoeRadius: 20 },
    sprite: mkSprite("char13", 0.501, 0.819, 90),
  },

  // 14 — Red Knight (girl): versatile melee
  char14: {
    id: "char14", name: "Red Knight", type: "unit", role: "melee",
    roleLabel: "Melee", desc: "Balanced sword & shield.",
    manaCost: 4, hp: 180, damage: 22, attackCooldown: 1.1,
    moveSpeed: 1.0, range: 22, radius: 16,
    color: "#e2625a", accent: "#5a1010",
    icon: "assets/icons/14.png",
    sprite: mkSprite("char14", 0.588, 0.908, 100),
  },

  // 15 — Elven Archer: solid ranged
  char15: {
    id: "char15", name: "Elf Archer", type: "unit", role: "ranged",
    roleLabel: "Ranged", desc: "Long-range elven bow.",
    manaCost: 4, hp: 80, damage: 22, attackCooldown: 1.2,
    moveSpeed: 1.0, range: 200, radius: 14,
    color: "#a3d977", accent: "#3d6f1f",
    icon: "assets/icons/15.png",
    projectile: { speed: 420, color: "#d8ff9a" },
    sprite: mkSprite("char15", 0.483, 0.892, 105),
  },

  // 16 — Skeleton Assassin (red plume): fast dagger
  char16: {
    id: "char16", name: "Bone Reaver", type: "unit", role: "fast",
    roleLabel: "Fast", desc: "Twin blades, glass cannon.",
    manaCost: 3, hp: 80, damage: 22, attackCooldown: 0.7,
    moveSpeed: 1.6, range: 20, radius: 14,
    color: "#dadce0", accent: "#7a1010",
    icon: "assets/icons/16.png",
    sprite: mkSprite("char16", 0.535, 0.886, 100),
  },

  // 17 — Skeleton Gunner: long-range musket sniper
  char17: {
    id: "char17", name: "Skeleton Gunner", type: "unit", role: "ranged",
    roleLabel: "Ranged", desc: "Heavy musket. Long range.",
    manaCost: 5, hp: 100, damage: 38, attackCooldown: 1.8,
    moveSpeed: 0.8, range: 220, radius: 14,
    color: "#dadce0", accent: "#3a3f49",
    icon: "assets/icons/17.png",
    projectile: { speed: 600, color: "#fff4a8" },
    sprite: mkSprite("char17", 0.516, 0.903, 100),
  },

  // 18 — Mummy/Cleric: healer support
  char18: {
    id: "char18", name: "Tomb Cleric", type: "unit", role: "support",
    roleLabel: "Support", desc: "Heals nearby allies.",
    manaCost: 4, hp: 110, damage: 8, attackCooldown: 1.0,
    moveSpeed: 0.9, range: 50, radius: 14,
    color: "#ffd47a", accent: "#a96a18",
    icon: "assets/icons/18.png",
    healPerSecond: 12,
    healRange: 100,
    sprite: mkSprite("char18", 0.544, 0.910, 100),
  },

  // 19 — Minotaur: heavy hitter
  char19: {
    id: "char19", name: "Minotaur", type: "unit", role: "giant",
    roleLabel: "Giant", desc: "Furious horned brute.",
    manaCost: 7, hp: 420, damage: 55, attackCooldown: 1.8,
    moveSpeed: 0.6, range: 25, radius: 24,
    color: "#cf8b5a", accent: "#5a2510",
    icon: "assets/icons/19.png",
    sprite: mkSprite("char19", 0.488, 0.900, 125),
  },

  // 20 — Stone Golem: boss tank, smashes castles
  char20: {
    id: "char20", name: "Stone Golem", type: "unit", role: "giant",
    roleLabel: "Golem", desc: "Smashes castles. Very slow.",
    manaCost: 8, hp: 950, damage: 60, attackCooldown: 2.5,
    moveSpeed: 0.4, range: 30, radius: 28,
    color: "#a4adb5", accent: "#3d4860",
    icon: "assets/icons/20.png",
    bonusVsCastle: 2.0,
    sprite: mkSprite("char20", 0.505, 0.827, 145),
  },
};

// -----------------------------------------------------------------------------
// SPELLS — instant-effect cards
// -----------------------------------------------------------------------------
const SPELLS = {
  fireball: {
    id: "fireball", name: "Fireball", type: "spell",
    role: "spell-fire", roleLabel: "Spell", desc: "Big AoE fire damage.",
    manaCost: 4, damage: 80, aoeRadius: 70, color: "#ff6a2a",
    targeting: "any",
  },
  heal: {
    id: "heal", name: "Heal", type: "spell",
    role: "spell-heal", roleLabel: "Spell", desc: "Heal allies in area.",
    manaCost: 3, heal: 100, aoeRadius: 80, color: "#7dd87d",
    targeting: "any",
  },
};

const CARD_POOL = [
  ...Object.keys(UNITS),
  ...Object.keys(SPELLS),
];

function getCardDef(id) {
  return UNITS[id] || SPELLS[id] || null;
}

// =============================================================================
// CAMPAIGN AI PROFILES — controls how the enemy AI plays each campaign stage.
// 6 stages of escalating difficulty. Each profile bundles every lever:
//
//   manaMul          : multiplier on AI mana regen (1.0 = same as player)
//   firstActionDelay : seconds before the AI's very first action of the match
//   decisionInterval : [min, max] seconds between successive AI decisions
//   spells           : array of spell ids the AI is allowed to cast
//   cardTier         : 1 = cheap units only (cost ≤ 4),
//                      2 = +tanks (cost ≤ 6),
//                      3 = all units (full pool)
//   misplayChance    : 0..1 probability of picking a random affordable card
//                      instead of the strategic best (simulates an imperfect AI)
//   combo            : true → AI may spawn 2 cards in quick succession when it
//                      has enough mana, simulating coordinated pushes
//
// The tuning follows the design doc:
//   • staircase progression (each stage adds one new layer)
//   • mana ramp ~ linear (0.6 → 1.25)
//   • decision interval ~ geometric (each step × 0.85)
//   • misplay chance ~ halved every 2 stages (30 → 18 → 12 → 8 → 5 → 2 %)
// =============================================================================
// Globally softened by ~25 % across all stages — fewer mana for the AI,
// longer warm-up + decision intervals, and more misplays at every level.
// Stage 1 in particular is now a real "tutorial" stage with a generous
// 8 s opener and an 0.45 misplay rate.
const STAGE_AI_PROFILES = [
  // index 0 unused (stages are 1-based when displayed but 0-based in code)
  { manaMul: 0.45, firstActionDelay: 8.0, decisionInterval: [4.0, 6.0],
    spells: [],                       cardTier: 1, misplayChance: 0.45, combo: false,
    label: "Apprenti" },
  { manaMul: 0.60, firstActionDelay: 6.0, decisionInterval: [3.0, 5.0],
    spells: [],                       cardTier: 1, misplayChance: 0.30, combo: false,
    label: "Recrue" },
  { manaMul: 0.75, firstActionDelay: 4.5, decisionInterval: [2.5, 4.0],
    spells: ["heal"],                 cardTier: 2, misplayChance: 0.20, combo: false,
    label: "Soldat" },
  { manaMul: 0.85, firstActionDelay: 3.5, decisionInterval: [2.0, 3.2],
    spells: ["heal"],                 cardTier: 2, misplayChance: 0.13, combo: false,
    label: "Vétéran" },
  { manaMul: 0.95, firstActionDelay: 2.5, decisionInterval: [1.5, 2.8],
    spells: ["heal", "fireball"],     cardTier: 3, misplayChance: 0.08, combo: true,
    label: "Capitaine" },
  { manaMul: 1.10, firstActionDelay: 2.0, decisionInterval: [1.2, 2.4],
    spells: ["heal", "fireball"],     cardTier: 3, misplayChance: 0.04, combo: true,
    label: "Champion" },
];

// Per-card AI tier — which tier(s) of the campaign can spawn this card.
// Cards not in `cardTier` 1 will never appear in the AI's hand on stage 1, etc.
// Tier 1: cheap melee + cheap ranged
// Tier 2: + tanks (cost 5-6)
// Tier 3: + giants (cost 7-8)
const AI_CARD_TIER = {
  // Stage-1 friendly (cheap, no big tanks/giants)
  char02: 1, char03: 1, char09: 1, char11: 1, char14: 1,
  char15: 1, char16: 1, char18: 1,
  // Stage-2+ — mid-cost units & spells
  char01: 2, char04: 2, char08: 2, char10: 2, char12: 2, char13: 2, char17: 2,
  fireball: 2, heal: 2,
  // Stage-3+ — heavy tanks, bosses, and legendaries (Zeus, Minotaur, Golem)
  char05: 2, char07: 3, char06: 3, char19: 3, char20: 3,
};

function aiCardAllowed(cardId, tier) {
  const t = AI_CARD_TIER[cardId];
  if (t == null) return true;
  return t <= tier;
}
