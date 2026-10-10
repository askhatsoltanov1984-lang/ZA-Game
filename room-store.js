const fs = require('node:fs');
const path = require('node:path');

function loadRooms(file) {
  if (!fs.existsSync(file)) return new Map();
  const snapshot = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (snapshot.version !== 1 || !Array.isArray(snapshot.rooms)) throw new Error('Unsupported room snapshot');
  return new Map(snapshot.rooms.map(saved => {
    const room = {
      ...saved,
      players: saved.players.map(player => ({ ...player, disconnected: true })),
      hands: new Map(saved.hands),
      disconnectTimers: new Map(),
      turnTimer: null,
      turnSecondsLeft: 0,
      observers: [],
      queue: [],
    };
    return [room.code, room];
  }));
}

function saveRooms(file, rooms) {
  const snapshots = [...rooms.values()].map(room => {
    const { turnTimer, disconnectTimers, observers, queue, ...saved } = room;
    return { ...saved, hands: [...room.hands] };
  });
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.tmp`;
  const fd = fs.openSync(temporary, 'w', 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify({ version: 1, rooms: snapshots }));
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
  fs.renameSync(temporary, file);
}

module.exports = { loadRooms, saveRooms };
