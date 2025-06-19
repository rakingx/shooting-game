const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const compression = require('compression');

const app = express();
const server = http.createServer(app);

// Express.js 최적화: gzip 압축 활성화
app.use(compression());

// Socket.IO 최적화 설정
const io = new Server(server, {
  // 네트워크 최적화: 핑 간격 증가로 트래픽 감소
  pingInterval: 10000,
  pingTimeout: 5000,
  
  // 연결 타임아웃 최적화
  connectTimeout: 45000,
  
  // 전송 최적화: WebSocket 우선 사용
  transports: ['websocket', 'polling'],
  
  // 업그레이드 타임아웃 단축
  upgradeTimeout: 10000,
  
  // 최대 HTTP 버퍼 크기 최적화
  maxHttpBufferSize: 1e6,
  
  // CORS 최적화
  cors: {
    origin: "*",
    credentials: false
  }
});

const PORT = process.env.PORT || 3001;

// 게임 상태 최적화: Map 사용으로 성능 향상
const players = new Map();
let bullets = [];
let teamScores = { red: 0, blue: 0 };
let winner = null;
let resetTimeout = null;
const GOAL_KILL = 100;

// 아이템 상태
let items = [];
const ITEM_TYPES = ['heal', 'immortal', 'weapon_laser'];

// 성능 최적화: 변경 추적을 통한 델타 업데이트
let gameStateChanged = {
  players: false,
  bullets: false,
  teamScores: false,
  obstacles: false,
  items: false
};

// 구조물 생성 최적화
function randomObstacles() {
  const arr = [];
  const count = 3;
  let tries = 0;
  while (arr.length < count && tries < 100) {
    tries++;
    const obs = {
      x: Math.random() * 700 + 50,
      y: Math.random() * 500 + 50,
      r: 35 + Math.random() * 20
    };
    // 성능 최적화: 제곱 거리 계산으로 Math.hypot 대체
    if (arr.every(o => {
      const dx = o.x - obs.x;
      const dy = o.y - obs.y;
      return (dx * dx + dy * dy) > Math.pow(o.r + obs.r + 20, 2);
    })) {
      arr.push(obs);
    }
  }
  return arr;
}
let obstacles = randomObstacles();

// 최적화된 충돌 감지 함수
function fastCollisionCheck(obj1, obj2, distance) {
  const dx = obj1.x - obj2.x;
  const dy = obj1.y - obj2.y;
  return (dx * dx + dy * dy) < (distance * distance);
}

// 게임 루프 최적화: 60FPS 게임 로직, 20FPS 네트워크
let gameLoop = setInterval(() => {
  if (winner) return;
  
  const now = Date.now();
  let hasUpdates = false;

  // 총알 업데이트 최적화
  if (bullets.length > 0) {
    const validBullets = [];
    
    for (const bullet of bullets) {
      // 총알 이동
      bullet.x += Math.cos(bullet.angle) * 20;
      bullet.y += Math.sin(bullet.angle) * 20;
      
      // 화면 경계 체크
      if (bullet.x <= 0 || bullet.x >= 800 || bullet.y <= 0 || bullet.y >= 600) {
        continue;
      }
      
      // 구조물 충돌 체크 최적화
      let hitObstacle = false;
      for (const obs of obstacles) {
        if (fastCollisionCheck(bullet, obs, obs.r)) {
          hitObstacle = true;
          break;
        }
      }
      
      if (!hitObstacle) {
        validBullets.push(bullet);
      }
    }
    
    bullets = validBullets;
    gameStateChanged.bullets = true;
    hasUpdates = true;
  }

  // 플레이어 업데이트 최적화
  for (const [id, player] of players) {
    if (!player.alive || player.x == null || player.y == null) continue;
    
    let playerChanged = false;

    // 구조물 충돌 처리 최적화
    const onObstacle = obstacles.some(obs => fastCollisionCheck(player, obs, obs.r + 20));
    
    if (onObstacle) {
      if (player.obstacleTime === undefined) player.obstacleTime = 0;
      player.obstacleTime += 16.67; // 60FPS 기준
      
      if (player.obstacleTime >= 3000) {
        if (!player._obstacleDamaged) {
          player.hp -= 1;
          player._obstacleDamaged = true;
          playerChanged = true;
          
          if (player.hp <= 0) {
            player.alive = false;
            player.x = null;
            player.y = null;
            player.respawnTime = now + 10000;
            teamScores[player.team === 'red' ? 'blue' : 'red']++;
            gameStateChanged.teamScores = true;
          }
        } else if (!player._obstacleHalfTick || now - player._obstacleHalfTick >= 1000) {
          player.hp -= 1;
          player._obstacleHalfTick = now;
          playerChanged = true;
          
          if (player.hp <= 0) {
            player.alive = false;
            player.x = null;
            player.y = null;
            player.respawnTime = now + 10000;
            teamScores[player.team === 'red' ? 'blue' : 'red']++;
            gameStateChanged.teamScores = true;
          }
        }
      }
    } else {
      if (player._obstacleDamaged) {
        player._obstacleDamaged = false;
        playerChanged = true;
      }
      if (player._obstacleHalfTick) {
        player._obstacleHalfTick = null;
        playerChanged = true;
      }
    }

    // 총알 충돌 처리 최적화
    if (!player.immortal) {
      for (let i = bullets.length - 1; i >= 0; i--) {
        const bullet = bullets[i];
        if (bullet.owner !== id && fastCollisionCheck(player, bullet, 20)) {
          player.hp -= 1;
          bullets.splice(i, 1);
          playerChanged = true;
          
          if (player.hp <= 0) {
            player.alive = false;
            player.x = null;
            player.y = null;
            player.respawnTime = now + 10000;
            
            if (player.team === 'red' || player.team === 'blue') {
              teamScores[player.team]++;
              const shooter = players.get(bullet.owner);
              if (shooter) {
                shooter.kill = (shooter.kill || 0) + 1;
              }
              
              if (teamScores[player.team] >= GOAL_KILL && !winner) {
                winner = player.team === 'red' ? 'blue' : 'red';
                gameStateChanged.teamScores = true;
                resetTimeout = setTimeout(resetGame, 3000);
              }
            }
          }
          break;
        }
      }
    }

    // 부활 처리
    if (!player.alive && player.respawnTime && now >= player.respawnTime && !winner) {
      player.x = Math.random() * 800;
      player.y = Math.random() * 600;
      player.hp = 10;
      player.alive = true;
      player.respawnTime = null;
      player.obstacleTime = 0;
      player._obstacleDamaged = false;
      player._obstacleHalfTick = null;
      playerChanged = true;
    }

    // 아이템 충돌 처리 최적화
    for (let i = items.length - 1; i >= 0; i--) {
      const item = items[i];
      if (fastCollisionCheck(player, item, 30)) {
        if (item.type === 'heal') {
          player.hp = Math.min(10, (player.hp || 0) + 4);
        }
        if (item.type === 'immortal') {
          player.immortalUntil = now + 3000;
        }
        if (item.type === 'weapon_laser') {
          player.weapon = 'laser';
          player.weaponUntil = now + 10000;
        }
        items.splice(i, 1);
        gameStateChanged.items = true;
        playerChanged = true;
      }
    }

    // 상태 업데이트 최적화
    const wasImmortal = player.immortal;
    player.immortal = player.immortalUntil && now < player.immortalUntil;
    if (wasImmortal !== player.immortal) playerChanged = true;

    if (player.weapon === 'laser' && player.weaponUntil && now > player.weaponUntil) {
      player.weapon = null;
      player.weaponUntil = null;
      playerChanged = true;
    }

    if (playerChanged) {
      gameStateChanged.players = true;
      hasUpdates = true;
    }
  }
}, 1000 / 60); // 60 FPS

// 네트워크 루프 최적화: 20FPS로 전송
let networkLoop = setInterval(() => {
  if (winner) return;
  
  // Socket.IO 최적화: binary(false) 사용으로 스캔 생략
  if (gameStateChanged.players) {
    io.binary(false).emit('players', Object.fromEntries(players));
    gameStateChanged.players = false;
  }
  
  if (gameStateChanged.bullets) {
    io.binary(false).emit('bullets', bullets);
    gameStateChanged.bullets = false;
  }
  
  if (gameStateChanged.teamScores) {
    io.binary(false).emit('teamScores', { teamScores, winner });
    gameStateChanged.teamScores = false;
  }
  
  if (gameStateChanged.items) {
    io.binary(false).emit('items', items);
    gameStateChanged.items = false;
  }
  
  if (gameStateChanged.obstacles) {
    io.binary(false).emit('obstacles', obstacles);
    gameStateChanged.obstacles = false;
  }
}, 1000 / 20); // 20 FPS

// 아이템 생성 최적화
setInterval(() => {
  if (winner) return;
  const type = ITEM_TYPES[Math.floor(Math.random() * ITEM_TYPES.length)];
  let x, y;
  let tries = 0;
  
  while (tries < 30) {
    x = Math.random() * 700 + 50;
    y = Math.random() * 500 + 50;
    if (!obstacles.some(obs => fastCollisionCheck({ x, y }, obs, obs.r + 30))) break;
    tries++;
  }
  
  items.push({ 
    id: Date.now() + Math.random(), 
    type, 
    x, 
    y, 
    createdAt: Date.now() 
  });
  gameStateChanged.items = true;
}, 10000);

// 아이템 정리 최적화
setInterval(() => {
  const now = Date.now();
  const initialLength = items.length;
  items = items.filter(item => now - (item.createdAt || 0) <= 5000);
  if (items.length !== initialLength) {
    gameStateChanged.items = true;
  }
}, 5000);

// Socket.IO 연결 최적화
io.on('connection', (socket) => {
  console.log(`Player connected: ${socket.id}`);
  
  // 새 플레이어 입장 최적화
  socket.on('join', (data) => {
    try {
      const teamCounts = { red: 0, blue: 0 };
      players.forEach(p => {
        if (p.team === 'red') teamCounts.red++;
        if (p.team === 'blue') teamCounts.blue++;
      });
      
      const team = teamCounts.red <= teamCounts.blue ? 'red' : 'blue';
      let nickname = (data && typeof data.nickname === 'string') ? 
        data.nickname.slice(0, 10) : '플레이어';
      
      players.set(socket.id, {
        x: Math.random() * 800,
        y: Math.random() * 600,
        color: '#' + Math.floor(Math.random()*16777215).toString(16),
        hp: 10,
        alive: true,
        respawnTime: null,
        team,
        kill: 0,
        nickname,
      });
      
      gameStateChanged.players = true;
      gameStateChanged.teamScores = true;
      
      // 초기 데이터 전송 최적화
      socket.binary(false).emit('items', items);
      socket.binary(false).emit('obstacles', obstacles);
      
    } catch (error) {
      console.error('Join error:', error);
    }
  });

  // 플레이어 이동 최적화
  socket.on('move', (data) => {
    try {
      const player = players.get(socket.id);
      if (player && typeof data.x === 'number' && typeof data.y === 'number') {
        player.x = Math.max(0, Math.min(800, data.x));
        player.y = Math.max(0, Math.min(600, data.y));
        gameStateChanged.players = true;
      }
    } catch (error) {
      console.error('Move error:', error);
    }
  });

  // 총알 발사 최적화
  socket.on('shoot', (bullet) => {
    try {
      if (bullet && typeof bullet.x === 'number' && typeof bullet.y === 'number') {
        bullets.push({ 
          ...bullet, 
          id: Date.now() + Math.random(),
          owner: socket.id
        });
        gameStateChanged.bullets = true;
      }
    } catch (error) {
      console.error('Shoot error:', error);
    }
  });

  // 연결 해제 최적화
  socket.on('disconnect', () => {
    console.log(`Player disconnected: ${socket.id}`);
    players.delete(socket.id);
    gameStateChanged.players = true;
  });
});

// 게임 리셋 함수 최적화
function resetGame() {
  teamScores = { red: 0, blue: 0 };
  winner = null;
  
  players.forEach(p => {
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
  });
  
  bullets = [];
  obstacles = randomObstacles();
  
  // 모든 상태 변경 플래그 설정
  Object.keys(gameStateChanged).forEach(key => {
    gameStateChanged[key] = true;
  });
}

// Express.js 에러 핸들링 최적화
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).send('Something broke!');
});

// 정적 파일은 nginx에서 처리하므로 제거
// API 엔드포인트 추가 (필요시)
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    players: players.size, 
    bullets: bullets.length,
    items: items.length 
  });
});

// 서버 시작 최적화
server.listen(PORT, () => {
  console.log(`🚀 Optimized Game Server running on port ${PORT}`);
  console.log(`⚡ Game Loop: 60 FPS | Network: 20 FPS`);
  console.log(`🔧 Features: Compression, Binary Optimization, Delta Updates`);
  console.log(`📊 Health endpoint: http://localhost:${PORT}/api/health`);
}); 