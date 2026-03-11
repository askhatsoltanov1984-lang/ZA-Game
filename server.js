const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;

// === CONSTANTS ===

const RANKS = ['4','5','6','7','8','9','10','J','Q','K','A','2','3'];
const SUITS = ['s','h','d','c'];
const RANK_VALUE = { '4':1,'5':2,'6':3,'7':4,'8':5,'9':6,'10':7,'J':8,'Q':9,'K':10,'A':11,'2':12,'3':13,'JOK':14 };
const STRAIGHT_RANKS = ['4','5','6','7','8','9','10','J','Q','K','A'];
const STRAIGHT_RANK_VALUE = { '4':1,'5':2,'6':3,'7':4,'8':5,'9':6,'10':7,'J':8,'Q':9,'K':10,'A':11 };
const ROOM_CHARS = 'ACDEFGHJKLMNPQRSTUVWXYZ23456789';
const COMBO_TYPES = { SINGLE: 'single', PAIR: 'pair', STRAIGHT: 'straight', ZA: 'za', PO: 'po', VANGOG: 'vangog' };
const COMBO_HIERARCHY = { single: 1, pair: 1, straight: 1, za: 2, po: 3, vangog: 4 };
const TURN_TIMER_SECONDS = 30;
const DISCONNECT_HOLD_MS = 2 * 60 * 1000;

// === DECK ===

function createDeck() {
  const deck = [];
  for (const r of RANKS) for (const s of SUITS) deck.push(r + s);
  deck.push('JOK1', 'JOK2');
  return deck;
}

function shuffleDeck(deck) {
  const d = [...deck];
  for (let i = d.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [d[i], d[j]] = [d[j], d[i]];
  }
  return d;
}

function getCardRank(cardId) {
  if (cardId.startsWith('JOK')) return 'JOK';
  if (cardId.startsWith('10')) return '10';
  return cardId.slice(0, -1);
}

function getCardSuit(cardId) {
  if (cardId.startsWith('JOK')) return null;
  if (cardId.startsWith('10')) return cardId.slice(2);
  return cardId.slice(-1);
}

function getCardValue(cardId) { return RANK_VALUE[getCardRank(cardId)]; }

function sortCards(cards) {
  return [...cards].sort((a, b) => getCardValue(a) - getCardValue(b));
}

// === ROOM MANAGER ===

const rooms = new Map();

function generateRoomCode() {
  let code;
  do {
    code = '';
    for (let i = 0; i < 4; i++) code += ROOM_CHARS[Math.floor(Math.random() * ROOM_CHARS.length)];
  } while (rooms.has('ZA-' + code));
  return 'ZA-' + code;
}

function createRoom(hostId, nickname, maxPlayers) {
  const code = generateRoomCode();
  const room = {
    code,
    players: [{ id: hostId, nickname, isHost: true, disconnected: false }],
    hands: new Map(),
    turnOrder: [],
    turnIndex: 0,
    passCount: 0,
    tableCombo: null,
    status: 'lobby',
    maxPlayers: Math.min(8, Math.max(3, maxPlayers || 8)),
    standings: [],
    finishedPlayers: [],
    createdAt: Date.now(),
    lastActivity: Date.now(),
    lastPlayerId: null,
    observers: [],
    queue: [],
    turnTimer: null,
    turnSecondsLeft: 0,
    wonWithUnbeatenCard: false,
    isFirstTurn: false,
    firstTurnPlayerId: null,
    disconnectTimers: new Map(),
  };
  rooms.set(code, room);
  return room;
}

function findRoomByPlayer(playerId) {
  for (const [, room] of rooms) {
    if (room.players.some(p => p.id === playerId)) return room;
  }
  return null;
}

// Room cleanup
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    const finishedTimeout = room.status === 'finished' && now - room.lastActivity > 30 * 60 * 1000;
    const inactiveTimeout = now - room.lastActivity > 2 * 60 * 60 * 1000;
    if (finishedTimeout || inactiveTimeout) {
      clearTurnTimer(room);
      rooms.delete(code);
    }
  }
}, 60 * 1000);

function getRoomList() {
  const list = [];
  for (const [, room] of rooms) {
    const activePlayers = room.players.filter(p => !p.disconnected);
    let type;
    if (room.status === 'lobby') {
      type = activePlayers.length >= room.maxPlayers ? 'full' : 'waiting';
    } else if (room.status === 'playing') {
      type = 'playing';
    } else {
      type = 'finished';
    }
    list.push({
      code: room.code,
      type,
      playerCount: activePlayers.length,
      maxPlayers: room.maxPlayers,
      observerCount: room.observers.length,
    });
  }
  return list;
}

setInterval(() => { io.emit('room_list', getRoomList()); }, 3000);

// === COMBO VALIDATOR ===

function isJoker(cardId) { return cardId === 'JOK1' || cardId === 'JOK2'; }

function detectCombo(cardIds) {
  const cards = [...cardIds];
  const jokers = cards.filter(isJoker);
  const normals = cards.filter(c => !isJoker(c));
  const jokerCount = jokers.length;
  if (jokerCount > 2) return null;
  if (cards.length === 0) return null;
  if (cards.length === 1) {
    if (jokerCount === 1) return { comboType: COMBO_TYPES.SINGLE, rank: 14, cards, displayRank: 'JOK' };
    return { comboType: COMBO_TYPES.SINGLE, rank: getCardValue(cards[0]), cards, displayRank: getCardRank(cards[0]) };
  }
  if (cards.length === 2) {
    if (jokerCount === 2) return { comboType: COMBO_TYPES.PAIR, rank: 14, cards, displayRank: 'JOKER' };
    if (jokerCount === 1) {
      const r = getCardValue(normals[0]);
      return { comboType: COMBO_TYPES.PAIR, rank: r, cards, displayRank: getCardRank(normals[0]) };
    }
    const r0 = getCardRank(normals[0]), r1 = getCardRank(normals[1]);
    if (r0 === r1) return { comboType: COMBO_TYPES.PAIR, rank: getCardValue(normals[0]), cards, displayRank: r0 };
    return null;
  }
  if (cards.length === 3) {
    const normalRanks = normals.map(getCardRank);
    const uniqueRanks = [...new Set(normalRanks)];
    if (jokerCount <= 2 && uniqueRanks.length === 1 && normals.length + jokerCount === 3)
      return { comboType: COMBO_TYPES.ZA, rank: getCardValue(normals[0]), cards, displayRank: normalRanks[0] };
    return null;
  }
  if (cards.length === 4) {
    const normalRanks = normals.map(getCardRank);
    const uniqueRanks = [...new Set(normalRanks)];
    if (jokerCount === 0 && uniqueRanks.length === 1)
      return { comboType: COMBO_TYPES.PO, rank: getCardValue(normals[0]), cards, displayRank: normalRanks[0] };
    if (jokerCount === 1 && uniqueRanks.length === 1 && normals.length === 3)
      return { comboType: COMBO_TYPES.PO, rank: getCardValue(normals[0]), cards, displayRank: normalRanks[0] };
    if (jokerCount === 2 && uniqueRanks.length === 1 && normals.length === 2)
      return { comboType: COMBO_TYPES.PO, rank: getCardValue(normals[0]), cards, displayRank: normalRanks[0] };
    const sr = detectStraight(normals, jokerCount);
    if (sr) return { comboType: COMBO_TYPES.STRAIGHT, rank: sr.topValue, cards, length: cards.length, displayRank: sr.display };
    return null;
  }
  if (cards.length === 6) {
    const vr = detectVangog(normals, jokerCount);
    if (vr) return { comboType: COMBO_TYPES.VANGOG, rank: vr.topValue, cards, displayRank: vr.display };
  }
  if (cards.length >= 4) {
    const sr = detectStraight(normals, jokerCount);
    if (sr) return { comboType: COMBO_TYPES.STRAIGHT, rank: sr.topValue, cards, length: cards.length, displayRank: sr.display };
  }
  return null;
}

function detectStraight(normals, jokerCount) {
  for (const c of normals) { const r = getCardRank(c); if (r === '2' || r === '3') return null; }
  const values = normals.map(c => STRAIGHT_RANK_VALUE[getCardRank(c)]).filter(v => v !== undefined);
  if (values.length !== normals.length) return null;
  if (new Set(values).size !== values.length) return null;
  values.sort((a, b) => a - b);
  const totalCards = normals.length + jokerCount;
  if (totalCards < 4) return null;
  let jokersNeeded = 0;
  for (let i = 1; i < values.length; i++) { const gap = values[i] - values[i-1] - 1; if (gap < 0) return null; jokersNeeded += gap; }
  if (jokersNeeded > jokerCount) return null;
  const span = values[values.length-1] - values[0] + 1;
  const neededForSpan = span - values.length;
  if (neededForSpan > jokerCount) return null;
  const remainingJokers = jokerCount - neededForSpan;
  const actualLength = span + remainingJokers;
  if (actualLength !== totalCards) return null;
  const topValue = values[values.length-1] + remainingJokers;
  if (topValue > 11) return null;
  const bottomValue = values[0];
  const valToRank = {};
  for (const [rank, val] of Object.entries(STRAIGHT_RANK_VALUE)) valToRank[val] = rank;
  return { topValue, display: `${valToRank[bottomValue]||bottomValue}-${valToRank[topValue]||topValue}` };
}

function detectVangog(normals, jokerCount) {
  if (normals.length + jokerCount !== 6) return null;
  const rankCounts = {};
  for (const c of normals) { const r = getCardRank(c); rankCounts[r] = (rankCounts[r]||0) + 1; }
  for (let si = 0; si < RANKS.length - 2; si++) {
    const r1 = RANKS[si], r2 = RANKS[si+1], r3 = RANKS[si+2];
    const n1 = Math.max(0, 2-(rankCounts[r1]||0)), n2 = Math.max(0, 2-(rankCounts[r2]||0)), n3 = Math.max(0, 2-(rankCounts[r3]||0));
    const totalNeeded = n1+n2+n3;
    const usedNormals = (rankCounts[r1]||0)+(rankCounts[r2]||0)+(rankCounts[r3]||0);
    if (usedNormals + jokerCount !== 6) continue;
    if (usedNormals !== normals.length) continue;
    if (totalNeeded > jokerCount) continue;
    if ((rankCounts[r1]||0)>2||(rankCounts[r2]||0)>2||(rankCounts[r3]||0)>2) continue;
    return { topValue: RANK_VALUE[r3], display: `${r1}-${r1},${r2}-${r2},${r3}-${r3}` };
  }
  return null;
}

function validatePlay(selectedCards, tableCombo) {
  const combo = detectCombo(selectedCards);
  if (!combo) return { valid: false, error: 'Неверная комбинация карт' };
  if (!tableCombo) return { valid: true, ...combo };
  // VanGog on table → only higher VanGog can beat it (not ZA, not PO)
  if (tableCombo.comboType === COMBO_TYPES.VANGOG) {
    if (combo.comboType !== COMBO_TYPES.VANGOG) return { valid: false, error: 'ВанГог можно побить только старшим ВанГогом' };
    if (combo.rank <= tableCombo.rank) return { valid: false, error: 'ВанГог должен быть старше' };
    return { valid: true, ...combo };
  }
  // VanGog cannot beat non-VanGog combos (only playable on empty table)
  if (combo.comboType === COMBO_TYPES.VANGOG) {
    return { valid: false, error: 'ВанГог можно играть только в начале раунда' };
  }
  if (combo.comboType === COMBO_TYPES.PO) {
    if (tableCombo.comboType === COMBO_TYPES.PO && combo.rank <= tableCombo.rank) return { valid: false, error: 'ПО должно быть старше' };
    return { valid: true, ...combo };
  }
  if (tableCombo.comboType === COMBO_TYPES.PO) return { valid: false, error: 'ПО можно побить только старшим ПО' };
  if (combo.comboType === COMBO_TYPES.ZA) {
    if (tableCombo.comboType === COMBO_TYPES.ZA && combo.rank <= tableCombo.rank) return { valid: false, error: 'ЗА должно быть старше' };
    return { valid: true, ...combo };
  }
  if (tableCombo.comboType === COMBO_TYPES.ZA) return { valid: false, error: 'ЗА можно побить только старшим ЗА или ПО' };
  if (combo.comboType !== tableCombo.comboType) return { valid: false, error: `Нужно играть ${comboTypeName(tableCombo.comboType)}` };
  if (combo.comboType === COMBO_TYPES.STRAIGHT && selectedCards.length !== tableCombo.cards.length)
    return { valid: false, error: `Стрит должен быть длиной ${tableCombo.cards.length} карт` };
  if (combo.rank <= tableCombo.rank) return { valid: false, error: 'Комбинация должна быть старше' };
  return { valid: true, ...combo };
}

function comboTypeName(type) {
  return { single:'одиночную', pair:'пару', straight:'стрит', za:'ЗА', po:'ПО', vangog:'ВанГог' }[type] || type;
}

function comboDisplayName(combo) {
  if (!combo) return '';
  const rn = { '4':'четвёрок','5':'пятёрок','6':'шестёрок','7':'семёрок','8':'восьмёрок','9':'девяток','10':'десяток','J':'вальтов','Q':'дам','K':'королей','A':'тузов','2':'двоек','3':'троек','JOK':'джокеров','JOKER':'джокеров' };
  const rankName = rn[combo.displayRank] || combo.displayRank;
  switch (combo.comboType) {
    case COMBO_TYPES.SINGLE: return combo.displayRank === 'JOK' ? 'Джокер!' : combo.displayRank;
    case COMBO_TYPES.PAIR: return `Пара ${rankName}`;
    case COMBO_TYPES.STRAIGHT: return `Стрит ${combo.displayRank}`;
    case COMBO_TYPES.ZA: return `ЗА ${rankName.toUpperCase()}!`;
    case COMBO_TYPES.PO: return `ПО ${rankName.toUpperCase()}!`;
    case COMBO_TYPES.VANGOG: return 'ВанГог!';
    default: return '';
  }
}

// === TIMER ===

function clearTurnTimer(room) {
  if (room.turnTimer) { clearInterval(room.turnTimer); room.turnTimer = null; }
  room.turnSecondsLeft = 0;
}

function startTurnTimer(room) {
  clearTurnTimer(room);
  room.turnSecondsLeft = TURN_TIMER_SECONDS;
  room.turnTimer = setInterval(() => {
    room.turnSecondsLeft--;
    io.to(room.code).emit('timer_tick', { secondsLeft: room.turnSecondsLeft });
    if (room.turnSecondsLeft <= 0) {
      clearTurnTimer(room);
      const currentId = getCurrentPlayerId(room);
      if (currentId && room.status === 'playing') autoPass(room, currentId);
    }
  }, 1000);
}

function autoPass(room, playerId) {
  if (!room.tableCombo) { startTurnTimer(room); return; }
  const player = room.players.find(p => p.id === playerId);
  room.passCount++;
  room.lastActivity = Date.now();
  io.to(room.code).emit('player_passed', { playerId, nickname: player ? player.nickname : 'Unknown' });
  const activePlayers = getActivePlayersInTurnOrder(room);
  if (room.passCount >= activePlayers.length - 1) {
    let trickWinnerId = (room.lastPlayerId && activePlayers.includes(room.lastPlayerId)) ? room.lastPlayerId : activePlayers[0];
    const winner = room.players.find(p => p.id === trickWinnerId);
    io.to(room.code).emit('trick_won', { playerId: trickWinnerId, nickname: winner ? winner.nickname : 'Unknown' });
    room.wonWithUnbeatenCard = true;
    room.tableCombo = null;
    room.passCount = 0;
    const wi = room.turnOrder.indexOf(trickWinnerId);
    if (wi !== -1) room.turnIndex = wi;
    if (room.finishedPlayers.includes(trickWinnerId) || !room.hands.get(trickWinnerId) || room.hands.get(trickWinnerId).length === 0) advanceTurn(room);
  } else {
    advanceTurn(room);
  }
  const standings = checkGameEnd(room);
  if (standings) { clearTurnTimer(room); io.to(room.code).emit('game_over', { standings }); return; }
  sendStateToAll(room);
  startTurnTimer(room);
}

// === GAME LOGIC ===

function dealCards(room) {
  const deck = shuffleDeck(createDeck());
  const activePlayers = room.players.filter(p => !p.disconnected);
  const n = activePlayers.length;
  room.hands = new Map();
  for (const p of activePlayers) room.hands.set(p.id, []);
  for (let i = 0; i < deck.length; i++) {
    const player = activePlayers[i % n];
    room.hands.get(player.id).push(deck[i]);
  }
  for (const [id, hand] of room.hands) room.hands.set(id, sortCards(hand));
}

function findFirstPlayer(room) {
  for (const [playerId, hand] of room.hands) {
    if (hand.includes('4s')) return playerId;
  }
  let lowestValue = Infinity, firstPlayerId = null;
  for (const [playerId, hand] of room.hands) {
    for (const card of hand) {
      const val = getCardValue(card);
      if (val < lowestValue) { lowestValue = val; firstPlayerId = playerId; }
    }
  }
  return firstPlayerId;
}

function startGame(room) {
  room.status = 'playing';
  room.standings = [];
  room.finishedPlayers = [];
  room.tableCombo = null;
  room.passCount = 0;
  room.wonWithUnbeatenCard = false;
  dealCards(room);
  const activePlayers = room.players.filter(p => !p.disconnected);
  const firstId = findFirstPlayer(room);
  const firstIdx = activePlayers.findIndex(p => p.id === firstId);
  room.turnOrder = [];
  for (let i = 0; i < activePlayers.length; i++) room.turnOrder.push(activePlayers[(firstIdx + i) % activePlayers.length].id);
  room.turnIndex = 0;
  room.isFirstTurn = true;
  room.firstTurnPlayerId = firstId;
  room.lastActivity = Date.now();
}

function getActivePlayersInTurnOrder(room) {
  return room.turnOrder.filter(id => {
    const p = room.players.find(pl => pl.id === id);
    return p && !p.disconnected && !room.finishedPlayers.includes(id) && room.hands.has(id) && room.hands.get(id).length > 0;
  });
}

function getCurrentPlayerId(room) {
  const active = getActivePlayersInTurnOrder(room);
  if (active.length === 0) return null;
  for (let i = 0; i < room.turnOrder.length; i++) {
    const idx = (room.turnIndex + i) % room.turnOrder.length;
    if (active.includes(room.turnOrder[idx])) { room.turnIndex = idx; return room.turnOrder[idx]; }
  }
  return active[0];
}

function advanceTurn(room) {
  const active = getActivePlayersInTurnOrder(room);
  if (active.length === 0) return;
  let nextIdx = (room.turnIndex + 1) % room.turnOrder.length;
  for (let i = 0; i < room.turnOrder.length; i++) {
    if (active.includes(room.turnOrder[nextIdx])) { room.turnIndex = nextIdx; return; }
    nextIdx = (nextIdx + 1) % room.turnOrder.length;
  }
}

function getPlayerInfo(room) {
  return room.players.map(p => ({
    id: p.id, nickname: p.nickname,
    cardCount: room.hands.has(p.id) ? room.hands.get(p.id).length : 0,
    isHost: p.isHost, disconnected: p.disconnected,
    finished: room.finishedPlayers.includes(p.id),
  }));
}

function buildStateUpdate(room, forPlayerId) {
  return {
    yourHand: room.hands.has(forPlayerId) ? sortCards(room.hands.get(forPlayerId)) : [],
    tableCombo: room.tableCombo ? { cards: room.tableCombo.cards, comboType: room.tableCombo.comboType } : null,
    tableComboName: room.tableCombo ? comboDisplayName(room.tableCombo) : '',
    players: getPlayerInfo(room),
    currentPlayerId: getCurrentPlayerId(room),
    turnOrder: room.turnOrder,
    timerSeconds: room.turnSecondsLeft,
    isObserving: room.finishedPlayers.includes(forPlayerId),
  };
}

function buildObserverState(room) {
  return {
    tableCombo: room.tableCombo ? { cards: room.tableCombo.cards, comboType: room.tableCombo.comboType } : null,
    tableComboName: room.tableCombo ? comboDisplayName(room.tableCombo) : '',
    players: getPlayerInfo(room),
    currentPlayerId: getCurrentPlayerId(room),
    turnOrder: room.turnOrder,
    timerSeconds: room.turnSecondsLeft,
    isObserver: true,
  };
}

function sendStateToAll(room) {
  for (const p of room.players) {
    if (!p.disconnected) {
      const sock = io.sockets.sockets.get(p.id);
      if (sock) sock.emit('state_update', buildStateUpdate(room, p.id));
    }
  }
  for (const obs of room.observers) {
    const sock = io.sockets.sockets.get(obs.id);
    if (sock) sock.emit('observer_update', buildObserverState(room));
  }
}

function checkGameEnd(room) {
  const active = getActivePlayersInTurnOrder(room);
  if (active.length <= 1) {
    if (active.length === 1) room.finishedPlayers.push(active[0]);
    room.status = 'finished';
    room.lastActivity = Date.now();
    clearTurnTimer(room);
    const standings = room.finishedPlayers.map((id, idx) => {
      const p = room.players.find(pl => pl.id === id);
      return { place: idx + 1, nickname: p ? p.nickname : 'Unknown', id };
    });
    room.standings = standings;
    return standings;
  }
  return null;
}

// === SOCKET HANDLERS ===

io.on('connection', (socket) => {
  let currentRoomCode = null;
  socket.emit('room_list', getRoomList());

  socket.on('get_room_list', () => { socket.emit('room_list', getRoomList()); });

  socket.on('create_room', ({ nickname, maxPlayers }) => {
    if (!nickname || nickname.trim().length === 0) { socket.emit('error', { message: 'Введите никнейм' }); return; }
    leaveCurrentRoom(socket);
    const room = createRoom(socket.id, nickname.trim(), maxPlayers || 8);
    currentRoomCode = room.code;
    socket.join(room.code);
    socket.emit('room_created', { roomCode: room.code, shareUrl: `/?room=${room.code}` });
    io.to(room.code).emit('room_updated', { players: getPlayerInfo(room) });
    io.emit('room_list', getRoomList());
  });

  socket.on('join_room', ({ roomCode, nickname }) => {
    if (!nickname || nickname.trim().length === 0) { socket.emit('error', { message: 'Введите никнейм' }); return; }
    const code = roomCode ? roomCode.toUpperCase().trim() : '';
    const room = rooms.get(code);
    if (!room) { socket.emit('error', { message: 'Комната не найдена' }); return; }
    if (room.status !== 'lobby') { socket.emit('error', { message: 'Игра уже началась' }); return; }
    if (room.players.filter(p => !p.disconnected).length >= room.maxPlayers) { socket.emit('error', { message: 'Комната заполнена' }); return; }
    if (room.players.some(p => p.id === socket.id)) { socket.emit('error', { message: 'Вы уже в комнате' }); return; }
    leaveCurrentRoom(socket);
    room.players.push({ id: socket.id, nickname: nickname.trim(), isHost: false, disconnected: false });
    room.lastActivity = Date.now();
    currentRoomCode = room.code;
    socket.join(room.code);
    socket.emit('room_joined', { roomCode: room.code });
    io.to(room.code).emit('room_updated', { players: getPlayerInfo(room) });
    io.emit('room_list', getRoomList());
  });

  socket.on('join_as_observer', ({ roomCode, nickname }) => {
    const code = roomCode ? roomCode.toUpperCase().trim() : '';
    const room = rooms.get(code);
    if (!room) { socket.emit('error', { message: 'Комната не найдена' }); return; }
    leaveCurrentRoom(socket);
    for (const [, r] of rooms) r.observers = r.observers.filter(o => o.id !== socket.id);
    room.observers.push({ id: socket.id, nickname: (nickname || 'Observer').trim() });
    currentRoomCode = room.code;
    socket.join(room.code);
    socket.emit('observer_joined', { roomCode: room.code });
    socket.emit('observer_update', buildObserverState(room));
  });

  socket.on('join_queue', ({ roomCode, nickname }) => {
    const code = roomCode ? roomCode.toUpperCase().trim() : '';
    const room = rooms.get(code);
    if (!room) { socket.emit('error', { message: 'Комната не найдена' }); return; }
    if (!room.queue.some(q => q.id === socket.id)) {
      room.queue.push({ id: socket.id, nickname: (nickname || 'Player').trim() });
    }
    socket.emit('queued', { roomCode: room.code });
  });

  socket.on('rejoin_room', ({ roomCode, playerId }) => {
    const code = roomCode ? roomCode.toUpperCase().trim() : '';
    const room = rooms.get(code);
    if (!room) { socket.emit('rejoin_failed', { reason: 'Комната не найдена' }); return; }
    const player = room.players.find(p => p.id === playerId);
    if (!player) { socket.emit('rejoin_failed', { reason: 'Игрок не найден' }); return; }
    if (room.disconnectTimers.has(playerId)) {
      clearTimeout(room.disconnectTimers.get(playerId));
      room.disconnectTimers.delete(playerId);
    }
    const oldId = player.id;
    player.id = socket.id;
    player.disconnected = false;
    if (room.hands.has(oldId)) {
      const hand = room.hands.get(oldId);
      room.hands.delete(oldId);
      room.hands.set(socket.id, hand);
    }
    const ti = room.turnOrder.indexOf(oldId);
    if (ti !== -1) room.turnOrder[ti] = socket.id;
    const fi = room.finishedPlayers.indexOf(oldId);
    if (fi !== -1) room.finishedPlayers[fi] = socket.id;
    if (room.lastPlayerId === oldId) room.lastPlayerId = socket.id;
    currentRoomCode = room.code;
    socket.join(room.code);
    if (room.status === 'lobby') {
      socket.emit('room_joined', { roomCode: room.code });
      socket.emit('room_updated', { players: getPlayerInfo(room) });
    } else if (room.status === 'playing') {
      socket.emit('rejoin_success', {
        roomCode: room.code,
        state: buildStateUpdate(room, socket.id),
        players: getPlayerInfo(room),
      });
    } else if (room.status === 'finished') {
      socket.emit('game_over', { standings: room.standings });
    }
  });

  socket.on('start_game', () => {
    const room = findRoomByPlayer(socket.id);
    if (!room) return;
    const player = room.players.find(p => p.id === socket.id);
    if (!player || !player.isHost) { socket.emit('error', { message: 'Только хост может начать игру' }); return; }
    const activePlayers = room.players.filter(p => !p.disconnected);
    if (activePlayers.length < 3) { socket.emit('error', { message: 'Нужно минимум 3 игрока' }); return; }
    startGame(room);
    for (const p of activePlayers) {
      const sock = io.sockets.sockets.get(p.id);
      if (sock) {
        sock.emit('game_started', {
          yourHand: sortCards(room.hands.get(p.id)),
          currentPlayerId: getCurrentPlayerId(room),
          turnOrder: room.turnOrder,
          players: getPlayerInfo(room),
          isFirstTurn: true,
          firstTurnPlayerId: room.firstTurnPlayerId,
        });
      }
    }
    for (const obs of room.observers) {
      const sock = io.sockets.sockets.get(obs.id);
      if (sock) sock.emit('observer_update', buildObserverState(room));
    }
    startTurnTimer(room);
    io.emit('room_list', getRoomList());
  });

  socket.on('play_cards', ({ cardIds }) => {
    const room = findRoomByPlayer(socket.id);
    if (!room || room.status !== 'playing') return;
    const currentId = getCurrentPlayerId(room);
    if (socket.id !== currentId) { socket.emit('invalid_move', { reason: 'Сейчас не ваш ход' }); return; }
    const hand = room.hands.get(socket.id);
    if (!hand) return;
    const handCopy = [...hand];
    for (const cid of cardIds) {
      const idx = handCopy.indexOf(cid);
      if (idx === -1) { socket.emit('invalid_move', { reason: 'У вас нет такой карты' }); return; }
      handCopy.splice(idx, 1);
    }
    // First turn player (holder of 4♠) can play any valid combination — no forced card
    const result = validatePlay(cardIds, room.tableCombo);
    if (!result.valid) { socket.emit('invalid_move', { reason: result.error }); return; }
    for (const cid of cardIds) { const idx = hand.indexOf(cid); if (idx !== -1) hand.splice(idx, 1); }
    if (room.isFirstTurn) room.isFirstTurn = false;
    room.tableCombo = { cards: cardIds, comboType: result.comboType, rank: result.rank, displayRank: result.displayRank };
    room.passCount = 0;
    room.lastPlayerId = socket.id;
    room.wonWithUnbeatenCard = false;
    room.lastActivity = Date.now();
    const player = room.players.find(p => p.id === socket.id);
    io.to(room.code).emit('player_played', {
      playerId: socket.id, nickname: player.nickname,
      comboName: comboDisplayName(result), comboCards: cardIds, comboType: result.comboType,
    });
    if (hand.length === 0) {
      room.finishedPlayers.push(socket.id);
      io.to(room.code).emit('player_finished', { playerId: socket.id, nickname: player.nickname, place: room.finishedPlayers.length });
      const standings = checkGameEnd(room);
      if (standings) { clearTurnTimer(room); io.to(room.code).emit('game_over', { standings }); return; }
    }
    advanceTurn(room);
    sendStateToAll(room);
    startTurnTimer(room);
  });

  socket.on('pass_turn', () => {
    const room = findRoomByPlayer(socket.id);
    if (!room || room.status !== 'playing') return;
    const currentId = getCurrentPlayerId(room);
    if (socket.id !== currentId) { socket.emit('invalid_move', { reason: 'Сейчас не ваш ход' }); return; }
    if (!room.tableCombo) { socket.emit('invalid_move', { reason: 'Вы должны сделать ход (новый раунд)' }); return; }
    const player = room.players.find(p => p.id === socket.id);
    room.passCount++;
    room.lastActivity = Date.now();
    io.to(room.code).emit('player_passed', { playerId: socket.id, nickname: player.nickname });
    const activePlayers = getActivePlayersInTurnOrder(room);
    if (room.passCount >= activePlayers.length - 1) {
      let trickWinnerId = (room.lastPlayerId && activePlayers.includes(room.lastPlayerId)) ? room.lastPlayerId : null;
      if (!trickWinnerId) {
        for (let i = 1; i <= room.turnOrder.length; i++) {
          const idx = (room.turnIndex - i + room.turnOrder.length * 10) % room.turnOrder.length;
          const id = room.turnOrder[idx];
          if (activePlayers.includes(id) && id !== socket.id) { trickWinnerId = id; break; }
        }
        if (!trickWinnerId) trickWinnerId = activePlayers[0];
      }
      const winner = room.players.find(p => p.id === trickWinnerId);
      io.to(room.code).emit('trick_won', { playerId: trickWinnerId, nickname: winner ? winner.nickname : 'Unknown' });
      room.wonWithUnbeatenCard = true;
      room.tableCombo = null;
      room.passCount = 0;
      const wi = room.turnOrder.indexOf(trickWinnerId);
      if (wi !== -1) room.turnIndex = wi;
      if (room.finishedPlayers.includes(trickWinnerId) || !room.hands.get(trickWinnerId) || room.hands.get(trickWinnerId).length === 0) {
        advanceTurn(room);
      }
    } else {
      advanceTurn(room);
    }
    const standings = checkGameEnd(room);
    if (standings) { clearTurnTimer(room); io.to(room.code).emit('game_over', { standings }); return; }
    sendStateToAll(room);
    startTurnTimer(room);
  });

  socket.on('play_again', () => {
    const room = findRoomByPlayer(socket.id);
    if (!room) return;
    const player = room.players.find(p => p.id === socket.id);
    if (!player || !player.isHost) { socket.emit('error', { message: 'Только хост может начать заново' }); return; }
    clearTurnTimer(room);
    room.status = 'lobby';
    room.hands = new Map();
    room.turnOrder = [];
    room.turnIndex = 0;
    room.passCount = 0;
    room.tableCombo = null;
    room.standings = [];
    room.finishedPlayers = [];
    room.lastPlayerId = null;
    room.wonWithUnbeatenCard = false;
    room.isFirstTurn = false;
    room.firstTurnPlayerId = null;
    room.lastActivity = Date.now();
    for (const q of room.queue) {
      if (!room.players.some(p => p.id === q.id) && room.players.length < room.maxPlayers) {
        room.players.push({ id: q.id, nickname: q.nickname, isHost: false, disconnected: false });
        const sock = io.sockets.sockets.get(q.id);
        if (sock) { sock.join(room.code); sock.emit('room_joined', { roomCode: room.code }); }
      }
    }
    room.queue = [];
    for (const p of room.players) {
      const sock = io.sockets.sockets.get(p.id);
      p.disconnected = !sock;
    }
    room.players = room.players.filter(p => !p.disconnected);
    io.to(room.code).emit('back_to_lobby', { players: getPlayerInfo(room) });
    io.emit('room_list', getRoomList());
  });

  socket.on('disconnect', () => {
    const room = findRoomByPlayer(socket.id);
    if (!room) {
      for (const [, r] of rooms) {
        r.observers = r.observers.filter(o => o.id !== socket.id);
        r.queue = r.queue.filter(q => q.id !== socket.id);
      }
      return;
    }
    if (room.status === 'playing') {
      const player = room.players.find(p => p.id === socket.id);
      if (player) {
        player.disconnected = true;
        const currentId = getCurrentPlayerId(room);
        if (currentId === socket.id) {
          if (room.tableCombo) {
            room.passCount++;
            io.to(room.code).emit('player_passed', { playerId: socket.id, nickname: player.nickname });
            const ap = getActivePlayersInTurnOrder(room);
            if (room.passCount >= ap.length - 1 && ap.length > 0) {
              let twi = (room.lastPlayerId && ap.includes(room.lastPlayerId)) ? room.lastPlayerId : ap[0];
              const w = room.players.find(p => p.id === twi);
              io.to(room.code).emit('trick_won', { playerId: twi, nickname: w ? w.nickname : 'Unknown' });
              room.wonWithUnbeatenCard = true;
              room.tableCombo = null;
              room.passCount = 0;
              const wi = room.turnOrder.indexOf(twi);
              if (wi !== -1) room.turnIndex = wi;
              if (room.finishedPlayers.includes(twi)) advanceTurn(room);
            } else { advanceTurn(room); }
          } else { advanceTurn(room); }
        }
        const standings = checkGameEnd(room);
        if (standings) { clearTurnTimer(room); io.to(room.code).emit('game_over', { standings }); return; }
        sendStateToAll(room);
        if (room.status === 'playing') startTurnTimer(room);
        const holdTimer = setTimeout(() => {
          const p2 = room.players.find(pl => pl.id === socket.id);
          if (p2 && p2.disconnected) {
            room.players = room.players.filter(pl => pl.id !== socket.id);
            room.disconnectTimers.delete(socket.id);
            if (room.players.filter(pl => !pl.disconnected).length === 0) { clearTurnTimer(room); rooms.delete(room.code); }
          }
        }, DISCONNECT_HOLD_MS);
        room.disconnectTimers.set(socket.id, holdTimer);
      }
    } else {
      leaveCurrentRoom(socket);
    }
    currentRoomCode = null;
    io.emit('room_list', getRoomList());
  });

  function leaveCurrentRoom(sock) {
    const room = findRoomByPlayer(sock.id);
    if (!room) return;
    if (room.status === 'lobby') {
      room.players = room.players.filter(p => p.id !== sock.id);
      sock.leave(room.code);
      if (room.players.length === 0) { rooms.delete(room.code); io.emit('room_list', getRoomList()); return; }
      if (!room.players.some(p => p.isHost)) room.players[0].isHost = true;
      io.to(room.code).emit('room_updated', { players: getPlayerInfo(room) });
      io.emit('room_list', getRoomList());
    } else if (room.status === 'playing') {
      const player = room.players.find(p => p.id === sock.id);
      if (player) {
        player.disconnected = true;
        if (getCurrentPlayerId(room) === sock.id) advanceTurn(room);
        const standings = checkGameEnd(room);
        if (standings) { clearTurnTimer(room); io.to(room.code).emit('game_over', { standings }); return; }
        sendStateToAll(room);
      }
    }
    currentRoomCode = null;
  }
});

server.listen(PORT, () => {
  console.log(`ZA Card Game server running on port ${PORT}`);
  console.log(`Open http://localhost:${PORT} to play`);
});
