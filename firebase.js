import { initializeApp } from 'firebase/app';
import { getAnalytics, isSupported, logEvent } from 'firebase/analytics';
import { getAuth, signInAnonymously } from 'firebase/auth';
import {
  collection,
  doc,
  getDoc,
  getDocs,
  getFirestore,
  onSnapshot,
  runTransaction,
  serverTimestamp,
  setDoc,
  writeBatch,
} from 'firebase/firestore';

const firebaseConfig = {
  apiKey: 'AIzaSyBM3cGuK8maVUb2gPNpKBhjOVZatB3bG-8',
  authDomain: 'carrinho-d139f.firebaseapp.com',
  projectId: 'carrinho-d139f',
  storageBucket: 'carrinho-d139f.firebasestorage.app',
  messagingSenderId: '911696908570',
  appId: '1:911696908570:web:3b72b7bbcbd415de635ca3',
  measurementId: 'G-12CE1ZQ8DP',
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const analyticsReady = isSupported()
  .then((supported) => supported ? getAnalytics(app) : null)
  .catch(() => null);

let anonymousUserRequest;

async function getAnonymousPlayer() {
  if (!anonymousUserRequest) {
    anonymousUserRequest = signInAnonymously(auth)
      .then(({ user }) => user)
      .catch((error) => {
        anonymousUserRequest = null;
        console.warn('Firebase Auth indisponível; o progresso ficará salvo localmente.', error);
        return null;
      });
  }
  return anonymousUserRequest;
}

export async function loadFirebasePlayer() {
  const user = await getAnonymousPlayer();
  if (!user) return null;

  try {
    const playerRef = doc(db, 'players', user.uid);
    const playerSnapshot = await getDoc(playerRef);
    if (playerSnapshot.exists()) {
      await setDoc(playerRef, { lastSeenAt: serverTimestamp() }, { merge: true });
      return { ...playerSnapshot.data(), uid: user.uid };
    }

    const newPlayer = {
      playerId: user.uid,
      createdAt: serverTimestamp(),
      lastSeenAt: serverTimestamp(),
      gamesPlayed: 0,
      totalCoins: 0,
      bestScore: 0,
      bestDistance: 0,
    };
    await setDoc(playerRef, newPlayer);
    return { ...newPlayer, uid: user.uid };
  } catch (error) {
    console.warn('Firestore indisponível; o progresso ficará salvo localmente.', error);
    return null;
  }
}

export async function saveFirebaseRun(run) {
  const user = await getAnonymousPlayer();
  if (!user) return null;

  const playerRef = doc(db, 'players', user.uid);
  const runRef = doc(collection(db, 'players', user.uid, 'runs'));
  const cleanRun = {
    score: Math.max(0, Math.floor(Number(run.score) || 0)),
    distance: Math.max(0, Math.floor(Number(run.distance) || 0)),
    coins: Math.max(0, Math.floor(Number(run.coins) || 0)),
    dodges: Math.max(0, Math.floor(Number(run.dodges) || 0)),
    hits: Math.max(0, Math.floor(Number(run.hits) || 0)),
    maxSpeed: Math.max(0, Math.floor(Number(run.maxSpeed) || 0)),
  };

  try {
    return await runTransaction(db, async (transaction) => {
      const playerSnapshot = await transaction.get(playerRef);
      const current = playerSnapshot.exists() ? playerSnapshot.data() : {};
      const previousBestDistance = Number(current.bestDistance) || 0;
      const bestDistance = Math.max(previousBestDistance, cleanRun.distance);
      const bestScore = Math.max(Number(current.bestScore) || 0, cleanRun.score);

      transaction.set(playerRef, {
        playerId: user.uid,
        createdAt: current.createdAt || serverTimestamp(),
        lastSeenAt: serverTimestamp(),
        lastPlayedAt: serverTimestamp(),
        gamesPlayed: (Number(current.gamesPlayed) || 0) + 1,
        totalCoins: (Number(current.totalCoins) || 0) + cleanRun.coins,
        bestScore,
        bestDistance,
      }, { merge: true });
      transaction.set(runRef, { ...cleanRun, createdAt: serverTimestamp() });

      return {
        uid: user.uid,
        bestScore,
        bestDistance,
        isNewBestDistance: cleanRun.distance > previousBestDistance,
      };
    });
  } catch (error) {
    console.warn('Não foi possível sincronizar esta partida com o Firestore.', error);
    return null;
  }
}

const ROOM_CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const MULTIPLAYER_START_X = Object.freeze([-6.1, -3.7, -1.2, 1.2, 3.7, 6.1]);

function generateRoomCode() {
  let code = '';
  for (let i = 0; i < 6; i++) code += ROOM_CODE_CHARS[Math.floor(Math.random() * ROOM_CODE_CHARS.length)];
  return code;
}

function multiplayerPlayerId() {
  const storageKey = 'carrinho-multiplayer-id';
  try {
    let id = sessionStorage.getItem(storageKey);
    if (!id) {
      id = globalThis.crypto?.randomUUID?.() || `p${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
      sessionStorage.setItem(storageKey, id);
    }
    return id;
  } catch {
    return globalThis.crypto?.randomUUID?.() || `p${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
  }
}

function initialRoomPlayer() {
  return {
    ready: true, x: 0, distance: 0, speed: 0, score: 0,
    alive: true, ping: serverTimestamp(),
  };
}

export async function createMultiplayerRoom() {
  const playerId = multiplayerPlayerId();
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = generateRoomCode();
    const roomRef = doc(db, 'rooms', code);
    const created = await runTransaction(db, async (transaction) => {
      const snapshot = await transaction.get(roomRef);
      if (snapshot.exists()) return false;
      transaction.set(roomRef, {
        createdAt: serverTimestamp(), status: 'waiting', hostId: playerId,
        playerIds: [playerId], winner: null, rematch: {},
      });
      transaction.set(doc(db, 'rooms', code, 'players', playerId), initialRoomPlayer());
      return true;
    });
    if (created) return { code, playerId, role: 'host' };
  }
  throw new Error('unavailable');
}

export async function joinMultiplayerRoom(rawCode) {
  const playerId = multiplayerPlayerId();
  const code = String(rawCode || '').trim().toUpperCase();
  if (code.length !== 6) throw new Error('not-found');
  const roomRef = doc(db, 'rooms', code);
  const playerRef = doc(db, 'rooms', code, 'players', playerId);
  return runTransaction(db, async (transaction) => {
    const snapshot = await transaction.get(roomRef);
    if (!snapshot.exists()) throw new Error('not-found');
    const room = snapshot.data();
    const playerIds = Array.isArray(room.playerIds) ? room.playerIds : [];
    const isReturningPlayer = playerIds.includes(playerId);
    if (room.status !== 'waiting') throw new Error('unavailable');
    if (!isReturningPlayer && playerIds.length >= 6) throw new Error('full');
    if (!isReturningPlayer) {
      transaction.update(roomRef, { playerIds: [...playerIds, playerId], rematch: {} });
      transaction.set(playerRef, initialRoomPlayer());
    }
    return { code, playerId, role: room.hostId === playerId ? 'host' : 'guest', status: room.status };
  });
}

export async function startMultiplayerRoom(code, hostId) {
  const roomRef = doc(db, 'rooms', code);
  return runTransaction(db, async (transaction) => {
    const snapshot = await transaction.get(roomRef);
    if (!snapshot.exists()) throw new Error('not-found');
    const room = snapshot.data();
    if (room.hostId !== hostId) throw new Error('not-host');
    if (room.status !== 'waiting') throw new Error('unavailable');
    const playerIds = room.playerIds || [];
    if (playerIds.length < 2) throw new Error('need-players');
    const playerRefs = playerIds.map((id) => doc(db, 'rooms', code, 'players', id));
    const playerSnapshots = await Promise.all(playerRefs.map((playerRef) => transaction.get(playerRef)));
    if (playerSnapshots.some((player) => !player.exists())) throw new Error('unavailable');
    playerRefs.forEach((playerRef, seat) => transaction.set(playerRef, {
      ready: true, x: MULTIPLAYER_START_X[seat] ?? 0, distance: 0,
      speed: 17, score: 0, alive: true, ping: serverTimestamp(),
    }, { merge: true }));
    transaction.update(roomRef, { status: 'playing', winner: null, rematch: {} });
    return true;
  });
}

export async function requestMultiplayerRematch(code, playerId) {
  const roomRef = doc(db, 'rooms', code);
  return runTransaction(db, async (transaction) => {
    const snapshot = await transaction.get(roomRef);
    if (!snapshot.exists()) throw new Error('not-found');
    const room = snapshot.data();
    if (room.status !== 'finished' || !(room.playerIds || []).includes(playerId)) throw new Error('unavailable');
    transaction.update(roomRef, { rematch: { ...(room.rematch || {}), [playerId]: true } });
    return true;
  });
}

export async function startMultiplayerRematch(code, hostId) {
  const roomRef = doc(db, 'rooms', code);
  return runTransaction(db, async (transaction) => {
    const snapshot = await transaction.get(roomRef);
    if (!snapshot.exists()) throw new Error('not-found');
    const room = snapshot.data();
    if (room.hostId !== hostId) throw new Error('not-host');
    const playerIds = room.playerIds || [];
    if (room.status !== 'finished') return false;
    if (playerIds.length < 2) throw new Error('need-players');
    const playerRefs = playerIds.map((id) => doc(db, 'rooms', code, 'players', id));
    const playerSnapshots = await Promise.all(playerRefs.map((playerRef) => transaction.get(playerRef)));
    if (playerSnapshots.some((player) => !player.exists())) throw new Error('unavailable');
    playerRefs.forEach((playerRef, seat) => transaction.set(playerRef, {
      ready: true, x: MULTIPLAYER_START_X[seat] ?? 0, distance: 0,
      speed: 17, score: 0, alive: true, ping: serverTimestamp(),
    }, { merge: true }));
    transaction.update(roomRef, { status: 'playing', winner: null, rematch: {} });
    return true;
  });
}

export async function finishMultiplayerRoom(code, winner) {
  const roomRef = doc(db, 'rooms', code);
  return runTransaction(db, async (transaction) => {
    const snapshot = await transaction.get(roomRef);
    if (!snapshot.exists() || snapshot.data().status !== 'playing') return false;
    transaction.update(roomRef, { status: 'finished', winner, rematch: {} });
    return true;
  });
}

export function listenMultiplayerRoom(code, callback) {
  let room = null;
  let players = [];
  let roomReady = false;
  let playersReady = false;
  const publish = () => { if (roomReady && playersReady) callback(room, players); };
  const unsubscribeRoom = onSnapshot(doc(db, 'rooms', code), (snapshot) => {
    room = snapshot.exists() ? snapshot.data() : null;
    roomReady = true;
    publish();
  }, () => callback(null, []));
  const unsubscribePlayers = onSnapshot(collection(db, 'rooms', code, 'players'), (snapshot) => {
    players = snapshot.docs.map((player) => ({ id: player.id, ...player.data() }));
    playersReady = true;
    publish();
  }, () => callback(null, []));
  return () => { unsubscribeRoom(); unsubscribePlayers(); };
}

export async function updateMultiplayerPlayer(code, playerId, state) {
  try {
    await setDoc(doc(db, 'rooms', code, 'players', playerId), { ...state, ping: serverTimestamp() }, { merge: true });
  } catch (error) {
    console.debug('Sincronização multiplayer ignorada.', error);
  }
}

export async function leaveMultiplayerRoom(code, role, participantId = multiplayerPlayerId()) {
  try {
    const roomRef = doc(db, 'rooms', code);
    if (role === 'host') {
      await runTransaction(db, async (transaction) => {
        const snapshot = await transaction.get(roomRef);
        if (snapshot.exists()) transaction.update(roomRef, { status: 'closed', winner: null, rematch: {} });
      });
      const playerSnapshot = await getDocs(collection(db, 'rooms', code, 'players'));
      const batch = writeBatch(db);
      playerSnapshot.docs.forEach((player) => batch.delete(player.ref));
      batch.delete(roomRef);
      await batch.commit();
      return;
    }
    await runTransaction(db, async (transaction) => {
      const snapshot = await transaction.get(roomRef);
      if (!snapshot.exists()) return;
      const room = snapshot.data();
      if (room.status === 'closed') return;
      const playerRef = doc(db, 'rooms', code, 'players', participantId);
      if (room.status === 'playing') {
        transaction.set(playerRef, { ready: true, alive: false, ping: serverTimestamp() }, { merge: true });
        return;
      }
      const playerIds = (room.playerIds || []).filter((id) => id !== participantId);
      transaction.update(roomRef, { playerIds, rematch: {} });
      if (room.status !== 'finished') transaction.delete(doc(db, 'rooms', code, 'players', participantId));
    });
  } catch (error) {
    console.debug('Saída da sala ignorada.', error);
  }
}

export function trackFirebaseEvent(name, parameters = {}) {
  void analyticsReady.then((analytics) => {
    if (!analytics) return;
    try { logEvent(analytics, name, parameters); }
    catch (error) { console.debug('Evento do Analytics ignorado.', error); }
  });
}
