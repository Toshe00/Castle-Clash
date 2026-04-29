// =============================================================================
// game.js — main game loop, state machine, and all real-time systems.
// Depends on: data.js, art.js, audio.js
// =============================================================================

(() => {
  const G = GAME_CONSTANTS;

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
        nextDecisionAt: 2.5,
        castleHitFlash: 0,
      },

      units: [],
      projectiles: [],
      effects: [],   // visual flashes (damage numbers, fireball booms, heals, dust)
      drag: null,    // { def, idx, x, y, originEl }
    };
  }

  // ---------- Deck ----------
  function drawCard() {
    return CARD_POOL[Math.floor(Math.random() * CARD_POOL.length)];
  }
  function fillHand(player) {
    while (player.hand.length < G.HAND_SIZE) player.hand.push(drawCard());
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
      // sprite animation state (used when def.sprite is defined)
      animState: "idle",
      animFrame: 0,
      animLocked: 0,        // when > 0, keep current animState (one-shot anims)
    });
    Sound.playCardSound();
  }

  function castSpell(spellId, x, y, casterSide) {
    const spell = SPELLS[spellId];
    if (!spell) return;
    if (spell.id === "fireball") {
      world.effects.push({ kind: "fireball", x, y, radius: spell.aoeRadius, life: 0.6, max: 0.6 });
      addShake(0.25, 8);
      Sound.playSpellFireSound();
      for (const u of world.units) {
        if (u.side === casterSide || u.dying > 0) continue;
        const dx = u.x - x, dy = u.y - y;
        if (dx * dx + dy * dy <= spell.aoeRadius * spell.aoeRadius) {
          dealDamage(u, spell.damage, casterSide);
        }
      }
      // splash on castles if epicenter is near
      const enemyCastleX = casterSide === "player" ? G.ENEMY_CASTLE_X : G.PLAYER_CASTLE_X;
      const cdx = enemyCastleX - x;
      const cdy = (G.GROUND_Y - 100) - y;
      if (cdx * cdx + cdy * cdy <= (spell.aoeRadius + 60) ** 2) {
        damageCastle(casterSide === "player" ? "enemy" : "player", spell.damage * 0.5);
      }
    } else if (spell.id === "heal") {
      world.effects.push({ kind: "heal", x, y, radius: spell.aoeRadius, life: 0.7, max: 0.7 });
      Sound.playSpellHealSound();
      for (const u of world.units) {
        if (u.side !== casterSide || u.dying > 0) continue;
        const dx = u.x - x, dy = u.y - y;
        if (dx * dx + dy * dy <= spell.aoeRadius * spell.aoeRadius) {
          const before = u.hp;
          u.hp = Math.min(u.maxHp, u.hp + spell.heal);
          const healed = Math.round(u.hp - before);
          if (healed > 0) spawnFloatingNumber(u.x, u.y - u.def.radius * 2 - 8, "+" + healed, "#a8f5a4");
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
    world.enemy.mana = Math.min(G.MAX_MANA, world.enemy.mana + G.MANA_REGEN_PER_SEC * dt * 1.05);

    aiTick(dt);

    for (const u of world.units) updateUnit(u, dt);
    for (const p of world.projectiles) updateProjectile(p, dt);

    for (const e of world.effects) {
      e.life -= dt;
      if (e.kind === "dmg") e.y += (e.vy || 0) * dt;
      if (e.kind === "dust") { e.x += (e.vx || 0) * dt; e.y += (e.vy || 0) * dt; e.vy += 30 * dt; }
    }

    if (world.player.castleHitFlash > 0) world.player.castleHitFlash -= dt;
    if (world.enemy.castleHitFlash > 0) world.enemy.castleHitFlash -= dt;

    world.units = world.units.filter((u) => u.dying <= 0 || u._fadeRemain > 0);
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

    if (!u.target || !targetAlive(u.target)) u.target = pickTarget(u);
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
        u.dustTimer = 0.18 / Math.max(0.6, u.def.moveSpeed);
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

    if (!best || castleDist < bestDist + 30) {
      // Note: x is what the unit walks toward; the projectile/melee logic
      // damages the castle by side, not by x, so this can safely point at
      // the wall instead of the center.
      return {
        kind: "castle",
        x: castleTargetX,
        y: castleY,
        side: u.side === "player" ? "enemy" : "player",
      };
    }
    return { kind: "unit", unit: best };
  }

  function attack(u) {
    const def = u.def;
    if (def.projectile) {
      const tx = targetX(u.target);
      const ty = targetY(u.target);
      const dx = tx - u.x, dy = (ty - u.y) - def.radius * 1.6;
      const len = Math.hypot(dx, dy) || 1;
      world.projectiles.push({
        x: u.x, y: u.y - def.radius * 1.6,
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
    fillHand(ai);
    if (world.time < ai.nextDecisionAt) return;

    const playable = ai.hand
      .map((id, idx) => ({ id, idx, def: getCardDef(id) }))
      .filter((c) => c.def && c.def.manaCost <= ai.mana);
    if (playable.length === 0) { ai.nextDecisionAt = world.time + 1.0; return; }

    const threat = countThreats(ai, "enemy");
    let pick = null;

    if (threat.totalHp > 200) {
      // Defensive: AoE first, then bring out tanks/heavies, otherwise anything
      pick = playable.find((c) => c.def.id === "fireball")
          || playable.find((c) => c.def.role === "tank" || c.def.role === "giant")
          || playable.find((c) => c.def.role === "melee" || c.def.role === "fast")
          || playable[0];
    } else if (ai.mana > 7 || Math.random() < 0.4) {
      // Push: prefer heavies, mages, ranged
      pick = playable.find((c) => c.def.role === "giant" || c.def.role === "tank")
          || playable.find((c) => c.def.role === "ranged" || c.def.role === "mage")
          || playable[Math.floor(Math.random() * playable.length)];
    } else {
      ai.nextDecisionAt = world.time + 0.6 + Math.random() * 0.8;
      return;
    }
    if (!pick) return;

    if (pick.def.type === "spell") {
      const target = findDensestCluster("player");
      if (!target) { ai.nextDecisionAt = world.time + 0.5; return; }
      castSpell(pick.def.id, target.x, target.y, "enemy");
    } else {
      let dx;
      if (threat.frontX !== null) {
        dx = clamp(threat.frontX + 60, G.ENEMY_DEPLOY_ZONE.x1, G.ENEMY_DEPLOY_ZONE.x2);
      } else {
        dx = G.ENEMY_DEPLOY_ZONE.x1 + Math.random() * (G.ENEMY_DEPLOY_ZONE.x2 - G.ENEMY_DEPLOY_ZONE.x1);
      }
      spawnUnit("enemy", pick.def.id, dx);
    }

    ai.mana -= pick.def.manaCost;
    ai.hand.splice(pick.idx, 1);
    fillHand(ai);
    ai.nextDecisionAt = world.time + 1.4 + Math.random() * 1.6;
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
    // background
    const bg = Art.cache.background;
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

    const img = Art.cache[side][stateKey];
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
    const t = e.life / e.max;
    if (e.kind === "fireball") {
      const r = e.radius * (1 - t);
      const grad = ctx.createRadialGradient(e.x, e.y, 4, e.x, e.y, r);
      grad.addColorStop(0, `rgba(255, 240, 180, ${t})`);
      grad.addColorStop(0.5, `rgba(255, 130, 30, ${t * 0.7})`);
      grad.addColorStop(1, `rgba(120, 20, 0, 0)`);
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(e.x, e.y, r, 0, Math.PI * 2);
      ctx.fill();
    } else if (e.kind === "heal") {
      const r = e.radius * (1 - t);
      ctx.strokeStyle = `rgba(140, 255, 160, ${t})`;
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.arc(e.x, e.y, r, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = `rgba(220, 255, 220, ${t})`;
      ctx.fillRect(e.x - 2, e.y - 14, 4, 28);
      ctx.fillRect(e.x - 14, e.y - 2, 28, 4);
    } else if (e.kind === "heal-spark") {
      ctx.fillStyle = `rgba(180, 255, 180, ${t})`;
      ctx.beginPath();
      ctx.arc(e.x, e.y, 4, 0, Math.PI * 2);
      ctx.fill();
    } else if (e.kind === "dust") {
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

  // ---------- HUD updates ----------
  function refreshHand() {
    handEl.innerHTML = "";
    world.player.hand.forEach((id, idx) => {
      const def = getCardDef(id);
      if (!def) return;
      const card = document.createElement("div");
      card.className = "card";
      if (def.type === "unit") card.classList.add("unit");
      else if (def.id === "fireball") card.classList.add("spell", "spell-fire");
      else if (def.id === "heal") card.classList.add("spell", "spell-heal");
      else card.classList.add("spell");
      if (world.player.mana < def.manaCost) card.classList.add("disabled");
      card.dataset.idx = idx;

      const cost = document.createElement("div");
      cost.className = "cost";
      cost.textContent = def.manaCost;
      card.appendChild(cost);

      const role = document.createElement("div");
      role.className = "role-tag";
      role.textContent = def.roleLabel || "Spell";
      card.appendChild(role);

      const art = document.createElement("div");
      art.className = "art";
      const icon = Art.cache.cardIcons[def.id];
      if (icon) {
        const img = new Image();
        img.src = icon.toDataURL();
        img.style.maxWidth = "100%";
        img.style.maxHeight = "100%";
        art.appendChild(img);
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
      if (def.type === "unit") {
        stats.innerHTML = `<span class="stat-hp">${def.hp} HP</span><span class="stat-dmg">${def.damage} DMG</span>`;
      } else if (def.id === "fireball") {
        stats.innerHTML = `<span class="stat-dmg">${def.damage} AoE</span>`;
      } else if (def.id === "heal") {
        stats.innerHTML = `<span class="stat-hp">+${def.heal} HP</span>`;
      }
      card.appendChild(stats);

      card.addEventListener("pointerdown", (ev) => onCardPointerDown(ev, idx, def, card));

      handEl.appendChild(card);
    });
  }

  function refreshMana() {
    if (!world) return;
    const m = world.player.mana;
    manaText.textContent = `${Math.floor(m)} / ${G.MAX_MANA}`;
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
    [...handEl.children].forEach((card) => {
      const idx = +card.dataset.idx;
      const def = getCardDef(world.player.hand[idx]);
      if (!def) return;
      if (m < def.manaCost) card.classList.add("disabled");
      else card.classList.remove("disabled");
    });
  }

  function refreshCastleHP() {
    if (!world) return;
    const ph = Math.max(0, Math.round(world.player.castleHp));
    const eh = Math.max(0, Math.round(world.enemy.castleHp));
    playerHpEl.textContent = `${ph} / ${G.CASTLE_MAX_HP}`;
    enemyHpEl.textContent = `${eh} / ${G.CASTLE_MAX_HP}`;
    playerBar.style.width = (ph / G.CASTLE_MAX_HP) * 100 + "%";
    enemyBar.style.width = (eh / G.CASTLE_MAX_HP) * 100 + "%";
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
      // shake to reject
      cardEl.classList.remove("shake");
      void cardEl.offsetWidth;
      cardEl.classList.add("shake");
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
      world.player.mana -= d.def.manaCost;
      world.player.hand.splice(d.idx, 1);
      fillHand(world.player);
      refreshHand();
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
  }

  function startMatch() {
    world = newWorld();
    fillHand(world.player);
    fillHand(world.enemy);
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
  playBtn.addEventListener("click", () => { Sound.playClickSound(); startMatch(); });
  restartBtn.addEventListener("click", () => { Sound.playClickSound(); startMatch(); });
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
  document.addEventListener("keydown", (ev) => {
    if (ev.code === "Space") {
      ev.preventDefault();
      if (phase === "playing") pauseMatch();
      else if (phase === "paused") resumeMatch();
    }
  });

  // ---------- Boot ----------
  Art.boot().then(() => {
    showTitle();
    if (!running) {
      running = true;
      lastT = performance.now();
      requestAnimationFrame(tick);
    }
  });
})();
