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
const STRAIGHT_RANKS = ['4','5','6','7','8','9','10','J','Q','K','A']; // ranks valid in straights
const STRAIGHT_RANK_VALUE = { '4':1,'5':2,'6':3,'7':4,'8':5,'9':6,'10':7,'J':8,'Q':9,'K':10,'A':11 };
const ROOM_CHARS = 'ACDEFGHJKLMNPQRSTUVWXYZ23456789';
const COMBO_TYPES = { SINGLE: 'single', PAIR: 'pair', STRAIGHT: 'straight', ZA: 'za', PO: 'po', VANGOG: 'vangog' };
const COMBO_HIERARCHY = { single: 1, pair: 1, straight: 1, za: 2, po: 3, vangog: 4 };

// === DECK ===

function createDeck() {
  const deck = [];
  for (const r of RANKS) {
    for (const s of SUITS) {
      deck.push(r + s);
    }
  }
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

function getCardValue(cardId) {
  return RANK_VALUE[getCardRank(cardId)];
}

function sortCards(cards) {
  return [...cards].sort((a, b) => getCardValue(a) - getCardValue(b));
}

// === ROOM MANAGER ===

const rooms = new Map();

function generateRoomCode() {
  let code;
  do {
    code = '';
    for (let i = 0; i < 4; i++) {
      code += ROOM_CHARS[Math.floor(Math.random() * ROOM_CHARS.length)];
    }
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

function getShareUrl(req, roomCode) {
  const host = req ? req.headers.host : `localhost:${PORT}`;
  const protocol = req && req.headers['x-forwarded-proto'] ? req.headers['x-forwarded-proto'] : 'http';
  return `${protocol}://${host}/?room=${roomCode}`;
}

// Room cleanup
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    const finishedTimeout = room.status === 'finished' && now - room.lastActivity > 30 * 60 * 1000;
    const inactiveTimeout = now - room.lastActivity > 2 * 60 * 60 * 1000;
    if (finishedTimeout || inactiveTimeout) {
      rooms.delete(code);
    }
  }
}, 60 * 1000);

// === COMBO VALIDATOR ===

function isJoker(cardId) {
  return cardId === 'JOK1' || cardId === 'JOK2';
}

function detectCombo(cardIds) {
  const cards = [...cardIds];
  const jokers = cards.filter(isJoker);
  const normals = cards.filter(c => !isJoker(c));
  const jokerCount = jokers.length;

  if (cards.length === 0) return null;

  // === SINGLE ===
  if (cards.length === 1) {
    if (jokerCount === 1) {
      return { comboType: COMBO_TYPES.SINGLE, rank: 14, cards, displayRank: 'JOK' };
    }
    return { comboType: COMBO_TYPES.SINGLE, rank: getCardValue(cards[0]), cards, displayRank: getCardRank(cards[0]) };
  }

  // === PAIR (2 cards) ===
  if (cards.length === 2) {
    if (jokerCount === 2) {
      return { comboType: COMBO_TYPES.PAIR, rank: 14, cards, displayRank: 'JOKER' };
    }
    if (jokerCount === 1) {
      // Joker + single = ZA (three of a kind) — NO, Joker+Pair=ZA. Joker+Single for 2 cards...
      // Actually: 2 cards, 1 joker, 1 normal → this is a PAIR (joker acts as duplicate)
      // Wait, re-reading rules: "Joker + Pair → ZA" means joker + 2 same rank = ZA (3 cards)
      // For 2 cards with 1 joker: "Joker alone → highest single" doesn't apply here
      // 2 cards: 1 joker + 1 normal = pair (joker matches the normal card's rank)
      const r = getCardValue(normals[0]);
      return { comboType: COMBO_TYPES.PAIR, rank: r, cards, displayRank: getCardRank(normals[0]) };
    }
    // 2 normals
    const r0 = getCardRank(normals[0]);
    const r1 = getCardRank(normals[1]);
    if (r0 === r1) {
      return { comboType: COMBO_TYPES.PAIR, rank: getCardValue(normals[0]), cards, displayRank: r0 };
    }
    // Not a pair — could be invalid or a 2-card straight? Straights need 4+.
    return null;
  }

  // === ZA (3 cards, three of a kind) ===
  if (cards.length === 3) {
    const normalRanks = normals.map(getCardRank);
    const uniqueRanks = [...new Set(normalRanks)];

    // Check for ZA first
    if (jokerCount <= 1 && uniqueRanks.length === 1 && normals.length + jokerCount === 3) {
      return { comboType: COMBO_TYPES.ZA, rank: getCardValue(normals[0]), cards, displayRank: normalRanks[0] };
    }

    // Check for straight (need 4+, so 3 cards can't be straight)
    // 3 cards can't be anything else valid
    return null;
  }

  // === PO (4 cards, four of a kind) ===
  if (cards.length === 4) {
    const normalRanks = normals.map(getCardRank);
    const uniqueRanks = [...new Set(normalRanks)];

    // 4 same rank (no jokers)
    if (jokerCount === 0 && uniqueRanks.length === 1) {
      return { comboType: COMBO_TYPES.PO, rank: getCardValue(normals[0]), cards, displayRank: normalRanks[0] };
    }
    // 3 same rank + 1 joker
    if (jokerCount === 1 && uniqueRanks.length === 1 && normals.length === 3) {
      return { comboType: COMBO_TYPES.PO, rank: getCardValue(normals[0]), cards, displayRank: normalRanks[0] };
    }

    // Could be a straight (4+ cards)
    const straightResult = detectStraight(normals, jokerCount);
    if (straightResult) {
      return { comboType: COMBO_TYPES.STRAIGHT, rank: straightResult.topValue, cards, length: cards.length, displayRank: straightResult.display };
    }

    return null;
  }

  // === 5 cards: could be PO+joker (invalid, PO is 4), straight, or check for PO inside ===
  // Actually PO is exactly 4 of a kind. 5 cards can't be PO.

  // === 6 cards: check for VANGOG ===
  if (cards.length === 6) {
    const vangogResult = detectVangog(normals, jokerCount);
    if (vangogResult) {
      return { comboType: COMBO_TYPES.VANGOG, rank: vangogResult.topValue, cards, displayRank: vangogResult.display };
    }
  }

  // === STRAIGHT (4+ cards) ===
  if (cards.length >= 4) {
    const straightResult = detectStraight(normals, jokerCount);
    if (straightResult) {
      return { comboType: COMBO_TYPES.STRAIGHT, rank: straightResult.topValue, cards, length: cards.length, displayRank: straightResult.display };
    }
  }

  return null;
}

function detectStraight(normals, jokerCount) {
  // 2, 3, Joker cannot be ranked cards in a straight
  for (const c of normals) {
    const r = getCardRank(c);
    if (r === '2' || r === '3') return null;
  }

  const values = normals.map(c => STRAIGHT_RANK_VALUE[getCardRank(c)]).filter(v => v !== undefined);
  if (values.length !== normals.length) return null; // had invalid ranks

  // Check for duplicate values among normals
  if (new Set(values).size !== values.length) return null;

  values.sort((a, b) => a - b);

  const totalCards = normals.length + jokerCount;
  if (totalCards < 4) return null;

  // Try to fill gaps with jokers
  let jokersNeeded = 0;
  for (let i = 1; i < values.length; i++) {
    const gap = values[i] - values[i - 1] - 1;
    if (gap < 0) return null; // duplicate
    jokersNeeded += gap;
  }

  if (jokersNeeded > jokerCount) return null;

  // Total length should match: values covered from min to max, plus any jokers extending
  const span = values[values.length - 1] - values[0] + 1;
  const neededForSpan = span - values.length;
  if (neededForSpan > jokerCount) return null;

  // The remaining jokers (after filling internal gaps) can extend the straight
  // But the total cards played must all be accounted for
  // totalCards = span + remaining jokers used to extend
  const remainingJokers = jokerCount - neededForSpan;
  const actualLength = span + remainingJokers;

  if (actualLength !== totalCards) return null;

  // The top value of the straight
  const topValue = values[values.length - 1] + remainingJokers;
  // Make sure extended values are still valid straight ranks (max A = 11)
  if (topValue > 11) return null;

  // Build display
  const bottomValue = values[0];
  const valToRank = {};
  for (const [rank, val] of Object.entries(STRAIGHT_RANK_VALUE)) {
    valToRank[val] = rank;
  }
  const display = `${valToRank[bottomValue] || bottomValue}-${valToRank[topValue] || topValue}`;

  return { topValue, display };
}

function detectVangog(normals, jokerCount) {
  if (normals.length + jokerCount !== 6) return null;

  // Need 3 consecutive pairs
  const rankCounts = {};
  for (const c of normals) {
    const r = getCardRank(c);
    rankCounts[r] = (rankCounts[r] || 0) + 1;
  }

  const ranksPresent = Object.keys(rankCounts).sort((a, b) => RANK_VALUE[a] - RANK_VALUE[b]);

  // Try all possible sequences of 3 consecutive ranks
  for (let startIdx = 0; startIdx < RANKS.length - 2; startIdx++) {
    const r1 = RANKS[startIdx];
    const r2 = RANKS[startIdx + 1];
    const r3 = RANKS[startIdx + 2];

    // 2, 3 can be part of vangog pairs
    const needed1 = Math.max(0, 2 - (rankCounts[r1] || 0));
    const needed2 = Math.max(0, 2 - (rankCounts[r2] || 0));
    const needed3 = Math.max(0, 2 - (rankCounts[r3] || 0));
    const totalNeeded = needed1 + needed2 + needed3;

    // Check that all normals belong to these three ranks
    const usedNormals = (rankCounts[r1] || 0) + (rankCounts[r2] || 0) + (rankCounts[r3] || 0);
    if (usedNormals + jokerCount !== 6) continue;
    if (usedNormals !== normals.length) continue;
    if (totalNeeded > jokerCount) continue;

    // Make sure no rank has more than 2
    if ((rankCounts[r1] || 0) > 2 || (rankCounts[r2] || 0) > 2 || (rankCounts[r3] || 0) > 2) continue;

    const topValue = RANK_VALUE[r3];
    return { topValue, display: `${r1}-${r1},${r2}-${r2},${r3}-${r3}` };
  }

  return null;
}

function validatePlay(selectedCards, tableCombo) {
  const combo = detectCombo(selectedCards);
  if (!combo) {
    return { valid: false, error: 'Неверная комбинация карт' };
  }

  // New trick — anything goes (except restrictions)
  if (!tableCombo) {
    return { valid: true, ...combo };
  }

  // VANGOG can only be played as opening move
  if (combo.comboType === COMBO_TYPES.VANGOG) {
    return { valid: false, error: 'ВанГог можно играть только первым ходом в раунде' };
  }

  // Table has VANGOG — only higher VANGOG beats it
  if (tableCombo.comboType === COMBO_TYPES.VANGOG) {
    if (combo.comboType !== COMBO_TYPES.VANGOG) {
      return { valid: false, error: 'ВанГог можно побить только старшим ВанГогом' };
    }
    if (combo.rank <= tableCombo.rank) {
      return { valid: false, error: 'ВанГог должен быть старше' };
    }
    return { valid: true, ...combo };
  }

  // PO beats anything except VANGOG
  if (combo.comboType === COMBO_TYPES.PO) {
    if (tableCombo.comboType === COMBO_TYPES.PO) {
      if (combo.rank <= tableCombo.rank) {
        return { valid: false, error: 'ПО должно быть старше' };
      }
    }
    return { valid: true, ...combo };
  }

  // Table has PO — only higher PO beats it
  if (tableCombo.comboType === COMBO_TYPES.PO) {
    return { valid: false, error: 'ПО можно побить только старшим ПО' };
  }

  // ZA beats single/pair/straight
  if (combo.comboType === COMBO_TYPES.ZA) {
    if (tableCombo.comboType === COMBO_TYPES.ZA) {
      if (combo.rank <= tableCombo.rank) {
        return { valid: false, error: 'ЗА должно быть старше' };
      }
    }
    return { valid: true, ...combo };
  }

  // Table has ZA — only higher ZA or PO beats it
  if (tableCombo.comboType === COMBO_TYPES.ZA) {
    return { valid: false, error: 'ЗА можно побить только старшим ЗА или ПО' };
  }

  // Same type required for single/pair/straight
  if (combo.comboType !== tableCombo.comboType) {
    return { valid: false, error: `Нужно играть ${comboTypeName(tableCombo.comboType)}` };
  }

  // Straight length must match
  if (combo.comboType === COMBO_TYPES.STRAIGHT) {
    if (selectedCards.length !== tableCombo.cards.length) {
      return { valid: false, error: `Стрит должен быть длиной ${tableCombo.cards.length} карт` };
    }
  }

  // Higher rank required
  if (combo.rank <= tableCombo.rank) {
    return { valid: false, error: 'Комбинация должна быть старше' };
  }

  return { valid: true, ...combo };
}

function comboTypeName(type) {
  const names = {
    single: 'одиночную',
    pair: 'пару',
    straight: 'стрит',
    za: 'ЗА',
    po: 'ПО',
    vangog: 'ВанГог',
  };
  return names[type] || type;
}

function comboDisplayName(combo) {
  if (!combo) return '';
  const rankNames = {
    '4': 'четвёрок', '5': 'пятёрок', '6': 'шестёрок', '7': 'семёрок',
    '8': 'восьмёрок', '9': 'девяток', '10': 'десяток', 'J': 'вальтов',
    'Q': 'дам', 'K': 'королей', 'A': 'тузов', '2': 'двоек', '3': 'троек', 'JOK': 'джокеров', 'JOKER': 'джокеров'
  };
  const rankName = rankNames[combo.displayRank] || combo.displayRank;

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

// === GAME LOGIC ===

function dealCards(room) {
  const deck = shuffleDeck(createDeck());
  const activePlayers = room.players.filter(p => !p.disconnected);
  const n = activePlayers.length;

  room.hands = new Map();
  for (const p of activePlayers) {
    room.hands.set(p.id, []);
  }

  for (let i = 0; i < deck.length; i++) {
    const player = activePlayers[i % n];
    room.hands.get(player.id).push(deck[i]);
  }

  // Sort each hand
  for (const [id, hand] of room.hands) {
    room.hands.set(id, sortCards(hand));
  }
}

function findFirstPlayer(room) {
  let lowestValue = Infinity;
  let firstPlayerId = null;

  for (const [playerId, hand] of room.hands) {
    for (const card of hand) {
      const val = getCardValue(card);
      if (val < lowestValue) {
        lowestValue = val;
        firstPlayerId = playerId;
      }
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

  dealCards(room);

  const activePlayers = room.players.filter(p => !p.disconnected);
  const firstId = findFirstPlayer(room);

  // Build turn order starting from first player
  const firstIdx = activePlayers.findIndex(p => p.id === firstId);
  room.turnOrder = [];
  for (let i = 0; i < activePlayers.length; i++) {
    room.turnOrder.push(activePlayers[(firstIdx + i) % activePlayers.length].id);
  }
  room.turnIndex = 0;

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

  // Find next active player from turnIndex
  for (let i = 0; i < room.turnOrder.length; i++) {
    const idx = (room.turnIndex + i) % room.turnOrder.length;
    const id = room.turnOrder[idx];
    if (active.includes(id)) {
      room.turnIndex = idx;
      return id;
    }
  }
  return active[0];
}

function advanceTurn(room) {
  const active = getActivePlayersInTurnOrder(room);
  if (active.length === 0) return;

  let nextIdx = (room.turnIndex + 1) % room.turnOrder.length;
  for (let i = 0; i < room.turnOrder.length; i++) {
    const id = room.turnOrder[nextIdx];
    if (active.includes(id)) {
      room.turnIndex = nextIdx;
      return;
    }
    nextIdx = (nextIdx + 1) % room.turnOrder.length;
  }
}

function getPlayerInfo(room) {
  return room.players.map(p => ({
    id: p.id,
    nickname: p.nickname,
    cardCount: room.hands.has(p.id) ? room.hands.get(p.id).length : 0,
    isHost: p.isHost,
    disconnected: p.disconnected,
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
  };
}

function checkGameEnd(room) {
  const active = getActivePlayersInTurnOrder(room);
  if (active.length <= 1) {
    // Add remaining player as last place
    if (active.length === 1) {
      room.finishedPlayers.push(active[0]);
    }
    room.status = 'finished';
    room.lastActivity = Date.now();

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

  socket.on('create_room', ({ nickname, maxPlayers }) => {
    if (!nickname || nickname.trim().length === 0) {
      socket.emit('error', { message: 'Введите никнейм' });
      return;
    }

    // Leave any existing room
    leaveCurrentRoom(socket);

    const room = createRoom(socket.id, nickname.trim(), maxPlayers || 8);
    currentRoomCode = room.code;
    socket.join(room.code);

    const shareUrl = `/?room=${room.code}`;
    socket.emit('room_created', { roomCode: room.code, shareUrl });
    io.to(room.code).emit('room_updated', { players: getPlayerInfo(room) });
  });

  socket.on('join_room', ({ roomCode, nickname }) => {
    if (!nickname || nickname.trim().length === 0) {
      socket.emit('error', { message: 'Введите никнейм' });
      return;
    }

    const code = roomCode ? roomCode.toUpperCase().trim() : '';
    const room = rooms.get(code);

    if (!room) {
      socket.emit('error', { message: 'Комната не найдена' });
      return;
    }

    if (room.status !== 'lobby') {
      socket.emit('error', { message: 'Игра уже началась' });
      return;
    }

    if (room.players.filter(p => !p.disconnected).length >= room.maxPlayers) {
      socket.emit('error', { message: 'Комната заполнена' });
      return;
    }

    // Check if already in room
    if (room.players.some(p => p.id === socket.id)) {
      socket.emit('error', { message: 'Вы уже в комнате' });
      return;
    }

    leaveCurrentRoom(socket);

    room.players.push({ id: socket.id, nickname: nickname.trim(), isHost: false, disconnected: false });
    room.lastActivity = Date.now();
    currentRoomCode = room.code;
    socket.join(room.code);

    socket.emit('room_joined', { roomCode: room.code });
    io.to(room.code).emit('room_updated', { players: getPlayerInfo(room) });
  });

  socket.on('start_game', () => {
    const room = findRoomByPlayer(socket.id);
    if (!room) return;

    const player = room.players.find(p => p.id === socket.id);
    if (!player || !player.isHost) {
      socket.emit('error', { message: 'Только хост может начать игру' });
      return;
    }

    const activePlayers = room.players.filter(p => !p.disconnected);
    if (activePlayers.length < 3) {
      socket.emit('error', { message: 'Нужно минимум 3 игрока' });
      return;
    }

    startGame(room);

    // Send game_started to each player with their hand
    for (const p of activePlayers) {
      const sock = io.sockets.sockets.get(p.id);
      if (sock) {
        sock.emit('game_started', {
          yourHand: sortCards(room.hands.get(p.id)),
          currentPlayerId: getCurrentPlayerId(room),
          turnOrder: room.turnOrder,
          players: getPlayerInfo(room),
        });
      }
    }
  });

  socket.on('play_cards', ({ cardIds }) => {
    const room = findRoomByPlayer(socket.id);
    if (!room || room.status !== 'playing') return;

    const currentId = getCurrentPlayerId(room);
    if (socket.id !== currentId) {
      socket.emit('invalid_move', { reason: 'Сейчас не ваш ход' });
      return;
    }

    const hand = room.hands.get(socket.id);
    if (!hand) return;

    // Check player has these cards
    const handCopy = [...hand];
    for (const cid of cardIds) {
      const idx = handCopy.indexOf(cid);
      if (idx === -1) {
        socket.emit('invalid_move', { reason: 'У вас нет такой карты' });
        return;
      }
      handCopy.splice(idx, 1);
    }

    // Validate the play
    const result = validatePlay(cardIds, room.tableCombo);
    if (!result.valid) {
      socket.emit('invalid_move', { reason: result.error });
      return;
    }

    // Remove cards from hand
    for (const cid of cardIds) {
      const idx = hand.indexOf(cid);
      if (idx !== -1) hand.splice(idx, 1);
    }

    // Update table
    room.tableCombo = { cards: cardIds, comboType: result.comboType, rank: result.rank, displayRank: result.displayRank };
    room.passCount = 0;
    room.lastPlayerId = socket.id;
    room.lastActivity = Date.now();

    const player = room.players.find(p => p.id === socket.id);
    const displayName = comboDisplayName(result);

    io.to(room.code).emit('player_played', {
      playerId: socket.id,
      nickname: player.nickname,
      comboName: displayName,
      comboCards: cardIds,
      comboType: result.comboType,
    });

    // Check if player finished
    if (hand.length === 0) {
      room.finishedPlayers.push(socket.id);
      io.to(room.code).emit('player_finished', {
        playerId: socket.id,
        nickname: player.nickname,
        place: room.finishedPlayers.length,
      });

      const standings = checkGameEnd(room);
      if (standings) {
        io.to(room.code).emit('game_over', { standings });
        return;
      }
    }

    advanceTurn(room);

    // Send state update to all
    for (const p of room.players) {
      if (!p.disconnected) {
        const sock = io.sockets.sockets.get(p.id);
        if (sock) {
          sock.emit('state_update', buildStateUpdate(room, p.id));
        }
      }
    }
  });

  socket.on('pass_turn', () => {
    const room = findRoomByPlayer(socket.id);
    if (!room || room.status !== 'playing') return;

    const currentId = getCurrentPlayerId(room);
    if (socket.id !== currentId) {
      socket.emit('invalid_move', { reason: 'Сейчас не ваш ход' });
      return;
    }

    // Can't pass on new trick
    if (!room.tableCombo) {
      socket.emit('invalid_move', { reason: 'Вы должны сделать ход (новый раунд)' });
      return;
    }

    const player = room.players.find(p => p.id === socket.id);
    room.passCount++;
    room.lastActivity = Date.now();

    io.to(room.code).emit('player_passed', {
      playerId: socket.id,
      nickname: player.nickname,
    });

    const activePlayers = getActivePlayersInTurnOrder(room);

    // Check if all other active players passed
    if (room.passCount >= activePlayers.length - 1) {
      // Trick won by the last player who played
      // Find who played last (the one who put tableCombo)
      let trickWinnerId = null;
      // The trick winner is the player who set the current tableCombo
      // That's the player whose turn it was passCount ago
      // Actually, easier: it's the player who is NOT the one passing and hasn't passed
      // The winner is the current player minus passCount steps (the one who played last)
      // Let's find it: go back from current position
      for (let i = 1; i <= room.turnOrder.length; i++) {
        const idx = (room.turnIndex - i + room.turnOrder.length * 10) % room.turnOrder.length;
        const id = room.turnOrder[idx];
        if (activePlayers.includes(id) && id !== socket.id) {
          // Check if this player was the one who played (not passed)
          trickWinnerId = id;
          break;
        }
      }

      // If we can't determine, the first active non-passer wins
      // Actually simpler: after all pass, the last to play was the one who set tableCombo
      // We need to track who last played. Let's store it.
      if (!trickWinnerId) {
        trickWinnerId = activePlayers[0];
      }

      // Use stored lastPlayerId if available
      if (room.lastPlayerId && activePlayers.includes(room.lastPlayerId)) {
        trickWinnerId = room.lastPlayerId;
      }

      const winner = room.players.find(p => p.id === trickWinnerId);
      io.to(room.code).emit('trick_won', {
        playerId: trickWinnerId,
        nickname: winner ? winner.nickname : 'Unknown',
      });

      // Reset trick
      room.tableCombo = null;
      room.passCount = 0;

      // Winner leads next trick
      const winnerTurnIdx = room.turnOrder.indexOf(trickWinnerId);
      if (winnerTurnIdx !== -1) {
        room.turnIndex = winnerTurnIdx;
      }

      // If winner has finished (0 cards), advance to next active player
      if (room.finishedPlayers.includes(trickWinnerId) || !room.hands.get(trickWinnerId) || room.hands.get(trickWinnerId).length === 0) {
        advanceTurn(room);
      }
    } else {
      advanceTurn(room);
    }

    // Check game end
    const standings = checkGameEnd(room);
    if (standings) {
      io.to(room.code).emit('game_over', { standings });
      return;
    }

    // Send state update to all
    for (const p of room.players) {
      if (!p.disconnected) {
        const sock = io.sockets.sockets.get(p.id);
        if (sock) {
          sock.emit('state_update', buildStateUpdate(room, p.id));
        }
      }
    }
  });

  socket.on('play_again', () => {
    const room = findRoomByPlayer(socket.id);
    if (!room) return;

    const player = room.players.find(p => p.id === socket.id);
    if (!player || !player.isHost) {
      socket.emit('error', { message: 'Только хост может начать заново' });
      return;
    }

    // Reset room
    room.status = 'lobby';
    room.hands = new Map();
    room.turnOrder = [];
    room.turnIndex = 0;
    room.passCount = 0;
    room.tableCombo = null;
    room.standings = [];
    room.finishedPlayers = [];
    room.lastPlayerId = null;
    room.lastActivity = Date.now();

    // Reset disconnected status for players still connected
    for (const p of room.players) {
      const sock = io.sockets.sockets.get(p.id);
      if (!sock) {
        p.disconnected = true;
      } else {
        p.disconnected = false;
      }
    }
    room.players = room.players.filter(p => !p.disconnected);

    io.to(room.code).emit('back_to_lobby', { players: getPlayerInfo(room) });
  });

  socket.on('disconnect', () => {
    leaveCurrentRoom(socket);
  });

  function leaveCurrentRoom(sock) {
    const room = findRoomByPlayer(sock.id);
    if (!room) return;

    if (room.status === 'lobby') {
      // Remove player
      room.players = room.players.filter(p => p.id !== sock.id);
      sock.leave(room.code);

      if (room.players.length === 0) {
        rooms.delete(room.code);
        return;
      }

      // If host left, reassign
      if (!room.players.some(p => p.isHost)) {
        room.players[0].isHost = true;
      }

      io.to(room.code).emit('room_updated', { players: getPlayerInfo(room) });
    } else if (room.status === 'playing') {
      const player = room.players.find(p => p.id === sock.id);
      if (player) {
        player.disconnected = true;

        // If it was their turn, advance
        const currentId = getCurrentPlayerId(room);
        if (currentId === sock.id) {
          advanceTurn(room);
        }

        // Check game end
        const standings = checkGameEnd(room);
        if (standings) {
          io.to(room.code).emit('game_over', { standings });
          return;
        }

        // Send update
        for (const p of room.players) {
          if (!p.disconnected) {
            const s = io.sockets.sockets.get(p.id);
            if (s) {
              s.emit('state_update', buildStateUpdate(room, p.id));
            }
          }
        }
      }
    }

    currentRoomCode = null;
  }

});

server.listen(PORT, () => {
  console.log(`ZA Card Game server running on port ${PORT}`);
  console.log(`Open http://localhost:${PORT} to play`);
});
