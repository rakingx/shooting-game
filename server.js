const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3001;

// 게임 상태 (예시: 플레이어 위치)
let players = {};
let bullets = [];
let teamScores = { red: 0, blue: 0 };
let winner = null;
let resetTimeout = null;
const GOAL_KILL = 100;

// 아이템 상태
let items = [];
const ITEM_TYPES = ['heal', 'immortal', 'weapon_laser']; // 레이저 아이템 추가

function randomObstacles() {
  const arr = [];
  const count = 3;
  let tries = 0;
  while (arr.length < count && tries < 100) {
    tries++;
    const obs = {
      x: Math.random() * 700 + 50,
      y: Math.random() * 500 + 50,
      r: 35 + Math.random() * 20 // 반지름 35~55
    };
    // 겹침 체크
    if (arr.every(o => Math.hypot(o.x - obs.x, o.y - obs.y) > (o.r + obs.r + 20))) {
      arr.push(obs);
    }
  }
  return arr;
}
let obstacles = randomObstacles();

// 총알 이동 및 브로드캐스트 루프
setInterval(() => {
  if (winner) return; // 게임 끝나면 멈춤
  bullets = bullets
    .map(b => ({
      ...b,
      x: b.x + Math.cos(b.angle) * 20,
      y: b.y + Math.sin(b.angle) * 20,
    }))
    .filter(b => b.x > 0 && b.x < 800 && b.y > 0 && b.y < 600);

  // 플레이어-구조물 겹침 시간 관리 및 HP 감소
  const now = Date.now();
  Object.entries(players).forEach(([id, p]) => {
    if (!p.alive || p.x == null || p.y == null) return;
    const onObstacle = obstacles.some(obs => Math.hypot(p.x - obs.x, p.y - obs.y) < (obs.r + 20));
    if (onObstacle) {
      if (p.obstacleTime === undefined) p.obstacleTime = 0;
      if (p.obstacleTime < 3000) {
        p.obstacleTime += 33;
        if (p.obstacleTime >= 3000) {
          p.obstacleTime = 3000; // 3초 도달 시 고정
        }
      }
      if (p.obstacleTime >= 3000) {
        if (!p._obstacleDamaged) {
          p.hp -= 1;
          p._obstacleDamaged = true;
          if (p.hp <= 0) {
            p.alive = false;
            p.x = null;
            p.y = null;
            p.respawnTime = now + 10000;
            if (p.team === 'red') teamScores['blue'] = (teamScores['blue'] || 0) + 1;
            if (p.team === 'blue') teamScores['red'] = (teamScores['red'] || 0) + 1;
          }
        } else {
          // obstacleTime이 3000이 된 이후 구조물에 계속 닿아있으면 HP를 1씩 감소
          if (!p._obstacleHalfTick || now - p._obstacleHalfTick >= 1000) { // 1초마다 1씩 닳게
            p.hp -= 1;
            p._obstacleHalfTick = now;
            if (p.hp <= 0) {
              p.alive = false;
              p.x = null;
              p.y = null;
              p.respawnTime = now + 10000;
              if (p.team === 'red') teamScores['blue'] = (teamScores['blue'] || 0) + 1;
              if (p.team === 'blue') teamScores['red'] = (teamScores['red'] || 0) + 1;
            }
          }
        }
      }
    } else {
      if (p._obstacleDamaged) p._obstacleDamaged = false;
      if (p._obstacleHalfTick) p._obstacleHalfTick = null;
    }
  });

  // 총알-구조물 충돌 판정
  bullets.forEach((b) => {
    for (const obs of obstacles) {
      if (Math.hypot(b.x - obs.x, b.y - obs.y) < obs.r) {
        b.hit = true;
        break;
      }
    }
  });

  // 총알-플레이어 충돌 판정
  Object.entries(players).forEach(([id, p]) => {
    if (!p.alive) return;
    if (p.immortal) return; // 무적이면 총알 무시
    bullets.forEach((b) => {
      if (b.owner !== id && Math.hypot(p.x - b.x, p.y - b.y) < 20) {
        p.hp -= 1;
        b.hit = true;
        if (p.hp <= 0) {
          p.alive = false;
          p.x = null;
          p.y = null;
          p.respawnTime = Date.now() + 10000;
          if (p.team === 'red' || p.team === 'blue') {
            teamScores[p.team] = (teamScores[p.team] || 0) + 1;
            if (players[b.owner]) {
              players[b.owner].kill = (players[b.owner].kill || 0) + 1;
            }
            if (teamScores[p.team] >= GOAL_KILL && !winner) {
              winner = p.team === 'red' ? 'blue' : 'red';
              io.emit('teamScores', { teamScores, winner });
              resetTimeout = setTimeout(resetGame, 3000);
            }
          }
        }
      }
    });
  });
  // 맞은 총알 삭제
  bullets = bullets.filter(b => !b.hit);

  // 죽은 플레이어 부활 처리
  Object.entries(players).forEach(([id, p]) => {
    if (!p.alive && p.respawnTime && Date.now() >= p.respawnTime && !winner) {
      p.x = Math.random() * 800;
      p.y = Math.random() * 600;
      p.hp = 10;
      p.alive = true;
      p.respawnTime = null;
      p.obstacleTime = 0; // 부활 시 obstacleTime 리셋
      p._obstacleDamaged = false;
      p._obstacleHalfTick = null;
    }
  });

  // 아이템-플레이어 충돌 판정
  Object.entries(players).forEach(([id, p]) => {
    if (!p.alive || p.x == null || p.y == null) return;
    for (let i = items.length - 1; i >= 0; i--) {
      const item = items[i];
      if (Math.hypot(p.x - item.x, p.y - item.y) < 30) {
        if (item.type === 'heal') {
          p.hp = Math.min(10, (p.hp || 0) + 4);
        }
        if (item.type === 'immortal') {
          p.immortalUntil = Date.now() + 3000;
        }
        if (item.type === 'weapon_laser') {
          p.weapon = 'laser';
          p.weaponUntil = Date.now() + 10000;
        }
        items.splice(i, 1);
        io.emit('items', items);
      }
    }
  });

  // 무적 상태 체크
  Object.entries(players).forEach(([id, p]) => {
    if (p.immortalUntil && Date.now() < p.immortalUntil) {
      p.immortal = true;
    } else {
      p.immortal = false;
    }
  });

  // 무기 지속시간 체크
  Object.entries(players).forEach(([id, p]) => {
    if (p.weapon === 'laser' && p.weaponUntil && Date.now() > p.weaponUntil) {
      p.weapon = null;
      p.weaponUntil = null;
    }
  });

  io.emit('players', players);
  io.emit('bullets', bullets);
  io.emit('teamScores', { teamScores, winner });
  io.emit('obstacles', obstacles);
  io.emit('items', items);
}, 33);

// 10초마다 아이템 생성
setInterval(() => {
  if (winner) return;
  const type = ITEM_TYPES[Math.floor(Math.random() * ITEM_TYPES.length)];
  let x, y;
  let tries = 0;
  while (tries < 30) {
    x = Math.random() * 700 + 50;
    y = Math.random() * 500 + 50;
    // 구조물과 겹치지 않는 위치만 허용
    if (!obstacles.some(obs => Math.hypot(x - obs.x, y - obs.y) < obs.r + 30)) break;
    tries++;
  }
  items.push({ id: Date.now() + Math.random(), type, x, y, createdAt: Date.now() });
  io.emit('items', items);
}, 10000);

// 5초가 지난 아이템 자동 삭제
setInterval(() => {
  const now = Date.now();
  let changed = false;
  for (let i = items.length - 1; i >= 0; i--) {
    if (now - (items[i].createdAt || 0) > 5000) {
      items.splice(i, 1);
      changed = true;
    }
  }
  if (changed) io.emit('items', items);
}, 5000);

io.on('connection', (socket) => {
  // 새 플레이어 입장
  socket.on('join', (data) => {
    // 팀 인원 계산
    const teamCounts = { red: 0, blue: 0 };
    Object.values(players).forEach(p => {
      if (p.team === 'red') teamCounts.red++;
      if (p.team === 'blue') teamCounts.blue++;
    });
    const team = teamCounts.red <= teamCounts.blue ? 'red' : 'blue';
    let nickname = (data && typeof data.nickname === 'string') ? data.nickname.slice(0, 10) : '';
    if (!nickname) nickname = '플레이어';
    players[socket.id] = {
      x: Math.random() * 800,
      y: Math.random() * 600,
      color: '#' + Math.floor(Math.random()*16777215).toString(16),
      hp: 10,
      alive: true,
      respawnTime: null,
      team,
      kill: 0,
      nickname,
    };
    io.emit('players', players);
    io.emit('teamScores', { teamScores, winner });
    socket.emit('items', items);
  });

  // 플레이어 이동
  socket.on('move', (data) => {
    if (players[socket.id]) {
      players[socket.id].x = data.x;
      players[socket.id].y = data.y;
      io.emit('players', players);
    }
  });

  // 연결 해제
  socket.on('disconnect', () => {
    delete players[socket.id];
    io.emit('players', players);
  });

  socket.on('shoot', (bullet) => {
    bullets.push({ ...bullet, id: Date.now() + Math.random() });
  });
});

function resetGame() {
  teamScores = { red: 0, blue: 0 };
  winner = null;
  Object.values(players).forEach(p => {
    p.x = Math.random() * 800;
    p.y = Math.random() * 600;
    p.hp = 10;
    p.alive = true;
    p.respawnTime = null;
    p.kill = 0;
    p.obstacleTime = 0;
    p._obstacleDamaged = false;
    p._obstacleHalfTick = null;
    p.immortalUntil = 0;
    p.immortal = false;
    p.weapon = null;
    p.weaponUntil = null;
    // 닉네임은 유지
  });
  bullets = [];
  obstacles = randomObstacles();
  io.emit('players', players);
  io.emit('teamScores', { teamScores, winner });
  io.emit('obstacles', obstacles);
  io.emit('items', items);
}

// 정적 파일 서빙 (React build)
app.use(express.static(path.join(__dirname, 'client', 'build')));
app.get('/*', (req, res) => {
  res.sendFile(path.join(__dirname, 'client', 'build', 'index.html'));
});

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
}); 