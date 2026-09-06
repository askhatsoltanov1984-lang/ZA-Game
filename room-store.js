const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function loadRooms(file) {
  if (!fs.existsSync(file)) return new Map();
  // Do not silently discard a corrupt or unknown snapshot: fail startup for recovery.
  const snapshot = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (snapshot.version !== 2 || !Array.isArray(snapshot.rooms)) throw new Error('Unsupported room snapshot; migrate or restore a backup');
  if (crypto.createHash('sha256').update(JSON.stringify(snapshot.rooms)).digest('hex') !== snapshot.checksum) throw new Error('Room snapshot checksum mismatch');
  return new Map(snapshot.rooms.map(saved => {
    if (!/^ZA-[A-Z2-9]{4}$/.test(saved.code) || !Array.isArray(saved.players) || saved.players.length > 8 || !Array.isArray(saved.hands) || !['lobby', 'playing', 'finished'].includes(saved.status)) throw new Error('Invalid room snapshot');
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
  }).filter(([, room]) => Date.now() - room.lastActivity <= 2 * 60 * 60 * 1000));
}

function saveRooms(file, rooms) {
  const snapshots = [...rooms.values()].map(room => {
    const { turnTimer, disconnectTimers, observers, queue, ...saved } = room;
    return { ...saved, hands: [...room.hands] };
  });
  const payload = JSON.stringify({ version: 2, checksum: crypto.createHash('sha256').update(JSON.stringify(snapshots)).digest('hex'), rooms: snapshots });
  // Bound disk use, including current, previous and temporary snapshots.
  if (Buffer.byteLength(payload) > 32 * 1024 * 1024) throw new Error('Snapshot size limit exceeded');
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const temporary = `${file}.tmp`;
  const fd = fs.openSync(temporary, 'w', 0o600);
  try { fs.writeFileSync(fd, payload); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  if (fs.existsSync(file)) {
    const previousTemporary = `${file}.previous.tmp`;
    fs.copyFileSync(file, previousTemporary);
    fs.chmodSync(previousTemporary, 0o600);
    const previous = fs.openSync(previousTemporary, 'r');
    try { fs.fsyncSync(previous); } finally { fs.closeSync(previous); }
    fs.renameSync(previousTemporary, `${file}.previous`);
  }
  fs.renameSync(temporary, file);
  const directory = fs.openSync(dir, 'r');
  try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
}
module.exports = { loadRooms, saveRooms };
