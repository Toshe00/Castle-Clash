// =============================================================================
// art.js — loads PNG assets (background + 6 castle states), pre-renders unit &
// spell card icons to offscreen canvases, and exposes drawing helpers used by
// the main render loop.
//
// Castle PNG framing:
//   Source PNGs are already correctly oriented in opposite directions:
//     - Player castle PNG → gate on the RIGHT → faces enemy castle on the right.
//     - Enemy castle PNG  → gate on the LEFT  → faces player castle on the left.
//   Both are drawn as-is; no mirroring is applied.
// =============================================================================

const Art = (() => {
  const cache = {
    cardIcons: {},
    background: null,
    player: { full: null, damaged: null, destroyed: null },
    enemy:  { full: null, damaged: null, destroyed: null },
    // sprites: { [unitId]: { idle: [Image,...], run: [...], attack: [...], death: [...], cfg } }
    sprites: {},
  };

  function makeCanvas(w, h) {
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    return c;
  }

  function lighten(hex, amt) {
    const h = hex.replace("#", "");
    const r = parseInt(h.substring(0, 2), 16);
    const g = parseInt(h.substring(2, 4), 16);
    const b = parseInt(h.substring(4, 6), 16);
    const nr = Math.min(255, Math.floor(r + (255 - r) * amt));
    const ng = Math.min(255, Math.floor(g + (255 - g) * amt));
    const nb = Math.min(255, Math.floor(b + (255 - b) * amt));
    return `rgb(${nr}, ${ng}, ${nb})`;
  }
  function darken(hex, amt) {
    const h = hex.replace("#", "");
    const r = parseInt(h.substring(0, 2), 16);
    const g = parseInt(h.substring(2, 4), 16);
    const b = parseInt(h.substring(4, 6), 16);
    const nr = Math.max(0, Math.floor(r * (1 - amt)));
    const ng = Math.max(0, Math.floor(g * (1 - amt)));
    const nb = Math.max(0, Math.floor(b * (1 - amt)));
    return `rgb(${nr}, ${ng}, ${nb})`;
  }

  // ---------- UNIT SILHOUETTE (role-aware) ----------
  // Drawn on the live canvas in main render loop. footY = y of feet on ground.
  // attackPhase: 0..1 (1 = mid-lunge, used for melee lunge animation)
  function drawUnitInto(ctx, unit, x, footY, opts = {}) {
    const { attackPhase = 0, alpha = 1, friendly = true } = opts;
    const r = unit.radius;
    ctx.save();
    ctx.globalAlpha = alpha;

    // soft shadow
    ctx.fillStyle = "rgba(0,0,0,0.4)";
    ctx.beginPath();
    ctx.ellipse(x, footY + 2, r * 1.15, r * 0.4, 0, 0, Math.PI * 2);
    ctx.fill();

    // melee lunge offset (forward bob)
    const lunge = attackPhase > 0 ? Math.sin(attackPhase * Math.PI) * 6 : 0;
    const cx = x + (friendly ? lunge : -lunge) * 0; // unit always drawn upright; lunge handled by caller via translate
    const role = unit.role;

    // Role specific silhouettes — kept simple & readable.
    switch (role) {
      case "tank":      drawTank(ctx, unit, cx, footY, r); break;
      case "ranged":    drawRanged(ctx, unit, cx, footY, r, friendly); break;
      case "fast":      drawFast(ctx, unit, cx, footY, r); break;
      case "mage":      drawMage(ctx, unit, cx, footY, r, attackPhase); break;
      case "giant":     drawGiant(ctx, unit, cx, footY, r); break;
      case "support":   drawSupport(ctx, unit, cx, footY, r, attackPhase); break;
      default:          drawMelee(ctx, unit, cx, footY, r, attackPhase, friendly); break;
    }

    // friendly/enemy tint ring around feet for clarity
    ctx.beginPath();
    ctx.strokeStyle = friendly ? "rgba(120, 220, 140, 0.7)" : "rgba(240, 110, 110, 0.7)";
    ctx.lineWidth = 2;
    ctx.ellipse(x, footY + 2, r * 1.05, r * 0.35, 0, 0, Math.PI * 2);
    ctx.stroke();

    ctx.restore();
  }

  function bodyGradient(ctx, color, x, top, bottom) {
    const grad = ctx.createLinearGradient(x, top, x, bottom);
    grad.addColorStop(0, lighten(color, 0.25));
    grad.addColorStop(1, color);
    return grad;
  }

  function drawMelee(ctx, u, x, footY, r, atk, friendly) {
    // body torso (rounded)
    ctx.fillStyle = bodyGradient(ctx, u.color, x, footY - r * 2.4, footY);
    ctx.beginPath();
    ctx.arc(x, footY - r, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = u.accent; ctx.lineWidth = 2; ctx.stroke();

    // helmet
    ctx.fillStyle = darken(u.accent, 0.05);
    ctx.beginPath();
    ctx.arc(x, footY - r * 1.7, r * 0.55, Math.PI, 0);
    ctx.fill();

    // sword (extends out when attacking)
    const swordX = x + r * (0.6 + atk * 0.5);
    ctx.strokeStyle = "#e9e2c8";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(swordX, footY - r * 1.5);
    ctx.lineTo(swordX + r * 0.7, footY - r * 0.4);
    ctx.stroke();
    // hilt
    ctx.strokeStyle = u.accent;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(swordX - 2, footY - r * 1.55);
    ctx.lineTo(swordX + 4, footY - r * 1.45);
    ctx.stroke();
  }

  function drawTank(ctx, u, x, footY, r) {
    // wider body (more squat)
    ctx.fillStyle = bodyGradient(ctx, u.color, x, footY - r * 2.2, footY);
    ctx.beginPath();
    ctx.ellipse(x, footY - r, r * 1.2, r * 1.05, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = u.accent; ctx.lineWidth = 2.5; ctx.stroke();
    // helmet horns/heavy crest
    ctx.fillStyle = darken(u.accent, 0.1);
    ctx.beginPath();
    ctx.arc(x, footY - r * 1.7, r * 0.6, Math.PI, 0);
    ctx.fill();
    // big shield
    ctx.fillStyle = "#c4a262";
    ctx.beginPath();
    ctx.moveTo(x - r * 1.0, footY - r * 1.4);
    ctx.lineTo(x - r * 1.0, footY - r * 0.4);
    ctx.lineTo(x - r * 0.4, footY - r * 0.2);
    ctx.lineTo(x - r * 0.2, footY - r * 1.5);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = "#3b2410"; ctx.lineWidth = 2; ctx.stroke();
    // shield crest
    ctx.fillStyle = "#a83232";
    ctx.beginPath();
    ctx.moveTo(x - r * 0.7, footY - r * 1.0);
    ctx.lineTo(x - r * 0.5, footY - r * 0.7);
    ctx.lineTo(x - r * 0.7, footY - r * 0.4);
    ctx.lineTo(x - r * 0.9, footY - r * 0.7);
    ctx.closePath();
    ctx.fill();
  }

  function drawRanged(ctx, u, x, footY, r, friendly) {
    // slim body
    ctx.fillStyle = bodyGradient(ctx, u.color, x, footY - r * 2.3, footY);
    ctx.beginPath();
    ctx.ellipse(x, footY - r, r * 0.85, r * 1.0, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = u.accent; ctx.lineWidth = 2; ctx.stroke();
    // hood/hat
    ctx.fillStyle = u.accent;
    ctx.beginPath();
    ctx.moveTo(x - r * 0.6, footY - r * 1.6);
    ctx.lineTo(x, footY - r * 2.2);
    ctx.lineTo(x + r * 0.6, footY - r * 1.6);
    ctx.closePath();
    ctx.fill();
    // bow
    const bowX = x + r * 0.75;
    ctx.strokeStyle = "#7c5028";
    ctx.lineWidth = 2.2;
    ctx.beginPath();
    ctx.arc(bowX, footY - r * 1.05, r * 0.7, -Math.PI / 2, Math.PI / 2);
    ctx.stroke();
    ctx.strokeStyle = "rgba(255,255,255,0.6)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(bowX, footY - r * 1.75);
    ctx.lineTo(bowX, footY - r * 0.35);
    ctx.stroke();
  }

  function drawFast(ctx, u, x, footY, r) {
    // small body, dynamic
    ctx.fillStyle = bodyGradient(ctx, u.color, x, footY - r * 2.0, footY);
    ctx.beginPath();
    ctx.ellipse(x, footY - r * 0.95, r * 0.85, r * 0.95, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = u.accent; ctx.lineWidth = 2; ctx.stroke();
    // hood
    ctx.fillStyle = u.accent;
    ctx.beginPath();
    ctx.arc(x, footY - r * 1.6, r * 0.5, Math.PI * 0.85, Math.PI * 2.15);
    ctx.fill();
    // dagger
    ctx.strokeStyle = "#e9e2c8";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x + r * 0.6, footY - r * 1.1);
    ctx.lineTo(x + r * 1.0, footY - r * 0.7);
    ctx.stroke();
  }

  function drawMage(ctx, u, x, footY, r, atk) {
    // robed body (cone shape)
    ctx.fillStyle = bodyGradient(ctx, u.color, x, footY - r * 2.4, footY);
    ctx.beginPath();
    ctx.moveTo(x - r, footY);
    ctx.lineTo(x - r * 0.4, footY - r * 1.6);
    ctx.lineTo(x + r * 0.4, footY - r * 1.6);
    ctx.lineTo(x + r, footY);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = u.accent; ctx.lineWidth = 2; ctx.stroke();
    // pointed hat
    ctx.fillStyle = u.accent;
    ctx.beginPath();
    ctx.moveTo(x - r * 0.6, footY - r * 1.6);
    ctx.lineTo(x, footY - r * 2.6);
    ctx.lineTo(x + r * 0.6, footY - r * 1.6);
    ctx.closePath();
    ctx.fill();
    // staff with glowing orb
    ctx.strokeStyle = "#7c5028";
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(x + r * 0.7, footY);
    ctx.lineTo(x + r * 0.7, footY - r * 2.1);
    ctx.stroke();
    const orbR = 5 + atk * 4;
    const grad = ctx.createRadialGradient(x + r * 0.7, footY - r * 2.1, 1, x + r * 0.7, footY - r * 2.1, orbR);
    grad.addColorStop(0, "#e8f5ff");
    grad.addColorStop(1, lighten(u.color, 0.2));
    ctx.fillStyle = grad;
    ctx.shadowColor = u.color; ctx.shadowBlur = 12;
    ctx.beginPath();
    ctx.arc(x + r * 0.7, footY - r * 2.1, orbR, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;
  }

  function drawGiant(ctx, u, x, footY, r) {
    // big oval body
    ctx.fillStyle = bodyGradient(ctx, u.color, x, footY - r * 2.8, footY);
    ctx.beginPath();
    ctx.ellipse(x, footY - r * 1.1, r * 1.3, r * 1.3, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = u.accent; ctx.lineWidth = 3; ctx.stroke();
    // head
    ctx.fillStyle = lighten(u.color, 0.1);
    ctx.beginPath();
    ctx.arc(x, footY - r * 2.4, r * 0.65, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = u.accent; ctx.lineWidth = 2; ctx.stroke();
    // club
    ctx.fillStyle = "#7c5028";
    ctx.fillRect(x + r * 0.9, footY - r * 2.0, r * 0.4, r * 1.6);
    ctx.fillStyle = "#5b3712";
    ctx.beginPath();
    ctx.arc(x + r * 1.1, footY - r * 2.2, r * 0.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "#2b1808"; ctx.lineWidth = 2; ctx.stroke();
  }

  function drawSupport(ctx, u, x, footY, r, atk) {
    // robed healer
    ctx.fillStyle = bodyGradient(ctx, u.color, x, footY - r * 2.4, footY);
    ctx.beginPath();
    ctx.moveTo(x - r, footY);
    ctx.lineTo(x - r * 0.5, footY - r * 1.7);
    ctx.lineTo(x + r * 0.5, footY - r * 1.7);
    ctx.lineTo(x + r, footY);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = u.accent; ctx.lineWidth = 2; ctx.stroke();
    // hood
    ctx.fillStyle = lighten(u.color, 0.2);
    ctx.beginPath();
    ctx.arc(x, footY - r * 1.85, r * 0.55, Math.PI, 0);
    ctx.fill();
    // healing aura (very subtle, pulses)
    const auraR = r * 1.6 + Math.sin(performance.now() / 220) * 2;
    ctx.strokeStyle = "rgba(160, 255, 170, 0.4)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(x, footY - r, auraR, 0, Math.PI * 2);
    ctx.stroke();
    // cross emblem
    ctx.fillStyle = "#fff";
    ctx.fillRect(x - 1.5, footY - r * 1.3, 3, 10);
    ctx.fillRect(x - 5, footY - r * 1.0, 10, 3);
  }

  // ---------- Card icons ----------
  function drawUnitIcon(unit, w, h) {
    const c = makeCanvas(w, h);
    const ctx = c.getContext("2d");
    drawUnitInto(ctx, unit, w / 2, h - 6);
    return c;
  }

  function drawSpellIcon(spell, w, h) {
    const c = makeCanvas(w, h);
    const ctx = c.getContext("2d");
    if (spell.id === "fireball") {
      const cx = w / 2, cy = h / 2;
      const grad = ctx.createRadialGradient(cx, cy, 4, cx, cy, 30);
      grad.addColorStop(0, "#ffe0a0");
      grad.addColorStop(0.4, "#ff8a2a");
      grad.addColorStop(1, "#7e1f00");
      ctx.fillStyle = grad;
      ctx.beginPath(); ctx.arc(cx, cy, 26, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = "#ffe0a0"; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(cx - 14, cy); ctx.quadraticCurveTo(cx - 8, cy - 18, cx + 4, cy - 22); ctx.stroke();
    } else if (spell.id === "heal") {
      const cx = w / 2, cy = h / 2;
      const grad = ctx.createRadialGradient(cx, cy, 2, cx, cy, 30);
      grad.addColorStop(0, "#e8ffd1");
      grad.addColorStop(1, "#3a8b35");
      ctx.fillStyle = grad;
      ctx.beginPath(); ctx.arc(cx, cy, 26, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = "#fff";
      ctx.fillRect(cx - 3, cy - 14, 6, 28);
      ctx.fillRect(cx - 14, cy - 3, 28, 6);
    }
    return c;
  }

  // ---------- SPRITE ANIMATION SYSTEM ----------
  // Two animation source formats are supported:
  //
  // 1) Per-frame PNGs:
  //      { dir: "assets/units/x/idle", prefix: "idle_", count: 8, fps: 8 }
  //
  // 2) Strip PNG (one row of frames):
  //      { strip: "assets/units/x/idle.png", count: 12, frameW: 64, frameH: 64, fps: 8 }
  //    For strips, frames are pre-sliced into offscreen canvases at boot.
  async function loadFrameAnimation(animCfg) {
    const out = [];
    for (let i = 1; i <= animCfg.count; i++) {
      const img = await loadImage(`${animCfg.dir}/${animCfg.prefix}${i}.png`);
      if (img) out.push(img);
    }
    return out;
  }

  async function loadStripAnimation(animCfg) {
    const strip = await loadImage(animCfg.strip);
    if (!strip) return [];
    const fW = animCfg.frameW || strip.height;
    const fH = animCfg.frameH || strip.height;
    const out = [];
    for (let i = 0; i < animCfg.count; i++) {
      const c = makeCanvas(fW, fH);
      const c2d = c.getContext("2d");
      c2d.imageSmoothingEnabled = false;
      c2d.drawImage(strip, i * fW, 0, fW, fH, 0, 0, fW, fH);
      out.push(c);
    }
    return out;
  }

  async function loadAnimation(animCfg) {
    if (animCfg.strip) return loadStripAnimation(animCfg);
    return loadFrameAnimation(animCfg);
  }

  async function loadUnitSprite(unit) {
    const cfg = unit.sprite;
    if (!cfg) return null;
    const set = {
      idle:   await loadAnimation(cfg.idle),
      run:    await loadAnimation(cfg.run),
      attack: await loadAnimation(cfg.attack),
      death:  await loadAnimation(cfg.death),
      cfg,
    };
    return set;
  }

  // Draw a sprite frame so the character's feet sit at (x, footY).
  // Mirrors horizontally if facingSign === -1.
  function drawSpriteFrame(ctx, sprite, animName, frameIdx, x, footY, facingSign, opts = {}) {
    const set = sprite[animName] || sprite.idle;
    if (!set || set.length === 0) return;
    const img = set[Math.max(0, Math.min(set.length - 1, Math.floor(frameIdx)))];
    if (!img) return;

    const cfg = sprite.cfg;
    const targetH = cfg.drawHeight * (opts.scale || 1);
    const ar = img.width / img.height;
    const drawW = targetH * ar;

    // foot anchor inside the source frame
    const ax = cfg.footAnchorX * drawW;
    const ay = cfg.footAnchorY * targetH;
    // top-left of where to draw the image so the anchor lands at (x, footY)
    const drawX = x - ax;
    const drawY = footY - ay;

    // Source frames in the All Personnages pack face LEFT, so:
    //   facingSign === -1 (unit walking left)  → draw as-is
    //   facingSign === +1 (unit walking right) → mirror horizontally
    ctx.save();
    if (opts.alpha != null) ctx.globalAlpha = opts.alpha;
    if (facingSign >= 0) {
      // Mirror around the unit's screen x. After the flip, drawing the image
      // at local x = -ax places its foot anchor back at world x.
      ctx.translate(x, 0);
      ctx.scale(-1, 1);
      ctx.drawImage(img, -ax, drawY, drawW, targetH);
    } else {
      ctx.drawImage(img, drawX, drawY, drawW, targetH);
    }
    ctx.restore();
  }

  // ---------- BOOT ----------
  async function boot() {
    cache.background = await loadImage("assets/background.png");
    cache.player.full       = await loadImage("assets/player_castle_full.png");
    cache.player.damaged    = await loadImage("assets/player_castle_damaged.png");
    cache.player.destroyed  = await loadImage("assets/player_castle_destroyed.png");
    cache.enemy.full        = await loadImage("assets/enemy_castle_full.png");
    cache.enemy.damaged     = await loadImage("assets/enemy_castle_damaged.png");
    cache.enemy.destroyed   = await loadImage("assets/enemy_castle_destroyed.png");

    // Load sprite-animated units
    for (const id in UNITS) {
      if (UNITS[id].sprite) {
        cache.sprites[id] = await loadUnitSprite(UNITS[id]);
      }
    }

    // Card icons:
    //   1) explicit icon PNG (preferred)
    //   2) fallback: sprite idle frame
    //   3) fallback: procedural silhouette
    for (const id in UNITS) {
      const u = UNITS[id];
      let icon = null;
      if (u.icon) icon = await loadIconAsCanvas(u.icon, 96, 80);
      if (!icon && u.sprite && cache.sprites[id]) icon = makeSpriteCardIcon(cache.sprites[id]);
      if (!icon) icon = drawUnitIcon(u, 96, 80);
      cache.cardIcons[id] = icon;
    }
    for (const id in SPELLS) cache.cardIcons[id] = drawSpellIcon(SPELLS[id], 96, 80);
  }

  async function loadIconAsCanvas(src, w, h) {
    const img = await loadImage(src);
    if (!img) return null;
    const c = makeCanvas(w, h);
    const c2d = c.getContext("2d");
    // fit while preserving aspect ratio, slight padding so the card frame breathes
    const pad = 4;
    const aw = w - pad * 2;
    const ah = h - pad * 2;
    const ar = img.width / img.height;
    let dw = aw, dh = ah;
    if (ar > aw / ah) dh = aw / ar;
    else dw = ah * ar;
    c2d.drawImage(img, (w - dw) / 2, (h - dh) / 2, dw, dh);
    return c;
  }

  function makeSpriteCardIcon(sprite) {
    const w = 96, h = 80;
    const c = makeCanvas(w, h);
    const c2d = c.getContext("2d");
    const img = (sprite.idle && sprite.idle[0]) || null;
    if (!img) return c;

    // Use the frame's foot anchor to crop snugly around the character.
    // Target: place the character so feet are at ~92% down the icon.
    const cfg = sprite.cfg;
    const ar = img.width / img.height;
    const targetH = h * 1.5; // oversize then crop
    const targetW = targetH * ar;
    const ax = cfg.footAnchorX * targetW;
    const ay = cfg.footAnchorY * targetH;
    const dx = w / 2 - ax;
    const dy = h * 0.92 - ay;
    c2d.drawImage(img, dx, dy, targetW, targetH);
    return c;
  }

  function loadImage(src) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => resolve(null);
      img.src = src;
    });
  }

  return {
    boot,
    cache,
    drawUnitInto,
    drawSpriteFrame,
  };
})();
