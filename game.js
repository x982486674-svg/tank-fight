(() => {
  // 读取画布和界面元素；地图逻辑尺寸由 HTML 的 width/height 决定。
  const canvas = document.querySelector('#game');
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  const playerBar = document.querySelector('#playerBar');
  const enemyBar = document.querySelector('#enemyBar');
  const playerStatus = document.querySelector('#playerStatus');
  const enemyStatus = document.querySelector('#enemyStatus');
  const overlay = document.querySelector('#overlay');
  const resultTitle = document.querySelector('#resultTitle');
  const resultText = document.querySelector('#resultText');
  const restartBtn = document.querySelector('#restartBtn');
  const soundBtn = document.querySelector('#soundBtn');
  const difficultySelect = document.querySelector('#difficulty');
  const difficultyHint = document.querySelector('#difficultyHint');
  const barrelSlider = document.querySelector('#barrelLength');
  const barrelValue = document.querySelector('#barrelValue');
  const keys = new Set();
  const mouse = { x: W / 2, y: H / 2, down: false };
  const TAU = Math.PI * 2;
  // 基础数值：速度单位为像素/秒，间隔和寿命单位为秒。
  const SETTINGS = {
    playerSpeed: 90,
    enemySpeed: 80,
    tankHealth: 200,
    brickHealth: 36, // 玩家普通子弹两发击碎一块砖；敌方需三发。
    bulletSpeed: 280,
    shotInterval: 0.7,
    barrelLength: 30, // 炮筒长度可以在开始界面调整，双方共用。
    playerTurretSpeed: 10, // 炮塔每秒最多旋转的弧度。
    bodyTurnSpeed: 7,
    bulletBounces: 4, // 成功反弹四次，第五次碰墙销毁。
    bulletLifetime: 20 // 安全上限，避免子弹无限留在地图中。
  };
  // 难度改变决策能力，保留双方原有的血量、移动速度和射击冷却。
  const DIFFICULTIES = {
    easy: { label: '简单', reaction: .65, error: .14, lead: 0, turn: 2.2, dodge: 0, fireDelay: .55,
      hint: '会绕墙和破砖，但反应较慢，瞄准误差大，不主动躲弹。' },
    normal: { label: '普通', reaction: .3, error: .055, lead: .5, turn: 3.8, dodge: .55, fireDelay: .18,
      hint: '会绕墙、破砖，尝试提前瞄准和躲避近处子弹。' },
    hard: { label: '困难', reaction: .15, error: .015, lead: 1, turn: 5.5, dodge: 1, fireDelay: 0,
      hint: '反应更快，预判移动、主动躲弹，并寻找一次反弹的射击机会。' }
  };
  let difficulty = 'normal'; // 在开始每局时读取选项，本局中不改变。
  let last = 0, gameOver = false, started = false, playerKills = 0, powerupTimer = 4;

  // 地图宽、高各翻倍。钢墙保留原布局并缩放；砖墙按块破坏，可打出通道。
  function createWalls() {
    const steel = [
      { x: 510, y: 170, w: 300, h: 56 }, { x: 1110, y: 170, w: 300, h: 56 },
      { x: 510, y: 854, w: 300, h: 56 }, { x: 1110, y: 854, w: 300, h: 56 },
      { x: 330, y: 400, w: 56, h: 280 }, { x: 1534, y: 400, w: 56, h: 280 },
      { x: 854, y: 374, w: 212, h: 60 }, { x: 854, y: 646, w: 212, h: 60 },
      { x: 80, y: 170, w: 130, h: 56 }, { x: 1710, y: 854, w: 130, h: 56 }
    ].map(w => ({ ...w, type: 'steel' }));
    const bricks = [];
    for (const x of [626, 1238]) {
      for (const y of [330, 396, 620, 686]) {
        bricks.push({ x, y, w: 56, h: 56, type: 'brick', hp: SETTINGS.brickHealth, maxHp: SETTINGS.brickHealth });
      }
    }
    for (const y of [280, 744]) {
      for (const x of [850, 922, 994]) {
        bricks.push({ x, y, w: 56, h: 56, type: 'brick', hp: SETTINGS.brickHealth, maxHp: SETTINGS.brickHealth });
      }
    }
    return [...steel, ...bricks];
  }
  let walls = [];

  // 使用浏览器合成短音效，不需要下载音频文件。音频只在用户点击后初始化。
  let audio = null, masterGain = null, muted = false;
  const lastSound = {};
  function unlockAudio() {
    try {
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      if (!AudioContext) { soundBtn.textContent = '声音不受支持'; soundBtn.disabled = true; return; }
      if (!audio) {
        audio = new AudioContext(); masterGain = audio.createGain();
        masterGain.gain.value = muted ? 0 : 0.3;
        masterGain.connect(audio.destination);
      }
      if (audio.state === 'suspended') audio.resume().catch(() => {});
    } catch { soundBtn.textContent = '声音不可用'; soundBtn.disabled = true; }
  }

  function playSound(kind) {
    if (!audio || audio.state !== 'running' || muted) return;
    const now = audio.currentTime;
    // 同帧多颗子弹撞墙时限流，防止声音叠加过响。
    if (now - (lastSound[kind] ?? -Infinity) < (kind === 'wall' ? 0.05 : 0.03)) return;
    lastSound[kind] = now;
    const duration = kind === 'explosion' ? 0.65 : kind === 'break' ? 0.22 : 0.11;
    const envelope = audio.createGain();
    envelope.gain.setValueAtTime(0.001, now);
    envelope.gain.exponentialRampToValueAtTime(kind === 'explosion' ? 0.65 : 0.22, now + 0.006);
    envelope.gain.exponentialRampToValueAtTime(0.001, now + duration);
    envelope.connect(masterGain);
    let source, filter;
    if (kind === 'explosion' || kind === 'break') {
      // 滤波噪声模拟爆炸的低沉轰鸣和碎砖声。
      source = audio.createBufferSource();
      const buffer = audio.createBuffer(1, Math.ceil(audio.sampleRate * duration), audio.sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
      source.buffer = buffer; filter = audio.createBiquadFilter(); filter.type = 'lowpass';
      filter.frequency.setValueAtTime(kind === 'explosion' ? 900 : 2000, now);
      filter.frequency.exponentialRampToValueAtTime(100, now + duration);
      source.connect(filter); filter.connect(envelope);
    } else {
      // 下滑的低频为开火声，高频短音为金属碰墙声。
      source = audio.createOscillator(); source.type = kind === 'shoot' ? 'square' : 'triangle';
      source.frequency.setValueAtTime(kind === 'shoot' ? 190 : 1100, now);
      source.frequency.exponentialRampToValueAtTime(kind === 'shoot' ? 55 : 380, now + duration);
      source.connect(envelope);
    }
    source.onended = () => { source.disconnect(); if (filter) filter.disconnect(); envelope.disconnect(); };
    source.start(now); source.stop(now + duration);
  }

  let player, enemy, bullets, sparks, powerups;

  // 创建坦克：cooldown 为射击冷却，三个 Buff 字段为剩余持续时间。
  function tank(x, y, color, accent, speed) {
    return { x, y, r: 21, angle: 0, bodyAngle: 0, vx: 0, vy: 0, recoil: 0, speed, color, accent, hp: SETTINGS.tankHealth, maxHp: SETTINGS.tankHealth, cooldown: 0, hitFlash: 0, aiTimer: 0, strafe: 1, speedBoost: 0, bigBullets: 0, tripleShot: 0, path: [], pathTimer: 0, thinkTimer: 0, target: null, aimPoint: null, aimError: 0, dodgeDirection: null, fireReady: 0 };
  }
  // 清空上一局并显示进入界面；点击开始后才更新战斗。
  function reset() {
    walls = createWalls(); // 每局恢复被打碎的砖墙。
    player = tank(240, H / 2, '#2898ff', '#b8e4ff', SETTINGS.playerSpeed);
    enemy = tank(W - 240, H / 2, '#ef5350', '#ffd0b2', SETTINGS.enemySpeed);
    enemy.angle = Math.PI;
    enemy.bodyAngle = Math.PI;
    bullets = []; sparks = []; powerups = []; powerupTimer = 4; playerKills = 0; gameOver = false; started = false;
    keys.clear(); mouse.down = false;
    resultTitle.textContent = '坦克大作战'; resultText.textContent = '双方生命值 200。灰色钢墙不可破坏，棕色砖墙可以击碎。点击开始启用声音，用 WASD 移动，鼠标瞄准射击。'; restartBtn.textContent = '开始游戏'; overlay.classList.remove('hidden');
    updateHud();
  }
  // 重置帧时间，避免等待开始期间的时间影响第一帧。
  function startGame() {
    difficulty = Object.hasOwn(DIFFICULTIES, difficultySelect.value) ? difficultySelect.value : 'normal';
    SETTINGS.barrelLength = clamp(Number(barrelSlider.value) || 30, 20, 42);
    enemy.thinkTimer = 0; enemy.fireReady = DIFFICULTIES[difficulty].fireDelay;
    unlockAudio(); started = true; gameOver = false;
    restartBtn.textContent = '再来一局'; overlay.classList.add('hidden'); last = performance.now();
    updateHud();
  }
  // 碰撞工具：限制数值到区间，检测圆形坦克是否接触矩形墙。
  function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }
  function circleRectHit(cx, cy, r, rect) { const x = clamp(cx, rect.x, rect.x + rect.w), y = clamp(cy, rect.y, rect.y + rect.h); return Math.hypot(cx - x, cy - y) < r; }
  function blocked(x, y, r) { return x - r < 8 || x + r > W - 8 || y - r < 8 || y + r > H - 8 || walls.some(w => circleRectHit(x, y, r, w)); }
  // 归一化方向避免斜向移动更快，分轴检测允许沿墙滑动。
  function moveTank(t, dx, dy, dt) {
    const len = Math.hypot(dx, dy) || 1; dx /= len; dy /= len;
    const oldX = t.x, oldY = t.y, currentSpeed = t.speed * (t.speedBoost > 0 ? 1.65 : 1);
    const nx = t.x + dx * currentSpeed * dt, ny = t.y + dy * currentSpeed * dt;
    if (!blocked(nx, t.y, t.r)) t.x = nx;
    if (!blocked(t.x, ny, t.r)) t.y = ny;
    t.vx = dt > 0 ? (t.x - oldX) / dt : 0; t.vy = dt > 0 ? (t.y - oldY) / dt : 0;
    if (Math.hypot(t.vx, t.vy) > .1) t.bodyAngle = turnTowards(t.bodyAngle, Math.atan2(t.vy, t.vx), SETTINGS.bodyTurnSpeed * dt);
  }
  // 将角度差限制在 -π 到 π，炮塔按最短方向平滑旋转。
  function angleDifference(target, current) { return Math.atan2(Math.sin(target - current), Math.cos(target - current)); }
  function turnTowards(current, target, step) { return current + clamp(angleDifference(target, current), -step, step); }
  function aimAt(t, x, y, dt, speed, error = 0) {
    t.angle = turnTowards(t.angle, Math.atan2(y - t.y, x - t.x) + error, speed * dt);
  }
  // 普通射击一发；三连发 Buff 产生三个方向，大子弹 Buff 增加碰撞半径。
  function shoot(t, owner) {
    if (t.cooldown > 0 || !started || gameOver) return;
    t.cooldown = SETTINGS.shotInterval;
    t.recoil = .13; // 开火后炮管短暂后坐，随后回到原位。
    playSound('shoot'); // 每次齐射只播放一次开火声。
    const muzzle = 8 + SETTINGS.barrelLength, count = owner === 'player' && t.tripleShot > 0 ? 3 : 1;
    for (let i = 0; i < count; i++) {
      const spread = count === 1 ? 0 : (i - 1) * .16;
      const a = t.angle + spread, size = owner === 'player' && t.bigBullets > 0 ? 7 : 4;
      const dx = Math.cos(a), dy = Math.sin(a);
      // 炮口贴墙时限制出生位置，避免子弹生成在墙内部。
      const obstruction = firstWallHit({ x: t.x, y: t.y, r: size }, dx * muzzle, dy * muzzle);
      const distance = obstruction ? Math.max(0, muzzle * obstruction.time - 0.01) : muzzle;
      bullets.push({
        x: t.x + dx * distance, y: t.y + dy * distance,
        vx: dx * SETTINGS.bulletSpeed, vy: dy * SETTINGS.bulletSpeed,
        owner, life: SETTINGS.bulletLifetime,
        damage: owner === 'player' ? 18 : 12,
        r: size, // 绘制和碰撞半径。
        bounces: SETTINGS.bulletBounces // 每颗子弹独立记录剩余反弹次数。
      });
    }
  }
  // 生成命中或反弹时的粒子特效。
  function addSparks(x, y, color, amount = 8) { for (let i = 0; i < amount; i++) { const a = Math.random() * TAU, s = 40 + Math.random() * 150; sparks.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: .35 + Math.random() * .3, color }); } }
  // 扫描整段位移与矩形的交点，防止一帧穿过薄墙。
  // time 是碰撞位置的比例（0~1）；flipX/flipY 是需要反转的速度轴。
  function segmentRectHit(x, y, dx, dy, rect) {
    let enter = -Infinity, exit = Infinity, flipX = false, flipY = false;
    const axes = [
      { position: x, delta: dx, min: rect.x, max: rect.x + rect.w, axis: 'x' },
      { position: y, delta: dy, min: rect.y, max: rect.y + rect.h, axis: 'y' }
    ];
    for (const a of axes) {
      if (Math.abs(a.delta) < 1e-9) {
        if (a.position < a.min || a.position > a.max) return null;
        continue;
      }
      const t1 = (a.min - a.position) / a.delta, t2 = (a.max - a.position) / a.delta;
      const near = Math.min(t1, t2), far = Math.max(t1, t2);
      if (near > enter + 1e-9) {
        enter = near; flipX = a.axis === 'x'; flipY = a.axis === 'y';
      } else if (Math.abs(near - enter) < 1e-9) {
        // 恰好撞上角点时两个轴都反转，计作一次碰撞。
        if (a.axis === 'x') flipX = true; else flipY = true;
      }
      exit = Math.min(exit, far);
      if (enter > exit) return null;
    }
    if (enter < -1e-9 || enter > 1 || exit < 0) return null;
    return { time: Math.max(0, enter), flipX, flipY };
  }

  // 寻找最早接触的墙或边界，按子弹半径扩大障碍物检测范围。
  function firstWallHit(b, dx, dy) {
    let closest = null;
    function consider(hit) {
      if (!hit || hit.time < 0 || hit.time > 1) return;
      if (!closest || hit.time < closest.time - 1e-9) closest = hit;
      else if (Math.abs(hit.time - closest.time) < 1e-9) {
        closest.flipX = closest.flipX || hit.flipX;
        closest.flipY = closest.flipY || hit.flipY;
      }
    }
    const minX = 8 + b.r, maxX = W - 8 - b.r;
    const minY = 8 + b.r, maxY = H - 8 - b.r;
    if (dx < 0) consider({ time: (minX - b.x) / dx, flipX: true, flipY: false });
    if (dx > 0) consider({ time: (maxX - b.x) / dx, flipX: true, flipY: false });
    if (dy < 0) consider({ time: (minY - b.y) / dy, flipX: false, flipY: true });
    if (dy > 0) consider({ time: (maxY - b.y) / dy, flipX: false, flipY: true });
    for (const w of walls) {
      const hit = segmentRectHit(b.x, b.y, dx, dy, {
        x: w.x - b.r, y: w.y - b.r, w: w.w + b.r * 2, h: w.h + b.r * 2
      });
      if (hit) consider({ ...hit, wall: w }); // 记录具体墙块，以便扣除砖墙耐久。
    }
    return closest;
  }

  // 沿飞行路径检测坦克，避免反弹后同一帧越过目标而漏判命中。
  function segmentTankHit(b, dx, dy, target) {
    const ox = b.x - target.x, oy = b.y - target.y;
    const radius = b.r + target.r, c = ox * ox + oy * oy - radius * radius;
    if (c <= 0) return 0;
    const a = dx * dx + dy * dy;
    if (a < 1e-12) return null;
    const linear = 2 * (ox * dx + oy * dy), discriminant = linear * linear - 4 * a * c;
    if (discriminant < 0) return null;
    const time = (-linear - Math.sqrt(discriminant)) / (2 * a);
    return time >= 0 && time <= 1 ? time : null;
  }

  // 推进一颗子弹；返回 true 表示销毁。反弹后仍只伤害对手。
  function advanceBullet(b, dt) {
    let remaining = Math.min(dt, b.life);
    b.life = Math.max(0, b.life - dt);
    const target = b.owner === 'player' ? enemy : player;
    while (remaining > 1e-9) {
      const dx = b.vx * remaining, dy = b.vy * remaining;
      const wallHit = firstWallHit(b, dx, dy);
      const tankTime = segmentTankHit(b, dx, dy, target);
      // 比较墙与坦克的命中时间，避免伤害墙后面的目标。
      if (tankTime !== null && (!wallHit || tankTime < wallHit.time)) {
        b.x += dx * tankTime; b.y += dy * tankTime;
        target.hp = Math.max(0, target.hp - b.damage); target.hitFlash = .12;
        addSparks(b.x, b.y, target.accent, 11);
        if (target.hp <= 0) {
          playSound('explosion'); addSparks(target.x, target.y, '#ffad66', 65);
          gameOver = true; if (target === enemy) playerKills++; showResult(target === enemy);
        }
        return true;
      }
      if (!wallHit) { b.x += dx; b.y += dy; break; }
      b.x += dx * wallHit.time; b.y += dy * wallHit.time;
      addSparks(b.x, b.y, '#e7cf8b', 4);
      playSound('wall');
      // 砖墙受双方子弹伤害；本次子弹被吸收，击碎后后续子弹可以通过。
      if (wallHit.wall && wallHit.wall.type === 'brick') {
        const brick = wallHit.wall;
        brick.hp = Math.max(0, brick.hp - b.damage);
        if (brick.hp === 0) {
          walls.splice(walls.indexOf(brick), 1);
          addSparks(brick.x + brick.w / 2, brick.y + brick.h / 2, '#ce9564', 22);
          playSound('break'); enemy.pathTimer = 0;
        }
        return true;
      }
      if (b.bounces <= 0) return true;
      b.bounces--;
      // 竖墙反转 vx，横墙反转 vy；反弹不会改变速度大小。
      if (wallHit.flipX) b.vx = -b.vx;
      if (wallHit.flipY) b.vy = -b.vy;
      remaining *= 1 - wallHit.time;
      // 沿反弹方向推出少量距离，防止同一墙面重复扣次数。
      const speed = Math.hypot(b.vx, b.vy);
      b.x += b.vx / speed * 0.01; b.y += b.vy / speed * 0.01;
    }
    return b.life <= 0;
  }

  // 随机刷新道具，避开墙和坦克；场上最多保留两个。
  function spawnPowerup() { const types = ['speed', 'big', 'triple']; for (let tries = 0; tries < 40; tries++) { const x = 45 + Math.random() * (W - 90), y = 45 + Math.random() * (H - 90); if (!blocked(x, y, 18) && Math.hypot(x - player.x, y - player.y) > 100 && Math.hypot(x - enemy.x, y - enemy.y) > 100) { powerups.push({ x, y, r: 15, type: types[Math.floor(Math.random() * types.length)], pulse: Math.random() * TAU }); return; } } }
  // 拾取后刷新对应 Buff 的时间，不同类型可以同时生效。
  function collectPowerups() { for (let i = powerups.length - 1; i >= 0; i--) { const p = powerups[i]; if (Math.hypot(player.x - p.x, player.y - p.y) < player.r + p.r) { if (p.type === 'speed') player.speedBoost = 8; if (p.type === 'big') player.bigBullets = 10; if (p.type === 'triple') player.tripleShot = 10; addSparks(p.x, p.y, powerupColor(p.type), 16); powerups.splice(i, 1); } } }
  function powerupColor(type) { return type === 'speed' ? '#72f1a8' : type === 'big' ? '#ffcf66' : '#d596ff'; }

  // 大地图上用网格广度优先搜索寻找通路，避免 AI 一直顶着钢墙走。
  function findPath(t, target) {
    const cell = 40, cols = Math.floor(W / cell), rows = Math.floor(H / cell);
    const points = Array.from({ length: cols * rows }, (_, i) => ({
      x: (i % cols + 0.5) * cell, y: (Math.floor(i / cols) + 0.5) * cell
    }));
    const free = points.map(p => !blocked(p.x, p.y, t.r + 1));
    function nearest(entity) {
      let best = -1, distance = Infinity;
      for (let i = 0; i < points.length; i++) {
        const p = points[i], d = Math.hypot(p.x - entity.x, p.y - entity.y);
        if (free[i] && d < distance && !firstWallHit({ x: entity.x, y: entity.y, r: t.r }, p.x - entity.x, p.y - entity.y)) {
          best = i; distance = d;
        }
      }
      return best;
    }
    const start = nearest(t), goal = nearest(target);
    if (start < 0 || goal < 0) return [];
    const parent = new Int32Array(points.length).fill(-1), queue = [start];
    parent[start] = start;
    for (let head = 0; head < queue.length && parent[goal] === -1; head++) {
      const current = queue[head], col = current % cols, row = Math.floor(current / cols);
      const neighbors = [];
      if (col > 0) neighbors.push(current - 1);
      if (col < cols - 1) neighbors.push(current + 1);
      if (row > 0) neighbors.push(current - cols);
      if (row < rows - 1) neighbors.push(current + cols);
      for (const n of neighbors) {
        if (!free[n] || parent[n] !== -1) continue;
        const p = points[current], next = points[n];
        if (firstWallHit({ ...p, r: t.r }, next.x - p.x, next.y - p.y)) continue;
        parent[n] = current; queue.push(n);
      }
    }
    if (parent[goal] === -1) return [];
    const route = [];
    for (let n = goal; n !== start; n = parent[n]) route.push(points[n]);
    route.push(points[start]);
    return route.reverse();
  }

  // 解匀速目标的拦截时间；普通难度部分预判，困难难度完整预判。
  function predictAim(t, target, lead) {
    const x = target.x - t.x, y = target.y - t.y;
    const vx = target.vx || 0, vy = target.vy || 0;
    const a = vx * vx + vy * vy - SETTINGS.bulletSpeed ** 2;
    const b = 2 * (x * vx + y * vy), c = x * x + y * y;
    let time = Math.sqrt(c) / SETTINGS.bulletSpeed;
    const discriminant = b * b - 4 * a * c;
    if (Math.abs(a) > 1e-9 && discriminant >= 0) {
      const roots = [(-b - Math.sqrt(discriminant)) / (2 * a), (-b + Math.sqrt(discriminant)) / (2 * a)].filter(n => n > 0);
      if (roots.length) time = Math.min(...roots);
    }
    time = Math.min(time, 3) * lead;
    return { x: clamp(target.x + vx * time, 30, W - 30), y: clamp(target.y + vy * time, 30, H - 30) };
  }

  // 检查当前方向是否可以直接击中目标、破砖，或经一次反弹命中。
  // 不播放声音、不改墙耐久，仅用于 AI 规划，防止朝无效钢墙不停射击。
  function shotOpportunity(t, angle, target, allowBounce) {
    const dx = Math.cos(angle), dy = Math.sin(angle);
    const probe = { x: t.x, y: t.y, r: 4 };
    const distance = difficulty === 'hard' ? 900 : 700;
    const wall = firstWallHit(probe, dx * distance, dy * distance);
    const tankTime = segmentTankHit(probe, dx * distance, dy * distance, { ...target, r: 21 });
    if (tankTime !== null && (!wall || tankTime < wall.time)) return 'target';
    if (!wall) return null;
    if (wall.wall && wall.wall.type === 'brick') return 'brick';
    if (!allowBounce) return null;
    const nx = wall.flipX ? -dx : dx, ny = wall.flipY ? -dy : dy;
    const next = {
      x: t.x + dx * distance * wall.time + nx * .01,
      y: t.y + dy * distance * wall.time + ny * .01, r: 4
    };
    const remaining = distance * (1 - wall.time);
    const secondWall = firstWallHit(next, nx * remaining, ny * remaining);
    const secondTime = segmentTankHit(next, nx * remaining, ny * remaining, { ...target, r: 21 });
    return secondTime !== null && (!secondWall || secondTime < secondWall.time) ? 'bounce' : null;
  }

  // 镜像法寻找反弹角度，再用实际碰撞检测排除中途被其他墙阻挡的方案。
  function findBounceAim(t, target) {
    const mirrors = [
      { x: 2 * 12 - target.x, y: target.y }, { x: 2 * (W - 12) - target.x, y: target.y },
      { x: target.x, y: 2 * 12 - target.y }, { x: target.x, y: 2 * (H - 12) - target.y }
    ];
    for (const w of walls) {
      if (w.type !== 'steel') continue;
      for (const x of [w.x - 4, w.x + w.w + 4]) mirrors.push({ x: 2 * x - target.x, y: target.y });
      for (const y of [w.y - 4, w.y + w.h + 4]) mirrors.push({ x: target.x, y: 2 * y - target.y });
    }
    for (const p of mirrors) {
      if (shotOpportunity(t, Math.atan2(p.y - t.y, p.x - t.x), target, true) === 'bounce') return p;
    }
    return null;
  }

  // 预测即将靠近的玩家子弹；对法线两侧的躲避方向评分，避开墙和其他子弹。
  function chooseDodge(t, horizon) {
    let threat = null, nearestTime = Infinity;
    for (const b of bullets) {
      if (b.owner !== 'player') continue;
      const rx = t.x - b.x, ry = t.y - b.y, vv = b.vx ** 2 + b.vy ** 2;
      const time = (rx * b.vx + ry * b.vy) / vv;
      if (time <= 0 || time > horizon || time > b.life) continue;
      const distance = Math.hypot(rx - b.vx * time, ry - b.vy * time);
      if (distance > t.r + b.r + 22) continue;
      const wall = firstWallHit(b, b.vx * time, b.vy * time);
      if (wall && wall.time < 1) continue;
      if (time < nearestTime) { threat = b; nearestTime = time; }
    }
    if (!threat) return null;
    const length = Math.hypot(threat.vx, threat.vy);
    const candidates = [
      { x: -threat.vy / length, y: threat.vx / length },
      { x: threat.vy / length, y: -threat.vx / length }
    ];
    let best = null, bestScore = -Infinity;
    for (const d of candidates) {
      const travel = t.speed * Math.min(nearestTime, .45);
      const nx = t.x + d.x * travel, ny = t.y + d.y * travel;
      if (firstWallHit({ ...t, r: t.r + 1 }, nx - t.x, ny - t.y) || blocked(nx, ny, t.r)) continue;
      let score = Infinity;
      for (const b of bullets) {
        if (b.owner !== 'player') continue;
        score = Math.min(score, Math.hypot(nx - b.x - b.vx * nearestTime, ny - b.y - b.vy * nearestTime));
      }
      if (score > bestScore) { bestScore = score; best = d; }
    }
    return best;
  }

  function updateEnemy(dt) {
    const config = DIFFICULTIES[difficulty];
    enemy.thinkTimer -= dt; enemy.pathTimer -= dt; enemy.fireReady = Math.max(0, enemy.fireReady - dt);
    // 难度控制观察频率，预判使用上一次观察到的位置与速度。
    if (enemy.thinkTimer <= 0 || !enemy.target) {
      enemy.thinkTimer = config.reaction;
      enemy.target = { x: player.x, y: player.y, vx: player.vx, vy: player.vy };
      enemy.aimError = (Math.random() * 2 - 1) * config.error;
      enemy.aimPoint = predictAim(enemy, enemy.target, config.lead);
      const direct = Math.atan2(enemy.aimPoint.y - enemy.y, enemy.aimPoint.x - enemy.x);
      if (difficulty === 'hard' && !shotOpportunity(enemy, direct, enemy.aimPoint, false)) {
        const bounce = findBounceAim(enemy, enemy.aimPoint);
        if (bounce) enemy.aimPoint = bounce;
      }
      enemy.dodgeDirection = config.dodge > 0 ? chooseDodge(enemy, config.dodge) : null;
      enemy.aiTimer -= config.reaction;
      if (enemy.aiTimer <= 0) { enemy.aiTimer = .8 + Math.random(); enemy.strafe *= -1; }
    }
    const target = enemy.target, ex = target.x - enemy.x, ey = target.y - enemy.y, dist = Math.hypot(ex, ey);
    aimAt(enemy, enemy.aimPoint.x, enemy.aimPoint.y, dt, config.turn, enemy.aimError);
    if (enemy.dodgeDirection) {
      moveTank(enemy, enemy.dodgeDirection.x, enemy.dodgeDirection.y, dt);
    } else if (firstWallHit({ x: enemy.x, y: enemy.y, r: enemy.r }, ex, ey) && dist > 140) {
      if (enemy.pathTimer <= 0) {
        enemy.path = findPath(enemy, target); enemy.pathTimer = difficulty === 'easy' ? 1.5 : .7;
      }
      while (enemy.path.length && Math.hypot(enemy.path[0].x - enemy.x, enemy.path[0].y - enemy.y) < 5) enemy.path.shift();
      if (enemy.path.length) {
        const p = enemy.path[0]; moveTank(enemy, p.x - enemy.x, p.y - enemy.y, dt);
      }
    } else {
      enemy.path = []; enemy.pathTimer = 0;
      const preferred = difficulty === 'hard' ? 310 : 260;
      const toward = dist > preferred + 40 ? 1 : dist < preferred - 60 ? -1 : 0;
      const strafe = difficulty === 'easy' ? .25 : .7;
      let ax = ex / (dist || 1) * toward - ey / (dist || 1) * enemy.strafe * strafe;
      let ay = ey / (dist || 1) * toward + ex / (dist || 1) * enemy.strafe * strafe;
      // 侧移前检测附近墙，受阻时换边，减少原地顶墙。
      const length = Math.hypot(ax, ay) || 1;
      if (firstWallHit({ ...enemy, r: enemy.r + 1 }, ax / length * 35, ay / length * 35)) {
        enemy.strafe *= -1;
        ax = ex / (dist || 1) * toward - ey / (dist || 1) * enemy.strafe * strafe;
        ay = ey / (dist || 1) * toward + ex / (dist || 1) * enemy.strafe * strafe;
      }
      moveTank(enemy, ax, ay, dt);
    }
    const firingTarget = predictAim(enemy, target, config.lead);
    const aimAngle = Math.atan2(enemy.aimPoint.y - enemy.y, enemy.aimPoint.x - enemy.x) + enemy.aimError;
    const aligned = Math.abs(angleDifference(aimAngle, enemy.angle)) < .06;
    // 瞄准后才射击；简单难度允许误射，普通和困难需确认弹道有作用。
    const opportunity = shotOpportunity(enemy, enemy.angle, firingTarget, difficulty === 'hard');
    if (dist < (difficulty === 'hard' ? 850 : 650) && aligned && enemy.fireReady <= 0 &&
        (opportunity || (difficulty === 'easy' && !firstWallHit({ ...enemy, r: 4 }, ex, ey)))) {
      if (enemy.cooldown <= 0) { shoot(enemy, 'enemy'); enemy.fireReady = SETTINGS.shotInterval + config.fireDelay; }
    }
  }

  // 独立更新特效，让坦克被击毁、战斗停止后爆炸粒子仍然消散。
  function updateParticles(dt) {
    for (let i = sparks.length - 1; i >= 0; i--) {
      const s = sparks[i]; s.x += s.vx * dt; s.y += s.vy * dt;
      const drag = Math.pow(.96, dt * 60); s.vx *= drag; s.vy *= drag;
      s.life -= dt; if (s.life <= 0) sparks.splice(i, 1);
    }
  }
  // dt 为每帧经过的秒数；进入界面和结算时暂停战斗。
  function update(dt) {
    if (!started || gameOver) return;
    player.vx = 0; player.vy = 0; enemy.vx = 0; enemy.vy = 0;
    player.recoil = Math.max(0, player.recoil - dt); enemy.recoil = Math.max(0, enemy.recoil - dt);
    player.cooldown = Math.max(0, player.cooldown - dt); enemy.cooldown = Math.max(0, enemy.cooldown - dt); player.hitFlash = Math.max(0, player.hitFlash - dt); enemy.hitFlash = Math.max(0, enemy.hitFlash - dt);
    player.speedBoost = Math.max(0, player.speedBoost - dt); player.bigBullets = Math.max(0, player.bigBullets - dt); player.tripleShot = Math.max(0, player.tripleShot - dt);
    powerupTimer -= dt; if (powerupTimer <= 0) { if (powerups.length < 2) spawnPowerup(); powerupTimer = 7 + Math.random() * 4; }
    let dx = 0, dy = 0; if (keys.has('w') || keys.has('arrowup')) dy -= 1; if (keys.has('s') || keys.has('arrowdown')) dy += 1; if (keys.has('a') || keys.has('arrowleft')) dx -= 1; if (keys.has('d') || keys.has('arrowright')) dx += 1; if (dx || dy) moveTank(player, dx, dy, dt);
    aimAt(player, mouse.x, mouse.y, dt, SETTINGS.playerTurretSpeed); if (mouse.down || keys.has(' ')) shoot(player, 'player');
    updateEnemy(dt);
    // 倒序删除不会跳过其他子弹，结算后立即停止后续伤害。
    for (let i = bullets.length - 1; i >= 0; i--) {
      if (advanceBullet(bullets[i], dt)) bullets.splice(i, 1);
      if (gameOver) break;
    }
    if (!gameOver) collectPowerups(); updateHud();
  }
  // 绘制车身和炮管；save/restore 保证每辆坦克的旋转不影响其他画面。
  function drawTank(t) {
    ctx.save(); ctx.translate(t.x, t.y); ctx.globalAlpha = t.hitFlash > 0 ? .55 : 1;
    // 车身和履带按实际移动方向旋转。
    ctx.save(); ctx.rotate(t.bodyAngle);
    ctx.fillStyle = '#101827'; ctx.fillRect(-21, -18, 42, 36);
    ctx.fillStyle = '#415063'; ctx.fillRect(-21, -18, 42, 6); ctx.fillRect(-21, 12, 42, 6);
    ctx.fillStyle = t.color; ctx.fillRect(-17, -12, 34, 24);
    ctx.fillStyle = '#ffffff22'; ctx.fillRect(8, -10, 6, 20); ctx.restore();
    // 炮塔独立旋转，后坐效果只影响炮管绘制，弹道仍从实际朝向发射。
    ctx.save(); ctx.rotate(t.angle);
    const recoil = t.recoil / .13 * 5, length = SETTINGS.barrelLength;
    ctx.fillStyle = '#101827'; ctx.fillRect(6 - recoil, -6, length + 3, 12);
    ctx.fillStyle = t.accent; ctx.fillRect(8 - recoil, -4, length, 8);
    ctx.fillStyle = '#e0ecf4'; ctx.fillRect(8 + length - 4 - recoil, -5, 4, 10);
    ctx.beginPath(); ctx.arc(0, 0, 12, 0, TAU); ctx.fillStyle = t.color; ctx.fill();
    ctx.strokeStyle = t.accent; ctx.lineWidth = 2; ctx.stroke();
    ctx.fillStyle = '#ffffff33'; ctx.fillRect(-4, -5, 8, 10);
    ctx.restore(); ctx.restore();
  }
  // 每帧清空并重绘背景、墙、道具、子弹、坦克和粒子。
  function draw() {
    ctx.clearRect(0, 0, W, H); ctx.fillStyle = '#29394a'; ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = '#ffffff08'; ctx.lineWidth = 1;
    for (let x = 0; x <= W; x += 40) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); }
    for (let y = 0; y <= H; y += 40) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }
    walls.forEach(drawWall);
    powerups.forEach(p => {
      const pulse = Math.sin(performance.now() / 220 + p.pulse) * 2;
      ctx.save(); ctx.translate(p.x, p.y); ctx.fillStyle = powerupColor(p.type);
      ctx.shadowColor = ctx.fillStyle; ctx.shadowBlur = 16;
      ctx.beginPath(); ctx.arc(0, 0, p.r + pulse, 0, TAU); ctx.fill();
      ctx.shadowBlur = 0; ctx.fillStyle = '#172235'; ctx.font = 'bold 16px sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(p.type === 'speed' ? '»' : p.type === 'big' ? '●' : '×3', 0, 0); ctx.restore();
    });
    bullets.forEach(b => { ctx.fillStyle = b.owner === 'player' ? '#b8edff' : '#ffd0ae'; ctx.beginPath(); ctx.arc(b.x, b.y, b.r, 0, TAU); ctx.fill(); });
    if (player.hp > 0) drawTank(player); if (enemy.hp > 0) drawTank(enemy);
    sparks.forEach(s => { ctx.globalAlpha = Math.max(0, Math.min(1, s.life * 2)); ctx.fillStyle = s.color; ctx.fillRect(s.x - 2, s.y - 2, 4, 4); });
    ctx.globalAlpha = 1;
  }

  // 钢墙用铆钉区分，砖墙用砖缝、裂痕和耐久条区分。
  function drawWall(w) {
    const brick = w.type === 'brick';
    ctx.fillStyle = brick ? '#ad714b' : '#536276'; ctx.fillRect(w.x, w.y, w.w, w.h);
    ctx.fillStyle = brick ? '#d19867' : '#7b8ba1'; ctx.fillRect(w.x + 3, w.y + 3, w.w - 6, 5);
    ctx.strokeStyle = brick ? '#603e2c' : '#1b2635'; ctx.lineWidth = 2;
    ctx.strokeRect(w.x, w.y, w.w, w.h);
    if (brick) {
      ctx.beginPath(); ctx.moveTo(w.x, w.y + 28); ctx.lineTo(w.x + w.w, w.y + 28);
      ctx.moveTo(w.x + 28, w.y); ctx.lineTo(w.x + 28, w.y + 28);
      ctx.moveTo(w.x + 14, w.y + 28); ctx.lineTo(w.x + 14, w.y + w.h); ctx.stroke();
      if (w.hp < w.maxHp) {
        ctx.strokeStyle = '#382a24'; ctx.lineWidth = 3; ctx.beginPath();
        ctx.moveTo(w.x + 40, w.y + 10); ctx.lineTo(w.x + 30, w.y + 24);
        ctx.lineTo(w.x + 37, w.y + 36); ctx.lineTo(w.x + 24, w.y + 50); ctx.stroke();
        ctx.fillStyle = '#372b27'; ctx.fillRect(w.x, w.y - 7, w.w, 4);
        ctx.fillStyle = '#eec185'; ctx.fillRect(w.x, w.y - 7, w.w * w.hp / w.maxHp, 4);
      }
    } else {
      ctx.fillStyle = '#c0c9d5';
      for (const x of [w.x + 10, w.x + w.w - 10]) {
        for (const y of [w.y + 13, w.y + w.h - 10]) { ctx.beginPath(); ctx.arc(x, y, 2.5, 0, TAU); ctx.fill(); }
      }
    }
  }
  // 将生命值和 Buff 倒计时同步到页面。
  function updateHud() { playerBar.style.width = `${player.hp / player.maxHp * 100}%`; enemyBar.style.width = `${enemy.hp / enemy.maxHp * 100}%`; const buffs = []; if (player.speedBoost > 0) buffs.push(`移速 ${Math.ceil(player.speedBoost)}s`); if (player.bigBullets > 0) buffs.push(`大子弹 ${Math.ceil(player.bigBullets)}s`); if (player.tripleShot > 0) buffs.push(`三连发 ${Math.ceil(player.tripleShot)}s`); playerStatus.textContent = `生命值 ${player.hp} / ${player.maxHp} · 击毁 ${playerKills}${buffs.length ? ' · ' + buffs.join('、') : ''}`; enemyStatus.textContent = `生命值 ${enemy.hp} / ${enemy.maxHp} · ${DIFFICULTIES[difficulty].label}`; }
  // 胜负结算复用进入界面，下一局由按钮重新初始化。
  function showResult(win) { resultTitle.textContent = win ? '胜利！' : '战败'; resultText.textContent = win ? '你击毁了敌方坦克，战场属于你。' : '你的坦克被击毁了，再试一次吧。'; restartBtn.textContent = '再来一局'; overlay.classList.remove('hidden'); }
  // 将屏幕鼠标坐标换算成 1920 × 1080 的逻辑地图坐标。
  function pointerPosition(e) { const r = canvas.getBoundingClientRect(); mouse.x = (e.clientX - r.left) * W / r.width; mouse.y = (e.clientY - r.top) * H / r.height; }
  // 记录按键状态：按住可持续移动/射击，松开后清除。
  window.addEventListener('keydown', e => { const k = e.key.toLowerCase(); if (['w','a','s','d','arrowup','arrowdown','arrowleft','arrowright',' '].includes(k)) { keys.add(k); e.preventDefault(); } if (k === 'r' && gameOver) reset(); }); window.addEventListener('keyup', e => keys.delete(e.key.toLowerCase()));
  // 鼠标负责瞄准和开火；pointer capture 可接收画布外的松开事件。
  canvas.addEventListener('pointermove', pointerPosition); canvas.addEventListener('pointerdown', e => { mouse.down = true; canvas.setPointerCapture(e.pointerId); pointerPosition(e); }); canvas.addEventListener('pointerup', () => mouse.down = false); canvas.addEventListener('pointerleave', () => mouse.down = false);
  restartBtn.addEventListener('click', () => { if (!started) startGame(); else { reset(); startGame(); } });
  // 结算时仍可选择难度和炮筒长度，点击“再来一局”时应用到新局。
  difficultySelect.addEventListener('change', () => {
    const config = DIFFICULTIES[difficultySelect.value] || DIFFICULTIES.normal;
    difficultyHint.textContent = config.hint;
  });
  barrelSlider.addEventListener('input', () => {
    barrelValue.textContent = String(clamp(Number(barrelSlider.value) || 30, 20, 42));
  });
  soundBtn.addEventListener('click', () => {
    muted = !muted; unlockAudio();
    if (masterGain) masterGain.gain.setValueAtTime(muted ? 0 : 0.3, audio.currentTime);
    if (!soundBtn.disabled) soundBtn.textContent = muted ? '声音：关' : '声音：开';
    soundBtn.setAttribute('aria-pressed', String(!muted));
  });
  window.addEventListener('blur', () => { keys.clear(); mouse.down = false; });
  // 浏览器逐帧循环：更新状态再绘制，限制长帧造成的移动跳跃。
  function frame(now) { const dt = Math.min(.033, (now - last) / 1000 || 0); last = now; update(dt); updateParticles(dt); draw(); requestAnimationFrame(frame); }
  reset(); requestAnimationFrame(frame);
})();
