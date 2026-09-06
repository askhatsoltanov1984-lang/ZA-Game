const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { io } = require('socket.io-client');
const { saveRooms, loadRooms } = require('../room-store');
const delay = ms => new Promise(r => setTimeout(r, ms));
function stateWhere(socket, predicate) {
  if (socket.state && predicate(socket.state)) return Promise.resolve(socket.state);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.off('state_update', handler); reject(new Error('Timed out waiting for authoritative state')); }, 5000);
    function handler(data) { if (predicate(data)) { clearTimeout(timer); socket.off('state_update', handler); resolve(data); } }
    socket.on('state_update', handler);
  });
}
function event(socket, name) { return new Promise((resolve, reject) => { const timer = setTimeout(() => { socket.off(name, handler); reject(new Error('Timeout: '+name)); }, 4000); function handler(data) { clearTimeout(timer); resolve(data); } socket.once(name, handler); }); }
async function run(t, fixture) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'za-test-'));
  const file = path.join(dir, 'rooms.json');
  if (fixture) saveRooms(file, new Map([[fixture.code, fixture]]));
  let child, url;
  const sockets = [];
  async function start() {
    child = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, PORT: '0', STATE_FILE: file } });
    url = await new Promise((resolve, reject) => { let log = ''; child.stdout.on('data', d => { log += d; const m = log.match(/running on port (\d+)/); if (m) resolve('http://127.0.0.1:'+m[1]); }); child.once('exit', c => reject(new Error('Server exited '+c))); child.stderr.on('data', d => { if (!String(d).includes('State commit failed')) process.stderr.write(d); }); });
  }
  async function connect() { const s = io(url, { transports: ['websocket'], reconnection: false }); s.on('state_update', d => s.state = d); s.on('session', d => s.session = d); sockets.push(s); await event(s, 'connect'); return s; }
  async function kill() { const ended = new Promise(r => child.once('exit', r)); child.kill('SIGKILL'); await ended; }
  t.after(async () => { sockets.forEach(s => s.disconnect()); if (child.exitCode === null && !child.killed) await kill(); fs.rmSync(dir, { recursive: true, force: true }); });
  await start();
  return { connect, file, dir, start, kill, health: () => fetch(url+'/health') };
}
async function emit(s, name, data, reply) { const answer = event(s, reply); s.emit(name, data); return answer; }
async function party(t, count = 3) {
  const app = await run(t); const players = [];
  for (let i=0; i<count; i++) players.push(await app.connect());
  const {roomCode} = await emit(players[0], 'create_room', {nickname:'Игрок 0',maxPlayers:8}, 'room_created');
  for (let i=1; i<count; i++) await emit(players[i], 'join_room', {roomCode,nickname:'Игрок '+i}, 'room_joined');
  await emit(players[0], 'start_game', {}, 'game_started');
  await Promise.all(players.map(s => stateWhere(s, d => d.revision > 0 && d.yourHand.length > 0)));
  return {...app, players, roomCode};
}
test('validated creation, distinct hands, host and phase authority', async t => {
  const {players, file} = await party(t);
  assert.equal(players.reduce((n,s)=>n+s.state.yourHand.length,0),54);
  assert.equal(new Set(players.flatMap(s=>s.state.yourHand)).size,54);
  const before = fs.readFileSync(file,'utf8');
  await emit(players[1], 'start_game', {}, 'error');
  await emit(players[0], 'start_game', {}, 'error');
  await emit(players[0], 'play_again', {}, 'error');
  assert.equal(fs.readFileSync(file,'utf8'),before);
  assert.ok(players.every(s=>s.state.players.every(p=>!('sessionHash' in p))));
});
test('invalid messages cannot crash or partially mutate a game', async t => {
  const {players, health, file} = await party(t);
  const before = fs.readFileSync(file,'utf8');
  for (const bad of [null, [], 7, 'x', {}, {cardIds:[]}, {cardIds:[{}]}, {cardIds:['4s','4s']}, {cardIds:['bad']}]) await emit(players[0],'play_cards',bad,'error');
  for (const bad of [{nickname:{}},{nickname:'x'.repeat(25)},{nickname:'x',maxPlayers:'8'}]) await emit(players[0],'create_room',bad,'error');
  assert.equal(fs.readFileSync(file,'utf8'),before);
  assert.equal((await health()).status,200);
});
test('rejoin requires private token; refresh retains hand and host', async t => {
  const {players, roomCode, connect} = await party(t);
  const host = players[0], saved = {...host.session}, hand = host.state.yourHand;
  const attacker = await connect();
  await emit(attacker,'rejoin_room',{roomCode,playerId:host.id},'rejoin_failed');
  await emit(attacker,'rejoin_room',{...saved,token:'0'.repeat(64)},'rejoin_failed');
  await emit(attacker,'rejoin_room',saved,'rejoin_failed'); // second active tab refused
  const paused = stateWhere(players[1], data => data.paused);
  host.disconnect();
  assert.equal((await paused).paused,true);
  const back = await connect(); const data = await emit(back,'rejoin_room',saved,'rejoin_success');
  assert.deepEqual(data.state.yourHand,hand);
  assert.equal(data.players.find(p=>p.id===back.id).isHost,true);
  assert.equal(data.state.paused,false);
});
test('confirmed play survives SIGKILL and all players can resume', async t => {
  const app = await party(t); const {players,roomCode} = app;
  const current = players.find(s=>s.id===s.state.currentPlayerId);
  await emit(current,'play_cards',{cardIds:[current.state.yourHand[0]],revision:current.state.revision},'state_update'); await delay(30);
  const saved = players.map(s=>({...s.session}));
  const hands = players.map(s=>s.state.yourHand);
  const table = current.state.tableCombo;
  await app.kill(); await app.start();
  for (let i=0;i<3;i++) { const back=await app.connect(); const data=await emit(back,'rejoin_room',saved[i],'rejoin_success'); assert.deepEqual(data.state.yourHand,hands[i]); assert.deepEqual(data.state.tableCombo,table); }
});
test('same revision never executes twice', async t => {
  const {players} = await party(t); const current=players.find(s=>s.id===s.state.currentPlayerId);
  const data={cardIds:[current.state.yourHand[0]],revision:current.state.revision};
  await emit(current,'play_cards',data,'state_update');
  await emit(current,'play_cards',data,'invalid_move');
  assert.equal(current.state.yourHand.length,17);
});
test('complete games with 3 and 8 players preserve 54 cards and finish', async t => {
  for (const count of [3,8]) await t.test(count+' players',async t=> {
    const {players,file}=await party(t,count);
    let finished=false; players[0].on('game_over',()=>finished=true);
    for(let i=0;i<1500&&!finished;i++) {
      const room=loadRooms(file).values().next().value;
      if(room.status==='finished') break;
      const s=players.find(p=>p.id===room.turnOrder[room.turnIndex]);
      const hand=room.hands.get(s.id);
      const ranks=['4','5','6','7','8','9','10','J','Q','K','A','2','3','JOK'];
      const value=c=>ranks.indexOf(c.startsWith('JOK')?'JOK':c.slice(0,-1))+1;
      const card=hand.find(c=>!room.tableCombo||value(c)>room.tableCombo.rank);
      const response=event(s,'state_update'); const end=event(s,'game_over').catch(()=>{});
      s.emit(card?'play_cards':'pass_turn',card?{cardIds:[card],revision:room.revision}:{revision:room.revision});
      // final event does not necessarily include a state_update
      await Promise.race([response,end]); response.catch(()=>{});
    }
    const room=loadRooms(file).values().next().value;
    assert.equal(room.status,'finished'); assert.equal(room.standings.length,count);
    await emit(players[0],'play_again',{},'back_to_lobby');
    assert.equal(loadRooms(file).values().next().value.status,'lobby');
  });
});
test('disk write failure never acknowledges play, health fails closed',async t=>{
  const {players,dir,file,health}=await party(t);
  const before=fs.readFileSync(file,'utf8');
  fs.mkdirSync(file+'.tmp');
  const s=players.find(s=>s.id===s.state.currentPlayerId); let played=false;
  s.on('player_played',()=>played=true);
  await emit(s,'play_cards',{cardIds:[s.state.yourHand[0]],revision:s.state.revision},'storage_error');
  assert.equal(played,false); assert.equal(fs.readFileSync(file,'utf8'),before); assert.equal((await health()).status,503);
});
test('store rejects corrupt snapshots instead of silently losing parties',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'za-store-'));const file=path.join(dir,'rooms.json');
  saveRooms(file,new Map());assert.equal(loadRooms(file).size,0);
  fs.writeFileSync(file,'{"version":2,"rooms":[],"checksum":"bad"}');assert.throws(()=>loadRooms(file),/checksum/);
  fs.rmSync(dir,{recursive:true});
});

test('finished combination author still gives BOTH remaining players a response',async t=>{
  const app=await party(t);const sessions=app.players.map(s=>({...s.session}));
  await app.kill();
  const rooms=loadRooms(app.file),room=rooms.get(app.roomCode);
  const ids=app.players.map(s=>s.id || s.session.playerId);
  room.turnOrder=ids;room.turnIndex=1;room.finishedPlayers=[ids[0]];room.lastPlayerId=ids[0];room.passCount=0;
  room.hands=new Map([[ids[0],[]],[ids[1],['5s']],[ids[2],['6s']]]);
  room.tableCombo={cards:['4s'],comboType:'single',rank:1,displayRank:'4'};
  saveRooms(app.file,rooms);await app.start();const returning=[];
  for(const session of sessions){const s=await app.connect();await emit(s,'rejoin_room',session,'rejoin_success');returning.push(s);}
  await delay(30);
  await emit(returning[1],'pass_turn',{revision:returning[1].state.revision},'state_update');
  assert.ok(returning[1].state.tableCombo,'first pass must not clear the table');
  await delay(20);
  await emit(returning[2],'pass_turn',{revision:returning[2].state.revision},'state_update');
  assert.equal(returning[2].state.tableCombo,null);
  assert.equal(returning[2].state.currentPlayerId,returning[1].id);
});

test('timer pass uses the same completed-author rule',async t=>{
  const app=await party(t);const sessions=app.players.map(s=>({...s.session}));await app.kill();
  const rooms=loadRooms(app.file),room=rooms.get(app.roomCode),ids=sessions.map(s=>s.playerId);
  room.turnOrder=ids;room.turnIndex=1;room.finishedPlayers=[ids[0]];room.lastPlayerId=ids[0];room.passCount=0;
  room.hands=new Map([[ids[0],[]],[ids[1],['5s']],[ids[2],['6s']]]);room.tableCombo={cards:['4s'],comboType:'single',rank:1,displayRank:'4'};
  saveRooms(app.file,rooms);await app.start();const returning=[];
  for(const session of sessions){const s=await app.connect();await emit(s,'rejoin_room',session,'rejoin_success');returning.push(s);}
  await new Promise((resolve,reject)=>{const timeout=setTimeout(()=>reject(new Error('Timer did not pass')),33000);returning[1].once('player_passed',()=>{clearTimeout(timeout);resolve();});});
  await delay(30);assert.ok(returning[2].state.tableCombo);assert.equal(returning[2].state.currentPlayerId,returning[2].id);
  await emit(returning[2],'pass_turn',{revision:returning[2].state.revision},'state_update');assert.equal(returning[2].state.tableCombo,null);
});

test('rolling previous snapshot stays recoverable and oversized writes leave current intact',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'za-backup-'));const file=path.join(dir,'rooms.json');
  try{
    saveRooms(file,new Map());const initial=fs.readFileSync(file,'utf8');
    saveRooms(file,new Map());assert.equal(fs.readFileSync(file+'.previous','utf8'),initial);assert.equal(loadRooms(file+'.previous').size,0);
    assert.throws(()=>saveRooms(file,new Map([['oversize',{hands:new Map(),huge:'x'.repeat(33*1024*1024)}]])),/size limit/);
    assert.equal(fs.readFileSync(file,'utf8'),initial);
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('fully disconnected rooms leave public list but remain in durable storage',async t=>{
  const app=await party(t), code=app.roomCode;app.players.forEach(s=>s.disconnect());await delay(40);
  const spectator=await app.connect();const list=await emit(spectator,'get_room_list',{},'room_list');
  assert.equal(list.some(r=>r.code===code),false);assert.ok(loadRooms(app.file).has(code));
});
