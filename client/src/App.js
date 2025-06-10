import React, { useEffect, useRef, useState } from 'react';
import io from 'socket.io-client';

const socket = io();
const WIDTH = 800;
const HEIGHT = 600;
const SPEED = 5;
const BULLET_SPEED = 10;
const PLAYER_RADIUS = 20;

function getAngle(cx, cy, mx, my) {
  return Math.atan2(my - cy, mx - cx);
}

function distance(x1, y1, x2, y2) {
  return Math.sqrt((x2 - x1) ** 2 + (y2 - y1) ** 2);
}

function App() {
  const canvasRef = useRef(null);
  const [players, setPlayers] = useState({});
  const [myId, setMyId] = useState(null);
  const pos = useRef({ x: Math.random() * WIDTH, y: Math.random() * HEIGHT });
  const [mouse, setMouse] = useState({ x: WIDTH / 2, y: HEIGHT / 2 });
  const mouseRef = useRef(mouse);
  const [bullets, setBullets] = useState([]); // {x, y, angle, owner}
  const isShooting = useRef(false);
  const myIdRef = useRef(null);
  const [teamScores, setTeamScores] = useState({ red: 0, blue: 0 });
  const [winner, setWinner] = useState(null);
  const [nickname, setNickname] = useState('');
  const [joined, setJoined] = useState(false);
  const [obstacles, setObstacles] = useState([]);
  const [items, setItems] = useState([]); // 아이템 상태 추가
  const laserCooldown = useRef(0);

  useEffect(() => { mouseRef.current = mouse; }, [mouse]);
  useEffect(() => { myIdRef.current = myId; }, [myId]);

  // 서버 연결 및 플레이어 동기화
  useEffect(() => {
    if (!joined) return;
    const handleConnect = () => {
      setMyId(socket.id);
      myIdRef.current = socket.id;
      socket.emit('join', { nickname });
    };
    socket.on('connect', handleConnect);
    socket.on('players', (players) => {
      setPlayers(players);
    });
    // 이미 연결된 상태라면 즉시 join emit
    if (socket.connected) {
      handleConnect();
    }
    return () => {
      socket.off('connect', handleConnect);
      socket.off('players');
    };
  }, [joined, nickname]);

  // 마우스 위치 추적 (목표점)
  useEffect(() => {
    if (!joined) return;
    const handleMouseMove = (e) => {
      const rect = canvasRef.current.getBoundingClientRect();
      setMouse({
        x: e.clientX - rect.left,
        y: e.clientY - rect.top,
      });
    };
    window.addEventListener('mousemove', handleMouseMove);
    return () => window.removeEventListener('mousemove', handleMouseMove);
  }, [joined]);

  // 플레이어가 마우스 위치로 자동 이동 (구조물 통과 가능)
  useEffect(() => {
    if (!joined) return;
    const interval = setInterval(() => {
      const dx = mouseRef.current.x - pos.current.x;
      const dy = mouseRef.current.y - pos.current.y;
      const dist = distance(pos.current.x, pos.current.y, mouseRef.current.x, mouseRef.current.y);
      if (dist > SPEED) {
        pos.current.x += (dx / dist) * SPEED;
        pos.current.y += (dy / dist) * SPEED;
        socket.emit('move', { x: pos.current.x, y: pos.current.y });
      }
    }, 16);
    return () => clearInterval(interval);
  }, [joined]);

  // 스페이스바로 총알/레이저 발사 (한 번에 한 발만, 레이저는 0.5초 쿨타임)
  useEffect(() => {
    if (!joined) return;
    const handleKeyDown = (e) => {
      if (e.code === 'Space' && myIdRef.current && !isShooting.current) {
        isShooting.current = true;
        const my = players[myIdRef.current];
        const now = Date.now();
        if (my && my.weapon === 'laser') {
          if (!laserCooldown.current || now - laserCooldown.current > 500) {
            laserCooldown.current = now;
            const angle = getAngle(
              pos.current.x,
              pos.current.y,
              mouseRef.current.x,
              mouseRef.current.y
            );
            // 레이저 총알: type: 'laser', 길이 999
            const bullet = {
              x: pos.current.x + Math.cos(angle) * PLAYER_RADIUS,
              y: pos.current.y + Math.sin(angle) * PLAYER_RADIUS,
              angle,
              owner: myIdRef.current,
              type: 'laser',
            };
            socket.emit('shoot', bullet);
          }
        } else {
          // 일반 총알
          const angle = getAngle(
            pos.current.x,
            pos.current.y,
            mouseRef.current.x,
            mouseRef.current.y
          );
          const bullet = {
            x: pos.current.x + Math.cos(angle) * PLAYER_RADIUS,
            y: pos.current.y + Math.sin(angle) * PLAYER_RADIUS,
            angle,
            owner: myIdRef.current,
          };
          socket.emit('shoot', bullet);
        }
      }
    };
    const handleKeyUp = (e) => {
      if (e.code === 'Space') {
        isShooting.current = false;
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
    };
  }, [joined, players]);

  // 총알 이동 (클라이언트에서만, 서버와 동기화 전용)
  useEffect(() => {
    if (!joined) return;
    const interval = setInterval(() => {
      setBullets((prev) =>
        prev
          .map((b) => ({
            ...b,
            x: b.x + Math.cos(b.angle) * BULLET_SPEED,
            y: b.y + Math.sin(b.angle) * BULLET_SPEED,
          }))
          .filter((b) => b.x > 0 && b.x < WIDTH && b.y > 0 && b.y < HEIGHT)
      );
    }, 16);
    return () => clearInterval(interval);
  }, [joined]);

  // 서버에서 bullets 동기화
  useEffect(() => {
    if (!joined) return;
    socket.on('bullets', (serverBullets) => {
      setBullets(serverBullets);
    });
    return () => socket.off('bullets');
  }, [joined]);

  // 서버에서 팀 점수/승자 정보 수신
  useEffect(() => {
    if (!joined) return;
    const handler = ({ teamScores, winner }) => {
      setTeamScores(teamScores || { red: 0, blue: 0 });
      setWinner(winner || null);
    };
    socket.on('teamScores', handler);
    return () => socket.off('teamScores', handler);
  }, [joined]);

  // 서버에서 obstacles 정보 수신
  useEffect(() => {
    if (!joined) return;
    socket.on('obstacles', setObstacles);
    return () => socket.off('obstacles', setObstacles);
  }, [joined]);

  // 서버에서 items 정보 수신
  useEffect(() => {
    if (!joined) return;
    socket.on('items', setItems);
    return () => socket.off('items', setItems);
  }, [joined]);

  // 내 HP, alive, respawnTime, team 상태 추출
  const myPlayer = players[myId] || {};
  const isDead = myPlayer.hp !== undefined && (myPlayer.hp <= 0 || myPlayer.alive === false || myPlayer.x == null);
  const respawnLeft = myPlayer.respawnTime ? Math.max(0, Math.ceil((myPlayer.respawnTime - Date.now()) / 1000)) : 0;
  const myTeam = myPlayer.team;

  // 승패 메시지 계산
  let resultMsg = null;
  if (winner && myTeam) {
    if (winner === myTeam) resultMsg = 'WIN';
    else resultMsg = 'LOSE';
  }

  // 그리기
  useEffect(() => {
    if (!joined) return;
    const ctx = canvasRef.current.getContext('2d');
    ctx.clearRect(0, 0, WIDTH, HEIGHT);
    // 구조물
    obstacles.forEach((obs) => {
      ctx.save();
      ctx.beginPath();
      ctx.arc(obs.x, obs.y, obs.r, 0, 2 * Math.PI);
      ctx.fillStyle = '#888';
      ctx.globalAlpha = 0.7;
      ctx.fill();
      ctx.lineWidth = 3;
      ctx.strokeStyle = '#444';
      ctx.globalAlpha = 1;
      ctx.stroke();
      ctx.restore();
    });
    // 아이템(힐링팩/무적/레이저)
    items.forEach((item) => {
      if (item.type === 'heal') {
        ctx.save();
        ctx.beginPath();
        ctx.arc(item.x, item.y, 18, 0, 2 * Math.PI);
        ctx.fillStyle = '#2ecc40'; // 초록색
        ctx.globalAlpha = 0.85;
        ctx.fill();
        ctx.lineWidth = 3;
        ctx.strokeStyle = '#117a2b';
        ctx.globalAlpha = 1;
        ctx.stroke();
        // + 표시
        ctx.font = 'bold 22px sans-serif';
        ctx.fillStyle = '#fff';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('+', item.x, item.y);
        ctx.restore();
      }
      if (item.type === 'immortal') {
        ctx.save();
        ctx.beginPath();
        ctx.arc(item.x, item.y, 18, 0, 2 * Math.PI);
        ctx.fillStyle = '#ffe066'; // 노란색
        ctx.globalAlpha = 0.92;
        ctx.fill();
        ctx.lineWidth = 3;
        ctx.strokeStyle = '#e1b800';
        ctx.globalAlpha = 1;
        ctx.stroke();
        // ! 표시
        ctx.font = 'bold 22px sans-serif';
        ctx.fillStyle = '#e67e22';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('!', item.x, item.y);
        ctx.restore();
      }
      if (item.type === 'weapon_laser') {
        ctx.save();
        ctx.beginPath();
        ctx.arc(item.x, item.y, 18, 0, 2 * Math.PI);
        ctx.fillStyle = '#ff1744'; // 강렬한 빨간색
        ctx.globalAlpha = 0.92;
        ctx.fill();
        ctx.lineWidth = 3;
        ctx.strokeStyle = '#b71c1c';
        ctx.globalAlpha = 1;
        ctx.stroke();
        // 번개 아이콘
        ctx.font = 'bold 22px sans-serif';
        ctx.fillStyle = '#fff';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('⚡', item.x, item.y);
        ctx.restore();
      }
    });
    // 총알
    bullets.forEach((b) => {
      if (b.type === 'laser') {
        // 레이저: 굵은 빨간색 직선
        ctx.save();
        ctx.strokeStyle = '#ff1744';
        ctx.lineWidth = 10;
        ctx.globalAlpha = 0.85;
        ctx.beginPath();
        ctx.moveTo(b.x, b.y);
        ctx.lineTo(b.x + Math.cos(b.angle) * 999, b.y + Math.sin(b.angle) * 999);
        ctx.stroke();
        ctx.globalAlpha = 1;
        ctx.restore();
      } else {
        // 일반 총알
        ctx.beginPath();
        ctx.arc(b.x, b.y, 5, 0, 2 * Math.PI);
        ctx.fillStyle = '#222';
        ctx.fill();
      }
    });
    // 플레이어
    Object.entries(players).forEach(([id, p]) => {
      if (!p.alive || p.x == null || p.y == null) return; // 죽으면 그리지 않음
      ctx.save();
      // 무적 효과: 황금색 오라
      if (p.immortal) {
        ctx.shadowColor = 'gold';
        ctx.shadowBlur = 32;
      }
      // 각도: 항상 마우스 방향
      let angle = 0;
      if (id === myId) {
        angle = getAngle(p.x, p.y, mouse.x, mouse.y);
      } else if (bullets.length > 0) {
        // 상대방은 총알 방향 추정(간단 처리)
        const last = bullets.find((b) => b.owner === id);
        if (last) angle = last.angle;
      }
      ctx.translate(p.x, p.y);
      ctx.rotate(angle);
      // 원
      ctx.beginPath();
      ctx.arc(0, 0, PLAYER_RADIUS, 0, 2 * Math.PI);
      ctx.fillStyle = p.color;
      ctx.globalAlpha = id === myId ? 1 : 0.6;
      ctx.fill();
      ctx.globalAlpha = 1;
      // 팀별 테두리
      ctx.strokeStyle = p.team === 'red' ? '#e22' : p.team === 'blue' ? '#22f' : '#888';
      ctx.lineWidth = id === myId ? 5 : 3;
      ctx.stroke();
      // 무적 효과: 별 아이콘
      if (p.immortal) {
        ctx.rotate(-angle);
        ctx.font = 'bold 28px sans-serif';
        ctx.fillStyle = 'gold';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'bottom';
        ctx.fillText('★', 0, -PLAYER_RADIUS - 8);
        ctx.rotate(angle);
      }
      // 총구(선)
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(PLAYER_RADIUS + 15, 0);
      ctx.strokeStyle = '#333';
      ctx.lineWidth = 5;
      ctx.stroke();
      ctx.rotate(-angle);
      // HP 바
      if (p.hp !== undefined) {
        ctx.beginPath();
        ctx.rect(-PLAYER_RADIUS, -PLAYER_RADIUS - 18, PLAYER_RADIUS * 2, 8);
        ctx.fillStyle = '#eee';
        ctx.fill();
        ctx.beginPath();
        ctx.rect(-PLAYER_RADIUS, -PLAYER_RADIUS - 18, (PLAYER_RADIUS * 2) * Math.max(0, p.hp) / 10, 8);
        ctx.fillStyle = '#f44';
        ctx.fill();
        ctx.strokeStyle = '#333';
        ctx.strokeRect(-PLAYER_RADIUS, -PLAYER_RADIUS - 18, PLAYER_RADIUS * 2, 8);
      }
      // 팀 마크
      ctx.font = 'bold 18px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = p.team === 'red' ? '#e22' : p.team === 'blue' ? '#22f' : '#888';
      ctx.fillText(p.team === 'red' ? 'R' : p.team === 'blue' ? 'B' : '', 0, 0);
      // 닉네임:킬수 표시
      ctx.font = 'bold 14px sans-serif';
      ctx.fillStyle = '#222';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillText(`${p.nickname ? p.nickname : '플레이어'}: ${p.kill ?? 0}`, 0, PLAYER_RADIUS + 8);
      ctx.restore();
    });
  }, [players, myId, mouse, bullets, joined, obstacles, items]);

  // 조작 제한: 죽었으면 마우스 이동/스페이스바 무시
  useEffect(() => {
    if (!isDead || !joined) return;
    const prevent = (e) => e.preventDefault();
    window.addEventListener('mousemove', prevent, { capture: true });
    window.addEventListener('keydown', prevent, { capture: true });
    return () => {
      window.removeEventListener('mousemove', prevent, { capture: true });
      window.removeEventListener('keydown', prevent, { capture: true });
    };
  }, [isDead, joined]);

  // 닉네임 입력 핸들러
  const handleNicknameChange = (e) => {
    let value = e.target.value;
    if (value.length > 10) value = value.slice(0, 10);
    setNickname(value);
  };
  const handleJoin = (e) => {
    e.preventDefault();
    if (nickname.trim().length === 0) return;
    setJoined(true);
  };

  if (!joined) {
    return (
      <div style={{textAlign:'center',marginTop:'120px'}}>
        <h2>닉네임을 입력하세요</h2>
        <form onSubmit={handleJoin}>
          <input
            type="text"
            value={nickname}
            onChange={handleNicknameChange}
            maxLength={10}
            placeholder="닉네임 (최대 10자)"
            style={{fontSize:'1.2em',padding:'8px',borderRadius:'6px',border:'1px solid #aaa'}}
          />
          <button type="submit" style={{marginLeft:12,fontSize:'1.2em',padding:'8px 18px'}}>입장</button>
        </form>
      </div>
    );
  }

  return (
    <div style={{ textAlign: 'center' }}>
      <h2>멀티플레이 2D 액션 게임</h2>
      <div style={{fontWeight:'bold',fontSize:'1.2em',marginBottom:8}}>
        <span style={{color:'#e22'}}>레드팀: {teamScores.red ?? 0}</span>
        {'  |  '}
        <span style={{color:'#22f'}}>블루팀: {teamScores.blue ?? 0}</span>
        {'  '}<span style={{color:'#333',marginLeft:16}}>(목표: 100킬)</span>
      </div>
      {myTeam && (
        <div style={{fontWeight:'bold',fontSize:'1.2em',marginBottom:8}}>
          내 팀: <span style={{color:myTeam==='red'?'#e22':'#22f'}}>{myTeam==='red'?'레드팀':'블루팀'}</span>
        </div>
      )}
      {winner && resultMsg && (
        <div style={{
          fontWeight:'bold',fontSize:'2.5em',marginBottom:8,
          color: resultMsg==='WIN' ? '#0c0' : '#f44',
          textShadow: '2px 2px 8px #fff, 0 0 8px #000'
        }}>
          {resultMsg}
        </div>
      )}
      <canvas ref={canvasRef} width={WIDTH} height={HEIGHT} style={{ border: '2px solid #333', background: '#fafafa' }} />
      {isDead && respawnLeft > 0 ? (
        <div style={{color:'#f44',fontWeight:'bold',fontSize:'2em'}}>죽었습니다!<br/>부활까지 {respawnLeft}초</div>
      ) : isDead ? (
        <div style={{color:'#f44',fontWeight:'bold',fontSize:'2em'}}>부활 중...</div>
      ) : (
        <div>마우스를 움직이면 따라가고, 스페이스바로 총알 발사!</div>
      )}
    </div>
  );
}

export default App;
