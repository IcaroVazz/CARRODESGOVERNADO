import { initializeApp } from 'firebase/app';
import { getAnalytics, isSupported, logEvent } from 'firebase/analytics';
import { getAuth, signInAnonymously } from 'firebase/auth';
import {
  collection,
  doc,
  getDoc,
  getFirestore,
  runTransaction,
  serverTimestamp,
  setDoc,
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

export function trackFirebaseEvent(name, parameters = {}) {
  void analyticsReady.then((analytics) => {
    if (!analytics) return;
    try { logEvent(analytics, name, parameters); }
    catch (error) { console.debug('Evento do Analytics ignorado.', error); }
  });
}
