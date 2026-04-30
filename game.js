// =============================================================================
// game.js — main game loop, state machine, and all real-time systems.
// Depends on: data.js, art.js, audio.js
// =============================================================================

(() => {
  const G = GAME_CONSTANTS;

  // Low-perf detection — coarse but reliable. Mobile and any device with ≤4
  // logical CPU cores gets reduced particle / effect counts to keep 60 fps.
  const IS_LOW_PERF =
    /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent) ||
    (navigator.hardwareConcurrency && navigator.hardwareConcurrency <= 4);
  // FX scale factor: 1.0 desktop, ~0.5 mobile (rounded per call-site).
  const FX_SCALE = IS_LOW_PERF ? 0.5 : 1.0;

  // ---------- DOM refs ----------
  const canvas = document.getElementById("battlefield");
  const ctx = canvas.getContext("2d");
  const handEl = document.getElementById("hand");
  const manaCrystalsEl = document.getElementById("mana-crystals");
  const manaText = document.getElementById("mana-text");
  const playerHpEl = document.getElementById("player-castle-hp");
  const enemyHpEl = document.getElementById("enemy-castle-hp");
  const playerBar = document.getElementById("player-castle-bar");
  const enemyBar = document.getElementById("enemy-castle-bar");
  const matchTimerEl = document.getElementById("match-timer");
  const endgameEl = document.getElementById("endgame");
  const endgameTitle = document.getElementById("endgame-title");
  const endgameSub = document.getElementById("endgame-sub");
  const restartBtn = document.getElementById("restart-btn");
  const endMenuBtn = document.getElementById("end-menu-btn");
  const titleEl = document.getElementById("title-screen");
  const playBtn = document.getElementById("play-btn");
  const pauseEl = document.getElementById("pause-overlay");
  const pauseBtn = document.getElementById("pause-btn");
  const resumeBtn = document.getElementById("resume-btn");
  const quitBtn = document.getElementById("quit-btn");
  const speedBtn = document.getElementById("speed-btn");

  // ---------- Build mana crystal pips ----------
  for (let i = 0; i < G.MAX_MANA; i++) {
    const pip = document.createElement("div");
    pip.className = "mana-pip";
    manaCrystalsEl.appendChild(pip);
  }
  const manaPips = [...manaCrystalsEl.children];

  // ---------- Game state machine ----------
  // 'title' | 'playing' | 'paused' | 'ended'
  let phase = "title";

  // ---------- World state ----------
  let world = null;
  let lastT = 0;
  let running = false;
  let speedMultiplier = 1;

  // FX state (lives outside `world` so it survives short pauses cleanly)
  let shakeT = 0;
  let shakeIntensity = 0;

  function newWorld() {
    return {
      time: 0,
      matchEndsAt: G.MATCH_DURATION_SEC,
      ended: false,

      player: {
        side: "player",
        mana: G.START_MANA,
        castleHp: G.CASTLE_MAX_HP,
        hand: [],
        castleHitFlash: 0,
      },
      enemy: {
        side: "enemy",
        mana: G.START_MANA,
        castleHp: G.CASTLE_MAX_HP,
        hand: [],
        nextDecisionAt: 2.5,        // overwritten by stage profile in startMatch()
        castleHitFlash: 0,
        comboQueue: 0,              // > 0 = follow-up combo spawn pending
      },

      // Reference to the stage AI profile in effect for this match
      aiProfile: null,

      units: [],
      projectiles: [],
      effects: [],   // visual flashes (damage numbers, fireball booms, heals, dust)
      drag: null,    // { def, idx, x, y, originEl }

      // Per-match stats used by the post-match performance score
      stats: {
        playerDeployed: 0,    // total units the player deployed
        manaSpent: 0,         // total mana the player spent
        cardsPlayed: 0,
      },
    };
  }

  // ---------- Deck ----------
  // No duplicate cards in a hand at the same time. A card can come back into
  // the hand once it's been played and removed from the existing 5 cards.
  function drawCard(excludeIds) {
    const pool = CARD_POOL.filter((id) => !excludeIds || !excludeIds.includes(id));
    const src = pool.length > 0 ? pool : CARD_POOL;
    return src[Math.floor(Math.random() * src.length)];
  }
  // Player has access to the full pool. The AI gets a *tier-restricted* pool
  // depending on the active campaign stage profile (early stages exclude big
  // tanks / spells, late stages unlock everything).
  function drawCardForAi(profile, excludeIds) {
    const allowed = CARD_POOL.filter((id) => {
      if (excludeIds && excludeIds.includes(id)) return false;
      if (!aiCardAllowed(id, profile.cardTier)) return false;
      if (SPELLS[id] && !profile.spells.includes(id)) return false;
      return true;
    });
    if (allowed.length === 0) {
      // If every allowed card is already in hand (rare), fall back to any
      // tier-allowed card to avoid a stall — duplicates only happen here.
      const fallback = CARD_POOL.filter((id) => {
        if (!aiCardAllowed(id, profile.cardTier)) return false;
        if (SPELLS[id] && !profile.spells.includes(id)) return false;
        return true;
      });
      return (fallback[0] || CARD_POOL[0]);
    }
    return allowed[Math.floor(Math.random() * allowed.length)];
  }
  function fillHand(player, drawer) {
    while (player.hand.length < G.HAND_SIZE) {
      const exclude = player.hand.slice();
      const card = drawer ? drawer(exclude) : drawCard(exclude);
      player.hand.push(card);
    }
  }

  // ---------- Spawning / spells ----------
  function spawnUnit(side, unitId, x) {
    const def = UNITS[unitId];
    if (!def) return;
    world.units.push({
      uid: Math.random().toString(36).slice(2),
      side,
      def,
      x,
      y: G.GROUND_Y,
      hp: def.hp,
      maxHp: def.hp,
      cooldown: 0.4,        // small startup so units can't insta-attack
      attackPhase: 0,       // 0..1 lunge animation (procedural units)
      attackDirSign: side === "player" ? 1 : -1,
      target: null,
      hitFlash: 0,
      dustTimer: 0,
      dying: 0,             // > 0 = death fade-out timer
      targetCheckTimer: 0,
      // sprite animation state (used when def.sprite is defined)
      animState: "idle",
      animFrame: 0,
      animLocked: 0,        // when > 0, keep current animState (one-shot anims)
    });
    if (side === "player" && world.stats) {
      world.stats.playerDeployed += 1;
    }
    Sound.playCardSound();
  }

  function castSpell(spellId, x, y, casterSide) {
    const spell = SPELLS[spellId];
    if (!spell) return;

    if (spell.id === "fireball") {
      // ----- Multi-layer fireball FX (pushed in render order: bottom → top) -----
      // 1) Lingering scorch mark on the ground (bottom layer)
      world.effects.push({ kind: "fb-scorch", x, y, radius: spell.aoeRadius * 0.85, life: 1.6, max: 1.6 });
      // 2) Main fireball blossom
      world.effects.push({ kind: "fireball", x, y, radius: spell.aoeRadius, life: 0.7, max: 0.7 });
      // 3) Expanding shockwave ring
      world.effects.push({ kind: "fb-shockwave", x, y, radius: spell.aoeRadius * 1.4, life: 0.55, max: 0.55 });
      // 4) Initial bright flash (hot core, drawn over the blossom for sharp impact)
      world.effects.push({ kind: "fb-flash", x, y, radius: spell.aoeRadius, life: 0.18, max: 0.18 });
      // 5) Smoke puff that lingers above
      world.effects.push({ kind: "fb-smoke", x, y: y - 12, radius: spell.aoeRadius * 0.6, life: 1.1, max: 1.1 });
      // 6) Embers flying outward (top layer) — reduced count on mobile
      const emberCount = Math.max(8, Math.round(16 * FX_SCALE));
      for (let i = 0; i < emberCount; i++) {
        const a = (Math.PI * 2 * i / emberCount) + (Math.random() - 0.5) * 0.4;
        const speed = 110 + Math.random() * 130;
        world.effects.push({
          kind: "fb-ember",
          x, y,
          vx: Math.cos(a) * speed,
          vy: Math.sin(a) * speed - 30, // bias slightly upward
          r: 2 + Math.random() * 2.5,
          life: 0.5 + Math.random() * 0.4,
          max: 0.8,
        });
      }

      addShake(0.4, 12);
      Sound.playSpellFireSound();

      for (const u of world.units) {
        if (u.side === casterSide || u.dying > 0) continue;
        const dx = u.x - x, dy = u.y - y;
        if (dx * dx + dy * dy <= spell.aoeRadius * spell.aoeRadius) {
          dealDamage(u, spell.damage, casterSide);
        }
      }
      const enemyCastleX = casterSide === "player" ? G.ENEMY_CASTLE_X : G.PLAYER_CASTLE_X;
      const cdx = enemyCastleX - x;
      const cdy = (G.GROUND_Y - 100) - y;
      if (cdx * cdx + cdy * cdy <= (spell.aoeRadius + 60) ** 2) {
        damageCastle(casterSide === "player" ? "enemy" : "player", spell.damage * 0.5);
      }
    } else if (spell.id === "heal") {
      // ----- Multi-layer heal FX -----
      // 1) Bright core flash
      world.effects.push({ kind: "heal-flash", x, y, radius: 36, life: 0.25, max: 0.25 });
      // 2) Two staggered expanding rings
      world.effects.push({ kind: "heal-ring",  x, y, radius: spell.aoeRadius,        life: 0.8, max: 0.8 });
      world.effects.push({ kind: "heal-ring",  x, y, radius: spell.aoeRadius * 0.7,  life: 0.8, max: 0.8, delay: 0.18 });
      // 3) Soft persistent aura beneath
      world.effects.push({ kind: "heal", x, y, radius: spell.aoeRadius, life: 0.9, max: 0.9 });
      // 4) Rising plus-sign sparkles — reduced count on mobile
      const plusCount = Math.max(5, Math.round(10 * FX_SCALE));
      for (let i = 0; i < plusCount; i++) {
        const a = Math.random() * Math.PI * 2;
        const dist = Math.random() * spell.aoeRadius * 0.7;
        world.effects.push({
          kind: "heal-plus",
          x: x + Math.cos(a) * dist,
          y: y + Math.sin(a) * dist + 6,
          vy: -40 - Math.random() * 30,
          r: 5 + Math.random() * 4,
          life: 0.9 + Math.random() * 0.4,
          max: 1.3,
          delay: Math.random() * 0.2,
        });
      }
      Sound.playSpellHealSound();
      for (const u of world.units) {
        if (u.side !== casterSide || u.dying > 0) continue;
        const dx = u.x - x, dy = u.y - y;
        if (dx * dx + dy * dy <= spell.aoeRadius * spell.aoeRadius) {
          const before = u.hp;
          u.hp = Math.min(u.maxHp, u.hp + spell.heal);
          const healed = Math.round(u.hp - before);
          if (healed > 0) {
            spawnFloatingNumber(u.x, u.y - u.def.radius * 2 - 8, "+" + healed, "#a8f5a4");
            // small green halo on each healed unit
            world.effects.push({
              kind: "heal-flash", x: u.x, y: u.y - u.def.radius,
              radius: u.def.radius * 1.6, life: 0.45, max: 0.45,
            });
          }
        }
      }
    }
  }

  // ---------- Damage / death / castle ----------
  function dealDamage(unit, amount, attackerSide) {
    if (unit.dying > 0) return;
    let dmg = amount;
    if (unit.def.takesExtraDamage) dmg *= unit.def.takesExtraDamage;
    unit.hp -= dmg;
    unit.hitFlash = 0.18;
    spawnFloatingNumber(unit.x, unit.y - unit.def.radius * 2 - 8, Math.round(dmg).toString(), "#ffd24a");
    Sound.playHitSound();
    if (unit.hp <= 0) {
      // sprite units linger long enough for their death animation
      let deathTime = 0.6;
      if (unit.def.sprite && unit.def.sprite.death) {
        deathTime = unit.def.sprite.death.count / unit.def.sprite.death.fps + 0.15;
      }
      unit.dying = deathTime;
      unit._deathDuration = deathTime;
      unit.hp = 0;
    }
  }

  function damageCastle(side, amount) {
    const target = side === "player" ? world.player : world.enemy;
    if (target.castleHp <= 0) return;
    target.castleHp = Math.max(0, target.castleHp - amount);
    target.castleHitFlash = 0.22;
    spawnFloatingNumber(
      side === "player" ? G.PLAYER_CASTLE_X : G.ENEMY_CASTLE_X,
      G.GROUND_Y - 200,
      Math.round(amount).toString(),
      "#ff7676"
    );
    Sound.playCastleDamageSound();
    if (amount >= 40) addShake(0.4, 10);
    else addShake(0.18, 4);

    if (target.castleHp <= 0 && !world.ended) endMatch(side === "player" ? "lose" : "win");
  }

  function spawnFloatingNumber(x, y, text, color) {
    world.effects.push({ kind: "dmg", x, y, text, color, life: 0.9, max: 0.9, vy: -32 });
  }
  function spawnDust(x) {
    world.effects.push({ kind: "dust", x: x + (Math.random() - 0.5) * 4, y: G.GROUND_Y, life: 0.5, max: 0.5,
      vx: (Math.random() - 0.5) * 12, vy: -6 - Math.random() * 6, r: 3 + Math.random() * 2 });
  }
  function addShake(time, intensity) {
    if (time > shakeT) shakeT = time;
    if (intensity > shakeIntensity) shakeIntensity = intensity;
  }

  // ---------- Update loop ----------
  function update(dt) {
    if (world.ended) return;

    world.time += dt;
    const remaining = Math.max(0, world.matchEndsAt - world.time);
    matchTimerEl.textContent = formatTime(remaining);
    if (remaining <= 0) {
      if (world.player.castleHp === world.enemy.castleHp) endMatch("draw");
      else endMatch(world.player.castleHp > world.enemy.castleHp ? "win" : "lose");
      return;
    }

    world.player.mana = Math.min(G.MAX_MANA, world.player.mana + G.MANA_REGEN_PER_SEC * dt);
    const aiManaMul = (world.aiProfile && world.aiProfile.manaMul) || 1.0;
    world.enemy.mana = Math.min(G.MAX_MANA, world.enemy.mana + G.MANA_REGEN_PER_SEC * dt * aiManaMul);

    aiTick(dt);

    for (const u of world.units) updateUnit(u, dt);
    for (const p of world.projectiles) updateProjectile(p, dt);

    for (const e of world.effects) {
      // Optional delayed start (for staggered FX layers)
      if (e.delay && e.delay > 0) { e.delay -= dt; continue; }
      e.life -= dt;
      if (e.kind === "dmg") e.y += (e.vy || 0) * dt;
      if (e.kind === "dust") { e.x += (e.vx || 0) * dt; e.y += (e.vy || 0) * dt; e.vy += 30 * dt; }
      // Fireball embers — gravity + air drag
      if (e.kind === "fb-ember") {
        e.x += (e.vx || 0) * dt;
        e.y += (e.vy || 0) * dt;
        e.vy += 280 * dt;            // gravity
        e.vx *= 0.92;                // drag
        e.vy *= 0.96;
      }
      // Heal plus signs rise
      if (e.kind === "heal-plus") {
        e.y += (e.vy || 0) * dt;
        e.vy *= 0.96;                // slow down as they rise
      }
    }

    if (world.player.castleHitFlash > 0) world.player.castleHitFlash -= dt;
    if (world.enemy.castleHitFlash > 0) world.enemy.castleHitFlash -= dt;

    // Keep alive units OR units still playing their death animation.
    // Anything else (hp == 0 AND dying counted down to 0) is fully dead — drop it.
    world.units = world.units.filter((u) => u.hp > 0 || u.dying > 0);
    world.projectiles = world.projectiles.filter((p) => !p.dead);
    world.effects = world.effects.filter((e) => e.life > 0);

    if (shakeT > 0) shakeT -= dt;
  }

  function updateUnit(u, dt) {
    if (u.dying > 0) {
      u.dying -= dt;
      u._fadeRemain = u.dying;
      // play death animation once for sprite units
      if (u.def.sprite) {
        if (u.animState !== "death") {
          u.animState = "death";
          u.animFrame = 0;
        }
        const anim = u.def.sprite.death;
        u.animFrame = Math.min(anim.count - 1, u.animFrame + anim.fps * dt);
      }
      return;
    }
    if (u.hitFlash > 0) u.hitFlash -= dt;
    if (u.attackPhase > 0) u.attackPhase = Math.max(0, u.attackPhase - dt * 4);

    // Target selection: pick fresh when missing/dead, or periodically re-check
    // so units engage interceptors instead of marching past them.
    //
    // SPECIAL RULE — castle commitment:
    //   Once a unit reaches the castle's attack range, it LOCKS ON the castle
    //   and ignores any new units that spawn nearby. This means defenders must
    //   intercept attackers BEFORE they reach the gate; once an attacker is
    //   swinging at the wall, only killing it stops it. Without this rule, a
    //   defender could chain-spawn units to keep pulling attackers off forever.
    if (u.targetCheckTimer === undefined) u.targetCheckTimer = 0;
    u.targetCheckTimer -= dt;
    const needsNew = !u.target || !targetAlive(u.target);

    // Compute "is this unit currently in attack range of a castle?"
    let lockedOnCastle = false;
    if (u.target && u.target.kind === "castle") {
      const dCastle = Math.hypot(u.target.x - u.x, u.target.y - u.y);
      // 18 = generic castle radius used elsewhere
      if (dCastle <= u.def.range + 18) lockedOnCastle = true;
    }

    if (needsNew || (!lockedOnCastle && u.targetCheckTimer <= 0)) {
      u.targetCheckTimer = 0.15 + Math.random() * 0.1;
      const candidate = pickTarget(u);
      if (needsNew) {
        u.target = candidate;
      } else if (candidate) {
        const curr = u.target;
        if (curr.kind === "castle" && candidate.kind === "unit") {
          // Engage interceptors only while we're STILL on the way to the
          // castle. If we already reached it, we commit (lockedOnCastle would
          // have skipped this branch entirely).
          u.target = candidate;
        } else if (curr.kind === "unit" && candidate.kind === "unit" && curr.unit !== candidate.unit) {
          const oldD = Math.hypot(curr.unit.x - u.x, curr.unit.y - u.y);
          const newD = Math.hypot(candidate.unit.x - u.x, candidate.unit.y - u.y);
          const inAttackRange = newD < (u.def.range + (candidate.unit.def.radius || 16) + 12);
          if (inAttackRange || newD < oldD - 30) u.target = candidate;
        }
      }
    }
    if (!u.target) return;

    const tx = targetX(u.target);
    const ty = targetY(u.target);
    const dx = tx - u.x;
    const dy = ty - u.y;
    const dist = Math.hypot(dx, dy);

    // healer aura passive
    if (u.def.healPerSecond) {
      for (const a of world.units) {
        if (a === u || a.side !== u.side || a.dying > 0 || a.hp >= a.maxHp) continue;
        if (Math.abs(a.x - u.x) <= u.def.healRange) {
          const before = a.hp;
          a.hp = Math.min(a.maxHp, a.hp + u.def.healPerSecond * dt);
          if (Math.random() < dt * 1.5 && a.hp > before) {
            world.effects.push({ kind: "heal-spark", x: a.x, y: a.y - a.def.radius * 1.5, life: 0.4, max: 0.4 });
          }
          break;
        }
      }
    }

    const targetRadius = u.target.kind === "unit" ? u.target.unit.def.radius : 18;

    // Decay one-shot animation lock (e.g. attack windup)
    if (u.animLocked > 0) u.animLocked -= dt;

    if (dist > u.def.range + targetRadius) {
      const speed = u.def.moveSpeed * G.SPEED_SCALE;
      const step = Math.min(dist, speed * dt);
      u.x += (dx / dist) * step;
      u.attackDirSign = dx >= 0 ? 1 : -1;

      if (u.def.sprite && u.animLocked <= 0) {
        if (u.animState !== "run") { u.animState = "run"; u.animFrame = 0; }
      }

      // dust puffs while moving (rate scales with speed)
      u.dustTimer -= dt;
      if (u.dustTimer <= 0) {
        // Spawn dust less often on mobile
        u.dustTimer = (IS_LOW_PERF ? 0.32 : 0.18) / Math.max(0.6, u.def.moveSpeed);
        spawnDust(u.x);
      }
    } else {
      u.attackDirSign = dx >= 0 ? 1 : -1;
      u.cooldown -= dt;
      if (u.cooldown <= 0) {
        u.cooldown = u.def.attackCooldown;
        u.attackPhase = 1;
        attack(u);
        if (u.def.sprite) {
          u.animState = "attack";
          u.animFrame = 0;
          // lock animation for the attack's full length
          const a = u.def.sprite.attack;
          u.animLocked = a.count / a.fps;
        }
      } else if (u.def.sprite && u.animLocked <= 0) {
        if (u.animState !== "idle") { u.animState = "idle"; u.animFrame = 0; }
      }
    }

    // advance the active animation frame
    if (u.def.sprite) {
      const anim = u.def.sprite[u.animState] || u.def.sprite.idle;
      u.animFrame += anim.fps * dt;
      if (anim.oneShot) u.animFrame = Math.min(anim.count - 1, u.animFrame);
      else u.animFrame = u.animFrame % anim.count;
    }
  }

  function targetAlive(t) {
    if (t.kind === "unit") return t.unit.hp > 0 && t.unit.dying <= 0;
    const target = t.side === "player" ? world.player : world.enemy;
    return target.castleHp > 0;
  }
  function targetX(t) { return t.kind === "unit" ? t.unit.x : t.x; }
  function targetY(t) { return t.kind === "unit" ? t.unit.y : t.y; }

  function pickTarget(u) {
    let best = null, bestDist = Infinity;
    for (const o of world.units) {
      if (o.side === u.side || o.hp <= 0 || o.dying > 0) continue;
      const d = Math.hypot(o.x - u.x, o.y - u.y);
      if (d < bestDist) { bestDist = d; best = o; }
    }

    // Melee units target the castle's *front wall* so they stop at the gate
    // instead of walking into the castle. Ranged units (anything with a
    // projectile) keep targeting the castle center to preserve their normal
    // stand-off range.
    const isMelee = !u.def.projectile;
    const enemyCastleCenter = u.side === "player" ? G.ENEMY_CASTLE_X : G.PLAYER_CASTLE_X;
    const frontOffset = u.side === "player" ? -G.CASTLE_FRONT_OFFSET : G.CASTLE_FRONT_OFFSET;
    const castleTargetX = isMelee ? enemyCastleCenter + frontOffset : enemyCastleCenter;
    const castleY = G.GROUND_Y - 30;
    const castleDist = Math.abs(castleTargetX - u.x);

    const castleTarget = {
      kind: "castle",
      x: castleTargetX,
      y: castleY,
      side: u.side === "player" ? "enemy" : "player",
    };

    // Threat radius: an enemy unit within this distance ALWAYS takes priority
    // over the castle, even if the unit is currently mid-castle-attack. This
    // makes castle-besiegers turn around to defend when reinforcements arrive
    // right next to them.
    const THREAT_RADIUS = u.def.range + 80;
    if (best && bestDist <= THREAT_RADIUS) {
      return { kind: "unit", unit: best };
    }

    // Otherwise, pick whichever is closer (no extra bias toward the castle).
    if (!best || castleDist <= bestDist) return castleTarget;
    return { kind: "unit", unit: best };
  }

  function attack(u) {
    const def = u.def;
    if (def.projectile) {
      // Spawn from the shooter's chest height (canvas y increases downward).
      const shooterChestY = u.y - def.radius * 1.6;
      const tx = targetX(u.target);
      // Aim at the *body* of the target, not its feet, so projectiles travel
      // roughly horizontally rather than diving into the ground.
      let aimY;
      if (u.target.kind === "unit") {
        aimY = u.target.unit.y - u.target.unit.def.radius;
      } else {
        aimY = u.target.y; // castle target already at chest level
      }
      const dx = tx - u.x;
      const dy = aimY - shooterChestY;
      const len = Math.hypot(dx, dy) || 1;
      world.projectiles.push({
        x: u.x, y: shooterChestY,
        vx: (dx / len) * def.projectile.speed,
        vy: (dy / len) * def.projectile.speed,
        damage: def.damage,
        side: u.side,
        color: def.projectile.color,
        aoeRadius: def.projectile.aoeRadius || 0,
        life: 2.4,
        target: u.target,
        bonusVsCastle: def.bonusVsCastle || 1,
        trail: [],
      });
    } else {
      const isCastle = u.target.kind === "castle";
      const bonus = isCastle && def.bonusVsCastle ? def.bonusVsCastle : 1;
      applyHit(u.target, def.damage * bonus, u.side);
    }
  }

  function applyHit(target, dmg, attackerSide) {
    if (target.kind === "unit") dealDamage(target.unit, dmg, attackerSide);
    else damageCastle(target.side, dmg);
  }

  function updateProjectile(p, dt) {
    p.life -= dt;
    if (p.life <= 0) { p.dead = true; return; }
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.trail.push({ x: p.x, y: p.y, life: 0.3 });
    if (p.trail.length > 8) p.trail.shift();
    for (const t of p.trail) t.life -= dt;

    if (p.target && p.target.kind === "unit") {
      const u = p.target.unit;
      if (u.hp > 0 && u.dying <= 0) {
        const d = Math.hypot(u.x - p.x, (u.y - u.def.radius) - p.y);
        if (d < u.def.radius + 6) {
          if (p.aoeRadius > 0) {
            for (const o of world.units) {
              if (o.side === p.side || o.dying > 0) continue;
              if (Math.hypot(o.x - p.x, o.y - p.y) < p.aoeRadius) dealDamage(o, p.damage * 0.5, p.side);
            }
          }
          dealDamage(u, p.damage, p.side);
          p.dead = true;
          return;
        }
      } else { p.dead = true; return; }
    } else if (p.target && p.target.kind === "castle") {
      const cx = p.target.x;
      if ((p.side === "player" && p.x >= cx - 20) || (p.side === "enemy" && p.x <= cx + 20)) {
        damageCastle(p.target.side, p.damage * p.bonusVsCastle);
        p.dead = true; return;
      }
    }

    if (p.x < -50 || p.x > G.CANVAS_W + 50 || p.y < -50 || p.y > G.CANVAS_H + 50) p.dead = true;
  }

  // ---------- AI ----------
  function aiTick(dt) {
    const ai = world.enemy;
    const profile = world.aiProfile || STAGE_AI_PROFILES[1];
    const drawer = (excludeIds) => drawCardForAi(profile, excludeIds);
    fillHand(ai, drawer);
    if (world.time < ai.nextDecisionAt) return;

    const playable = ai.hand
      .map((id, idx) => ({ id, idx, def: getCardDef(id) }))
      .filter((c) => c.def && c.def.manaCost <= ai.mana);
    if (playable.length === 0) {
      ai.nextDecisionAt = world.time + 1.0;
      return;
    }

    const threat = countThreats(ai, "enemy");
    let pick = null;

    // ---------- Misplay roll (early-stage AI feels human) ----------
    if (Math.random() < profile.misplayChance) {
      pick = playable[Math.floor(Math.random() * playable.length)];
    } else {
      // ---------- Strategic decision ----------
      if (threat.totalHp > 200) {
        pick = playable.find((c) => c.def.id === "fireball")
            || playable.find((c) => c.def.role === "tank" || c.def.role === "giant")
            || playable.find((c) => c.def.role === "melee" || c.def.role === "fast")
            || playable[0];
      } else if (ai.mana > 7 || Math.random() < 0.4) {
        pick = playable.find((c) => c.def.role === "giant" || c.def.role === "tank")
            || playable.find((c) => c.def.role === "ranged" || c.def.role === "mage")
            || playable[Math.floor(Math.random() * playable.length)];
      } else {
        ai.nextDecisionAt = world.time + 0.6 + Math.random() * 0.8;
        return;
      }
    }
    if (!pick) return;

    // Execute the chosen card
    playAiCard(pick, threat);

    // ---------- Combo follow-up ----------
    // High-tier profiles can spawn a second supporting card in the same beat
    // (e.g. tank → ranged behind, or unit → heal buff). Only fires when the AI
    // still has enough mana and a second sensible play is in hand.
    if (profile.combo && Math.random() < 0.6) {
      const followup = ai.hand
        .map((id, idx) => ({ id, idx, def: getCardDef(id) }))
        .filter((c) => c.def && c.def.manaCost <= ai.mana)
        .find((c) => {
          if (pick.def.role === "tank" || pick.def.role === "giant") {
            return c.def.role === "ranged" || c.def.role === "mage";
          }
          if (pick.def.role === "ranged") return c.def.role === "tank";
          return false;
        });
      if (followup) {
        playAiCard(followup, threat);
      }
    }

    // Schedule next decision per the profile's interval
    const [lo, hi] = profile.decisionInterval;
    ai.nextDecisionAt = world.time + lo + Math.random() * (hi - lo);
  }

  // Helper: actually deploy / cast the chosen AI card
  function playAiCard(pick, threat) {
    const ai = world.enemy;
    if (pick.def.type === "spell") {
      const target = findDensestCluster("player");
      if (!target) return;
      castSpell(pick.def.id, target.x, target.y, "enemy");
    } else {
      let dx;
      if (threat && threat.frontX !== null) {
        dx = clamp(threat.frontX + 60, G.ENEMY_DEPLOY_ZONE.x1, G.ENEMY_DEPLOY_ZONE.x2);
      } else {
        dx = G.ENEMY_DEPLOY_ZONE.x1 + Math.random() * (G.ENEMY_DEPLOY_ZONE.x2 - G.ENEMY_DEPLOY_ZONE.x1);
      }
      spawnUnit("enemy", pick.def.id, dx);
    }
    ai.mana -= pick.def.manaCost;
    ai.hand.splice(pick.idx, 1);
    fillHand(ai, (excludeIds) => drawCardForAi(world.aiProfile || STAGE_AI_PROFILES[1], excludeIds));
  }

  function countThreats(ai, ownerSide) {
    let totalHp = 0;
    let frontX = null;
    for (const u of world.units) {
      if (u.side === ownerSide || u.dying > 0) continue;
      const inOurHalf = ownerSide === "enemy" ? u.x > G.CANVAS_W / 2 : u.x < G.CANVAS_W / 2;
      if (inOurHalf) {
        totalHp += u.hp;
        if (frontX === null || (ownerSide === "enemy" ? u.x > frontX : u.x < frontX)) frontX = u.x;
      }
    }
    return { totalHp, frontX };
  }

  function findDensestCluster(side) {
    const us = world.units.filter((u) => u.side === side && u.dying <= 0);
    if (us.length === 0) return null;
    let best = us[0], bestScore = 0;
    for (const u of us) {
      let score = 0;
      for (const o of us) if (Math.hypot(o.x - u.x, o.y - u.y) < 80) score += 1;
      if (score > bestScore) { best = u; bestScore = score; }
    }
    return { x: best.x, y: best.y };
  }

  // ---------- Rendering ----------
  function render() {
    // Campaign mode swaps the background image; quick-play keeps the default.
    const themeRoot = (world && world.isCampaign && Art.cache.campaign)
      ? Art.cache.campaign
      : Art.cache;
    // background
    const bg = themeRoot.background;
    if (bg) ctx.drawImage(bg, 0, 0, G.CANVAS_W, G.CANVAS_H);
    else { ctx.fillStyle = "#1b2330"; ctx.fillRect(0, 0, G.CANVAS_W, G.CANVAS_H); }

    // dark band overlay near top to improve UI readability
    const grad = ctx.createLinearGradient(0, 0, 0, G.CANVAS_H * 0.18);
    grad.addColorStop(0, "rgba(0, 8, 18, 0.55)");
    grad.addColorStop(1, "rgba(0, 8, 18, 0)");
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, G.CANVAS_W, G.CANVAS_H * 0.18);

    // combat lane (subtle dirt strip)
    const laneTop = G.GROUND_BAND_TOP;
    const laneBot = G.GROUND_BAND_BOTTOM;
    const laneGrad = ctx.createLinearGradient(0, laneTop, 0, laneBot);
    laneGrad.addColorStop(0, "rgba(70, 50, 30, 0.0)");
    laneGrad.addColorStop(0.5, "rgba(70, 50, 30, 0.18)");
    laneGrad.addColorStop(1, "rgba(70, 50, 30, 0.0)");
    ctx.fillStyle = laneGrad;
    ctx.fillRect(0, laneTop, G.CANVAS_W, laneBot - laneTop);

    // subtle deployment zone (always)
    drawDeployZone(false);
    // active deployment zone (when dragging unit card)
    if (world.drag && world.drag.def && world.drag.def.type === "unit") drawDeployZone(true);

    // castles
    drawCastle("player");
    drawCastle("enemy");

    // units sorted by y for fake depth
    const sorted = [...world.units].sort((a, b) => a.y - b.y);
    for (const u of sorted) drawUnit(u);

    // projectiles
    for (const p of world.projectiles) drawProjectile(p);

    // effects
    for (const e of world.effects) drawEffect(e);

    // drag preview (above everything)
    if (world.drag) drawDragPreview();
  }

  function drawDeployZone(active) {
    const z = G.PLAYER_DEPLOY_ZONE;
    const top = G.GROUND_BAND_TOP;
    const bot = G.GROUND_BAND_BOTTOM;

    if (!active) {
      // subtle outline only
      ctx.save();
      ctx.strokeStyle = "rgba(140, 220, 160, 0.18)";
      ctx.lineWidth = 2;
      ctx.setLineDash([8, 8]);
      ctx.strokeRect(z.x1, top, z.x2 - z.x1, bot - top);
      ctx.restore();
      return;
    }

    ctx.save();
    const valid = isValidDeploy(world.drag.x, world.drag.y);
    const fill = valid ? "rgba(80, 220, 120, 0.22)" : "rgba(255, 110, 110, 0.18)";
    const border = valid ? "rgba(120, 240, 160, 0.95)" : "rgba(255, 130, 130, 0.85)";
    ctx.fillStyle = fill;
    ctx.fillRect(z.x1, top, z.x2 - z.x1, bot - top);

    // pulsing border
    const pulse = 0.7 + Math.sin(performance.now() / 180) * 0.3;
    ctx.strokeStyle = border;
    ctx.globalAlpha = pulse;
    ctx.setLineDash([12, 6]);
    ctx.lineWidth = 3;
    ctx.strokeRect(z.x1, top, z.x2 - z.x1, bot - top);
    ctx.globalAlpha = 1;
    ctx.setLineDash([]);

    ctx.fillStyle = valid ? "#a4f3b6" : "#f5c0c0";
    ctx.font = "bold 16px Trebuchet MS, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(valid ? "DEPLOY HERE" : "OUT OF ZONE", (z.x1 + z.x2) / 2, top - 8);
    ctx.restore();
  }

  function drawCastle(side) {
    const player = side === "player" ? world.player : world.enemy;
    const ratio = player.castleHp / G.CASTLE_MAX_HP;
    let stateKey = "full";
    if (ratio <= 0) stateKey = "destroyed";
    else if (ratio <= 0.5) stateKey = "damaged";

    // Pick the right asset bundle (default for JOUER, campaign for CAMPAGNE)
    const themeRoot = (world.isCampaign && Art.cache.campaign)
      ? Art.cache.campaign
      : Art.cache;
    const img = themeRoot[side][stateKey];
    if (!img) return;

    // target draw height; preserves aspect ratio
    const targetH = 230;
    const ar = img.width / img.height;
    const drawW = targetH * ar;
    const anchorX = side === "player" ? G.PLAYER_CASTLE_X : G.ENEMY_CASTLE_X;
    const anchorY = G.GROUND_Y + 6;

    ctx.save();

    // Source assets are already correctly oriented:
    //   • Player castle PNG → gate on the right → draw as-is, faces enemy (right).
    //   • Enemy castle PNG  → gate on the left  → draw as-is, faces player (left).
    ctx.drawImage(img, anchorX - drawW / 2, anchorY - targetH, drawW, targetH);
    ctx.restore();

    // Hit flash (red overlay on damage)
    if (player.castleHitFlash > 0) {
      const a = Math.min(1, player.castleHitFlash * 4);
      ctx.save();
      ctx.globalAlpha = a * 0.4;
      ctx.fillStyle = "#ff3a3a";
      const flashRect = {
        x: anchorX - drawW / 2,
        y: anchorY - targetH,
        w: drawW,
        h: targetH,
      };
      ctx.fillRect(flashRect.x, flashRect.y, flashRect.w, flashRect.h);
      ctx.restore();
    }
  }

  function drawUnit(u) {
    const friendly = u.side === "player";
    const deathDur = u._deathDuration || 0.6;
    // Fade out only in the last 0.4s of the death animation to keep the sprite
    // visible while the death frames play.
    let fadeAlpha = 1;
    if (u.dying > 0) {
      const fadeStart = Math.min(0.4, deathDur);
      fadeAlpha = u.dying < fadeStart ? Math.max(0, u.dying / fadeStart) : 1;
    }

    // Soft elliptical shadow under the unit (drawn for sprite & procedural alike)
    if (u.def.sprite) {
      ctx.save();
      ctx.fillStyle = `rgba(0,0,0,${0.35 * fadeAlpha})`;
      ctx.beginPath();
      ctx.ellipse(u.x, u.y + 2, u.def.radius * 1.3, u.def.radius * 0.4, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    if (u.def.sprite && Art.cache.sprites[u.def.id]) {
      // sprite-driven unit
      Art.drawSpriteFrame(
        ctx,
        Art.cache.sprites[u.def.id],
        u.animState,
        u.animFrame,
        u.x,
        u.y,
        u.attackDirSign,
        { alpha: fadeAlpha }
      );

      // faction tint ring at feet
      ctx.save();
      ctx.strokeStyle = friendly ? "rgba(120, 220, 140, 0.7)" : "rgba(240, 110, 110, 0.7)";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.ellipse(u.x, u.y + 2, u.def.radius * 1.1, u.def.radius * 0.35, 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    } else {
      ctx.save();
      if (u.attackDirSign < 0) {
        ctx.translate(u.x, 0);
        ctx.scale(-1, 1);
        Art.drawUnitInto(ctx, u.def, 0, u.y, { attackPhase: u.attackPhase, alpha: fadeAlpha, friendly });
      } else {
        Art.drawUnitInto(ctx, u.def, u.x, u.y, { attackPhase: u.attackPhase, alpha: fadeAlpha, friendly });
      }
      ctx.restore();
    }

    // hit flash glow
    if (u.hitFlash > 0 && u.dying <= 0) {
      ctx.save();
      ctx.globalAlpha = Math.min(1, u.hitFlash * 4);
      ctx.fillStyle = "rgba(255, 220, 220, 0.55)";
      ctx.beginPath();
      ctx.arc(u.x, u.y - u.def.radius, u.def.radius * 1.15, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    // HP bar (skip if dying)
    if (u.dying <= 0) {
      const w = u.def.radius * 2.4;
      const x = u.x - w / 2;
      // sprite units have taller silhouettes — push the bar above the sprite
      const headOffset = u.def.sprite
        ? (u.def.sprite.drawHeight * (u.def.sprite.footAnchorY)) + 6
        : u.def.radius * 2 + 12;
      const y = u.y - headOffset;
      ctx.fillStyle = "rgba(0,0,0,0.7)";
      ctx.fillRect(x - 1, y - 1, w + 2, 5);
      ctx.fillStyle = friendly ? "#7be09a" : "#ff7676";
      ctx.fillRect(x, y, w * (u.hp / u.maxHp), 3);
    }
  }

  function drawProjectile(p) {
    // trail
    for (let i = 0; i < p.trail.length; i++) {
      const t = p.trail[i];
      const a = Math.max(0, t.life / 0.3) * (i / p.trail.length);
      ctx.save();
      ctx.globalAlpha = a * 0.7;
      ctx.fillStyle = p.color || "#fff";
      ctx.beginPath();
      ctx.arc(t.x, t.y, 3, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
    // head
    ctx.save();
    ctx.fillStyle = p.color || "#fff";
    ctx.shadowColor = p.color || "#fff";
    ctx.shadowBlur = 12;
    ctx.beginPath();
    ctx.arc(p.x, p.y, 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  function drawEffect(e) {
    if (e.delay && e.delay > 0) return; // not started yet
    const t = e.life / e.max;
    if (t <= 0) return;

    // ============================================================
    //   FIREBALL FX
    // ============================================================
    if (e.kind === "fb-flash") {
      // Sharp white flash, very short
      const r = e.radius * (1.5 - t * 0.5);
      const grad = ctx.createRadialGradient(e.x, e.y, 0, e.x, e.y, r);
      grad.addColorStop(0, `rgba(255, 255, 255, ${t})`);
      grad.addColorStop(0.4, `rgba(255, 230, 160, ${t * 0.7})`);
      grad.addColorStop(1, `rgba(255, 130, 30, 0)`);
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(e.x, e.y, r, 0, Math.PI * 2);
      ctx.fill();
    } else if (e.kind === "fireball") {
      // Main blossom — scales UP then fades
      const grow = 1 - Math.pow(t, 2);
      const r = e.radius * (0.55 + grow * 0.7);
      const grad = ctx.createRadialGradient(e.x, e.y, 4, e.x, e.y, r);
      grad.addColorStop(0,    `rgba(255, 250, 220, ${t})`);
      grad.addColorStop(0.25, `rgba(255, 200, 90,  ${t})`);
      grad.addColorStop(0.55, `rgba(255, 100, 20,  ${t * 0.85})`);
      grad.addColorStop(0.85, `rgba(160, 30, 0,    ${t * 0.55})`);
      grad.addColorStop(1,    `rgba(60, 0, 0, 0)`);
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(e.x, e.y, r, 0, Math.PI * 2);
      ctx.fill();
    } else if (e.kind === "fb-shockwave") {
      // Expanding ring — grows from 0 → e.radius as it fades
      const r = e.radius * (1 - t);
      ctx.save();
      ctx.strokeStyle = `rgba(255, 200, 100, ${t * 0.85})`;
      ctx.lineWidth = 4 + t * 6;
      ctx.beginPath();
      ctx.arc(e.x, e.y, r, 0, Math.PI * 2);
      ctx.stroke();
      // inner thinner trailing ring
      ctx.strokeStyle = `rgba(255, 240, 180, ${t * 0.6})`;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(e.x, e.y, r * 0.78, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    } else if (e.kind === "fb-scorch") {
      // Dark ground scorch — flat ellipse that fades slowly
      ctx.save();
      ctx.globalAlpha = t * 0.7;
      const grad = ctx.createRadialGradient(e.x, e.y, 0, e.x, e.y, e.radius);
      grad.addColorStop(0, "rgba(60, 25, 10, 0.8)");
      grad.addColorStop(0.6, "rgba(40, 15, 5, 0.5)");
      grad.addColorStop(1, "rgba(40, 15, 5, 0)");
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.ellipse(e.x, e.y, e.radius, e.radius * 0.45, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    } else if (e.kind === "fb-smoke") {
      // Greyish smoke that drifts up and dissipates
      const lifeT = 1 - t;                       // 0 at spawn → 1 at end
      const r = e.radius * (0.4 + lifeT * 1.2);
      const sy = e.y - lifeT * 28;
      ctx.save();
      ctx.globalAlpha = t * 0.6;
      const grad = ctx.createRadialGradient(e.x, sy, 0, e.x, sy, r);
      grad.addColorStop(0, "rgba(120, 110, 100, 0.7)");
      grad.addColorStop(1, "rgba(90, 80, 70, 0)");
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(e.x, sy, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    } else if (e.kind === "fb-ember") {
      // Small bright dot with a soft glow trail
      ctx.save();
      ctx.globalAlpha = t;
      ctx.shadowColor = "#ff8a18";
      ctx.shadowBlur = 8;
      ctx.fillStyle = "#ffe098";
      ctx.beginPath();
      ctx.arc(e.x, e.y, e.r * (0.4 + t * 0.6), 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
    // ============================================================
    //   HEAL FX
    // ============================================================
    else if (e.kind === "heal-flash") {
      // Bright core pulse
      const r = e.radius * (0.4 + (1 - t) * 0.8);
      const grad = ctx.createRadialGradient(e.x, e.y, 0, e.x, e.y, r);
      grad.addColorStop(0, `rgba(255, 255, 255, ${t * 0.95})`);
      grad.addColorStop(0.3, `rgba(180, 255, 200, ${t * 0.75})`);
      grad.addColorStop(1, `rgba(80, 200, 110, 0)`);
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(e.x, e.y, r, 0, Math.PI * 2);
      ctx.fill();
    } else if (e.kind === "heal-ring") {
      // Expanding ring with shimmer
      const r = e.radius * (1 - t);
      ctx.save();
      ctx.strokeStyle = `rgba(180, 255, 200, ${t * 0.9})`;
      ctx.lineWidth = 5 * t + 1;
      ctx.shadowColor = "rgba(120, 255, 160, 0.9)";
      ctx.shadowBlur = 14;
      ctx.beginPath();
      ctx.arc(e.x, e.y, r, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    } else if (e.kind === "heal") {
      // Persistent ground aura under the spell — soft green glow
      const r = e.radius * (0.6 + (1 - t) * 0.5);
      const grad = ctx.createRadialGradient(e.x, e.y, 0, e.x, e.y, r);
      grad.addColorStop(0, `rgba(180, 255, 200, ${t * 0.45})`);
      grad.addColorStop(1, "rgba(90, 200, 120, 0)");
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.ellipse(e.x, e.y, r, r * 0.55, 0, 0, Math.PI * 2);
      ctx.fill();
    } else if (e.kind === "heal-plus") {
      // Rising white "+" sparkle
      ctx.save();
      ctx.globalAlpha = Math.min(1, t * 1.3);
      ctx.shadowColor = "#a8f5a4";
      ctx.shadowBlur = 8;
      ctx.fillStyle = "#ffffff";
      const armW = Math.max(2, e.r * 0.32);
      const armL = e.r * 1.6;
      // vertical
      ctx.fillRect(e.x - armW / 2, e.y - armL / 2, armW, armL);
      // horizontal
      ctx.fillRect(e.x - armL / 2, e.y - armW / 2, armL, armW);
      ctx.restore();
    } else if (e.kind === "heal-spark") {
      // Existing tiny green spark from healers
      ctx.fillStyle = `rgba(180, 255, 180, ${t})`;
      ctx.beginPath();
      ctx.arc(e.x, e.y, 4, 0, Math.PI * 2);
      ctx.fill();
    }
    // ============================================================
    //   GENERIC
    // ============================================================
    else if (e.kind === "dust") {
      ctx.fillStyle = `rgba(180, 160, 120, ${t * 0.5})`;
      ctx.beginPath();
      ctx.arc(e.x, e.y, e.r * t, 0, Math.PI * 2);
      ctx.fill();
    } else if (e.kind === "dmg") {
      ctx.save();
      ctx.globalAlpha = Math.min(1, t * 1.4);
      ctx.fillStyle = e.color || "#fff";
      ctx.strokeStyle = "rgba(0,0,0,0.85)";
      ctx.lineWidth = 3;
      ctx.font = "bold 16px Trebuchet MS, sans-serif";
      ctx.textAlign = "center";
      ctx.strokeText(e.text, e.x, e.y);
      ctx.fillText(e.text, e.x, e.y);
      ctx.restore();
    }
  }

  function drawDragPreview() {
    const d = world.drag;
    if (!d) return;
    if (d.def.type === "unit") {
      const valid = isValidDeploy(d.x, d.y);
      const drawY = valid ? G.GROUND_Y : d.y;
      ctx.save();
      ctx.globalAlpha = valid ? 0.85 : 0.35;
      if (d.def.sprite && Art.cache.sprites[d.def.id]) {
        Art.drawSpriteFrame(
          ctx,
          Art.cache.sprites[d.def.id],
          "idle",
          0,
          d.x,
          drawY,
          1,
          { alpha: 1 }
        );
      } else {
        Art.drawUnitInto(ctx, d.def, d.x, drawY, { attackPhase: 0, alpha: 1, friendly: true });
      }
      ctx.restore();
    } else if (d.def.type === "spell") {
      ctx.save();
      ctx.strokeStyle = d.def.color;
      ctx.fillStyle = d.def.color + "30"; // hex alpha
      ctx.lineWidth = 3;
      ctx.setLineDash([8, 6]);
      ctx.beginPath();
      ctx.arc(d.x, d.y, d.def.aoeRadius, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    }
  }

  function isValidDeploy(x, y) {
    const z = G.PLAYER_DEPLOY_ZONE;
    return x >= z.x1 && x <= z.x2 && y >= G.GROUND_BAND_TOP && y <= G.GROUND_BAND_BOTTOM;
  }

  // ---------- HUD helpers ----------

  // Map mana cost → rarity tier (purely visual; gameplay-neutral).
  function rarityOf(def) {
    const c = def.manaCost;
    if (c >= 7) return "legendary";
    if (c >= 5) return "epic";
    if (c === 4) return "rare";
    return "common";
  }

  // Compact role glyph (one character). Emoji-rendered, falls back gracefully.
  function rolePicto(def) {
    if (def.id === "fireball") return "✦";
    if (def.id === "heal")     return "✚";
    switch (def.role) {
      case "tank":    return "🛡";
      case "ranged":  return "➹";
      case "mage":    return "✦";
      case "support": return "✚";
      case "fast":    return "✦";
      case "giant":   return "⚒";
      default:        return "⚔";
    }
  }

  function buildStatsHTML(def) {
    if (def.type === "unit") {
      return (
        `<span class="stat stat-hp"><span class="stat-icon">♥</span>${def.hp}</span>` +
        `<span class="stat stat-dmg"><span class="stat-icon">⚔</span>${def.damage}</span>`
      );
    }
    if (def.id === "fireball") {
      return `<span class="stat stat-aoe"><span class="stat-icon">✦</span>${def.damage}</span>`;
    }
    if (def.id === "heal") {
      return `<span class="stat stat-heal"><span class="stat-icon">✚</span>${def.heal}</span>`;
    }
    return "";
  }

  // ---------- HUD updates ----------
  function refreshHand() {
    handEl.innerHTML = "";
    world.player.hand.forEach((id, idx) => {
      const def = getCardDef(id);
      if (!def) return;
      const card = document.createElement("div");
      card.className = "card rarity-" + rarityOf(def);
      if (def.type === "unit") card.classList.add("unit");
      else if (def.id === "fireball") card.classList.add("spell", "spell-fire");
      else if (def.id === "heal") card.classList.add("spell", "spell-heal");
      else card.classList.add("spell");
      const affordable = world.player.mana >= def.manaCost;
      card.classList.toggle("disabled", !affordable);
      card.classList.toggle("affordable", affordable);
      card.dataset.idx = idx;

      const cost = document.createElement("div");
      cost.className = "cost";
      cost.textContent = def.manaCost;
      card.appendChild(cost);

      // Role pictogram
      const role = document.createElement("div");
      const roleClass = (def.id === "fireball") ? "role-spell-fire"
                       : (def.id === "heal")    ? "role-spell-heal"
                       : "role-" + (def.role || "melee");
      role.className = "role-tag " + roleClass;
      role.title = def.roleLabel || "";
      role.textContent = rolePicto(def);
      card.appendChild(role);

      const art = document.createElement("div");
      art.className = "art";
      // Use the raw 149×156 PNG directly — keeps icons sharp at any zoom.
      // Spells (no .icon path) fall back to the procedural canvas.
      if (def.icon) {
        const img = new Image();
        const iconPath = def.icon.startsWith("assets/") ? "game/" + def.icon : def.icon;
        img.src = iconPath;
        img.style.maxWidth = "100%";
        img.style.maxHeight = "100%";
        art.appendChild(img);
      } else {
        const icon = Art.cache.cardIcons[def.id];
        if (icon) {
          const img = new Image();
          img.src = icon.toDataURL();
          img.style.maxWidth = "100%";
          img.style.maxHeight = "100%";
          art.appendChild(img);
        }
      }
      card.appendChild(art);

      const name = document.createElement("div");
      name.className = "name";
      name.textContent = def.name;
      card.appendChild(name);

      const desc = document.createElement("div");
      desc.className = "desc";
      desc.textContent = def.desc || "";
      card.appendChild(desc);

      const stats = document.createElement("div");
      stats.className = "stats";
      stats.innerHTML = buildStatsHTML(def);
      card.appendChild(stats);

      card.addEventListener("pointerdown", (ev) => onCardPointerDown(ev, idx, def, card));

      handEl.appendChild(card);
    });
  }

  // Track previous integer mana so we can fire animations when crossing
  // integer boundaries (gain) and on explicit spend.
  let _prevFloorMana = null;

  function refreshMana(opts = {}) {
    if (!world) return;
    const m = world.player.mana;
    manaText.textContent = `${Math.floor(m)} / ${G.MAX_MANA}`;

    const prev = _prevFloorMana;
    const cur  = Math.floor(m);

    for (let i = 0; i < manaPips.length; i++) {
      const pip = manaPips[i];
      pip.classList.remove("full", "partial");
      pip.style.removeProperty("--fill");
      if (i + 1 <= m) pip.classList.add("full");
      else if (i < m) {
        pip.classList.add("partial");
        const frac = m - i;
        pip.style.setProperty("--fill", `${Math.round(frac * 100)}%`);
      }
    }

    // Detect a +1 crossing: pop the newly-filled pip(s).
    if (prev !== null && cur > prev) {
      for (let i = prev; i < cur; i++) {
        if (i >= 0 && i < manaPips.length) playPipPop(manaPips[i]);
      }
    }
    _prevFloorMana = cur;

    // Affordable / disabled state on cards
    [...handEl.children].forEach((card) => {
      const idx = +card.dataset.idx;
      const def = getCardDef(world.player.hand[idx]);
      if (!def) return;
      const affordable = m >= def.manaCost;
      card.classList.toggle("disabled", !affordable);
      card.classList.toggle("affordable", affordable);
    });
  }

  function playPipPop(pip) {
    pip.classList.remove("popping");
    void pip.offsetWidth; // restart animation
    pip.classList.add("popping");
    setTimeout(() => pip.classList.remove("popping"), 360);
    Sound.playClickSound();
  }

  // Animate a cascade of drains on the highest filled pips when player spends
  // `cost` mana. Right→left stagger so it reads as "draining toward zero".
  function playManaSpend(cost) {
    const startIdx = Math.min(manaPips.length - 1, Math.floor(world.player.mana + cost) - 1);
    for (let k = 0; k < cost; k++) {
      const i = startIdx - k;
      if (i < 0) break;
      const pip = manaPips[i];
      setTimeout(() => {
        pip.classList.remove("draining");
        void pip.offsetWidth;
        pip.classList.add("draining");
        setTimeout(() => pip.classList.remove("draining"), 260);
      }, k * 60);
    }
  }

  // Flash the missing pips in red briefly + shake the mana block.
  function playManaInsufficient(cost) {
    const have = Math.floor(world.player.mana);
    for (let i = have; i < Math.min(cost, manaPips.length); i++) {
      const pip = manaPips[i];
      pip.classList.remove("insufficient");
      void pip.offsetWidth;
      pip.classList.add("insufficient");
      setTimeout(() => pip.classList.remove("insufficient"), 280);
    }
    const block = document.getElementById("mana-block");
    if (block) {
      block.classList.remove("shake");
      void block.offsetWidth;
      block.classList.add("shake");
      setTimeout(() => block.classList.remove("shake"), 320);
    }
  }

  function refreshCastleHP() {
    if (!world) return;
    const ph = Math.max(0, Math.round(world.player.castleHp));
    const eh = Math.max(0, Math.round(world.enemy.castleHp));
    playerHpEl.textContent = `${ph} / ${G.CASTLE_MAX_HP}`;
    enemyHpEl.textContent = `${eh} / ${G.CASTLE_MAX_HP}`;
    // Drive the clip-path on the colored fill image via a CSS custom property.
    // Player bar drains right→left, enemy bar drains left→right (CSS handles
    // direction — see .hp-bar.player / .hp-bar.enemy in styles.css).
    const playerPct = (ph / G.CASTLE_MAX_HP) * 100;
    const enemyPct = (eh / G.CASTLE_MAX_HP) * 100;
    playerBar.style.setProperty("--hp", playerPct + "%");
    enemyBar.style.setProperty("--hp", enemyPct + "%");
  }

  function formatTime(s) {
    const m = Math.floor(s / 60);
    const r = Math.floor(s % 60);
    return `${m}:${r.toString().padStart(2, "0")}`;
  }

  // ---------- Input: drag & drop ----------
  function onCardPointerDown(ev, idx, def, cardEl) {
    if (phase !== "playing") return;
    if (world.player.mana < def.manaCost) {
      // shake to reject + flash the missing mana pips red
      cardEl.classList.remove("shake");
      void cardEl.offsetWidth;
      cardEl.classList.add("shake");
      playManaInsufficient(def.manaCost);
      Sound.playDenySound();
      return;
    }
    ev.preventDefault();
    cardEl.classList.add("dragging");
    const { x, y } = canvasCoordsFromEvent(ev);
    world.drag = { idx, def, x, y, originEl: cardEl };
    document.addEventListener("pointermove", onPointerMove);
    document.addEventListener("pointerup", onPointerUp, { once: true });
  }

  function onPointerMove(ev) {
    if (!world.drag) return;
    const { x, y } = canvasCoordsFromEvent(ev);
    world.drag.x = x;
    world.drag.y = y;
  }

  function onPointerUp(ev) {
    document.removeEventListener("pointermove", onPointerMove);
    if (!world.drag) return;
    const { x, y } = canvasCoordsFromEvent(ev);
    const d = world.drag;
    let played = false;

    if (d.def.type === "unit") {
      if (isValidDeploy(x, y)) {
        spawnUnit("player", d.def.id, x);
        played = true;
      }
    } else if (d.def.type === "spell") {
      if (x >= 0 && x <= G.CANVAS_W && y >= 0 && y <= G.CANVAS_H) {
        castSpell(d.def.id, x, y, "player");
        played = true;
      }
    }

    if (played) {
      // FX: cascade-drain the spent pips, fly the card off, then refresh hand
      playManaSpend(d.def.manaCost);
      if (d.originEl) {
        d.originEl.classList.remove("dragging");
        d.originEl.classList.add("played");
      }
      world.player.mana -= d.def.manaCost;
      world.stats.manaSpent += d.def.manaCost;
      world.stats.cardsPlayed += 1;
      world.player.hand.splice(d.idx, 1);
      fillHand(world.player);
      // wait briefly so the play-out animation can read before re-rendering
      setTimeout(() => {
        refreshHand();
        refreshMana();
      }, 160);
      // also refresh mana state immediately for cards still in hand
      refreshMana();
    } else if (d.originEl) {
      // snap back: visually reset the dragging state with a brief shake
      d.originEl.classList.remove("dragging");
      d.originEl.classList.remove("shake");
      void d.originEl.offsetWidth;
      d.originEl.classList.add("shake");
      Sound.playDenySound();
    }
    world.drag = null;
  }

  function canvasCoordsFromEvent(ev) {
    const rect = canvas.getBoundingClientRect();
    const sx = G.CANVAS_W / rect.width;
    const sy = G.CANVAS_H / rect.height;
    return {
      x: (ev.clientX - rect.left) * sx,
      y: (ev.clientY - rect.top) * sy,
    };
  }

  // ---------- Match end ----------
  // -----------------------------------------------------------------------
  //  Performance scoring  (described in the design brief)
  // -----------------------------------------------------------------------
  //  Score = (CastleDamage × 0.45)
  //        + (TimeRemaining × 0.25)
  //        + (ArmySurvival × 0.15)
  //        + (DeploymentEfficiency × 0.10)
  //        + (DestructionBonus × 0.05)
  //
  //  Stars:
  //    ≥ 85 AND castle destroyed → 3 ★
  //    ≥ 65                       → 2 ★
  //    ≥ 40 OR castle destroyed   → 1 ★
  //    otherwise                  → 0 ★
  //
  //  Weights are extracted as named constants for easy balancing.
  // -----------------------------------------------------------------------
  const SCORE_WEIGHTS = {
    castleDamage: 0.45,
    timeRemaining: 0.25,
    armySurvival: 0.15,
    deploymentEfficiency: 0.10,
    destructionBonus: 0.05,
  };
  // Cap on "max units a player would reasonably deploy" — used by the
  // deployment-efficiency criterion. Anything below this is fine, anything
  // above is "spammy".
  const MAX_REASONABLE_DEPLOYS = 30;

  function computePerformance() {
    const stats = world.stats || {};
    const enemyMaxHp = G.CASTLE_MAX_HP;
    const enemyHp = Math.max(0, world.enemy.castleHp);
    const castleDestroyed = enemyHp <= 0;

    // Castle damage: 0..100 = % HP we removed from the enemy castle
    const castleDamageScore = clamp(((enemyMaxHp - enemyHp) / enemyMaxHp) * 100, 0, 100);

    // Time remaining (seconds left in the match scaled to 100)
    const timeRemaining = Math.max(0, world.matchEndsAt - world.time);
    const timeScore = clamp((timeRemaining / G.MATCH_DURATION_SEC) * 100, 0, 100);

    // Army survival: alive friendly units / total deployed
    const aliveUnits = world.units.filter(
      (u) => u.side === "player" && u.dying <= 0 && u.hp > 0
    ).length;
    const deployed = stats.playerDeployed || 0;
    const survivalScore = deployed === 0 ? 100 : clamp((aliveUnits / deployed) * 100, 0, 100);

    // Deployment efficiency: leaving "head room" instead of spamming everything.
    //   unused = MAX_REASONABLE_DEPLOYS − deployed (clamped ≥ 0)
    //   score  = unused / MAX × 100
    const unused = Math.max(0, MAX_REASONABLE_DEPLOYS - deployed);
    const deploymentScore = clamp((unused / MAX_REASONABLE_DEPLOYS) * 100, 0, 100);

    // Destruction bonus
    const destructionBonus = castleDestroyed ? 100 : 0;

    const performanceScore =
      castleDamageScore * SCORE_WEIGHTS.castleDamage +
      timeScore * SCORE_WEIGHTS.timeRemaining +
      survivalScore * SCORE_WEIGHTS.armySurvival +
      deploymentScore * SCORE_WEIGHTS.deploymentEfficiency +
      destructionBonus * SCORE_WEIGHTS.destructionBonus;

    let stars = 0;
    if (performanceScore >= 85 && castleDestroyed) stars = 3;
    else if (performanceScore >= 65) stars = 2;
    else if (performanceScore >= 40 || castleDestroyed) stars = 1;
    if (castleDestroyed && stars < 1) stars = 1; // explicit floor when destroyed

    return {
      castleDamageScore: Math.round(castleDamageScore),
      timeScore: Math.round(timeScore),
      survivalScore: Math.round(survivalScore),
      deploymentScore: Math.round(deploymentScore),
      destructionBonus,
      total: Math.round(performanceScore),
      stars,
      castleDestroyed,
      deployed,
      aliveUnits,
    };
  }

  function endMatch(result) {
    if (world.ended) return;
    world.ended = true;
    phase = "ended";
    const card = endgameEl.querySelector(".endgame-card");
    card.classList.remove("win", "lose");
    if (result === "win") {
      endgameTitle.textContent = "Victory!";
      endgameSub.textContent = "You crushed the enemy castle.";
      card.classList.add("win");
      Sound.playVictorySound();
    } else if (result === "lose") {
      endgameTitle.textContent = "Defeat";
      endgameSub.textContent = "Your castle has fallen.";
      card.classList.add("lose");
      Sound.playDefeatSound();
    } else {
      endgameTitle.textContent = "Draw";
      endgameSub.textContent = "Time ran out with both castles standing.";
    }

    // Compute score → render breakdown + stars → persist for the current stage
    const perf = computePerformance();
    renderEndgameScore(perf);
    recordStageResult(currentStageIdx, perf.stars);
    updateDDA(currentStageIdx, perf);

    endgameEl.classList.remove("hidden");
  }

  // ---------- State machine ----------
  function showTitle() {
    phase = "title";
    titleEl.classList.remove("hidden");
    pauseEl.classList.add("hidden");
    endgameEl.classList.add("hidden");
    canvas.classList.remove("shaking");
    matchTimerEl.textContent = formatTime(G.MATCH_DURATION_SEC);
    // Always reset the main menu to the HOME screen when returning here
    document.querySelectorAll(".menu-screen").forEach((s) => {
      s.classList.toggle("hidden", s.dataset.screen !== "home");
    });
  }

  function startMatch(opts) {
    world = newWorld();
    // Campaign mode swaps the visual theme (background + castles) only.
    // Quick-play (JOUER) keeps the default look.
    world.isCampaign = !!(opts && opts.campaign);

    // Resolve the AI profile for this stage (with DDA modifiers if any)
    const baseProfile = STAGE_AI_PROFILES[currentStageIdx + 1] || STAGE_AI_PROFILES[1];
    world.aiProfile = applyDDA(baseProfile, currentStageIdx);
    // Push the first-action delay onto the AI's first decision time
    world.enemy.nextDecisionAt = world.aiProfile.firstActionDelay;

    fillHand(world.player);
    fillHand(world.enemy, (excludeIds) => drawCardForAi(world.aiProfile, excludeIds));
    refreshHand();
    refreshMana();
    refreshCastleHP();
    matchTimerEl.textContent = formatTime(G.MATCH_DURATION_SEC);
    titleEl.classList.add("hidden");
    pauseEl.classList.add("hidden");
    endgameEl.classList.add("hidden");
    phase = "playing";
    lastT = performance.now();
    if (!running) {
      running = true;
      requestAnimationFrame(tick);
    }
  }

  function pauseMatch() {
    if (phase !== "playing") return;
    phase = "paused";
    pauseEl.classList.remove("hidden");
  }

  function resumeMatch() {
    if (phase !== "paused") return;
    phase = "playing";
    pauseEl.classList.add("hidden");
    lastT = performance.now();
  }

  function tick(now) {
    const rawDt = (now - lastT) / 1000;
    const dt = Math.min(0.05, rawDt) * speedMultiplier;
    lastT = now;

    if (phase === "playing") update(dt);
    refreshMana();
    refreshCastleHP();
    if (world) render();

    // screen shake — applied via transform on canvas wrapper
    if (shakeT > 0 && phase === "playing") {
      const a = shakeT > 0 ? Math.min(1, shakeT / 0.4) : 0;
      const ox = (Math.random() - 0.5) * shakeIntensity * a;
      const oy = (Math.random() - 0.5) * shakeIntensity * a;
      canvas.style.transform = `translate(${ox.toFixed(2)}px, ${oy.toFixed(2)}px)`;
    } else {
      canvas.style.transform = "";
      shakeIntensity = 0;
    }

    requestAnimationFrame(tick);
  }

  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

  // ---------- Wire up UI buttons ----------
  // Legacy #play-btn (hidden arena tab) → quick-play default theme
  playBtn.addEventListener("click", () => { Sound.playClickSound(); startMatch({ campaign: false }); });
  // "Play Again" after a match → preserves whichever mode was active
  restartBtn.addEventListener("click", () => {
    Sound.playClickSound();
    startMatch({ campaign: !!(world && world.isCampaign) });
  });
  endMenuBtn.addEventListener("click", () => { Sound.playClickSound(); showTitle(); });
  pauseBtn.addEventListener("click", () => { Sound.playClickSound(); phase === "paused" ? resumeMatch() : pauseMatch(); });
  resumeBtn.addEventListener("click", () => { Sound.playClickSound(); resumeMatch(); });
  quitBtn.addEventListener("click", () => { Sound.playClickSound(); pauseEl.classList.add("hidden"); showTitle(); });
  speedBtn.addEventListener("click", () => {
    Sound.playClickSound();
    speedMultiplier = speedMultiplier === 1 ? 2 : 1;
    speedBtn.textContent = `x${speedMultiplier}`;
    speedBtn.classList.toggle("active", speedMultiplier !== 1);
  });

  // ---------- Stage progression / persistence ----------
  // 6 stages — first one is always playable, others unlock as you star earlier
  // ones. Star counts persist in localStorage as { idx: starsEarned } keyed by
  // stage index. -1 means "never played".
  const STAGE_COUNT = 6;
  const STAR_STORAGE_KEY = "castleClash.stageStars.v1";
  const DDA_STORAGE_KEY  = "castleClash.dda.v1";

  // Reset campaign progression on every page reload — the player always
  // starts fresh at stage 1 with no DDA modifier. Comment out the two
  // removeItem calls if you want progression to persist across sessions.
  try {
    localStorage.removeItem(STAR_STORAGE_KEY);
    localStorage.removeItem(DDA_STORAGE_KEY);
  } catch (_) {}

  let stageStars = loadStageStars();
  let stageDDA   = loadDDA();           // per-stage difficulty modifier (-1 / 0 / +1)
  let currentStageIdx = pickNextStage();

  function loadStageStars() {
    try {
      const raw = localStorage.getItem(STAR_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.length === STAGE_COUNT) return parsed;
      }
    } catch (_) {}
    return new Array(STAGE_COUNT).fill(-1); // -1 = unplayed, 0..3 = star result
  }
  function saveStageStars() {
    try { localStorage.setItem(STAR_STORAGE_KEY, JSON.stringify(stageStars)); } catch (_) {}
  }
  function loadDDA() {
    try {
      const raw = localStorage.getItem(DDA_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.length === STAGE_COUNT) return parsed;
      }
    } catch (_) {}
    return new Array(STAGE_COUNT).fill(0); // 0 = baseline, +1 = harder, -1 = easier
  }
  function saveDDA() {
    try { localStorage.setItem(DDA_STORAGE_KEY, JSON.stringify(stageDDA)); } catch (_) {}
  }

  // ---------- DYNAMIC DIFFICULTY ADJUSTMENT ----------
  // Returns a tweaked copy of `baseProfile` based on the player's recent
  // performance on this stage. Modifiers are bounded to ±15 % of baseline so a
  // skilled player can still reset the curve, and stage 1 is never modified.
  function applyDDA(baseProfile, stageIdx) {
    if (stageIdx === 0) return { ...baseProfile }; // never tweak the tutorial
    const mod = stageDDA[stageIdx] || 0;            // -1 = easier, +1 = harder
    if (mod === 0) return { ...baseProfile };
    const factor = mod > 0 ? 1.10 : 0.90;
    return {
      ...baseProfile,
      manaMul:        clamp(baseProfile.manaMul * factor, baseProfile.manaMul * 0.85, baseProfile.manaMul * 1.15),
      misplayChance:  clamp(baseProfile.misplayChance * (mod > 0 ? 0.7 : 1.3), 0, 0.5),
      // Slightly faster decisions on harder DDA, slower on easier
      decisionInterval: baseProfile.decisionInterval.map((v) => v * (mod > 0 ? 0.92 : 1.08)),
      label: baseProfile.label + (mod > 0 ? " ★" : " ↓"),
    };
  }
  function updateDDA(stageIdx, perf) {
    if (stageIdx === 0) return;
    const beforeMod = stageDDA[stageIdx] || 0;
    let nextMod = beforeMod;
    // Crush victory → bump up (next time this stage will be harder)
    if (perf.stars === 3 && perf.castleDestroyed && (world.player.castleHp / G.CASTLE_MAX_HP) > 0.85) {
      nextMod = Math.min(1, beforeMod + 1);
    }
    // Decisive defeat → ease up
    else if (perf.stars === 0 && !perf.castleDestroyed && world.time < 120) {
      nextMod = Math.max(-1, beforeMod - 1);
    }
    // Standard performance → drift back to baseline (slow, only over multiple matches)
    else {
      if (beforeMod > 0 && perf.stars < 2) nextMod = beforeMod - 1;
      if (beforeMod < 0 && perf.stars > 1) nextMod = beforeMod + 1;
    }
    if (nextMod !== beforeMod) {
      stageDDA[stageIdx] = nextMod;
      saveDDA();
    }
  }
  function pickNextStage() {
    // First unplayed (stars === -1) and unlocked stage
    for (let i = 0; i < STAGE_COUNT; i++) {
      if (stageStars[i] === -1 && isStageUnlocked(i)) return i;
    }
    // Otherwise the lowest-starred unlocked stage (replay)
    for (let i = 0; i < STAGE_COUNT; i++) {
      if (isStageUnlocked(i)) return i;
    }
    return 0;
  }
  function isStageUnlocked(i) {
    return i === 0 || stageStars[i - 1] >= 1;
  }
  function recordStageResult(idx, stars) {
    if (idx < 0 || idx >= STAGE_COUNT) return;
    if (stars > (stageStars[idx] || 0)) {
      stageStars[idx] = stars;
      saveStageStars();
    } else if (stageStars[idx] === -1) {
      // First completion (even with 0 stars) overwrites the unplayed marker
      stageStars[idx] = Math.max(0, stars);
      saveStageStars();
    }
    // After completion, advance to next unplayed stage if available
    currentStageIdx = pickNextStage();
    refreshMapTrail();
    refreshMapPlayBtn();
  }

  // Position of each stage along the cartoon path (% of the map image).
  // Coordinates were derived from a horizontal pixel scan of LvlMap02.png for
  // the sand-yellow walkway colour (RGB ≈ 255, 198, 102) — the desert path
  // winds from the upper-left tent down toward the lower-right tent.
  const STAGE_POSITIONS = [
    { x: 12, y: 55 },   // 1 — left side, on the descending portion of the path
    { x: 26, y: 38 },   // 2 — nudged a bit RIGHT
    { x: 40, y: 27 },   // 3 — nudged slightly UP
    { x: 58, y: 30 },   // 4 — centre, before the dive
    { x: 68, y: 80 },   // 5 — moved DOWN, deeper into the south dip
    { x: 90, y: 50 },   // 6 — final ascent toward the lower-right tent (boss)
  ];

  // Map rendering ---------------------------------------------------------
  function refreshMapTrail() {
    const canvas = document.getElementById("map-canvas");
    if (!canvas) return;
    canvas.innerHTML = "";
    for (let i = 0; i < STAGE_COUNT; i++) {
      const pos = STAGE_POSITIONS[i] || { x: 50, y: 50 };
      const cell = document.createElement("div");
      cell.className = "map-stage";
      cell.style.left = pos.x + "%";
      cell.style.top  = pos.y + "%";

      const unlocked = isStageUnlocked(i);
      const stars = stageStars[i];

      let img;
      if (!unlocked) {
        cell.classList.add("locked");
        img = "game/assets/ui/menu/LvlMapLock.png";
      } else if (stars === -1) {
        if (i === currentStageIdx) cell.classList.add("current");
        img = "game/assets/ui/menu/LvlMapAvailable.png";
      } else {
        const s = Math.max(0, Math.min(3, stars));
        const file = s === 0 ? "LvlMap0Star" :
                     s === 1 ? "LvlMap1Star" :
                     s === 2 ? "LvlMap2Star" :
                                "LvlMap3Star";
        img = `game/assets/ui/menu/${file}.png`;
        if (i === currentStageIdx) cell.classList.add("current");
      }

      cell.innerHTML =
        `<img src="${img}" alt="Stage ${i + 1}">` +
        `<span class="stage-num">${i + 1}</span>`;

      cell.addEventListener("click", () => {
        if (!unlocked) { Sound.playDenySound(); return; }
        Sound.playClickSound();
        currentStageIdx = i;
        refreshMapTrail();
        refreshMapPlayBtn();
      });
      canvas.appendChild(cell);
    }
  }
  function refreshMapPlayBtn() {
    const btn = document.getElementById("map-play-btn");
    if (!btn) return;
    const profile = STAGE_AI_PROFILES[currentStageIdx + 1] || STAGE_AI_PROFILES[1];
    const ddaMod = stageDDA[currentStageIdx] || 0;
    let suffix = "";
    if (ddaMod > 0) suffix = " ★";
    else if (ddaMod < 0) suffix = " ↓";
    btn.textContent = `STAGE ${currentStageIdx + 1} — ${profile.label}${suffix}`;
  }
  refreshMapTrail();
  refreshMapPlayBtn();

  // Endgame rendering ----------------------------------------------------
  function renderEndgameScore(perf) {
    const set = (id, v) => {
      const el = document.getElementById(id);
      if (el) el.textContent = v;
    };
    set("end-score-total", perf.total);
    set("end-score-castle", perf.castleDamageScore);
    set("end-score-time", perf.timeScore);
    set("end-score-survival", perf.survivalScore);
    set("end-score-deploy", perf.deploymentScore);
    set("end-score-destruction", perf.destructionBonus);

    // Animate the stars sequentially
    const stars = document.querySelectorAll(".end-star");
    stars.forEach((s) => s.classList.remove("lit"));
    setTimeout(() => {
      stars.forEach((s, i) => {
        if (i < perf.stars) s.classList.add("lit");
      });
    }, 250);
  }

  // ---------- Main menu wiring ----------
  let menuGold = 230; // cosmetic gold counter

  function setActiveTab(name) {
    document.querySelectorAll(".menu-tab").forEach((t) => {
      t.classList.toggle("active", t.dataset.tab === name);
    });
    document.querySelectorAll(".tab-panel").forEach((p) => {
      p.classList.toggle("hidden", p.dataset.tab !== name);
    });
  }

  function flashGold(amount) {
    menuGold += amount;
    const el = document.getElementById("menu-gold-amount");
    if (el) {
      el.textContent = menuGold;
      el.style.transition = "transform 0.18s ease, color 0.18s ease";
      el.style.transform = "scale(1.25)";
      el.style.color = "#fff58a";
      setTimeout(() => {
        el.style.transform = "";
        el.style.color = "";
      }, 220);
    }
  }

  function buildHeroesGrid() {
    const grid = document.getElementById("menu-heroes-grid");
    if (!grid || grid.dataset.built === "1") return;
    grid.dataset.built = "1";
    Object.values(UNITS).forEach((u) => {
      const cell = document.createElement("div");
      cell.className = "hero-cell";
      cell.title = `${u.name} — ${u.roleLabel} — ${u.manaCost}`;
      const cost = document.createElement("div");
      cost.className = "hero-cost";
      cost.textContent = u.manaCost;
      cell.appendChild(cost);
      const img = document.createElement("img");
      img.src = u.icon || "";
      // u.icon is a relative path like "assets/icons/01.png" — prefix for /game/
      if (img.src && !img.src.startsWith("http") && img.getAttribute("src").startsWith("assets/")) {
        img.src = "game/" + img.getAttribute("src");
      }
      cell.appendChild(img);
      grid.appendChild(cell);
    });
  }

  // ---------- Arena hero loadout ----------
  // 6 slots — purely cosmetic so far. Click cycles through the 20 heroes.
  const arenaSlots = [null, null, null, null, null, null];
  function refreshArenaSlots() {
    const slotEls = document.querySelectorAll(".hero-slot");
    const heroIds = Object.keys(UNITS);
    slotEls.forEach((el, i) => {
      const heroId = arenaSlots[i];
      el.innerHTML = "";
      if (heroId && UNITS[heroId]) {
        el.classList.remove("empty");
        const img = document.createElement("img");
        const iconPath = UNITS[heroId].icon || "";
        img.src = iconPath.startsWith("assets/") ? "game/" + iconPath : iconPath;
        el.appendChild(img);
      } else {
        el.classList.add("empty");
      }
    });
  }
  function attachArenaSlots() {
    const slotEls = document.querySelectorAll(".hero-slot");
    const heroIds = Object.keys(UNITS);
    slotEls.forEach((el, i) => {
      el.addEventListener("click", () => {
        Sound.playClickSound();
        const cur = arenaSlots[i];
        // Cycle: null → first hero → next → ... → last → null
        if (cur == null) arenaSlots[i] = heroIds[0];
        else {
          const idx = heroIds.indexOf(cur);
          arenaSlots[i] = idx === heroIds.length - 1 ? null : heroIds[idx + 1];
        }
        refreshArenaSlots();
      });
    });
  }
  attachArenaSlots();
  refreshArenaSlots();

  document.querySelectorAll(".menu-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      Sound.playClickSound();
      const name = tab.dataset.tab;
      setActiveTab(name);
      if (name === "heroes") buildHeroesGrid();
      if (name === "map") { refreshMapTrail(); refreshMapPlayBtn(); }
    });
  });

  // ---------- New main menu screen navigation ----------
  function showMenuScreen(name) {
    const screens = document.querySelectorAll(".menu-screen");
    screens.forEach((s) => s.classList.toggle("hidden", s.dataset.screen !== name));
    if (name === "map") { refreshMapTrail(); refreshMapPlayBtn(); }
    if (name === "heroes") buildHeroesCollection();
  }

  const btnJouer = document.getElementById("btn-jouer");
  if (btnJouer) btnJouer.addEventListener("click", () => {
    Sound.playClickSound();
    // Quick play uses the default visual theme
    startMatch({ campaign: false });
  });
  const btnCampagne = document.getElementById("btn-campagne");
  if (btnCampagne) btnCampagne.addEventListener("click", () => {
    Sound.playClickSound();
    showMenuScreen("map");
  });
  const btnHeroes = document.getElementById("btn-heroes");
  if (btnHeroes) btnHeroes.addEventListener("click", () => {
    Sound.playClickSound();
    showMenuScreen("heroes");
  });

  // ---------- Heroes collection builder ----------
  // Renders one card per unit + spell, showing cost / rarity / stats /
  // special ability. Built once on first visit and cached.
  function rarityKey(def) {
    const c = def.manaCost;
    if (c >= 7) return "legendary";
    if (c >= 5) return "epic";
    if (c === 4) return "rare";
    return "common";
  }
  function rarityLabel(key) {
    return { common: "Commun", rare: "Rare", epic: "Épique", legendary: "Légendaire" }[key] || "";
  }
  function specialText(def) {
    const lines = [];
    if (def.bonusVsCastle && def.bonusVsCastle > 1) {
      lines.push(`Dégâts ×${def.bonusVsCastle.toFixed(1)} contre les châteaux`);
    }
    if (def.takesExtraDamage && def.takesExtraDamage > 1) {
      lines.push(`Subit ×${def.takesExtraDamage.toFixed(1)} dégâts (fragile)`);
    }
    if (def.healPerSecond) {
      lines.push(`Soigne ${def.healPerSecond}/s les alliés à ${def.healRange}px`);
    }
    if (def.projectile && def.projectile.aoeRadius) {
      lines.push(`Projectile à dégâts de zone (rayon ${def.projectile.aoeRadius})`);
    }
    if (def.id === "fireball") lines.push(`Inflige ${def.damage} dégâts AoE (rayon ${def.aoeRadius})`);
    if (def.id === "heal")     lines.push(`Soigne ${def.heal} PV aux alliés (rayon ${def.aoeRadius})`);
    return lines.join("\n");
  }

  function buildHeroesCollection() {
    const grid = document.getElementById("heroes-collection");
    if (!grid || grid.dataset.built === "1") return;
    grid.dataset.built = "1";

    const all = [
      ...Object.values(UNITS).sort((a, b) => a.manaCost - b.manaCost),
      ...Object.values(SPELLS).sort((a, b) => a.manaCost - b.manaCost),
    ];

    all.forEach((def) => {
      const card = document.createElement("div");
      const rk = rarityKey(def);
      card.className = `hero-card rarity-${rk}`;

      // cost
      const cost = document.createElement("div");
      cost.className = "hc-cost";
      cost.textContent = def.manaCost;
      card.appendChild(cost);

      // rarity badge
      const rar = document.createElement("div");
      rar.className = "hc-rarity";
      rar.textContent = rarityLabel(rk);
      card.appendChild(rar);

      // art slot — load the original 149×156 PNG directly (no canvas
      // downscale → keeps the icon sharp at any display size)
      const art = document.createElement("div");
      art.className = "hc-art";
      if (def.icon) {
        const img = new Image();
        const iconPath = def.icon.startsWith("assets/") ? "game/" + def.icon : def.icon;
        img.src = iconPath;
        img.alt = def.name;
        art.appendChild(img);
      } else {
        // Fallback: spell — use the procedural icon canvas
        const iconCanvas = Art.cache.cardIcons[def.id];
        if (iconCanvas) {
          const img = new Image();
          img.src = iconCanvas.toDataURL();
          art.appendChild(img);
        }
      }
      card.appendChild(art);

      // name + role
      const name = document.createElement("div");
      name.className = "hc-name";
      name.textContent = def.name;
      card.appendChild(name);
      const role = document.createElement("div");
      role.className = "hc-role";
      role.textContent = def.roleLabel || (def.type === "spell" ? "Sort" : "");
      card.appendChild(role);

      // stats line
      const stats = document.createElement("div");
      stats.className = "hc-stats";
      if (def.type === "unit") {
        stats.innerHTML =
          `<span class="hc-stat-hp">♥ ${def.hp}</span>` +
          `<span class="hc-stat-dmg">⚔ ${def.damage}</span>` +
          `<span class="hc-stat-rng">➹ ${def.range}</span>` +
          `<span class="hc-stat-spd">↗ ${def.moveSpeed.toFixed(1)}</span>`;
      } else if (def.id === "fireball") {
        stats.innerHTML = `<span class="hc-stat-dmg">✦ ${def.damage} AoE</span>`;
      } else if (def.id === "heal") {
        stats.innerHTML = `<span class="hc-stat-hp">✚ +${def.heal} HP</span>`;
      }
      card.appendChild(stats);

      // special ability description (if any)
      const special = specialText(def);
      if (special) {
        const sp = document.createElement("div");
        sp.className = "hc-special";
        sp.textContent = special;
        card.appendChild(sp);
      } else if (def.desc) {
        const sp = document.createElement("div");
        sp.className = "hc-special";
        sp.textContent = def.desc;
        card.appendChild(sp);
      }

      grid.appendChild(card);
    });
  }

  // Cosmetic main + bottom buttons (no functional behavior yet)
  document.querySelectorAll(".big-menu-btn[data-cosmetic], .bottom-icon[data-cosmetic]")
    .forEach((b) => b.addEventListener("click", () => Sound.playClickSound()));

  // Bottom OPTIONS icon → opens options screen
  const btnBottomOptions = document.querySelector('.bottom-icon[data-action="options"]');
  if (btnBottomOptions) btnBottomOptions.addEventListener("click", () => {
    Sound.playClickSound();
    showMenuScreen("options");
  });

  // Back buttons return to the home view
  document.querySelectorAll(".back-btn[data-back]").forEach((b) => {
    b.addEventListener("click", () => {
      Sound.playClickSound();
      showMenuScreen("home");
    });
  });

  // Cosmetic shop buttons
  document.querySelectorAll('[data-action="buy-coins"]').forEach((btn) => {
    btn.addEventListener("click", () => {
      Sound.playCardSound();
      flashGold(parseInt(btn.dataset.amount, 10) || 0);
    });
  });
  document.querySelectorAll('[data-action="buy-deal"]').forEach((btn) => {
    btn.addEventListener("click", () => {
      Sound.playCardSound();
      btn.textContent = "PURCHASED ✓";
      btn.disabled = true;
    });
  });
  document.querySelectorAll('[data-action="watch-video"]').forEach((btn) => {
    btn.addEventListener("click", () => {
      Sound.playClickSound();
      flashGold(50);
    });
  });
  const goldAddBtn = document.getElementById("menu-gold-add");
  if (goldAddBtn) goldAddBtn.addEventListener("click", () => {
    Sound.playClickSound();
    setActiveTab("shop");
    document.querySelector('.menu-tab[data-tab="shop"]').classList.add("active");
  });

  // Map "Play Stage" button just starts a match
  const mapPlayBtn = document.getElementById("map-play-btn");
  if (mapPlayBtn) mapPlayBtn.addEventListener("click", () => {
    Sound.playClickSound();
    // Campaign play uses the campaign visual theme
    startMatch({ campaign: true });
  });

  // Options
  const optSound = document.getElementById("opt-sound");
  if (optSound) optSound.addEventListener("change", (ev) => {
    Sound.setMuted(!ev.target.checked);
  });
  const optFast = document.getElementById("opt-fast");
  if (optFast) optFast.addEventListener("change", (ev) => {
    speedMultiplier = ev.target.checked ? 2 : 1;
    speedBtn.textContent = `x${speedMultiplier}`;
    speedBtn.classList.toggle("active", speedMultiplier !== 1);
  });
  const optRestart = document.getElementById("opt-restart");
  if (optRestart) optRestart.addEventListener("click", () => {
    Sound.playClickSound();
    // Restart preserves whichever mode was active
    startMatch({ campaign: !!(world && world.isCampaign) });
  });
  document.addEventListener("keydown", (ev) => {
    if (ev.code === "Space") {
      ev.preventDefault();
      if (phase === "playing") pauseMatch();
      else if (phase === "paused") resumeMatch();
    }
  });

  // ---------- Boot ----------
  // Two-phase: bootEssential resolves quickly with the menu's required art,
  // then sprites continue loading in the background. The render loop falls
  // back to procedural silhouettes for any unit whose sprites haven't yet
  // finished loading, so the player can start a match immediately.
  Art.bootEssential().then(() => {
    showTitle();
    if (!running) {
      running = true;
      lastT = performance.now();
      requestAnimationFrame(tick);
    }
    // Kick the heavy sprite load AFTER the menu is interactive.
    Art.bootSprites();
  });
})();
