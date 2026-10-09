import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import {
  createMultiplayerRoom,
  finishMultiplayerRoom,
  joinMultiplayerRoom,
  leaveMultiplayerRoom,
  listenMultiplayerRoom,
  loadFirebasePlayer,
  MULTIPLAYER_START_X,
  requestMultiplayerRematch,
  saveFirebaseRun,
  startMultiplayerRematch,
  startMultiplayerRoom,
  trackFirebaseEvent,
  updateMultiplayerPlayer,
} from './firebase.js';

const $ = (id) => document.getElementById(id);
const clamp = THREE.MathUtils.clamp;
const lerp = THREE.MathUtils.lerp;
const damp = (a, b, lambda, dt) => THREE.MathUtils.damp(a, b, lambda, dt);
const random = (a, b) => a + Math.random() * (b - a);
const choose = (values) => values[Math.floor(Math.random() * values.length)];
const slope = 0.055;
const laneX = [-4.8, 0, 4.8];
const ROAD_WIDTH = 18;
const SEGMENT_LENGTH = 54;
const SEGMENT_COUNT = 6;
const MAX_COLLISIONS = 1;
const MP_SYNC_INTERVAL = .16;
const MP_MAX_EXTRAPOLATION = .25;
const number = (n) => Math.floor(n).toLocaleString('pt-BR');

const COLORS = {
  ink: 0x173957, deep: 0x24577d, road: 0x405a73, asphalt: 0x657d94,
  cream: 0xf0f8ff, orange: 0x2788d3, yellow: 0xe4f5ff, mint: 0x80d6df,
  coral: 0x73aee4, blue: 0x337fc4, lilac: 0x98b6dd, white: 0xf9fdff,
  metal: 0xd8e6f0, darkMetal: 0x758ea4, tire: 0x263a4d, wood: 0x7190a5,
  leaf: 0x5b9998, leaf2: 0x91c6bf, bark: 0x567488, sky: 0x82c7ef,
};

const gameRoot = $('game');
const canvas = $('world');
const ui = {
  menu: $('menu-overlay'), gameover: $('gameover-overlay'), hud: $('hud'),
  play: $('play-button'), restart: $('restart-button'), menuButton: $('menu-button'),
  sound: $('sound-toggle'), soundState: $('sound-state'), soundIcon: $('sound-icon'),
  phase: $('phase-label'), distance: $('distance'), speed: $('speed'), score: $('score'), coins: $('coins-collected'),
  best: $('best-score'), bestDistance: $('best-distance'), menuBest: $('menu-best'),
  zone: $('zone-name'), fill: $('distance-fill'), health: $('health'),
  comboBadge: $('combo-badge'), combo: $('combo'), powerBadge: $('powerup-badge'),
  powerName: $('powerup-name'), powerTime: $('powerup-time'), powerIcon: $('powerup-icon'),
  toast: $('toast'), sideRecord: $('side-record'), hints: $('controls-hint'),
  finalDistance: $('final-distance'), finalScore: $('final-score'),
  finalDodges: $('final-dodges'), finalHits: $('final-hits'), finalSpeed: $('final-speed'),
  newRecord: $('new-record'), run: $('run-number'), tip: $('bottom-tip'), bottomline: document.querySelector('.bottomline'), mobileControls: $('mobile-controls'),
  mpButton: $('mp-button'), mpMenu: $('mp-menu'), mpCreate: $('mp-create'), mpJoin: $('mp-join'), mpBack: $('mp-back'),
  mpLobby: $('mp-lobby'), mpCodeBlock: $('mp-code-block'), mpCode: $('mp-code'), mpCopy: $('mp-copy'), mpJoinBlock: $('mp-join-block'),
  mpCodeInput: $('mp-code-input'), mpJoinConfirm: $('mp-join-confirm'), mpStatus: $('mp-status'),
  mpLobbyPlayers: $('mp-lobby-players'), mpStart: $('mp-start'), mpLeave: $('mp-leave'),
  mpResult: $('mp-result'), mpResultTitle: $('mp-result-title'), mpResults: $('mp-results'),
  mpWinnerLine: $('mp-winner-line'), mpRematch: $('mp-rematch'), mpExit: $('mp-exit'), mpRematchStatus: $('mp-rematch-status'),
  mpScore: $('mp-score'), mpScorePlayers: $('mp-score-players'),
};

class AudioManager {
  constructor() { this.context = null; this.master = null; this.wind = null; this.windTone = null; this.enabled = true; }
  unlock() {
    if (!this.context) {
      const Context = window.AudioContext || window.webkitAudioContext;
      if (!Context) return;
      this.context = new Context();
      this.master = this.context.createGain(); this.master.gain.value = .42; this.master.connect(this.context.destination);
      this.wind = this.context.createGain(); this.wind.gain.value = 0; this.wind.connect(this.master);
      this.windTone = this.context.createOscillator(); this.windTone.type = 'triangle';
      const filter = this.context.createBiquadFilter(); filter.type = 'lowpass'; filter.frequency.value = 290;
      this.windTone.connect(filter); filter.connect(this.wind); this.windTone.start();
    }
    if (this.context.state === 'suspended') this.context.resume();
  }
  setEnabled(enabled) {
    this.enabled = enabled;
    if (this.master && this.context) this.master.gain.setTargetAtTime(enabled ? .42 : 0, this.context.currentTime, .03);
  }
  setMotion(speed, active) {
    if (!this.context || !this.wind) return;
    const t = this.context.currentTime;
    this.wind.gain.setTargetAtTime(active && this.enabled ? .015 + speed / 2200 : 0, t, .18);
    if (this.windTone) this.windTone.frequency.setTargetAtTime(68 + speed * 1.45, t, .14);
  }
  play(kind) {
    if (!this.enabled || !this.context || !this.master) return;
    const presets = {
      click: [520, .055, 'sine'], coin: [890, .10, 'sine'], power: [480, .20, 'triangle'],
      turbo: [185, .25, 'sawtooth'], hit: [105, .22, 'square'], gameover: [78, .5, 'triangle'],
      dodge: [710, .055, 'sine'], brake: [155, .09, 'sawtooth'],
    };
    const [frequency, duration, wave] = presets[kind] || presets.click;
    const now = this.context.currentTime;
    const osc = this.context.createOscillator(); const gain = this.context.createGain();
    osc.type = wave; osc.frequency.setValueAtTime(frequency, now);
    if (kind === 'power' || kind === 'coin' || kind === 'dodge') osc.frequency.exponentialRampToValueAtTime(frequency * 1.7, now + duration);
    else if (kind === 'hit' || kind === 'gameover') osc.frequency.exponentialRampToValueAtTime(frequency * .48, now + duration);
    gain.gain.setValueAtTime(kind === 'hit' ? .13 : .085, now);
    gain.gain.exponentialRampToValueAtTime(.001, now + duration);
    osc.connect(gain); gain.connect(this.master); osc.start(now); osc.stop(now + duration + .02);
  }
}

class CameraController {
  constructor(camera, player) {
    this.camera = camera; this.player = player; this.shake = 0; this.fov = 69;
    this.target = new THREE.Vector3(); this.lookTarget = new THREE.Vector3();
  }
  bump(amount = .4) { this.shake = Math.min(1.25, this.shake + amount); }
  update(dt, speed, active) {
    const p = this.player.position;
    const shakeX = (Math.random() - .5) * this.shake;
    const shakeY = (Math.random() - .5) * this.shake * .55;
    const target = this.target.set(p.x * .32 + shakeX, 4.6 + shakeY + (active ? Math.min(1.2, speed / 75) : 0), 10.7);
    this.camera.position.x = damp(this.camera.position.x, target.x, 3.4, dt);
    this.camera.position.y = damp(this.camera.position.y, target.y, 2.8, dt);
    this.camera.position.z = damp(this.camera.position.z, target.z, 2.6, dt);
    const look = this.lookTarget.set(p.x * .23, .9 + shakeY * .4, -8.5);
    this.camera.lookAt(look);
    const wantedFov = active ? 69 + clamp((speed - 17) / 24, 0, 1) * 12 : 69;
    this.fov = damp(this.fov, wantedFov, 2, dt);
    if (Math.abs(this.camera.fov - this.fov) > .001) {
      this.camera.fov = this.fov; this.camera.updateProjectionMatrix();
    }
    this.shake = Math.max(0, this.shake - dt * 2.1);
  }
}

class TrackGenerator {
  constructor(world, onPass) {
    this.world = world; this.onPass = onPass; this.segments = []; this.roadMaterial = asphaltMaterial();
    this.segmentMarking = {
      tileGeometry: new THREE.BoxGeometry(3.45, .018, .07),
      tileMaterial: material(0xc0d7e5, .9, 0, 0, true),
      laneGeometry: new THREE.PlaneGeometry(.12, 3.15),
      laneMaterial: material(0xf8fcff, .82, 0, 0, true),
      edgeGeometry: new THREE.BoxGeometry(.085, .013, 7.4),
      edgePaint: material(0xf8fcff, .82, 0, 0, true),
      edgeCurb: material(0x9eb7c8, .94, 0, 0, true),
    };
    this.makeContinuousSurface();
    this.buildStaticHouses();
    for (let i = 0; i < SEGMENT_COUNT; i++) {
      const segment = this.createSegment(SEGMENT_LENGTH / 2 - SEGMENT_LENGTH * i);
      this.segments.push(segment);
    }
  }
  makeContinuousSurface() {
    const ground = new THREE.Group(); ground.rotation.x = -Math.asin(slope); this.world.add(ground); this.surfaceGroup = ground;
    const road = new THREE.Mesh(new THREE.PlaneGeometry(ROAD_WIDTH, 18000), this.roadMaterial);
    road.rotation.x = -Math.PI / 2; road.position.y = -.055; road.receiveShadow = true; ground.add(road);
    for (const side of [-1, 1]) {
      const sidewalk = new THREE.Mesh(new THREE.PlaneGeometry(3.5, 18000), material(0xd2e7f3, .86, 0, 0, true));
      sidewalk.rotation.x = -Math.PI / 2; sidewalk.position.set(side * 10.72, -.08, 0); ground.add(sidewalk);
      const verge = new THREE.Mesh(new THREE.PlaneGeometry(11, 18000), material(0x9dbcb9, 1, 0, 0, true));
      verge.rotation.x = -Math.PI / 2; verge.position.set(side * 18, -.14, 0); ground.add(verge);
      const neighborhoodGround = new THREE.Mesh(new THREE.PlaneGeometry(61, 18000), material(0x8eafa9, 1, 0, 0, true));
      neighborhoodGround.rotation.x = -Math.PI / 2; neighborhoodGround.position.set(side * 54, -.19, 0); neighborhoodGround.receiveShadow = true; ground.add(neighborhoodGround);
      const curb = new THREE.Mesh(new THREE.BoxGeometry(.20, .23, 18000), material(0x9eb7c8, .94, 0, 0, true));
      curb.position.set(side * 9.04, .06, 0); ground.add(curb);
    }
  }
  buildStaticHouses() {
    // Houses live under the long, stationary ground instead of recycled road segments.
    // Each 108m chunk batches all house parts into a handful of instanced meshes.
    const chunkLength = 108;
    const courseLength = 18000;
    const chunkCount = Math.ceil(courseLength / chunkLength);
    const wallGeometry = new THREE.BoxGeometry(1, 1, 1);
    const baseGeometry = new THREE.BoxGeometry(1, 1, 1);
    const flatRoofGeometry = new THREE.BoxGeometry(1, 1, 1);
    const gableRoofGeometry = new THREE.ConeGeometry(1, 1, 4);
    const frameGeometry = new THREE.BoxGeometry(1.03, 1.12, .13);
    const paneGeometry = new THREE.BoxGeometry(.79, .88, .04);
    const doorGeometry = new THREE.BoxGeometry(.88, 1.85, .09);
    const wallMaterial = material(0xffffff, .92, 0, 0, true);
    const baseMaterial = material(0x789bb2, .94, 0, 0, true);
    const roofMaterial = material(0xffffff, .9, 0, 0, true);
    const trimMaterial = material(0xf8fcff, .7, 0, 0, true);
    const glassMaterial = material(0x63a9d0, .28, .06, 0x102b43, true);
    const doorMaterial = material(0x315f86, .88, 0, 0, true);
    const wallColors = [0xeaf6fd, 0xd2e9f5, 0xb9dcef, 0xf6fbff];
    const roofColors = [0x285c83, 0x397da8, 0x6fa8ce, 0xf5fbff];
    const dummy = new THREE.Object3D();
    const addInstances = (chunk, entries, geometry, mat, name) => {
      if (!entries.length) return;
      const mesh = new THREE.InstancedMesh(geometry, mat, entries.length);
      mesh.name = name; mesh.castShadow = false; mesh.receiveShadow = false;
      for (let i = 0; i < entries.length; i++) {
        const item = entries[i];
        dummy.position.set(item.x, item.y, item.z);
        dummy.rotation.set(0, item.rotationY, 0);
        dummy.scale.set(item.sx, item.sy, item.sz);
        dummy.updateMatrix(); mesh.setMatrixAt(i, dummy.matrix);
        if (item.color !== undefined) mesh.setColorAt(i, new THREE.Color(item.color));
      }
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      chunk.add(mesh);
    };

    for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex++) {
      const chunk = new THREE.Group();
      chunk.name = `fixed-houses-${chunkIndex}`;
      chunk.position.z = -courseLength / 2 + chunkLength * (chunkIndex + .5);
      const parts = { bases: [], walls: [], flatRoofs: [], gableRoofs: [], frames: [], panes: [], doors: [] };

      const addPart = (list, house, x, y, z, sx, sy, sz, localRotationY = 0, color) => {
        const c = Math.cos(house.rotationY), s = Math.sin(house.rotationY);
        list.push({
          x: house.x + (x * c + z * s) * house.scale,
          y: -.19 + y * house.scale,
          z: house.z + (-x * s + z * c) * house.scale,
          sx: sx * house.scale, sy: sy * house.scale, sz: sz * house.scale,
          rotationY: house.rotationY + localRotationY,
          color,
        });
      };

      for (let half = 0; half < 2; half++) {
        for (const side of [-1, 1]) {
          const homeCount = Math.random() < .62 ? 1 : 2;
          for (let home = 0; home < homeCount; home++) {
            const apartment = Math.random() < .38;
            const width = apartment ? random(9, 13) : random(6.5, 9.5);
            const depth = apartment ? random(8, 11) : random(6, 9);
            const floors = apartment ? THREE.MathUtils.randInt(2, 4) : THREE.MathUtils.randInt(1, 2);
            const floorHeight = apartment ? 2.35 : 2.65;
            const baseHeight = .28;
            const wallHeight = floors * floorHeight;
            const roofHeight = apartment ? .3 : random(1.05, 1.65);
            const house = {
              x: side * random(35, 68),
              z: -chunkLength / 2 + (half + .5) * (chunkLength / 2) + random(-18, 18),
              rotationY: (side === 1 ? -Math.PI / 2 : Math.PI / 2) + random(-.08, .08),
              scale: random(.88, 1.12),
            };
            addPart(parts.bases, house, 0, baseHeight / 2, 0, width + .42, baseHeight, depth + .42);
            addPart(parts.walls, house, 0, baseHeight + wallHeight / 2, 0, width, wallHeight, depth, 0, choose(wallColors));
            if (apartment) {
              addPart(parts.flatRoofs, house, 0, baseHeight + wallHeight + .12, 0, width + .32, .24, depth + .32, 0, choose(roofColors));
            } else {
              addPart(parts.gableRoofs, house, 0, baseHeight + wallHeight + roofHeight / 2, 0,
                width * .79, roofHeight, depth * .79, Math.PI / 4, choose(roofColors));
            }

            const columns = apartment ? 3 : 2;
            const addWindow = (x, y, z, rotationY) => {
              addPart(parts.frames, house, x, y, z, 1, 1, 1, rotationY);
              addPart(parts.panes, house, x + Math.sin(rotationY) * .09, y,
                z + Math.cos(rotationY) * .09, 1, 1, 1, rotationY);
            };
            for (let floor = 0; floor < floors; floor++) {
              const y = baseHeight + floor * floorHeight + floorHeight * .56;
              for (let column = 0; column < columns; column++) {
                const x = (column - (columns - 1) / 2) * width / (columns + .15);
                addWindow(x, y, depth / 2 + .055, 0);
                addWindow(x, y, -depth / 2 - .055, Math.PI);
              }
              const sideWindows = depth > 8.5 ? 2 : 1;
              for (let column = 0; column < sideWindows; column++) {
                const z = (column - (sideWindows - 1) / 2) * depth / (sideWindows + .1);
                addWindow(width / 2 + .055, y, z, Math.PI / 2);
                addWindow(-width / 2 - .055, y, z, -Math.PI / 2);
              }
            }
            const front = depth / 2 + .09;
            addPart(parts.doors, house, 0, baseHeight + .94, front, 1, 1, 1);
          }
        }
      }

      addInstances(chunk, parts.bases, baseGeometry, baseMaterial, 'house-foundations');
      addInstances(chunk, parts.walls, wallGeometry, wallMaterial, 'house-walls');
      addInstances(chunk, parts.flatRoofs, flatRoofGeometry, roofMaterial, 'house-flat-roofs');
      addInstances(chunk, parts.gableRoofs, gableRoofGeometry, roofMaterial, 'house-gable-roofs');
      addInstances(chunk, parts.frames, frameGeometry, trimMaterial, 'house-window-frames');
      addInstances(chunk, parts.panes, paneGeometry, glassMaterial, 'house-window-panes');
      addInstances(chunk, parts.doors, doorGeometry, doorMaterial, 'house-doors');
      this.surfaceGroup.add(chunk);
    }
  }
  createSegment(z) {
    const group = new THREE.Group();
    group.position.set(0, slope * z, z); group.rotation.x = -Math.asin(slope);
    const dummy = new THREE.Object3D();
    const markings = this.segmentMarking;
    const tileLines = new THREE.InstancedMesh(markings.tileGeometry, markings.tileMaterial, 10);
    tileLines.name = 'sidewalk-tile-lines'; tileLines.castShadow = false; tileLines.receiveShadow = false;
    let tileIndex = 0;
    for (const side of [-1, 1]) {
      for (let k = 0; k < 5; k++) {
        dummy.position.set(side * 10.72, .018, -SEGMENT_LENGTH / 2 + 5.5 + k * 10.4);
        dummy.rotation.set(0, 0, 0); dummy.scale.set(1, 1, 1); dummy.updateMatrix();
        tileLines.setMatrixAt(tileIndex++, dummy.matrix);
      }
    }
    tileLines.instanceMatrix.needsUpdate = true; group.add(tileLines);

    const laneMarks = new THREE.InstancedMesh(markings.laneGeometry, markings.laneMaterial, 7);
    laneMarks.name = 'road-center-marks'; laneMarks.castShadow = false; laneMarks.receiveShadow = false;
    for (let i = 0; i < 7; i++) {
      dummy.position.set(0, -.018, -SEGMENT_LENGTH / 2 + 4 + i * 8);
      dummy.rotation.set(-Math.PI / 2, 0, 0); dummy.scale.set(1, 1, 1); dummy.updateMatrix();
      laneMarks.setMatrixAt(i, dummy.matrix);
    }
    laneMarks.instanceMatrix.needsUpdate = true; group.add(laneMarks);

    const paintedEdges = new THREE.InstancedMesh(markings.edgeGeometry, markings.edgePaint, 4);
    const curbEdges = new THREE.InstancedMesh(markings.edgeGeometry, markings.edgeCurb, 2);
    paintedEdges.name = 'road-painted-edges'; curbEdges.name = 'road-curb-edges';
    paintedEdges.castShadow = false; paintedEdges.receiveShadow = false;
    curbEdges.castShadow = false; curbEdges.receiveShadow = false;
    let paintedIndex = 0; let curbIndex = 0;
    for (const x of [-8.58, 8.58]) {
      for (let i = 0; i < 3; i++) {
        dummy.position.set(x, -.01, -SEGMENT_LENGTH / 2 + 7 + i * 17);
        dummy.rotation.set(0, 0, 0); dummy.scale.set(1, 1, 1); dummy.updateMatrix();
        if (i % 2) curbEdges.setMatrixAt(curbIndex++, dummy.matrix);
        else paintedEdges.setMatrixAt(paintedIndex++, dummy.matrix);
      }
    }
    paintedEdges.instanceMatrix.needsUpdate = true; curbEdges.instanceMatrix.needsUpdate = true;
    group.add(paintedEdges, curbEdges);
    const decor = new THREE.Group(); group.add(decor);
    this.populateDecor(decor);
    this.world.add(group);
    return { group, decor };
  }
  populateDecor(decor) {
    for (const side of [-1, 1]) {
      const treeCount = Math.random() < .58 ? 1 : 2;
      for (let i = 0; i < treeCount; i++) {
        const z = random(-21, 21);
        const tree = createTree(); tree.position.set(side * random(14, 24), -.08, z); tree.scale.setScalar(random(.76, 1.2)); decor.add(tree);
      }
      if (Math.random() < .44) {
        const lamp = createStreetLamp(); lamp.position.set(side * 11.7, 0, random(-23, 23)); decor.add(lamp);
      }
      if (Math.random() < .22) {
        const car = createVehicle(choose(['car', 'van'])); car.position.set(side * random(13, 15), -.08, random(-21, 21)); car.rotation.y = side === 1 ? Math.PI : 0; decor.add(car);
      }
      if (Math.random() < .13) {
        const building = createStorefront(); building.position.set(side * random(22, 28), -.19, random(-19, 19)); building.rotation.y = side === 1 ? -Math.PI / 2 : Math.PI / 2; decor.add(building);
      }
      if (Math.random() < .3) {
        const hydrant = createHydrant(); hydrant.position.set(side * random(9.9, 11.3), 0, random(-21, 21)); decor.add(hydrant);
      }
      if (Math.random() < .26) {
        const bench = createBench(); bench.position.set(side * random(12, 14), 0, random(-22, 22)); bench.rotation.y = side === 1 ? -Math.PI / 2 : Math.PI / 2; decor.add(bench);
      }
    }
    if (Math.random() < .22) {
      const sign = createMarketSign(); sign.position.set(choose([-9.9, 9.9]), 0, random(-20, 20)); sign.rotation.y = sign.position.x > 0 ? Math.PI / 2 : -Math.PI / 2; decor.add(sign);
    }
  }
  update(dt, speed) {
    for (const segment of this.segments) {
      segment.group.position.z += speed * dt;
      if (segment.group.position.z > SEGMENT_LENGTH * 2.5) {
        const nextZ = Math.min(...this.segments.map((s) => s.group.position.z)) - SEGMENT_LENGTH;
        segment.group.position.z = nextZ; segment.group.position.y = slope * nextZ;
      }
    }
  }
}

class Cart {
  constructor({ procedural = true } = {}) {
    this.group = new THREE.Group(); this.wheels = []; this.reaction = new THREE.Group(); this.group.add(this.reaction);
    this.handleHalfWidth = .48; this.handleY = 1.16; this.handleZ = 1.29;
    this.riderWobbleTime = 0;
    if (procedural) {
      this.buildBasket(); this.buildFrame(); this.buildWheels();
    } else {
      this.proceduralBasket = null; this.proceduralFrame = null; this.proceduralNose = null;
    }
    this.buildRider(procedural);
    this.group.add(this.reaction);
    this.shadow = new THREE.Mesh(new THREE.CircleGeometry(1.43, 28), new THREE.MeshBasicMaterial({ color: 0x22342d, transparent: true, opacity: .19, depthWrite: false }));
    this.shadow.rotation.x = -Math.PI / 2; this.shadow.scale.set(1.0, 1.55, 1); this.shadow.position.set(0, -.02, .1); this.group.add(this.shadow);
    this.group.position.y = 0;
  }
  buildBasket() {
    const basket = new THREE.Group(); basket.position.y = .91;
    const topW = 1.8, topD = 1.34, lowW = 1.28, lowD = .91, h = .93;
    const bright = metal(COLORS.metal), dark = metal(COLORS.darkMetal);
    const cornersTop = [[-topW / 2, .38, -topD / 2], [topW / 2, .38, -topD / 2], [topW / 2, .38, topD / 2], [-topW / 2, .38, topD / 2]];
    const cornersLow = [[-lowW / 2, -.51, -lowD / 2], [lowW / 2, -.51, -lowD / 2], [lowW / 2, -.51, lowD / 2], [-lowW / 2, -.51, lowD / 2]];
    for (let i = 0; i < 4; i++) {
      const next = (i + 1) % 4;
      rodBetween(basket, new THREE.Vector3(...cornersTop[i]), new THREE.Vector3(...cornersTop[next]), .044, bright);
      rodBetween(basket, new THREE.Vector3(...cornersLow[i]), new THREE.Vector3(...cornersLow[next]), .035, dark);
      rodBetween(basket, new THREE.Vector3(...cornersLow[i]), new THREE.Vector3(...cornersTop[i]), .033, dark);
    }
    for (let i = 1; i < 8; i++) {
      const t = i / 8, x = lerp(-topW / 2, topW / 2, t);
      rodBetween(basket, new THREE.Vector3(x, -.49, -lowD / 2), new THREE.Vector3(x, .37, -topD / 2), .021, bright);
      rodBetween(basket, new THREE.Vector3(x, -.49, lowD / 2), new THREE.Vector3(x, .37, topD / 2), .021, bright);
    }
    for (let i = 1; i <= 5; i++) {
      const t = i / 6, zFront = lerp(-lowD / 2, -topD / 2, t), zBack = lerp(lowD / 2, topD / 2, t);
      const y = lerp(-.51, .38, t);
      rodBetween(basket, new THREE.Vector3(-lerp(lowW / 2, topW / 2, t), y, zFront), new THREE.Vector3(lerp(lowW / 2, topW / 2, t), y, zFront), .021, bright);
      rodBetween(basket, new THREE.Vector3(-lerp(lowW / 2, topW / 2, t), y, zBack), new THREE.Vector3(lerp(lowW / 2, topW / 2, t), y, zBack), .021, bright);
    }
    this.proceduralBasket = basket; this.reaction.add(basket);
    const nose = new THREE.Mesh(new THREE.BoxGeometry(.45, .12, .16), material(COLORS.orange, .44, .03));
    nose.position.set(0, .91, -.69); this.reaction.add(nose); this.proceduralNose = nose;
  }
  buildFrame() {
    const frameGroup = new THREE.Group(); this.proceduralFrame = frameGroup; this.reaction.add(frameGroup);
    const frame = metal(COLORS.darkMetal); const bright = metal(0xdbe2d6);
    for (const side of [-1, 1]) {
      rodBetween(frameGroup, new THREE.Vector3(side * .62, .36, .54), new THREE.Vector3(side * .93, .28, 1.13), .072, frame);
      rodBetween(frameGroup, new THREE.Vector3(side * .93, .28, 1.13), new THREE.Vector3(side * .86, .84, 1.34), .057, bright);
      rodBetween(frameGroup, new THREE.Vector3(side * .86, .84, 1.34), new THREE.Vector3(side * .86, 1.14, 1.28), .055, bright);
      rodBetween(frameGroup, new THREE.Vector3(side * .89, .3, .76), new THREE.Vector3(side * .89, .77, .79), .043, frame);
    }
    rodBetween(frameGroup, new THREE.Vector3(-.86, 1.13, 1.27), new THREE.Vector3(.86, 1.13, 1.27), .074, bright);
    const handle = new THREE.Mesh(new THREE.CylinderGeometry(.072, .072, 1.72, 8), material(COLORS.ink, .35));
    handle.rotation.z = Math.PI / 2; handle.position.set(0, 1.16, 1.29); frameGroup.add(handle);
    const footrest = new THREE.Mesh(new THREE.BoxGeometry(1.25, .11, .27), material(COLORS.darkMetal, .55));
    footrest.position.set(0, .33, -.67); frameGroup.add(footrest);
  }
  buildWheels() {
    const hub = metal(0xe1ddc5); const rim = metal(0x99aaa0); const tire = material(COLORS.tire, .94, 0, 0, true);
    for (const x of [-.97, .97]) for (const z of [-.83, .91]) {
      const wheelGroup = new THREE.Group(); wheelGroup.position.set(x, .29, z);
      const tireMesh = new THREE.Mesh(new THREE.TorusGeometry(.255, .087, 8, 16), tire); tireMesh.rotation.y = Math.PI / 2; wheelGroup.add(tireMesh);
      const hubMesh = new THREE.Mesh(new THREE.CylinderGeometry(.098, .098, .19, 10), hub); hubMesh.rotation.z = Math.PI / 2; wheelGroup.add(hubMesh);
      for (let spoke = 0; spoke < 6; spoke++) {
        const angle = spoke * Math.PI / 3;
        const line = new THREE.Mesh(new THREE.BoxGeometry(.17, .018, .018), rim);
        line.position.set(0, Math.sin(angle) * .15, Math.cos(angle) * .15); line.rotation.x = angle; wheelGroup.add(line);
      }
      this.wheels.push(wheelGroup); this.group.add(wheelGroup);
    }
  }
  removeProceduralCart() {
    for (const part of [this.proceduralBasket, this.proceduralFrame, this.proceduralNose]) {
      if (!part) continue;
      part.parent?.remove(part); disposeObject(part);
    }
    for (const wheel of this.wheels) { this.group.remove(wheel); disposeObject(wheel); }
    this.wheels.length = 0;
  }
  removeProceduralRider() {
    for (const part of this.proceduralRiderParts) { this.rider.remove(part); disposeObject(part); }
    this.proceduralRiderParts.length = 0;
  }
  buildRider(procedural = true) {
    const riderPivot = new THREE.Group(); riderPivot.position.set(0, this.handleY, this.handleZ); this.reaction.add(riderPivot);
    const rider = new THREE.Group();
    rider.position.set(0, .10 - this.handleY, 2.42 - this.handleZ);
    rider.rotation.x = .25;
    this.riderBaseRotation = rider.rotation.clone();
    rider.scale.setScalar(1.08);
    riderPivot.add(rider);

    if (!procedural) {
      this.rider = rider; this.riderPivot = riderPivot; this.riderBaseScale = rider.scale.clone();
      this.riderPivotBasePosition = riderPivot.position.clone(); this.proceduralRiderParts = [];
      return;
    }

    const skin = material(0xc98961, .86);
    const jersey = material(0xf07825, .76);
    const jerseyTrim = material(0xffdd79, .65);
    const pants = material(0x334b5a, .86);
    const shoe = material(0xeaf4f5, .72);
    const helmetShell = material(0xf0f4ef, .32, .12);
    const helmetRed = material(0xc72f45, .4, .08);
    const visor = material(0x18364a, .24, .18);

    // Narrow rounded torso, with a colored back panel visible from the chase camera.
    const torso = new THREE.Mesh(new THREE.CapsuleGeometry(.215, .30, 5, 12), jersey);
    torso.scale.set(1, 1, .82); torso.position.set(0, .56, .015); torso.rotation.x = .12; rider.add(torso);
    const backPanel = new THREE.Mesh(new THREE.SphereGeometry(1, 12, 8), jerseyTrim);
    backPanel.scale.set(.13, .22, .035); backPanel.position.set(0, .57, .194); rider.add(backPanel);
    const belt = new THREE.Mesh(new THREE.TorusGeometry(.175, .026, 6, 14), material(0x203b4c, .78));
    belt.position.set(0, .34, .02); belt.rotation.x = Math.PI / 2; rider.add(belt);

    const neck = new THREE.Mesh(new THREE.CapsuleGeometry(.085, .10, 3, 8), skin);
    neck.position.set(0, .88, -.035); neck.rotation.x = -.16; rider.add(neck);
    const head = new THREE.Mesh(new THREE.SphereGeometry(.205, 14, 10), skin);
    head.position.set(0, 1.045, -.105); rider.add(head);
    const helmet = new THREE.Mesh(new THREE.SphereGeometry(.255, 16, 12), helmetShell);
    helmet.scale.set(1, .88, 1.08); helmet.position.set(0, 1.105, -.11); rider.add(helmet);
    const helmetCrown = new THREE.Mesh(new THREE.SphereGeometry(.262, 14, 8, 0, Math.PI * 2, 0, Math.PI * .40), helmetRed);
    helmetCrown.scale.set(1, .72, 1.04); helmetCrown.position.set(0, 1.13, -.105); rider.add(helmetCrown);
    const helmetBand = new THREE.Mesh(new THREE.TorusGeometry(.226, .025, 6, 20), helmetRed);
    helmetBand.position.set(0, 1.095, -.11); helmetBand.rotation.x = Math.PI / 2 - .12; rider.add(helmetBand);
    const helmetVisor = new THREE.Mesh(new THREE.SphereGeometry(.19, 12, 7, 0, Math.PI, 0, Math.PI * .42), visor);
    helmetVisor.scale.set(1, .8, .42); helmetVisor.position.set(0, 1.065, -.303); helmetVisor.rotation.x = -.18; rider.add(helmetVisor);

    for (const side of [-1, 1]) {
      const hip = new THREE.Vector3(side * .12, .34, .02);
      const knee = new THREE.Vector3(side * .17, .25, .34);
      const ankle = new THREE.Vector3(side * .18, .15, .18);
      rodBetween(rider, hip, knee, .105, pants, 9);
      rodBetween(rider, knee, ankle, .078, pants, 9);
      const shoeMesh = new THREE.Mesh(new THREE.CapsuleGeometry(.073, .15, 4, 8), shoe);
      shoeMesh.position.set(side * .18, .12, .12); shoeMesh.rotation.x = Math.PI / 2; rider.add(shoeMesh);

      const shoulder = new THREE.Vector3(side * .19, .78, .005);
      const elbow = new THREE.Vector3(side * .34, .91, -.13);
      const handPoint = new THREE.Vector3(side * .46, 1.02, -.34);
      const shoulderCap = new THREE.Mesh(new THREE.SphereGeometry(.115, 10, 8), jersey);
      shoulderCap.position.copy(shoulder); rider.add(shoulderCap);
      rodBetween(rider, shoulder, elbow, .082, jersey, 9);
      rodBetween(rider, elbow, handPoint, .053, skin, 9);
      const wrist = new THREE.Mesh(new THREE.SphereGeometry(.062, 9, 7), skin);
      wrist.position.copy(handPoint); rider.add(wrist);
      const glove = new THREE.Mesh(new THREE.SphereGeometry(.068, 9, 7), jerseyTrim);
      glove.scale.set(1, .72, 1.1); glove.position.copy(handPoint).add(new THREE.Vector3(0, -.01, -.055)); rider.add(glove);
    }

    const chestMark = new THREE.Mesh(new THREE.SphereGeometry(.12, 10, 7), helmetRed);
    chestMark.scale.set(.56, .58, .22); chestMark.position.set(0, .62, -.178); rider.add(chestMark);
    this.rider = rider; this.riderJersey = jersey; this.riderHelmetAccent = helmetRed;
    this.riderPivot = riderPivot; this.riderBaseScale = rider.scale.clone();
    this.riderPivotBasePosition = riderPivot.position.clone(); this.proceduralRiderParts = [...rider.children];
  }
  update(dt, speed, steer, bump, active) {
    this.wheels.forEach((wheel, i) => { wheel.rotation.x += dt * speed * 1.7; wheel.rotation.z = steer * (i < 2 ? -.05 : .05); });
    this.reaction.rotation.z = damp(this.reaction.rotation.z, -steer * .12 + bump, 8, dt);
    this.reaction.rotation.x = damp(this.reaction.rotation.x, active ? Math.min(.045, speed * .0007) : 0, 3, dt);
    this.riderWobbleTime += dt * (active ? 1.2 : .75);
    const t = this.riderWobbleTime; const looseness = active ? 1 : .42;
    this.riderPivot.position.copy(this.riderPivotBasePosition);
    this.riderPivot.position.y += Math.sin(t * 6.4) * .018 * looseness;
    this.riderPivot.rotation.set(
      Math.sin(t * 5.4) * .17 * looseness + bump * .68,
      Math.sin(t * 6.2 + .9) * .21 * looseness + steer * .045,
      Math.sin(t * 4.2 + .4) * .15 * looseness + steer * .055 + bump * .22,
    );
    const squash = Math.sin(t * 8.1 + .6) * looseness;
    this.rider.scale.set(
      this.riderBaseScale.x * (1 - squash * .014),
      this.riderBaseScale.y * (1 + squash * .026),
      this.riderBaseScale.z * (1 - squash * .014),
    );
    if (this.characterFrames?.length) {
      const loopDuration = this.characterFrameDuration * this.characterFrames.length;
      this.characterFrameTime = (this.characterFrameTime + dt) % loopDuration;
      const nextFrame = Math.floor(this.characterFrameTime / this.characterFrameDuration);
      if (nextFrame !== this.characterFrameIndex) {
        this.characterFrames[this.characterFrameIndex].visible = false;
        this.characterFrames[nextFrame].visible = true;
        this.characterFrameIndex = nextFrame;
      }
    } else {
      this.characterMixer?.update(dt);
    }
    if (this.updateRiderPose) this.updateRiderPose();
  }
}

function installCharacterModel(cart, characterAsset, name) {
  if (!characterAsset || cart.group.userData.hasMainCharacter) return;
  const character = characterAsset.scene.clone(true);
  character.name = name;
  character.traverse((object) => {
    if (!object.isMesh) return;
    if (object.name.endsWith('_Gordin_baked_double_0')) object.visible = false;
    object.castShadow = false; object.receiveShadow = false;
  });
  const frameGroups = [];
  character.traverse((object) => {
    const match = object.name.match(/^Gordin_baked_(\d{4})$/);
    if (match) frameGroups.push({ index: Number(match[1]), object });
  });
  frameGroups.sort((a, b) => a.index - b.index);
  if (frameGroups.length > 1 && characterAsset.animations[0]) {
    // The export includes a closing snapshot at the clip boundary. Display
    // the preceding baked frames discretely so the character never fades out.
    cart.characterFrames = frameGroups.slice(0, -1).map(({ object }) => object);
    cart.characterFrameDuration = characterAsset.animations[0].duration / cart.characterFrames.length;
    cart.characterFrameTime = 0;
    cart.characterFrameIndex = 0;
    frameGroups.forEach(({ object }, index) => { object.visible = index === 0; });
  } else {
    const mixer = new THREE.AnimationMixer(character);
    for (const clip of characterAsset.animations) mixer.clipAction(clip).play();
    cart.characterMixer = mixer;
  }
  cart.group.add(character);
  cart.characterModel = character;
  cart.group.userData.hasMainCharacter = true;
}

class ObstacleManager {
  constructor(world, hooks) {
    this.world = world; this.hooks = hooks; this.entities = []; this.distanceToObstacle = 72; this.distanceToCoins = 27;
    this.distanceToPower = 118; this.lastSpawnDistance = 0; this.pools = new Map(); this.poolLimit = 2;
    this.obstacleModels = new Map(); this.obstacleRadii = new Map(); this.pickupModels = new Map();
  }
  setObstacleModel(kind, model, radius) {
    this.obstacleModels.set(kind, model); this.obstacleRadii.set(kind, radius);
  }
  setPickupModel(kind, model) {
    this.pickupModels.set(kind, model);
    const entities = [...this.entities, ...[...this.pools.values()].flat()];
    for (const entity of entities) {
      if (entity.type === 'obstacle' || entity.kind !== kind || entity.assetBacked) continue;
      entity.group.remove(entity.model); disposeObject(entity.model);
      entity.model = model.clone(true); entity.group.add(entity.model); entity.assetBacked = true;
    }
  }
  update(dt, distance, speed, difficulty, playerX, magnet) {
    if (distance >= this.distanceToObstacle && this.obstacleModels.size >= 3) {
      this.spawnWave(distance, difficulty);
      const baseGap = lerp(37, 19, difficulty / 4);
      this.distanceToObstacle = distance + random(baseGap * .79, baseGap * 1.24);
    }
    if (distance >= this.distanceToCoins) {
      this.spawnCollectibles(distance, difficulty);
      this.distanceToCoins = distance + random(36, 57);
    }
    if (distance >= this.distanceToPower) {
      this.spawnPowerup(distance);
      this.distanceToPower = distance + random(135, 195);
    }
    for (let i = this.entities.length - 1; i >= 0; i--) {
      const entity = this.entities[i];
      entity.group.position.z += speed * dt;
      entity.age += dt;
      if (entity.float) {
        entity.group.position.y = Math.sin(entity.age * 3) * .14;
        entity.model.rotation.y += dt * 1.2;
        if (entity.type === 'coin' && magnet && entity.group.position.z < 7 && entity.group.position.z > -56) {
          const horizontalPull = 20 + speed * .55;
          const forwardPull = 26 + speed * .8;
          entity.group.position.x = damp(entity.group.position.x, playerX, horizontalPull, dt);
          entity.group.position.z = damp(entity.group.position.z, 0, forwardPull, dt);
        }
      }
      if (entity.type === 'obstacle') {
        if (!entity.resolved && entity.group.position.z > 2.1) {
          entity.resolved = true; this.hooks.onDodge(entity.group.position.x, entity.kind);
        }
        if (!entity.resolved && Math.abs(entity.group.position.z) < .95 && Math.abs(entity.group.position.x - playerX) < entity.radius + .88) {
          entity.resolved = true; this.hooks.onCollision(entity.group.position.x, entity.kind);
        }
      } else if (!entity.resolved && Math.abs(entity.group.position.z) < 2.1 && Math.abs(entity.group.position.x - playerX) < (entity.type === 'coin' ? 1.45 : 1.7)) {
        entity.resolved = true; this.hooks.onCollect(entity.kind, entity.group.position.x, entity.type);
      }
      const leftScreen = entity.group.position.z > 13;
      const collected = entity.resolved && entity.type !== 'obstacle';
      if (leftScreen || collected) {
        this.recycle(entity); this.entities.splice(i, 1);
      }
    }
  }
  spawnWave(distance, difficulty) {
    let count = 1;
    if (difficulty > 1.1 && Math.random() < .31 + difficulty * .08) count = 2;
    if (difficulty > 2.8 && Math.random() < .22) count = 2;
    const lanes = THREE.MathUtils.randInt(0, 2);
    const occupied = count === 1 ? [lanes] : [lanes, (lanes + 1 + THREE.MathUtils.randInt(0, 1)) % 3];
    for (const lane of occupied) {
      const availableKinds = ['caixa', 'feno', 'pedra', 'cones'].filter((name) => this.obstacleModels.has(name));
      const kind = choose(availableKinds);
      this.addObstacle(kind, laneX[lane], -100 - Math.max(0, distance - this.distanceToObstacle));
    }
    this.lastSpawnDistance = distance;
  }
  spawnCollectibles(distance, difficulty) {
    const lane = THREE.MathUtils.randInt(0, 2);
    const x = laneX[lane];
    const treat = Math.random() < .25;
    const scoringBoosters = ['coupon', 'cash'];
    const kind = treat ? choose(scoringBoosters) : 'coin';
    const count = treat ? 1 : THREE.MathUtils.randInt(3, 5);
    const spacing = 4.1;
    for (let i = 0; i < count; i++) this.addPickup(kind, x, -94 - i * spacing);
    if (difficulty > 2 && Math.random() < .27) {
      const sideLane = (lane + 1 + THREE.MathUtils.randInt(0, 1)) % 3;
      for (let i = 0; i < 3; i++) this.addPickup('coin', laneX[sideLane], -94 - i * spacing - 5);
    }
  }
  spawnPowerup() {
    const kind = choose(['turbo', 'magnet', 'brake', 'coffee-power']);
    this.addPickup(kind, laneX[THREE.MathUtils.randInt(0, 2)], -105);
  }
  addObstacle(kind, x, z) {
    this.addEntity(kind, 'obstacle', x, z);
  }
  addPickup(kind, x, z) {
    this.addEntity(kind, isPowerup(kind) ? 'powerup' : 'coin', x, z);
  }
  addEntity(kind, type, x, z) {
    const key = `${type}:${kind}`; const pool = this.pools.get(key); let entity = pool?.pop();
    if (!entity) {
      const assetModel = type === 'obstacle' ? this.obstacleModels.get(kind) : this.pickupModels.get(kind);
      const model = assetModel?.clone(true) || (type === 'obstacle' ? createObstacle(kind) : createPickup(kind));
      const group = new THREE.Group(); group.add(model);
      entity = { type, kind, group, model, assetBacked: Boolean(assetModel), age: 0, resolved: false, float: type !== 'obstacle' && kind !== 'cash', radius: type === 'obstacle' ? this.obstacleRadii.get(kind) || obstacleRadius(kind) : 0 };
    }
    entity.type = type; entity.kind = kind; entity.age = entity.float ? random(0, 5) : 0; entity.resolved = false;
    entity.group.position.set(x, 0, z); entity.group.rotation.set(0, 0, 0); entity.group.scale.set(1, 1, 1); entity.group.visible = true;
    this.world.add(entity.group); this.entities.push(entity);
  }
  recycle(entity) {
    this.world.remove(entity.group); entity.group.visible = false;
    const key = `${entity.type}:${entity.kind}`; let pool = this.pools.get(key);
    if (!pool) { pool = []; this.pools.set(key, pool); }
    if (entity.type === 'obstacle' || pool.length < this.poolLimit) pool.push(entity);
    else if (!entity.assetBacked) disposeObject(entity.group);
  }
  reset() {
    for (const e of this.entities) this.recycle(e);
    this.entities.length = 0; this.distanceToObstacle = 67; this.distanceToCoins = 22; this.distanceToPower = 112;
  }
}

class ParticleSystem {
  constructor(scene) { this.scene = scene; this.items = []; this.pool = []; this.geometry = new THREE.IcosahedronGeometry(.09, 0); }
  burst(position, color, amount = 12, dust = false) {
    for (let i = 0; i < amount; i++) {
      if (this.items.length >= 76) this.remove(this.items[0]);
      const item = this.pool.pop() || this.createParticle();
      item.mat.color.set(color); item.mat.opacity = 1; item.mesh.visible = true; item.mesh.position.copy(position);
      item.mesh.rotation.set(0, 0, 0); item.mesh.scale.setScalar(random(.35, 1.35));
      item.velocity.set(random(-3, 3), dust ? random(.2, 1.3) : random(.6, 5.5), dust ? random(1.3, 3.8) : random(-4, 1));
      item.life = dust ? random(.23, .53) : random(.32, .85); item.maxLife = item.life;
      this.scene.add(item.mesh); this.items.push(item);
    }
  }
  createParticle() {
    const mat = new THREE.MeshBasicMaterial({ color: COLORS.orange, transparent: true, opacity: 1 });
    return { mesh: new THREE.Mesh(this.geometry, mat), mat, velocity: new THREE.Vector3(), life: 0, maxLife: 1 };
  }
  update(dt) {
    for (let i = this.items.length - 1; i >= 0; i--) {
      const p = this.items[i]; p.life -= dt; p.mesh.position.addScaledVector(p.velocity, dt); p.velocity.y -= 10 * dt;
      p.mesh.rotation.x += dt * 7; p.mesh.rotation.y += dt * 8; p.mat.opacity = Math.max(0, p.life / p.maxLife);
      if (p.life <= 0) this.remove(p);
    }
  }
  remove(p) {
    this.scene.remove(p.mesh); p.mesh.visible = false; p.mat.opacity = 0;
    const index = this.items.indexOf(p); if (index >= 0) this.items.splice(index, 1);
    if (this.pool.length < 76) this.pool.push(p);
  }
  clear() { for (const p of [...this.items]) this.remove(p); }
}

class AssetManager {
  constructor(game) {
    this.game = game; this.loader = new GLTFLoader(); this.loader.setMeshoptDecoder(MeshoptDecoder); this.cartLoaded = true;
    this.riderPoseCache = new WeakMap();
    this.loadMainCharacter(); this.loadObstacleModels(); this.loadPickupModels();
  }
  loadMainCharacter() {
    const url = new URL('./3DMODELS/fast_boy_in_quill.glb?v=20261009-meshopt-1', import.meta.url).href;
    this.loader.load(url, (gltf) => {
      const character = gltf.scene;
      const bounds = new THREE.Box3().setFromObject(character);
      const size = bounds.getSize(new THREE.Vector3());
      const center = bounds.getCenter(new THREE.Vector3());
      if (!Number.isFinite(size.y) || size.y <= 0) {
        console.warn('O modelo do personagem principal não tem dimensões válidas.');
        return;
      }
      const scale = 2.35 / size.y;
      character.scale.setScalar(scale);
      character.position.set(-center.x * scale, -bounds.min.y * scale, -center.z * scale);
      character.rotation.y = Math.PI;
      character.name = 'modelo-fast-boy-in-quill';
      const characterAsset = { scene: character, animations: gltf.animations || [] };
      this.game.characterAsset = characterAsset;
      installCharacterModel(this.game.cart, characterAsset, 'personagem-principal-fast-boy');
      this.game.setMultiplayerCharacterModel(characterAsset);
    }, undefined, (error) => console.warn('Não foi possível carregar fast_boy_in_quill.glb.', error));
  }
  loadPickupModels() {
    const specs = [
      { kind: 'coin', file: 'coin.glb', size: .74, anchorY: .66, center: true },
      { kind: 'magnet', file: 'magnet.glb', size: 1.1, anchorY: .29, center: false },
      { kind: 'soda', file: 'soda_can.glb', size: 1.05, anchorY: .8, center: true, height: true },
      { kind: 'coffee', aliases: ['coffee-power'], file: 'coffee_shop_cup.glb', size: 1, anchorY: .28, center: false, height: true },
      { kind: 'cash', file: 'bag_of_money.glb', size: 1.15, anchorY: 0, center: false, maxAxis: true },
      { kind: 'turbo', file: 'SpeedBoost.glb', size: 1.05, anchorY: .8, center: true, maxAxis: true },
      { kind: 'brake', file: 'Stop.glb', size: 1.6, anchorY: .8, center: true, maxAxis: true },
    ];
    for (const spec of specs) {
      const url = new URL(`./3DMODELS/${spec.file}`, import.meta.url).href;
      this.loader.load(url, (gltf) => {
        const model = gltf.scene;
        const bounds = new THREE.Box3().setFromObject(model);
        const dimensions = bounds.getSize(new THREE.Vector3());
        const center = bounds.getCenter(new THREE.Vector3());
        const referenceSize = spec.height ? dimensions.y : spec.maxAxis
          ? Math.max(dimensions.x, dimensions.y, dimensions.z)
          : Math.max(dimensions.x, dimensions.y);
        const scale = spec.size / referenceSize;
        model.scale.setScalar(scale);
        model.position.set(
          -center.x * scale,
          spec.anchorY - (spec.center ? center.y : bounds.min.y) * scale,
          -center.z * scale,
        );
        model.traverse((object) => {
          if (object.isMesh) { object.castShadow = false; object.receiveShadow = false; }
        });
        model.name = `modelo-${spec.kind}`;
        for (const kind of [spec.kind, ...(spec.aliases || [])]) this.game.obstacles.setPickupModel(kind, model);
      }, undefined, (error) => console.warn(`Modelo de coleta ${spec.file} indisponÃ­vel.`, error));
    }
  }
  loadObstacleModels() {
    const models = [
      { kind: 'caixa', file: 'caixa.glb', height: 2.2, width: 2.6, depth: 2.6 },
      { kind: 'feno', file: 'feno.glb', height: 2.45, width: 3.1, depth: 3.25 },
      { kind: 'pedra', file: 'pedra.glb', height: 2, width: 3.2, depth: 3.2 },
      { kind: 'cones', file: 'cones.glb', height: 2.2, width: 2.4, depth: 2.4 },
    ];
    for (const spec of models) {
      const url = new URL(`./3DMODELS/${spec.file}`, import.meta.url).href;
      this.loader.load(url, (gltf) => {
        const model = gltf.scene;
        const bounds = new THREE.Box3().setFromObject(model);
        const size = bounds.getSize(new THREE.Vector3());
        const center = bounds.getCenter(new THREE.Vector3());
        const scale = Math.min(spec.height / size.y, spec.width / size.x, spec.depth / size.z);
        model.scale.setScalar(scale);
        model.position.set(-center.x * scale, -bounds.min.y * scale, -center.z * scale);
        model.traverse((object) => {
          if (object.isMesh) { object.castShadow = false; object.receiveShadow = false; }
        });
        model.name = `obstaculo-${spec.kind}`;
        const radius = Math.max(.65, size.x * scale * .42);
        this.game.obstacles.setObstacleModel(spec.kind, model, radius);
      }, undefined, (error) => console.warn(`Modelo de obstáculo ${spec.file} indisponível.`, error));
    }
  }
}

class Game {
  constructor() {
    this.phase = 'menu'; this.time = 0; this.distance = 0; this.score = 0; this.coinsCollected = 0; this.dodges = 0; this.hits = 0;
    this.maxSpeed = 0; this.speed = 15; this.targetSpeed = 15; this.health = MAX_COLLISIONS; this.combo = 1;
    this.comboTimer = 0; this.playerX = 0; this.steerVelocity = 0; this.lastSteer = 0;
    this.uiUpdateTimer = 0; this.visualUpdateTimer = 0;
    this.key = { left: false, right: false, down: false };
    this.mouseSteer = null; this.pointerDown = false; this.mobileSteer = 0;
    this.powerup = null; this.powerTimer = 0; this.invulnerable = 0; this.impact = 0; this.impactVelocity = 0;
    this.storyFlags = new Set(); this.toastTimeout = 0; this.dustTimer = 0;
    this.meterRecords = this.readStorage('carrinho-best-distance', 0);
    this.runCount = this.readStorage('carrinho-runs', 0);
    this.firebasePlayerId = null;
    this.mp = {
      code: null, role: null, playerId: null, hostId: null, playerIds: [], players: [], allPlayers: [], racePlayerIds: [],
      unsubscribe: null, heartbeat: 0, syncTimer: 0, uiTimer: 0,
      finished: false, finalState: null, resultsRequested: false,
      pingSeen: new Map(), motionBuffers: new Map(), motionSignatures: new Map(),
    };
    this.remoteCarts = new Map();
    this.characterAsset = null;
    this.multiplayerCharacterModel = null;
    this.audio = new AudioManager();
    this.setupThree();
    this.makeWorld();
    this.setupControls();
    this.populateMenu();
    loadFirebasePlayer().then((player) => {
      if (!player) return;
      this.firebasePlayerId = player.uid;
      this.applyRemoteBest(player.bestDistance);
    });
    this.lastFrame = performance.now();
    requestAnimationFrame((t) => this.loop(t));
  }
  readStorage(key, fallback) { try { const value = Number(localStorage.getItem(key)); return Number.isFinite(value) ? value : fallback; } catch { return fallback; } }
  writeStorage(key, value) { try { localStorage.setItem(key, String(value)); } catch { /* storage can be disabled */ } }
  applyRemoteBest(distance) {
    const best = Math.max(this.meterRecords, Math.floor(Number(distance) || 0));
    if (best <= this.meterRecords) return;
    this.meterRecords = best;
    this.writeStorage('carrinho-best-distance', best);
    ui.best.textContent = `${number(best)} m`;
    ui.bestDistance.textContent = number(best);
    ui.menuBest.textContent = number(best);
  }
  setupThree() {
    this.scene = new THREE.Scene(); this.scene.background = createSkyTexture(); this.scene.fog = new THREE.Fog(0xc9e7f7, 72, 220);
    this.camera = new THREE.PerspectiveCamera(69, innerWidth / innerHeight, .1, 260); this.camera.position.set(0, 6, 10.7);
    try {
      this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: 'high-performance' });
    } catch (error) {
      document.body.innerHTML = '<div style="padding:40px;font:16px sans-serif;color:#193b37">Este passeio precisa de WebGL. Ative a aceleração de hardware do navegador e abra novamente.</div>';
      throw error;
    }
    this.renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 1));
    this.renderer.setSize(innerWidth, innerHeight, false);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping; this.renderer.toneMappingExposure = 1.13;
    this.renderer.shadowMap.enabled = true; this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.scene.add(new THREE.HemisphereLight(0xdaf1ff, 0x526c81, 2.15));
    const sun = new THREE.DirectionalLight(0xf0f8ff, 2.8); sun.position.set(-15, 26, 15); sun.castShadow = true;
    sun.shadow.mapSize.set(512, 512); sun.shadow.camera.left = -18; sun.shadow.camera.right = 18; sun.shadow.camera.top = 24; sun.shadow.camera.bottom = -14;
    sun.shadow.bias = -.00025; sun.shadow.radius = 3; this.scene.add(sun);
    const skyGlow = new THREE.DirectionalLight(0x8ecdf1, .7); skyGlow.position.set(16, 8, -21); this.scene.add(skyGlow);
    const skyDecor = new THREE.Group(); this.scene.add(skyDecor);
    const sunGlow = new THREE.Mesh(new THREE.CircleGeometry(17, 48), new THREE.MeshBasicMaterial({ color: 0xa8ddfa, transparent: true, opacity: .22, depthWrite: false, fog: false }));
    sunGlow.position.set(-24, 27, -144); skyDecor.add(sunGlow);
    const sunDisc = new THREE.Mesh(new THREE.CircleGeometry(7.5, 48), new THREE.MeshBasicMaterial({ color: 0xf5fbff, fog: false }));
    sunDisc.position.set(-24, 27, -143); skyDecor.add(sunDisc);
    this.cameraController = null;
  }
  makeWorld() {
    this.terrain = new THREE.Group(); this.terrain.rotation.x = -Math.asin(slope); this.scene.add(this.terrain);
    this.dynamicWorld = new THREE.Group(); this.dynamicWorld.rotation.x = -Math.asin(slope); this.scene.add(this.dynamicWorld);
    this.track = new TrackGenerator(this.scene, () => {});
    this.cart = new Cart({ procedural: false }); this.cart.group.position.set(0, 0, 0);
    this.cart.reaction.visible = false; this.cart.shadow.visible = false;
    this.cart.group.traverse((o) => { if (o.isMesh) { o.castShadow = o !== this.cart.shadow; o.receiveShadow = o !== this.cart.shadow; } }); this.scene.add(this.cart.group);
    this.cameraController = new CameraController(this.camera, this.cart.group);
    this.particles = new ParticleSystem(this.scene);
    this.obstacles = new ObstacleManager(this.dynamicWorld, {
      onDodge: (x, type) => this.onDodge(x, type),
      onCollision: (x, type) => this.onCollision(x, type),
      onCollect: (type, x, entity) => this.onCollect(type, x, entity),
    });
    this.makeAmbientObjects();
    this.assets = new AssetManager(this);
  }
  makeAmbientObjects() {
    this.clouds = [];
    const cloudMat = material(0xf8fcff, 1, 0, 0, true);
    const cloudGeometry = new THREE.IcosahedronGeometry(1, 1);
    const puffTransform = new THREE.Object3D();
    for (let i = 0; i < 12; i++) {
      const count = 5 + Math.floor(Math.random() * 4);
      const cloud = new THREE.InstancedMesh(cloudGeometry, cloudMat, count);
      cloud.castShadow = false; cloud.receiveShadow = false;
      for (let j = 0; j < count; j++) {
        puffTransform.position.set((j - count / 2) * 2.15, random(-.55, .75), random(-1.2, 1.2));
        puffTransform.rotation.set(0, 0, 0); puffTransform.scale.setScalar(random(1.35, 2.9));
        puffTransform.updateMatrix(); cloud.setMatrixAt(j, puffTransform.matrix);
      }
      cloud.instanceMatrix.needsUpdate = true;
      cloud.position.set(random(-75, 75), random(24, 47), -random(35, 250)); this.scene.add(cloud); this.clouds.push(cloud);
    }
  }
  setupControls() {
    const keyMap = { KeyA: 'left', ArrowLeft: 'left', KeyD: 'right', ArrowRight: 'right', KeyS: 'down', ArrowDown: 'down' };
    const isTextEntry = (target) => target instanceof Element
      && Boolean(target.closest('input, textarea, select, [contenteditable="true"]'));
    window.addEventListener('keydown', (e) => {
      if (keyMap[e.code] && !isTextEntry(e.target)) { e.preventDefault(); this.key[keyMap[e.code]] = true; }
      if (e.code === 'Enter' && (this.phase === 'menu' || this.phase === 'gameover')) this.start();
      else if (e.code === 'Enter' && this.phase === 'mp-lobby' && !ui.mpJoinBlock.classList.contains('is-hidden')) this.confirmJoin();
    });
    window.addEventListener('keyup', (e) => { if (keyMap[e.code]) this.key[keyMap[e.code]] = false; });
    window.addEventListener('blur', () => {
      for (const key of Object.keys(this.key)) this.key[key] = false;
      this.mobileSteer = 0; this.mouseSteer = null; this.pointerDown = false;
    });
    canvas.addEventListener('pointermove', (e) => {
      if (e.pointerType === 'mouse' && this.pointerDown && this.phase === 'playing') {
        const rect = canvas.getBoundingClientRect(); this.mouseSteer = clamp(((e.clientX - rect.left) / rect.width - .5) * 2, -1, 1);
      }
    });
    canvas.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse' && this.phase === 'playing') { this.pointerDown = true; canvas.setPointerCapture?.(e.pointerId); }
    });
    canvas.addEventListener('pointerup', () => { this.pointerDown = false; this.mouseSteer = null; });
    canvas.addEventListener('pointercancel', () => { this.pointerDown = false; this.mouseSteer = null; });
    canvas.addEventListener('pointerleave', () => { if (!this.pointerDown) this.mouseSteer = null; });
    const bindSteer = (id, direction) => {
      const button = $(id);
      button.addEventListener('pointerdown', (e) => { e.preventDefault(); this.mobileSteer = direction; button.classList.add('is-pressed'); button.setPointerCapture?.(e.pointerId); });
      const release = () => { if (this.mobileSteer === direction) this.mobileSteer = 0; button.classList.remove('is-pressed'); };
      button.addEventListener('pointerup', release); button.addEventListener('pointercancel', release); button.addEventListener('lostpointercapture', release);
    };
    bindSteer('steer-left', -1); bindSteer('steer-right', 1);
    ui.play.addEventListener('click', () => this.start()); ui.restart.addEventListener('click', () => this.start());
    ui.menuButton.addEventListener('click', () => this.toMenu());
    ui.mpButton.addEventListener('click', () => { this.audio.unlock(); this.audio.play('click'); ui.menu.classList.add('is-hidden'); ui.mpMenu.classList.remove('is-hidden'); });
    ui.mpBack.addEventListener('click', () => { this.audio.play('click'); ui.mpMenu.classList.add('is-hidden'); this.toMenu(); });
    ui.mpCreate.addEventListener('click', () => this.hostRoom());
    ui.mpJoin.addEventListener('click', () => { this.audio.play('click'); this.showLobby('join'); this.setMpStatus(''); });
    ui.mpCodeInput.addEventListener('input', () => {
      const normalized = ui.mpCodeInput.value.toUpperCase()
        .replace(/[^ABCDEFGHJKMNPQRSTUVWXYZ23456789]/g, '')
        .slice(0, 6);
      if (ui.mpCodeInput.value !== normalized) ui.mpCodeInput.value = normalized;
    });
    ui.mpJoinConfirm.addEventListener('click', () => this.confirmJoin());
    ui.mpStart.addEventListener('click', () => {
      this.audio.play('click');
      void this.beginMultiplayerRoom();
    });
    ui.mpCopy.addEventListener('click', () => this.copyRoomCode());
    ui.mpLeave.addEventListener('click', () => this.leaveRoom());
    ui.mpRematch.addEventListener('click', () => this.requestRematch());
    ui.mpExit.addEventListener('click', () => this.leaveRoom());
    ui.sound.addEventListener('click', () => {
      this.audio.unlock(); this.audio.setEnabled(!this.audio.enabled);
      ui.soundState.textContent = this.audio.enabled ? 'ON' : 'OFF'; ui.soundIcon.textContent = this.audio.enabled ? '♫' : '♪';
      ui.sound.setAttribute('aria-label', this.audio.enabled ? 'Desativar som' : 'Ativar som');
      if (this.audio.enabled) this.audio.play('click');
    });
    window.addEventListener('resize', () => this.resize());
    document.addEventListener('visibilitychange', () => { this.lastFrame = performance.now(); });
  }
  populateMenu() {
    ui.bestDistance.textContent = number(this.meterRecords); ui.menuBest.textContent = number(this.meterRecords);
    ui.best.textContent = `${number(this.meterRecords)} m`; ui.run.textContent = String(this.runCount + 1).padStart(3, '0');
    ui.hints.classList.add('is-hidden'); ui.bottomline.classList.add('is-hidden'); ui.mobileControls.classList.add('is-hidden');
  }
  start() {
    this.audio.unlock(); this.audio.play('click');
    trackFirebaseEvent('game_start');
    this.uiUpdateTimer = 0; this.visualUpdateTimer = 0;
    clearTimeout(this.toastTimeout); ui.toast.classList.remove('is-visible'); ui.toast.textContent = '';
    this.phase = 'playing'; this.time = 0; this.distance = 0; this.score = 0; this.coinsCollected = 0; this.dodges = 0; this.hits = 0; this.maxSpeed = 0;
    ui.coins.textContent = '0';
    this.health = MAX_COLLISIONS; this.combo = 1; this.comboTimer = 0; this.playerX = 0; this.steerVelocity = 0;
    this.key.left = false; this.key.right = false; this.pointerDown = false;
    this.speed = 17; this.targetSpeed = 17; this.powerup = null; this.powerTimer = 0; this.invulnerable = 0;
    this.impact = 0; this.impactVelocity = 0; this.dustTimer = 0; this.storyFlags.clear(); this.mobileSteer = 0; this.mouseSteer = null;
    gameRoot.style.setProperty('--rush', '0');
    this.obstacles.reset(); this.particles.clear(); this.runCount++; this.writeStorage('carrinho-runs', this.runCount);
    this.track.segments.forEach((segment, i) => {
      const z = SEGMENT_LENGTH / 2 - SEGMENT_LENGTH * i; segment.group.position.set(0, slope * z, z); segment.group.rotation.x = -Math.asin(slope);
    });
    this.cart.group.position.set(0, 0, 0); this.cart.reaction.rotation.set(0, 0, 0);
    this.cart.riderPivot.rotation.set(0, 0, 0); this.cart.riderPivot.position.copy(this.cart.riderPivotBasePosition);
    this.cart.rider.rotation.copy(this.cart.riderBaseRotation);
    this.cart.rider.scale.copy(this.cart.riderBaseScale); this.cart.riderWobbleTime = 0;
    this.camera.position.set(0, 6, 10.7); this.cameraController.shake = 0;
    ui.menu.classList.add('is-hidden'); ui.gameover.classList.add('is-hidden'); ui.hud.classList.add('is-visible'); ui.sideRecord.classList.add('is-hidden');
    ui.mpMenu.classList.add('is-hidden'); ui.mpLobby.classList.add('is-hidden'); ui.mpResult.classList.add('is-hidden'); ui.mpScore.classList.add('is-hidden');
    for (const cart of this.remoteCarts.values()) {
      cart.group.visible = false; cart.group.userData.hasRemoteMotion = false;
    }
    ui.hints.classList.remove('is-hidden'); ui.bottomline.classList.remove('is-hidden'); ui.mobileControls.classList.remove('is-hidden');
    ui.hints.style.opacity = ''; ui.run.textContent = String(this.runCount).padStart(3, '0');
    ui.phase.textContent = 'DESCIDA EM ANDAMENTO'; ui.comboBadge.classList.remove('is-active'); ui.powerBadge.classList.remove('is-active');
    this.updateUI();
  }
  toMenu() {
    this.phase = 'menu'; this.audio.setMotion(0, false);
    gameRoot.style.setProperty('--rush', '0');
    clearTimeout(this.toastTimeout); ui.toast.classList.remove('is-visible'); ui.toast.textContent = '';
    ui.mpMenu.classList.add('is-hidden'); ui.mpLobby.classList.add('is-hidden'); ui.mpResult.classList.add('is-hidden'); ui.mpScore.classList.add('is-hidden');
    for (const cart of this.remoteCarts.values()) cart.group.visible = false;
    ui.gameover.classList.add('is-hidden'); ui.menu.classList.remove('is-hidden'); ui.hud.classList.remove('is-visible');
    ui.hints.classList.add('is-hidden'); ui.bottomline.classList.add('is-hidden'); ui.mobileControls.classList.add('is-hidden');
    ui.sideRecord.classList.remove('is-hidden'); ui.phase.textContent = 'PRONTO PARA DESCER'; this.populateMenu();
  }
  endRun() {
    if (this.phase === 'mp-playing') { this.finishMultiplayer('died'); return; }
    if (this.phase !== 'playing') return;
    this.phase = 'gameover'; this.audio.setMotion(0, false); this.audio.play('gameover');
    gameRoot.style.setProperty('--rush', '0');
    clearTimeout(this.toastTimeout); ui.toast.classList.remove('is-visible');
    const isNew = this.distance > this.meterRecords;
    if (isNew) { this.meterRecords = Math.floor(this.distance); this.writeStorage('carrinho-best-distance', this.meterRecords); }
    const finalScore = this.score + Math.floor(this.distance * 10);
    const savedRun = {
      score: finalScore,
      distance: this.distance,
      coins: this.coinsCollected,
      dodges: this.dodges,
      hits: this.hits,
      maxSpeed: this.maxSpeed,
    };
    trackFirebaseEvent('game_over', { score: finalScore, distance: Math.floor(this.distance), coins: this.coinsCollected });
    void saveFirebaseRun(savedRun).then((player) => {
      if (!player) return;
      this.applyRemoteBest(player.bestDistance);
      if (player.isNewBestDistance) ui.newRecord.classList.remove('is-hidden');
    });
    ui.finalDistance.innerHTML = `${number(this.distance)} <small>metros</small>`;
    ui.finalScore.textContent = number(finalScore); ui.finalDodges.textContent = number(this.dodges);
    ui.finalHits.textContent = number(this.hits); ui.finalSpeed.textContent = `${number(this.maxSpeed)} km/h`;
    ui.newRecord.classList.toggle('is-hidden', !isNew); ui.gameover.classList.remove('is-hidden');
    ui.phase.textContent = 'DESCIDA ENCERRADA'; ui.comboBadge.classList.remove('is-active'); ui.powerBadge.classList.remove('is-active');
    ui.sideRecord.classList.add('is-hidden'); this.populateMenu();
    ui.hints.classList.add('is-hidden'); ui.bottomline.classList.add('is-hidden'); ui.mobileControls.classList.add('is-hidden');
  }
  setMpStatus(message, isError = false) {
    ui.mpStatus.textContent = message;
    ui.mpStatus.classList.toggle('is-error', isError);
  }
  showLobby(mode) {
    ui.mpMenu.classList.add('is-hidden'); ui.mpLobby.classList.remove('is-hidden');
    ui.mpCodeBlock.classList.toggle('is-hidden', mode !== 'host');
    ui.mpJoinBlock.classList.toggle('is-hidden', mode !== 'join');
    ui.mpStart.classList.add('is-hidden');
    [...ui.mpLobbyPlayers.children].forEach((slot, index) => {
      slot.textContent = `VAGA ${index + 1}`;
      slot.classList.add('is-empty');
    });
    this.phase = 'mp-lobby';
    if (mode === 'join') setTimeout(() => ui.mpCodeInput.focus(), 80);
  }
  async hostRoom() {
    this.audio.unlock(); this.audio.play('click');
    ui.mpCreate.disabled = true;
    this.showLobby('host'); ui.mpCode.textContent = '······';
    this.setMpStatus('Criando sala…');
    try {
      const { code, role, playerId } = await createMultiplayerRoom();
      this.mp.code = code; this.mp.role = role; this.mp.playerId = playerId;
      ui.mpCode.textContent = code;
      this.setMpStatus('Compartilhe o código e aguarde os participantes.');
      this.listenRoom();
      trackFirebaseEvent('mp_room_created');
    } catch (error) {
      console.error('Falha ao criar sala multiplayer no Firestore.', error);
      ui.mpCode.textContent = '------';
      const code = String(error?.code || error?.message || '').toLowerCase();
      const reason = String(error?.code || error?.name || 'erro-desconhecido').replace(/^firestore\//, '');
      if (code.includes('permission-denied')) {
        this.setMpStatus(`Acesso negado [${reason}]. No PowerShell, rode .\\node_modules\\.bin\\firebase.cmd login --reauth e depois .\\node_modules\\.bin\\firebase.cmd deploy --only firestore:rules --project carrinho-d139f.`, true);
      } else if (code.includes('unavailable') || code.includes('network')) {
        this.setMpStatus(`Sem conexão com o Firestore [${reason}]. Confira a internet.`, true);
      } else {
        this.setMpStatus(`Falha ao criar sala [${reason}]. Confira a configuração do Firestore.`, true);
      }
    } finally {
      ui.mpCreate.disabled = false;
    }
  }
  async copyRoomCode() {
    const code = ui.mpCode.textContent;
    if (!/^[A-Z2-9]{6}$/.test(code)) return;
    try {
      await navigator.clipboard.writeText(code);
      this.setMpStatus('Código copiado. Envie para os outros jogadores.');
    } catch {
      this.setMpStatus(`Código da sala: ${code}`);
    }
  }
  async beginMultiplayerRoom() {
    if (!this.mp.code || this.mp.role !== 'host') return;
    ui.mpStart.disabled = true;
    this.setMpStatus('Preparando a corrida…');
    try {
      await startMultiplayerRoom(this.mp.code, this.mp.playerId);
    } catch (error) {
      const messages = {
        'need-players': 'É preciso ter pelo menos dois jogadores.',
        'not-host': 'Somente quem criou a sala pode iniciar.',
        unavailable: 'Esta sala já foi iniciada ou encerrada.',
        'not-found': 'A sala não está mais disponível.',
      };
      this.setMpStatus(messages[error.message] || 'Não foi possível iniciar. Confira a conexão e as regras do Firestore.');
    } finally {
      ui.mpStart.disabled = false;
    }
  }
  async confirmJoin() {
    const code = ui.mpCodeInput.value.trim().toUpperCase();
    if (code.length !== 6) { this.setMpStatus('O código tem 6 caracteres.'); return; }
    this.audio.unlock(); this.audio.play('click');
    this.setMpStatus('Procurando sala…');
    try {
      const result = await joinMultiplayerRoom(code);
      this.mp.code = result.code; this.mp.role = result.role; this.mp.playerId = result.playerId;
      ui.mpJoinBlock.classList.add('is-hidden'); ui.mpCodeBlock.classList.remove('is-hidden');
      ui.mpCode.textContent = result.code;
      this.setMpStatus('Entrou na sala. Aguardando o host iniciar.');
      this.listenRoom();
      trackFirebaseEvent('mp_room_joined');
    } catch (error) {
      const messages = {
        'not-found': 'Sala não encontrada. Confira o código.',
        full: 'Esta sala já tem seis participantes.',
        unavailable: 'A corrida já começou ou a sala foi encerrada.',
      };
      this.setMpStatus(messages[error.message] || 'Não foi possível entrar. Verifique a conexão e as regras do Firestore.');
    }
  }
  listenRoom() {
    this.mp.unsubscribe?.();
    clearInterval(this.mp.heartbeat);
    this.mp.unsubscribe = listenMultiplayerRoom(this.mp.code, (room, players) => this.onRoomUpdate(room, players));
    this.mp.heartbeat = setInterval(() => {
      if (this.mp.code && this.phase === 'mp-result') {
        void updateMultiplayerPlayer(this.mp.code, this.mp.playerId, this.mpPlayerState());
      }
    }, 2500);
  }
  orderedMpPlayers() {
    const byId = new Map(this.mp.players.map((player) => [player.id, player]));
    return this.mp.playerIds.map((id) => byId.get(id)).filter(Boolean);
  }
  renderLobbyPlayers() {
    const players = this.orderedMpPlayers();
    [...ui.mpLobbyPlayers.children].forEach((slot, index) => {
      const player = players[index];
      slot.textContent = player ? (player.id === this.mp.playerId ? `VOCÊ · J${index + 1}` : `JOGADOR ${index + 1}`) : `VAGA ${index + 1}`;
      slot.classList.toggle('is-empty', !player);
    });
  }
  playerIsConnected(player) {
    const stamp = player.ping?.toMillis?.() ?? null;
    const previous = this.mp.pingSeen.get(player.id);
    if (!previous || previous.stamp !== stamp) {
      this.mp.pingSeen.set(player.id, { stamp, seenAt: performance.now() });
      return true;
    }
    return performance.now() - previous.seenAt < 15000;
  }
  recordRemoteMotion(players) {
    const receivedAt = performance.now();
    for (const player of players) {
      if (player.id === this.mp.playerId || !Number(player.speed)) continue;
      const stamp = player.ping?.toMillis?.() ?? '';
      const sample = {
        receivedAt,
        x: clamp(Number(player.x) || 0, -7.25, 7.25),
        distance: Math.max(0, Number(player.distance) || 0),
        speed: Math.max(0, Number(player.speed) || 0),
        score: Math.max(0, Number(player.score) || 0),
        alive: player.alive !== false,
      };
      const signature = `${stamp}:${sample.x}:${sample.distance}:${sample.speed}:${sample.score}:${sample.alive}`;
      if (this.mp.motionSignatures.get(player.id) === signature) continue;
      this.mp.motionSignatures.set(player.id, signature);
      const samples = this.mp.motionBuffers.get(player.id) || [];
      samples.push(sample);
      while (samples.length > 2 && samples[1].receivedAt < receivedAt - 1800) samples.shift();
      if (samples.length > 16) samples.splice(0, samples.length - 16);
      this.mp.motionBuffers.set(player.id, samples);
    }
  }
  interpolatedRemoteMotion(player, now) {
    const samples = this.mp.motionBuffers.get(player.id) || [];
    if (!samples.length) return {
      x: clamp(Number(player.x) || 0, -7.25, 7.25),
      distance: Math.max(0, Number(player.distance) || 0),
      speed: Math.max(0, Number(player.speed) || 0),
    };

    const renderAt = now;
    if (renderAt <= samples[0].receivedAt) return samples[0];
    for (let index = 1; index < samples.length; index++) {
      const older = samples[index - 1];
      const newer = samples[index];
      if (renderAt > newer.receivedAt) continue;
      const span = Math.max(1, newer.receivedAt - older.receivedAt);
      const amount = clamp((renderAt - older.receivedAt) / span, 0, 1);
      return {
        x: lerp(older.x, newer.x, amount),
        distance: lerp(older.distance, newer.distance, amount),
        speed: lerp(older.speed, newer.speed, amount),
      };
    }

    const latest = samples[samples.length - 1];
    const ahead = Math.min(MP_MAX_EXTRAPOLATION, Math.max(0, (renderAt - latest.receivedAt) / 1000));
    const previous = samples.length > 1 ? samples[samples.length - 2] : null;
    let x = latest.x;
    if (previous) {
      const span = (latest.receivedAt - previous.receivedAt) / 1000;
      const maxLateralSpeed = Math.max(7, (Number(latest.speed) || 17) * .38);
      if (span > .02) x = clamp(latest.x + clamp((latest.x - previous.x) / span, -maxLateralSpeed, maxLateralSpeed) * ahead, -7.25, 7.25);
    }
    return { x, distance: latest.distance + latest.speed * ahead, speed: latest.speed };
  }
  onRoomUpdate(room, players = []) {
    if (!this.mp.code) return;
    if (!room) {
      if (this.phase === 'mp-playing') this.finishMultiplayer('disconnect', true);
      else if (this.phase !== 'menu') { this.setMpStatus('A sala foi encerrada.'); this.leaveRoom(true); }
      return;
    }
    this.mp.hostId = room.hostId;
    this.mp.role = room.hostId === this.mp.playerId ? 'host' : 'guest';
    this.mp.playerIds = Array.isArray(room.playerIds) ? room.playerIds : [];
    this.mp.allPlayers = players;
    this.mp.players = players.filter((player) => this.mp.playerIds.includes(player.id));
    this.recordRemoteMotion(this.mp.players);
    if (room.status === 'closed') {
      this.setMpStatus('O anfitrião encerrou a sala.');
      this.leaveRoom(true);
      return;
    }
    if (!this.mp.playerIds.includes(this.mp.playerId)) {
      this.leaveRoom(true);
      return;
    }
    if (this.phase === 'mp-lobby') {
      this.renderLobbyPlayers();
      const count = this.mp.playerIds.length;
      ui.mpStart.classList.toggle('is-hidden', this.mp.role !== 'host' || count < 2);
      this.setMpStatus(this.mp.role === 'host'
        ? count < 2 ? 'Aguardando pelo menos mais um jogador.'
          : `${count} de 6 participantes. ${count < 6 ? 'Podem começar ou aguardar mais jogadores.' : 'Sala completa; podem começar.'}`
        : `${count} de 6 participantes. Aguardando o host iniciar.`);
      if (room.status === 'playing') this.startMultiplayer();
    } else if (this.phase === 'mp-playing') {
      if (room.status === 'finished') this.showMultiplayerResult(room);
    } else if (this.phase === 'mp-result') {
      if (room.status === 'playing') { this.startMultiplayer(); return; }
      const rematch = room.rematch || {};
      const readyCount = this.mp.playerIds.filter((id) => rematch[id]).length;
      ui.mpRematchStatus.textContent = this.mp.role === 'host'
        ? `${readyCount} de ${this.mp.playerIds.length} prontos. Você pode iniciar outra corrida nesta sala quando quiser.`
        : rematch[this.mp.playerId]
          ? 'Você está pronto. Aguardando o anfitrião iniciar outra corrida nesta sala.'
          : 'Aguardando o anfitrião iniciar outra corrida nesta sala.';
    }
    if (room.status === 'finished' && this.phase === 'mp-playing') this.showMultiplayerResult(room);
  }
  makeRemoteCart(playerId) {
    let cart = this.remoteCarts.get(playerId);
    if (cart) return cart;
    cart = new Cart({ procedural: false });
    cart.reaction.visible = false; cart.shadow.visible = false;
    cart.shadow.material = new THREE.MeshBasicMaterial({ color: 0x5a3226, transparent: true, opacity: .19, depthWrite: false });
    this.scene.add(cart.group);
    this.remoteCarts.set(playerId, cart);
    this.installMultiplayerCharacterModel(cart);
    return cart;
  }
  setMultiplayerCharacterModel(characterAsset) {
    this.multiplayerCharacterModel = characterAsset;
    for (const cart of this.remoteCarts.values()) this.installMultiplayerCharacterModel(cart);
  }
  installMultiplayerCharacterModel(cart) {
    installCharacterModel(cart, this.multiplayerCharacterModel, 'personagem-multiplayer-fast-boy');
  }
  startMultiplayer() {
    if (this.phase === 'mp-playing') return;
    this.start();
    installCharacterModel(this.cart, this.multiplayerCharacterModel, 'personagem-principal-fast-boy');
    this.phase = 'mp-playing';
    this.mp.finished = false; this.mp.finalState = null; this.mp.resultsRequested = false; this.mp.syncTimer = 0; this.mp.uiTimer = 0;
    this.mp.racePlayerIds = [...this.mp.playerIds];
    const seat = Math.max(0, this.mp.playerIds.indexOf(this.mp.playerId));
    const startX = MULTIPLAYER_START_X[seat] ?? 0;
    this.playerX = startX;
    this.cart.group.position.x = this.playerX;
    this.mp.motionBuffers.clear(); this.mp.motionSignatures.clear();
    const startedAt = performance.now();
    this.mp.playerIds.forEach((id, remoteSeat) => {
      if (id === this.mp.playerId) return;
      this.mp.motionBuffers.set(id, [{
        receivedAt: startedAt, x: MULTIPLAYER_START_X[remoteSeat] ?? 0,
        distance: 0, speed: 17, score: 0, alive: true,
      }]);
    });
    for (const cart of this.remoteCarts.values()) cart.group.visible = false;
    ui.mpScore.classList.remove('is-hidden');
    ui.phase.textContent = 'CORRIDA MULTIPLAYER';
    this.toastMessage('Desvie dos obstáculos e seja o último carrinho na ladeira!', 3);
    trackFirebaseEvent('mp_match_start');
  }
  mpPlayerState() {
    if (this.mp.finished && this.mp.finalState) return { ...this.mp.finalState, alive: false };
    return {
      ready: true,
      x: Math.round(this.playerX * 100) / 100,
      distance: Math.round(this.distance * 10) / 10,
      speed: Math.max(0, Math.round(this.speed)),
      score: Math.max(0, this.score + Math.floor(this.distance * 10)),
      alive: this.health > 0 && !this.mp.finished,
    };
  }
  renderMpScoreboard() {
    const current = this.mp.players.map((player) => player.id === this.mp.playerId
      ? { ...player, ...this.mpPlayerState() }
      : player);
    const ordered = [...current].sort((a, b) => (b.score || 0) - (a.score || 0));
    ui.mpScorePlayers.replaceChildren(...ordered.map((player) => {
      const row = document.createElement('div');
      row.className = `mp-score-row${player.id === this.mp.playerId ? ' is-you' : ''}${player.alive === false ? ' is-eliminated' : ''}`;
      const name = document.createElement('span');
      const seat = this.mp.playerIds.indexOf(player.id) + 1;
      name.textContent = player.id === this.mp.playerId ? `VOCÊ · J${seat}` : `JOGADOR ${seat}`;
      const score = document.createElement('strong'); score.textContent = number(player.score || 0);
      row.append(name, score);
      return row;
    }));
  }
  updateMultiplayer(dt) {
    const byId = new Map(this.mp.players.map((player) => [player.id, player]));
    const activeRemoteIds = new Set();
    for (const id of this.mp.playerIds) {
      if (id === this.mp.playerId) continue;
      const player = byId.get(id);
      if (!player) continue;
      activeRemoteIds.add(id);
      const cart = this.makeRemoteCart(id);
      cart.group.visible = true;
      const motion = this.interpolatedRemoteMotion(player, performance.now());
      const targetZ = this.distance - motion.distance;
      const hasMotion = cart.group.userData.hasRemoteMotion;
      const previousX = hasMotion ? cart.group.position.x : motion.x;
      cart.group.position.z = hasMotion ? damp(cart.group.position.z, targetZ, 10, dt) : targetZ;
      cart.group.position.x = hasMotion ? damp(cart.group.position.x, motion.x, 18, dt) : motion.x;
      cart.group.position.y = slope * cart.group.position.z + Math.sin(this.time * 14) * .022;
      cart.group.userData.hasRemoteMotion = true;
      const remoteSteer = clamp((cart.group.position.x - previousX) / Math.max(dt, .001) / 6, -1, 1);
      cart.update(dt, motion.speed || this.speed, remoteSteer, 0, true);
    }
    for (const [id, cart] of this.remoteCarts) {
      if (!activeRemoteIds.has(id)) cart.group.visible = false;
    }

    this.mp.syncTimer -= dt;
    if (this.mp.syncTimer <= 0 && this.mp.code && this.mp.playerId) {
      this.mp.syncTimer = this.mp.finished ? 1.2 : MP_SYNC_INTERVAL;
      void updateMultiplayerPlayer(this.mp.code, this.mp.playerId, this.mpPlayerState());
    }
    this.mp.uiTimer -= dt;
    if (this.mp.uiTimer <= 0) {
      this.mp.uiTimer = .45;
      this.renderMpScoreboard();
    }

    const livePlayers = this.mp.players.filter((player) => player.alive !== false && this.playerIsConnected(player));
    const playerStatesLoaded = this.mp.players.length >= this.mp.playerIds.length;
    if (playerStatesLoaded && !livePlayers.length && this.mp.players.length && !this.mp.resultsRequested) {
      this.mp.resultsRequested = true;
      const bestScore = Math.max(...this.mp.players.map((player) => Number(player.score) || 0));
      const winners = this.mp.players.filter((player) => (Number(player.score) || 0) === bestScore);
      const winner = winners.length === 1 ? winners[0].id : 'draw';
      void finishMultiplayerRoom(this.mp.code, winner).then((finished) => {
        if (finished) trackFirebaseEvent('mp_match_end', { winner, reason: 'all-finished' });
      });
    }
  }
  async finishMultiplayer(reason, roomGone = false) {
    if (this.mp.finished || this.phase !== 'mp-playing') return;
    this.mp.finalState = { ...this.mpPlayerState(), alive: false };
    this.mp.finished = true;
    this.obstacles.reset();
    this.audio.setMotion(0, false); this.audio.play('gameover');
    gameRoot.style.setProperty('--rush', '0');
    if (roomGone) {
      const bestScore = Math.max(0, ...this.mp.players.map((player) => Number(player.score) || 0));
      const winners = this.mp.players.filter((player) => (Number(player.score) || 0) === bestScore);
      this.showMultiplayerResult({ winner: winners.length === 1 ? winners[0].id : 'draw' });
      return;
    }
    ui.phase.textContent = 'VOCÊ BATEU · ACOMPANHANDO A CORRIDA';
    ui.hints.classList.add('is-hidden'); ui.bottomline.classList.add('is-hidden'); ui.mobileControls.classList.add('is-hidden');
    this.toastMessage('Você foi eliminado. Acompanhe o restante da corrida.', 3);
    await updateMultiplayerPlayer(this.mp.code, this.mp.playerId, this.mpPlayerState());
    trackFirebaseEvent('mp_player_eliminated', { reason });
  }
  showMultiplayerResult(room) {
    if (this.phase === 'mp-result') return;
    this.phase = 'mp-result'; this.mp.finished = true;
    this.audio.setMotion(0, false);
    gameRoot.style.setProperty('--rush', '0');
    ui.mpScore.classList.add('is-hidden'); ui.hud.classList.remove('is-visible');
    ui.hints.classList.add('is-hidden'); ui.bottomline.classList.add('is-hidden'); ui.mobileControls.classList.add('is-hidden');
    for (const cart of this.remoteCarts.values()) cart.group.visible = false;
    const playersById = new Map(this.mp.allPlayers.map((player) => [player.id, player]));
    const raceIds = this.mp.racePlayerIds.length ? this.mp.racePlayerIds : this.mp.playerIds;
    const ordered = raceIds.map((id) => playersById.get(id)).filter(Boolean).sort((a, b) => (b.score || 0) - (a.score || 0));
    ui.mpResults.replaceChildren(...ordered.map((player) => {
      const seat = raceIds.indexOf(player.id) + 1;
      const row = document.createElement('div');
      row.className = `mp-result-player${player.id === room.winner ? ' is-winner' : ''}`;
      const name = document.createElement('span');
      name.textContent = player.id === this.mp.playerId ? `VOCÊ · J${seat}` : `JOGADOR ${seat}`;
      const score = document.createElement('strong'); score.textContent = number(player.score || 0);
      row.append(name, score);
      return row;
    }));
    const winnerSeat = raceIds.indexOf(room.winner) + 1;
    ui.mpResultTitle.textContent = room.winner === 'draw' ? 'EMPATE!' : room.winner === this.mp.playerId ? 'VITÓRIA!' : 'FIM DA DISPUTA';
    ui.mpWinnerLine.textContent = room.winner === 'draw'
      ? 'Empate técnico na ladeira.'
      : room.winner === this.mp.playerId ? '🏆 Você venceu a corrida!' : `🏆 Jogador ${winnerSeat} venceu a corrida!`;
    ui.mpRematchStatus.textContent = '';
    const rematchLabel = ui.mpRematch.querySelector('span');
    if (rematchLabel) rematchLabel.textContent = this.mp.role === 'host' ? 'INICIAR OUTRA CORRIDA' : 'ESTOU PRONTO';
    ui.mpRematch.disabled = false;
    ui.mpResult.classList.remove('is-hidden');
    ui.phase.textContent = 'PARTIDA ENCERRADA';
  }
  requestRematch() {
    this.audio.play('click');
    if (!this.mp.code) return;
    ui.mpRematch.disabled = true;
    if (this.mp.role === 'host') {
      ui.mpRematchStatus.textContent = 'Preparando outra corrida na mesma sala…';
      void startMultiplayerRematch(this.mp.code, this.mp.playerId)
        .then((started) => { if (!started) throw new Error('unavailable'); })
        .catch((error) => {
          const messages = {
            'need-players': 'É preciso ter pelo menos dois participantes na sala.',
            'not-host': 'Somente o anfitrião pode iniciar outra corrida.',
            unavailable: 'A sala não está disponível para outra corrida.',
            'not-found': 'A sala não está mais disponível.',
          };
          ui.mpRematchStatus.textContent = messages[error.message] || 'Não foi possível iniciar outra corrida.';
        })
        .finally(() => { if (this.phase === 'mp-result') ui.mpRematch.disabled = false; });
      return;
    }
    ui.mpRematchStatus.textContent = 'Registrando que você está pronto…';
    void requestMultiplayerRematch(this.mp.code, this.mp.playerId)
      .then(() => {
        ui.mpRematchStatus.textContent = 'Você está pronto. Aguardando o anfitrião iniciar outra corrida nesta sala.';
        const rematchLabel = ui.mpRematch.querySelector('span');
        if (rematchLabel) rematchLabel.textContent = 'PRONTO';
      })
      .catch(() => { ui.mpRematchStatus.textContent = 'A sala não está mais disponível.'; })
      .finally(() => { if (this.phase === 'mp-result') ui.mpRematch.disabled = false; });
  }
  leaveRoom(silent = false) {
    if (this.mp.code) void leaveMultiplayerRoom(this.mp.code, this.mp.role, this.mp.playerId);
    this.mp.unsubscribe?.(); this.mp.unsubscribe = null;
    clearInterval(this.mp.heartbeat);
    this.mp.code = null; this.mp.role = null; this.mp.playerId = null; this.mp.hostId = null;
    this.mp.playerIds = []; this.mp.players = []; this.mp.allPlayers = []; this.mp.racePlayerIds = [];
    this.mp.finished = false; this.mp.finalState = null; this.mp.resultsRequested = false;
    this.mp.pingSeen.clear(); this.mp.motionBuffers.clear(); this.mp.motionSignatures.clear();
    for (const cart of this.remoteCarts.values()) cart.group.visible = false;
    if (!silent) this.audio.play('click');
    this.toMenu();
  }
  difficulty() { return clamp(this.distance / 900, 0, 4); }
  updateEliminatedSpectator(dt) {
    const spectatorSpeed = Math.max(17, this.speed);
    this.time += dt;
    this.distance += spectatorSpeed * dt;
    this.track.update(dt, spectatorSpeed);
    this.particles.update(dt);
    this.updateClouds(dt);
    this.cart.group.position.y = Math.sin(this.time * 14) * .022;
    this.cart.update(dt, spectatorSpeed, 0, 0, false);
    this.cameraController.update(dt, spectatorSpeed, true);
    this.updateMultiplayer(dt);
  }
  update(dt) {
    if (this.phase === 'mp-playing' && this.mp.finished) {
      this.updateEliminatedSpectator(dt);
      return;
    }
    this.time += dt;
    const diff = this.difficulty();
    const speedProgress = clamp(this.distance / 3600, 0, 1);
    const easedSpeedProgress = speedProgress * speedProgress * (3 - 2 * speedProgress);
    this.targetSpeed = lerp(17, 40, easedSpeedProgress);
    if (this.key.down) this.targetSpeed = Math.max(10, this.targetSpeed - 7);
    if (this.powerup === 'turbo') this.targetSpeed *= 1.48;
    if (this.powerup === 'coffee-power') this.targetSpeed *= 1.83;
    if (this.powerup === 'brake') this.targetSpeed *= .56;
    const acceleratingPower = this.powerup === 'turbo' || this.powerup === 'coffee-power';
    const accelerationRate = acceleratingPower ? 4.2 : 1.15;
    const decelerationRate = this.powerup === 'brake' ? 3.8 : 2.8;
    this.speed += clamp(this.targetSpeed - this.speed, -decelerationRate * dt, accelerationRate * dt);
    this.distance += this.speed * dt;
    this.maxSpeed = Math.max(this.maxSpeed, this.speed * 2.45);
    const left = this.key.left ? -1 : 0; const right = this.key.right ? 1 : 0;
    const steer = clamp(left + right + this.mobileSteer + (this.mouseSteer ?? 0), -1, 1);
    const speedFactor = clamp(this.speed / 17, 1, 2.3);
    const wantedVelocity = steer * 6.2 * speedFactor;
    const steerResponse = lerp(7.5, 11, clamp((this.speed - 17) / 23, 0, 1));
    this.steerVelocity = steer === 0 ? 0 : damp(this.steerVelocity, wantedVelocity, steerResponse, dt);
    const wobble = this.impact > 0 ? Math.sin(this.time * 38) * this.impact * .055 : 0;
    this.playerX = clamp(this.playerX + (this.steerVelocity + wobble) * dt, -7.25, 7.25);
    this.cart.group.position.x = damp(this.cart.group.position.x, this.playerX, 11 + speedFactor * 2.5, dt);
    this.cart.group.position.y = Math.sin(this.time * 14) * .022 + Math.max(0, this.impact) * .025;
    this.cart.group.rotation.y = damp(this.cart.group.rotation.y, -steer * .08 + this.impactVelocity * .05, 6, dt);
    this.cart.update(dt, this.speed, steer, this.impactVelocity * .075, true);
    this.impact = Math.max(0, this.impact - dt * 2.4); this.impactVelocity = damp(this.impactVelocity, 0, 5, dt);
    this.track.update(dt, this.speed);
    this.obstacles.update(dt, this.distance, this.speed, diff, this.playerX, this.powerup === 'magnet');
    this.particles.update(dt);
    this.dustTimer -= dt;
    if (this.speed > 23 && this.dustTimer <= 0) {
      this.dustTimer = .17;
      for (const side of [-.94, .94]) this.particles.burst(new THREE.Vector3(this.playerX + side, .18, .91), 0xbfe7fb, 1, true);
    }
    this.visualUpdateTimer -= dt;
    if (this.visualUpdateTimer <= 0) {
      this.visualUpdateTimer = .05;
      const wind = clamp((this.speed * 2.45 - 42) / 54, 0, 1);
      gameRoot.style.setProperty('--rush', wind.toFixed(3));
      gameRoot.style.setProperty('--wind-duration', `${lerp(1.15, .27, wind).toFixed(2)}s`);
    }
    this.invulnerable = Math.max(0, this.invulnerable - dt);
    if (this.comboTimer > 0) { this.comboTimer -= dt; if (this.comboTimer <= 0) this.combo = 1; }
    if (this.powerup) { this.powerTimer -= dt; if (this.powerTimer <= 0) this.clearPower(); }
    this.updateClouds(dt);
    this.cameraController.update(dt, this.speed, true);
    this.audio.setMotion(this.speed, true);
    this.showDistanceJokes();
    this.uiUpdateTimer -= dt;
    if (this.uiUpdateTimer <= 0) { this.uiUpdateTimer = .1; this.updateUI(); }
    if (this.phase === 'mp-playing') this.updateMultiplayer(dt);
    if (this.health <= 0) this.endRun();
  }
  updateClouds(dt) {
    for (const cloud of this.clouds) {
      cloud.position.x += Math.sin(this.time * .18 + cloud.position.z) * dt * .1;
      cloud.position.z += this.speed * dt * .12;
      if (cloud.position.z > 26) { cloud.position.z = -260; cloud.position.x = random(-76, 76); cloud.position.y = random(23, 48); }
    }
  }
  onDodge(x, kind) {
    if (this.phase === 'mp-playing' && this.mp.finished) return;
    this.dodges++; this.combo = Math.min(12, this.combo + 1); this.comboTimer = 2.8;
    this.score += 30 * this.combo; this.audio.play('dodge');
    ui.combo.textContent = `x${this.combo}`; ui.comboBadge.classList.add('is-active');
    if (kind === 'cow' || kind === 'tvman' || kind === 'snowman') this.toastMessage(choose(['A vaca ficou impressionada.', 'A gerência finge que não viu.', 'A física pediu demissão.']), 1.55);
  }
  onCollision(x, kind) {
    if (this.phase === 'mp-playing' && this.mp.finished) return;
    if (this.invulnerable > 0) return;
    this.hits++; this.health = 0; this.combo = 1; this.comboTimer = 0; this.invulnerable = 1.2;
    this.targetSpeed = Math.max(11, this.speed * .62); this.speed *= .77; this.impact = .85; this.impactVelocity = x < this.playerX ? 1 : -1;
    this.steerVelocity += this.impactVelocity * (kind === 'bus' || kind === 'truck' ? 4.2 : 2.7);
    this.cameraController.bump(kind === 'bus' || kind === 'truck' || kind === 'cow' ? 1.15 : .76);
    this.burstCart(COLORS.white, 17); this.audio.play('hit');
    ui.comboBadge.classList.remove('is-active');
    this.toastMessage('Uma batida. Fim da descida.', 1.4);
  }
  onCollect(kind, x, entityType) {
    if (this.phase === 'mp-playing' && this.mp.finished) return;
    if (entityType === 'coin') {
      const values = { coin: 250, burger: 260, soda: 180, coffee: 240, coupon: 320, chips: 210, cash: 400 };
      this.score += (values[kind] || 160) * this.combo; this.audio.play('coin');
      if (kind === 'coin') { this.coinsCollected++; ui.coins.textContent = number(this.coinsCollected); }
      if (kind !== 'coin') this.toastMessage(({ burger: 'Lanche de procedência duvidosa.', soda: 'Refrigerante. Decisão questionável.', coffee: 'Café turbo desbloqueado.', coupon: 'CUPOM! Economia e velocidade.', chips: 'Batata frita: combustível oficial.', cash: 'Dinheiro caído. Sem perguntas.' })[kind], 1.1);
      return;
    }
    this.audio.play(kind === 'turbo' || kind === 'coffee-power' ? 'turbo' : 'power');
    this.applyPower(kind);
  }
  applyPower(kind) {
    const names = { turbo: ['TURBO', '↗'], magnet: ['ÍMÃ DE MOEDAS', '✳'], brake: ['FREIO ABSURDO', '↓'], 'coffee-power': ['CAFÉ DUPLO', '☕'] };
    this.powerup = kind; this.powerTimer = kind === 'coffee-power' ? 4.1 : kind === 'turbo' ? 5.2 : kind === 'brake' ? 3.8 : 8;
    if (kind === 'brake') { this.speed = Math.max(10, this.speed * .52); this.audio.play('brake'); }
    ui.powerName.textContent = names[kind][0]; ui.powerIcon.textContent = names[kind][1]; ui.powerBadge.classList.add('is-active');
    this.toastMessage(({ turbo: 'TURBO! Os pontos ficaram com pressa.', magnet: 'Moedas? Venham para a mamãe.', brake: 'Freio ABSURDO acionado.', 'coffee-power': 'CAFEÍNA. PÂNICO. VELOCIDADE.' })[kind], 1.5);
  }
  clearPower() { this.powerup = null; this.powerTimer = 0; ui.powerBadge.classList.remove('is-active'); }
  burstCart(color, amount) {
    const p = this.cart.group.position.clone(); p.y += .8; this.particles.burst(p, color, amount);
  }
  toastMessage(message, duration = 1.8) {
    if (!message) return; ui.toast.textContent = message; ui.toast.classList.add('is-visible');
    clearTimeout(this.toastTimeout); this.toastTimeout = setTimeout(() => ui.toast.classList.remove('is-visible'), duration * 1000);
  }
  showDistanceJokes() {
    const entries = [[480, 'Você realmente ainda está fazendo isso?'], [1450, 'O carrinho atingiu velocidade ilegal.'], [3000, 'DEUS ABENÇOE ESSE CARRINHO.']];
    for (const [d, message] of entries) if (this.distance >= d && !this.storyFlags.has(d)) { this.storyFlags.add(d); this.toastMessage(message, 2.25); }
  }
  updateUI() {
    ui.distance.textContent = number(this.distance); ui.speed.textContent = number(this.speed * 2.45);
    ui.best.textContent = `${number(this.meterRecords)} m`; ui.bestDistance.textContent = number(this.meterRecords);
    ui.health.textContent = this.health > 0 ? '●' : '○';
    ui.health.setAttribute('aria-label', this.health > 0 ? '1 tentativa restante' : '0 tentativas restantes');
    ui.health.style.color = this.health > 0 ? '#2788d3' : '#8aa3b8';
    ui.fill.style.width = `${Math.max(2, (this.distance % 500) / 5)}%`;
    const zones = this.distance < 500 ? 'AQUECIMENTO' : this.distance < 1500 ? 'TRÂNSITO LOCAL' : this.distance < 3000 ? 'SITUAÇÃO DELICADA' : 'CAOS ABSOLUTO';
    ui.zone.textContent = zones;
    ui.combo.textContent = `x${this.combo}`;
    ui.powerTime.textContent = `${Math.max(0, this.powerTimer).toFixed(1)} s`;
    const score = this.score + Math.floor(this.distance * 10); ui.score.textContent = number(score);
  }
  resize() {
    if (!this.renderer) return; this.camera.aspect = innerWidth / innerHeight;
    this.camera.updateProjectionMatrix(); this.renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 1)); this.renderer.setSize(innerWidth, innerHeight, false);
  }
  loop(now) {
    const dt = Math.min(.04, Math.max(0, (now - this.lastFrame) / 1000)); this.lastFrame = now;
    if (document.visibilityState === 'hidden') {
      requestAnimationFrame((t) => this.loop(t));
      return;
    }
    if (this.phase === 'playing' || this.phase === 'mp-playing') this.update(dt);
    else {
      const idleDt = Math.min(dt, .04); this.time += idleDt;
      const idleSpeed = this.phase === 'menu' ? 4.6 : 0;
      this.track.update(idleDt, idleSpeed);
      if (this.phase === 'menu') this.cart.group.position.x = 0;
      this.cart.group.position.y = Math.sin(this.time * 2.2) * .055;
      this.cart.update(idleDt, 4.5, 0, 0, false);
      this.cameraController.update(idleDt, 4.5, false);
      this.particles.update(idleDt);
    }
    this.renderer.render(this.scene, this.camera);
    requestAnimationFrame((t) => this.loop(t));
  }
}

function createSkyTexture() {
  const sky = document.createElement('canvas'); sky.width = 1024; sky.height = 512;
  const context = sky.getContext('2d');
  const gradient = context.createLinearGradient(0, 0, 0, sky.height);
  gradient.addColorStop(0, '#4b9bd3');
  gradient.addColorStop(.38, '#78bee9');
  gradient.addColorStop(.72, '#c6e6f5');
  gradient.addColorStop(1, '#edf8fd');
  context.fillStyle = gradient; context.fillRect(0, 0, sky.width, sky.height);
  const glow = context.createRadialGradient(740, 292, 8, 740, 292, 180);
  glow.addColorStop(0, 'rgba(255,255,255,.66)'); glow.addColorStop(.35, 'rgba(239,250,255,.27)'); glow.addColorStop(1, 'rgba(239,250,255,0)');
  context.fillStyle = glow; context.fillRect(0, 0, sky.width, sky.height);
  const texture = new THREE.CanvasTexture(sky);
  texture.mapping = THREE.EquirectangularReflectionMapping; texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function material(color, roughness = .82, metalness = 0, emissive = 0, flat = false) {
  return new THREE.MeshStandardMaterial({ color, roughness, metalness, emissive, flatShading: flat });
}
function asphaltMaterial() {
  const canvas = document.createElement('canvas'); canvas.width = 256; canvas.height = 256;
  const context = canvas.getContext('2d'); context.fillStyle = '#f4f0df'; context.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 4200; i++) {
    const alpha = random(.015, .105); const shade = Math.random() > .54 ? '22,37,34' : '255,252,228';
    context.fillStyle = `rgba(${shade},${alpha})`; context.fillRect(Math.random() * 256, Math.random() * 256, random(.3, 1.8), random(.3, 1.5));
  }
  for (let i = 0; i < 46; i++) {
    context.fillStyle = 'rgba(28,43,40,0.035)'; context.fillRect(Math.random() * 256, Math.random() * 256, random(7, 42), random(.35, 1));
  }
  const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping; texture.wrapT = THREE.RepeatWrapping; texture.repeat.set(8, 800);
  return new THREE.MeshStandardMaterial({ color: COLORS.road, map: texture, roughness: .97, metalness: 0, flatShading: true });
}
function metal(color) { return new THREE.MeshStandardMaterial({ color, roughness: .32, metalness: .78 }); }
function box(parent, size, position, mat, radius = 0) {
  const geometry = new THREE.BoxGeometry(...size); const mesh = new THREE.Mesh(geometry, mat); mesh.position.set(...position); parent.add(mesh); return mesh;
}
function sphere(parent, radius, position, mat, detail = 1) {
  const mesh = new THREE.Mesh(new THREE.IcosahedronGeometry(radius, detail), mat); mesh.position.set(...position); parent.add(mesh); return mesh;
}
function rodBetween(parent, start, end, radius, mat, radialSegments = 7) {
  const delta = new THREE.Vector3().subVectors(end, start); const length = delta.length();
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, length, radialSegments), mat);
  mesh.position.copy(start).add(end).multiplyScalar(.5); mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), delta.normalize()); parent.add(mesh); return mesh;
}
function disposeObject(root) {
  const geometries = new Set(); const materials = new Set();
  root.traverse((o) => { if (o.geometry) geometries.add(o.geometry); if (o.material) for (const m of (Array.isArray(o.material) ? o.material : [o.material])) materials.add(m); });
  for (const g of geometries) g.dispose(); for (const m of materials) m.dispose();
}
function disposeChildren(root) {
  const children = [...root.children];
  for (const child of children) { root.remove(child); disposeObject(child); }
}
function obstacleRadius(kind) {
  return ({ cone: .72, crate: .9, bin: .86, sign: .63, cart: .96, tree: 1.15, car: 1.28, bike: .85, bench: 1, hydrant: .64, bus: 1.75, truck: 1.7, barrier: .9, crowd: 1.45, cow: 1.15, tvman: 1.1, 'oncoming-cart': 1, 'kid-ball': .91, dog: .79, 'cart-worker': 1.2, fridge: 1.12, sofa: 1.4, snowman: .84 })[kind] || 1;
}
function isPowerup(kind) { return ['turbo', 'magnet', 'brake', 'coffee-power'].includes(kind); }

function createTree() {
  const g = new THREE.Group(); const trunk = new THREE.Mesh(new THREE.CylinderGeometry(.19, .34, 2.4, 7), material(COLORS.bark, .94, 0, 0, true)); trunk.position.y = 1.13; g.add(trunk);
  sphere(g, 1.02, [0, 2.53, 0], material(COLORS.leaf, .96, 0, 0, true), 1);
  sphere(g, .72, [-.55, 2.88, .03], material(COLORS.leaf2, .96, 0, 0, true), 1);
  sphere(g, .73, [.56, 2.93, -.02], material(0x78aeb4, .96, 0, 0, true), 1);
  return g;
}
function createStreetLamp() {
  const g = new THREE.Group(); const dark = metal(0x496d89); const cap = material(COLORS.white, .52, .03, 0x244963, true);
  const post = new THREE.Mesh(new THREE.CylinderGeometry(.075, .11, 5.1, 8), dark); post.position.y = 2.55; g.add(post);
  rodBetween(g, new THREE.Vector3(0, 4.82, 0), new THREE.Vector3(.72, 5.06, 0), .065, dark);
  const shade = new THREE.Mesh(new THREE.CapsuleGeometry(.22, .19, 3, 7), cap); shade.rotation.z = Math.PI / 2; shade.position.set(.78, 5, 0); g.add(shade);
  const bulb = new THREE.Mesh(new THREE.SphereGeometry(.13, 8, 6), material(0xf4fbff, .24, 0, 0x9edcff)); bulb.position.set(.8, 4.86, 0); g.add(bulb);
  return g;
}
function createBench() {
  const g = new THREE.Group(); const wood = material(0x7596ae, .87, 0, 0, true); const iron = metal(0x496d89);
  for (let i = 0; i < 4; i++) { const slat = box(g, [1.55, .11, .15], [0, .57, -.18 + i * .13], wood); slat.rotation.x = -.11; }
  for (const x of [-.57, .57]) {
    rodBetween(g, new THREE.Vector3(x, 0, -.32), new THREE.Vector3(x, .55, -.26), .055, iron);
    rodBetween(g, new THREE.Vector3(x, 0, .3), new THREE.Vector3(x, .55, .26), .055, iron);
    rodBetween(g, new THREE.Vector3(x, .46, -.21), new THREE.Vector3(x, 1.08, -.3), .047, iron);
    box(g, [.1, .73, .10], [x, .87, -.28], wood);
  }
  return g;
}
function createHydrant() {
  const g = new THREE.Group(); const red = material(0x3989c5, .72, 0, 0, true); const dark = metal(0x315e80);
  const base = new THREE.Mesh(new THREE.CylinderGeometry(.30, .39, .16, 9), dark); base.position.y = .08; g.add(base);
  const body = new THREE.Mesh(new THREE.CylinderGeometry(.22, .27, .66, 9), red); body.position.y = .46; g.add(body);
  const top = new THREE.Mesh(new THREE.CylinderGeometry(.16, .24, .19, 9), red); top.position.y = .86; g.add(top);
  const cap = new THREE.Mesh(new THREE.CylinderGeometry(.29, .12, .16, 8), red); cap.position.y = .99; g.add(cap);
  for (const side of [-1, 1]) {
    const nozzle = new THREE.Mesh(new THREE.CylinderGeometry(.11, .12, .28, 8), red); nozzle.rotation.z = Math.PI / 2; nozzle.position.set(side * .26, .56, 0); g.add(nozzle);
    const end = new THREE.Mesh(new THREE.CylinderGeometry(.12, .12, .035, 8), dark); end.rotation.z = Math.PI / 2; end.position.set(side * .4, .56, 0); g.add(end);
  }
  return g;
}
function createStorefront() {
  const g = new THREE.Group(); const wall = material(choose([0xf2f9fd, 0xc9e5f4, 0xb8dcee, 0xddeef8]), .94, 0, 0, true);
  const width = random(6.5, 9.5); const height = random(4.8, 7.2);
  const body = new THREE.Mesh(new THREE.BoxGeometry(width, height, 4.8), wall); body.position.y = height / 2; g.add(body);
  const signMat = material(choose([COLORS.blue, COLORS.ink, COLORS.white, 0x7bb9e2]), .65, 0, 0, true);
  box(g, [width + .2, .8, .16], [0, height - .7, 2.5], signMat);
  const awning = new THREE.Mesh(new THREE.BoxGeometry(width * .86, .22, 1.3), material(COLORS.cream, .7, 0, 0, true)); awning.position.set(0, height - 1.65, 3); g.add(awning);
  box(g, [width * .65, 2.05, .1], [0, 1.25, 2.49], material(0x668f8b, .22, .12, 0, true));
  for (let x = -width * .22; x <= width * .23; x += width * .22) box(g, [.1, 2, .12], [x, 1.25, 2.56], material(0xf8e8c7, .46, 0, 0, true));
  const roof = new THREE.Mesh(new THREE.ConeGeometry(width * .72, 1.45, 4), material(0x315b7c, .92, 0, 0, true)); roof.position.set(0, height + .55, 0); roof.rotation.y = Math.PI / 4; roof.scale.z = .58; g.add(roof);
  const awningFabric = new THREE.Mesh(new THREE.BoxGeometry(width * .9, .25, 1.18), material(COLORS.orange, .7, 0, 0, true)); awningFabric.position.set(0, height - 1.53, 3.06); g.add(awningFabric);
  return g;
}
function createSideBuilding() {
  const apartment = Math.random() < .38;
  const width = apartment ? random(9, 13) : random(6.5, 9.5);
  const depth = apartment ? random(8, 11) : random(6, 9);
  const floors = apartment ? THREE.MathUtils.randInt(2, 4) : THREE.MathUtils.randInt(1, 2);
  const floorHeight = apartment ? 2.35 : 2.65;
  const baseHeight = .28;
  const wallHeight = floors * floorHeight;
  const roofHeight = apartment ? .3 : random(1.05, 1.65);
  const building = new THREE.Group();
  const wallMat = material(choose([0xeaf6fd, 0xd2e9f5, 0xb9dcef, 0xf6fbff]), .92, 0, 0, true);
  const baseMat = material(0x789bb2, .94, 0, 0, true);
  const roofMat = material(choose([0x285c83, 0x397da8, 0x6fa8ce, 0xf5fbff]), .9, 0, 0, true);
  const trimMat = material(0xf8fcff, .7, 0, 0, true);
  const glassMat = material(0x63a9d0, .28, .06, 0x102b43, true);
  const foundation = new THREE.Mesh(new THREE.BoxGeometry(width + .42, baseHeight, depth + .42), baseMat);
  foundation.position.y = baseHeight / 2; foundation.castShadow = false; foundation.receiveShadow = false; building.add(foundation);
  const walls = new THREE.Mesh(new THREE.BoxGeometry(width, wallHeight, depth), wallMat);
  walls.position.y = baseHeight + wallHeight / 2; walls.castShadow = false; walls.receiveShadow = false; building.add(walls);

  if (apartment) {
    const roof = new THREE.Mesh(new THREE.BoxGeometry(width + .32, .24, depth + .32), roofMat);
    roof.position.y = baseHeight + wallHeight + .12; roof.castShadow = false; roof.receiveShadow = false; building.add(roof);
  } else {
    const roof = new THREE.Mesh(new THREE.ConeGeometry(width * .79, roofHeight, 4), roofMat);
    roof.position.y = baseHeight + wallHeight + roofHeight / 2; roof.rotation.y = Math.PI / 4;
    roof.scale.z = depth / width; roof.castShadow = false; roof.receiveShadow = false; building.add(roof);
  }

  const columns = apartment ? 3 : 2;
  const frameGeometry = new THREE.BoxGeometry(1.03, 1.12, .13);
  const glassGeometry = new THREE.BoxGeometry(.79, .88, .04);
  const windowFrames = [];
  const windowPanes = [];
  const dummy = new THREE.Object3D();
  const addWindow = (x, y, z, rotationY) => {
    dummy.position.set(x, y, z); dummy.rotation.set(0, rotationY, 0); dummy.updateMatrix();
    windowFrames.push(dummy.matrix.clone());
    const pane = new THREE.Object3D();
    pane.position.set(x + Math.sin(rotationY) * .09, y, z + Math.cos(rotationY) * .09);
    pane.rotation.y = rotationY; pane.updateMatrix(); windowPanes.push(pane.matrix.clone());
  };
  for (let floor = 0; floor < floors; floor++) {
    const y = baseHeight + floor * floorHeight + floorHeight * .56;
    for (let column = 0; column < columns; column++) {
      const x = (column - (columns - 1) / 2) * width / (columns + .15);
      addWindow(x, y, depth / 2 + .055, 0);
      addWindow(x, y, -depth / 2 - .055, Math.PI);
    }
    const sideWindows = depth > 8.5 ? 2 : 1;
    for (let column = 0; column < sideWindows; column++) {
      const z = (column - (sideWindows - 1) / 2) * depth / (sideWindows + .1);
      addWindow(width / 2 + .055, y, z, Math.PI / 2);
      addWindow(-width / 2 - .055, y, z, -Math.PI / 2);
    }
  }
  const frames = new THREE.InstancedMesh(frameGeometry, trimMat, windowFrames.length);
  const panes = new THREE.InstancedMesh(glassGeometry, glassMat, windowPanes.length);
  windowFrames.forEach((matrix, index) => frames.setMatrixAt(index, matrix));
  windowPanes.forEach((matrix, index) => panes.setMatrixAt(index, matrix));
  frames.instanceMatrix.needsUpdate = true; panes.instanceMatrix.needsUpdate = true;
  frames.castShadow = false; panes.castShadow = false; panes.receiveShadow = false;
  building.add(frames, panes);

  const front = depth / 2 + .09;
  const door = new THREE.Mesh(new THREE.BoxGeometry(.88, 1.85, .09), material(0x315f86, .88, 0, 0, true));
  door.position.set(0, baseHeight + .94, front); door.castShadow = false; building.add(door);
  const handle = new THREE.Mesh(new THREE.SphereGeometry(.055, 8, 6), material(0xd8eaf5, .42, .22, 0, true));
  handle.position.set(.27, baseHeight + .95, front + .06); building.add(handle);
  return building;
}
function createMarketSign() {
  const g = new THREE.Group(); const pole = metal(0x596c62);
  const mast = new THREE.Mesh(new THREE.CylinderGeometry(.085, .11, 4.1, 8), pole); mast.position.y = 2.03; g.add(mast);
  const board = new THREE.Mesh(new THREE.BoxGeometry(1.42, .89, .17), material(COLORS.white, .66, 0, 0, true)); board.position.y = 3.45; g.add(board);
  box(g, [1.02, .11, .19], [0, 3.59, .02], material(COLORS.orange, .6, 0, 0, true));
  const arrow = new THREE.Mesh(new THREE.ConeGeometry(.20, .32, 3), material(COLORS.ink, .67, 0, 0, true)); arrow.rotation.z = -Math.PI / 2; arrow.position.set(.37, 3.21, .12); g.add(arrow);
  return g;
}
function createVehicle(kind = 'car') {
  const g = new THREE.Group(); const bus = kind === 'bus'; const truck = kind === 'truck'; const van = kind === 'van';
  const width = bus ? 2.92 : truck ? 2.72 : van ? 2.45 : 2.15;
  const length = bus ? 7.8 : truck ? 6.3 : van ? 4.2 : 3.65;
  const bodyMat = material(bus ? 0x4c91c5 : truck ? 0x547f9f : van ? 0xd9eef8 : choose([0x347cba, 0x5d9bc9, 0x91bad7, 0xe9f5fb]), .66, .07, 0, true);
  const lowerH = bus ? 1.85 : truck ? 1.4 : 1.1;
  const lower = new THREE.Mesh(new THREE.BoxGeometry(width, lowerH, length), bodyMat); lower.position.y = lowerH * .5 + .45; g.add(lower);
  if (truck) {
    const cargo = new THREE.Mesh(new THREE.BoxGeometry(width * .94, 2.4, length * .53), material(0xf0dfbb, .92, 0, 0, true)); cargo.position.set(0, 2.3, -.78); g.add(cargo);
    const cab = new THREE.Mesh(new THREE.BoxGeometry(width * .94, 1.35, 1.58), bodyMat); cab.position.set(0, 1.83, 1.75); g.add(cab);
  } else if (bus) {
    const windowMat = material(0x8bb5b5, .23, .08, 0, true);
    for (const side of [-1, 1]) {
      for (let i = 0; i < 4; i++) {
        const window = new THREE.Mesh(new THREE.BoxGeometry(.045, .91, .94), windowMat); window.position.set(side * (width / 2 + .018), 1.97, -.2 + i * 1.45); g.add(window);
      }
    }
    const windscreen = new THREE.Mesh(new THREE.BoxGeometry(width * .76, .78, .05), windowMat); windscreen.position.set(0, 1.94, length / 2 + .02); g.add(windscreen);
  } else {
    const cabin = new THREE.Mesh(new THREE.BoxGeometry(width * .72, .9, length * .47), material(0x8eb5b3, .2, .08, 0, true)); cabin.position.set(0, 1.57, -.05); g.add(cabin);
    const roof = new THREE.Mesh(new THREE.BoxGeometry(width * .78, .15, length * .43), bodyMat); roof.position.set(0, 2.05, -.08); g.add(roof);
    box(g, [width * .58, .58, .045], [0, 1.55, length * .28], material(0x8eb5b3, .24, .04, 0, true));
  }
  const bumper = metal(0x798981);
  for (const z of [-length / 2 - .07, length / 2 + .07]) {
    box(g, [width * .93, .16, .21], [0, .52, z], bumper);
    for (const side of [-1, 1]) {
      const wheel = new THREE.Mesh(new THREE.CylinderGeometry(.39, .39, .21, 10), material(COLORS.tire, .91, 0, 0, true)); wheel.rotation.z = Math.PI / 2; wheel.position.set(side * (width / 2 - .08), .45, z * .61); g.add(wheel);
      const lamp = new THREE.Mesh(new THREE.SphereGeometry(.105, 7, 6), material(z > 0 ? COLORS.yellow : COLORS.coral, .24, .04, z > 0 ? 0x9d792d : 0, true)); lamp.position.set(side * width * .37, .88, z > 0 ? z : -length / 2 - .19); g.add(lamp);
    }
  }
  const grill = new THREE.Mesh(new THREE.BoxGeometry(width * .33, .4, .055), metal(0x738780)); grill.position.set(0, .88, length / 2 + .08); g.add(grill);
  if (bus) {
    const route = new THREE.Mesh(new THREE.BoxGeometry(1.4, .26, .08), material(COLORS.yellow, .58, 0, 0, true)); route.position.set(0, 2.76, length / 2 + .035); g.add(route);
  }
  return g;
}
function createBike() {
  const g = new THREE.Group(); const rubber = material(COLORS.tire, .85, 0, 0, true); const frame = metal(COLORS.orange);
  for (const z of [-.65, .65]) {
    const wheel = new THREE.Mesh(new THREE.TorusGeometry(.49, .052, 7, 14), rubber); wheel.rotation.y = Math.PI / 2; wheel.position.set(0, .58, z); g.add(wheel);
    for (let i = 0; i < 6; i++) rodBetween(g, new THREE.Vector3(-.02, .58, z), new THREE.Vector3(.02, .58 + Math.sin(i * Math.PI / 3) * .43, z + Math.cos(i * Math.PI / 3) * .43), .012, metal(0xb8c1b2), 5);
  }
  const a = new THREE.Vector3(0, .58, -.65), b = new THREE.Vector3(0, .58, .65), c = new THREE.Vector3(0, 1.03, -.13);
  rodBetween(g, a, c, .045, frame); rodBetween(g, b, c, .045, frame); rodBetween(g, a, b, .04, frame);
  rodBetween(g, c, new THREE.Vector3(0, 1.03, .53), .035, frame); rodBetween(g, new THREE.Vector3(-.32, 1.04, .49), new THREE.Vector3(.32, 1.04, .57), .035, metal(0x485d55));
  rodBetween(g, new THREE.Vector3(0, 1.03, -.13), new THREE.Vector3(0, 1.2, -.43), .034, frame); box(g, [.42, .06, .14], [0, 1.23, -.44], material(0x443f37, .8, 0, 0, true));
  return g;
}
function createCone() {
  const g = new THREE.Group(); const base = new THREE.Mesh(new THREE.CylinderGeometry(.51, .55, .12, 8), material(0x246fae, .82, 0, 0, true)); base.position.y = .06; g.add(base);
  const body = new THREE.Mesh(new THREE.CylinderGeometry(.045, .39, 1.19, 7), material(0x388fd0, .74, 0, 0, true)); body.position.y = .66; g.add(body);
  const band = new THREE.Mesh(new THREE.CylinderGeometry(.13, .24, .16, 7), material(COLORS.cream, .67, 0, 0, true)); band.position.y = .68; g.add(band); return g;
}
function createCrate() {
  const g = new THREE.Group(); const wood = material(0x6b95b4, .91, 0, 0, true); const dark = material(0x355d7d, .93, 0, 0, true);
  const frame = new THREE.Mesh(new THREE.BoxGeometry(1.18, 1.1, 1.18), dark); frame.position.y = .55; g.add(frame);
  for (let y = .19; y < 1.02; y += .25) {
    box(g, [1.12, .15, .055], [0, y, -.6], wood); box(g, [1.12, .15, .055], [0, y, .6], wood);
    box(g, [.055, .15, 1.12], [-.6, y, 0], wood); box(g, [.055, .15, 1.12], [.6, y, 0], wood);
  }
  for (const x of [-.51, .51]) for (const z of [-.51, .51]) box(g, [.13, 1.15, .13], [x, .57, z], material(0xa9cde2, .9, 0, 0, true));
  const stamp = new THREE.Mesh(new THREE.BoxGeometry(.32, .24, .025), material(0x254c6d, .86, 0, 0, true)); stamp.position.set(0, .62, -.635); g.add(stamp);
  return g;
}
function createBin() {
  const g = new THREE.Group(); const bodyMat = material(choose([0x477b9f, 0x5e91b6, 0x7da9c5]), .86, 0, 0, true);
  const body = new THREE.Mesh(new THREE.CylinderGeometry(.48, .39, 1.16, 10), bodyMat); body.position.y = .58; g.add(body);
  const rim = new THREE.Mesh(new THREE.TorusGeometry(.46, .06, 6, 12), metal(0xc3bd9f)); rim.rotation.x = Math.PI / 2; rim.position.y = 1.1; g.add(rim);
  const lid = new THREE.Mesh(new THREE.CylinderGeometry(.51, .51, .1, 10), material(COLORS.white, .65, 0, 0, true)); lid.position.set(0, 1.22, .01); g.add(lid);
  const slot = new THREE.Mesh(new THREE.BoxGeometry(.35, .035, .13), material(0x244763, .91, 0, 0, true)); slot.position.set(0, 1.28, .03); g.add(slot);
  for (let i = 0; i < 4; i++) { const rib = new THREE.Mesh(new THREE.BoxGeometry(.036, .75, .03), material(0xa6c8dc, .83, 0, 0, true)); rib.position.set(-.22 + i * .145, .56, -.4); g.add(rib); }
  return g;
}
function createObstacle(kind) {
  if (kind === 'cone') return createCone();
  if (kind === 'crate') return createCrate();
  if (kind === 'bin') return createBin();
  if (kind === 'car' || kind === 'bus' || kind === 'truck') return createVehicle(kind);
  if (kind === 'bike') return createBike();
  if (kind === 'bench') return createBench();
  if (kind === 'tree') return createTree();
  if (kind === 'hydrant') return createHydrant();
  if (kind === 'cart' || kind === 'oncoming-cart') { const cart = buildPropCart(); if (kind === 'oncoming-cart') { const driver = makePedestrian(COLORS.lilac); driver.position.set(0, .2, .78); cart.add(driver); cart.rotation.y = Math.PI; } return cart; }
  if (kind === 'sign') { const sign = createMarketSign(); sign.scale.set(.72, .72, .72); return sign; }
  if (kind === 'barrier') return createBarrier();
  if (kind === 'crowd') return createCrowd();
  if (kind === 'cow') return createCow();
  if (kind === 'tvman') return createTVMan();
  if (kind === 'kid-ball') return createKidBall();
  if (kind === 'dog') return createDog();
  if (kind === 'cart-worker') return createCartWorker();
  if (kind === 'fridge') return createFridge();
  if (kind === 'sofa') return createSofa();
  if (kind === 'snowman') return createSnowman();
  return createCrate();
}
function buildPropCart() {
  const g = new THREE.Group(); const frame = metal(COLORS.darkMetal); const silver = metal(COLORS.metal);
  for (const side of [-1, 1]) {
    rodBetween(g, new THREE.Vector3(side * .56, .75, -.52), new THREE.Vector3(side * .39, .15, .26), .032, silver);
    rodBetween(g, new THREE.Vector3(side * .42, .15, .25), new THREE.Vector3(side * .4, .08, .63), .03, frame);
    for (let i = 1; i < 4; i++) rodBetween(g, new THREE.Vector3(side * .56, .27 + i * .12, -.46), new THREE.Vector3(side * .48, .27 + i * .12, .37), .018, silver);
  }
  for (let i = 1; i < 5; i++) rodBetween(g, new THREE.Vector3(-.5 + i * .2, .27, -.44), new THREE.Vector3(-.5 + i * .2, .7, -.5), .019, silver);
  rodBetween(g, new THREE.Vector3(-.56, .76, -.52), new THREE.Vector3(.56, .76, -.52), .034, silver);
  rodBetween(g, new THREE.Vector3(-.39, .08, .64), new THREE.Vector3(.39, .08, .64), .034, frame);
  for (const x of [-.47, .47]) for (const z of [-.46, .52]) {
    const wheel = new THREE.Mesh(new THREE.TorusGeometry(.12, .04, 6, 10), material(COLORS.tire, .95, 0, 0, true)); wheel.rotation.y = Math.PI / 2; wheel.position.set(x, .13, z); g.add(wheel);
  }
  return g;
}
function makePedestrian(shirt = 0xd27561) {
  const g = new THREE.Group(); const skin = material(0xe2ad80, .9, 0, 0, true); const clothes = material(shirt, .89, 0, 0, true); const pants = material(0x40534c, .94, 0, 0, true);
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(.28, .47, 3, 7), clothes); body.position.y = .94; g.add(body);
  sphere(g, .245, [0, 1.69, 0], skin, 1); sphere(g, .25, [0, 1.79, .02], material(0x493d36, .96, 0, 0, true), 1);
  for (const side of [-1, 1]) {
    const leg = new THREE.Mesh(new THREE.CapsuleGeometry(.09, .45, 3, 6), pants); leg.position.set(side * .13, .34, .04); g.add(leg);
    const arm = new THREE.Mesh(new THREE.CapsuleGeometry(.075, .44, 3, 6), clothes); arm.position.set(side * .35, 1.02, -.04); arm.rotation.z = side * .19; g.add(arm);
    const shoe = new THREE.Mesh(new THREE.CapsuleGeometry(.07, .15, 3, 5), material(0xf0ca7f, .8, 0, 0, true)); shoe.position.set(side * .14, .09, -.05); g.add(shoe);
  }
  return g;
}
function createBarrier() {
  const g = new THREE.Group(); const bar = box(g, [2.8, .36, .24], [0, .84, 0], material(0xf2dfc3, .85, 0, 0, true));
  for (let i = 0; i < 5; i++) { const stripe = box(g, [.36, .39, .26], [-1.1 + i * .55, .84, .01], material(i % 2 ? COLORS.orange : COLORS.white, .7, 0, 0, true)); stripe.rotation.z = -.64; }
  for (const x of [-1.08, 1.08]) {
    rodBetween(g, new THREE.Vector3(x, 0, .04), new THREE.Vector3(x, .69, .04), .06, metal(0x55655f));
    const foot = box(g, [.5, .08, .32], [x, .06, .04], material(0x4c625b, .9, 0, 0, true));
  }
  return g;
}
function createCrowd() {
  const g = new THREE.Group(); const palette = [0x578b87, 0xd67b62, 0x687ca1, 0xc5a44f];
  for (let i = 0; i < 3; i++) { const person = makePedestrian(palette[i]); person.scale.setScalar(.78 + Math.random() * .15); person.position.set((i - 1) * .79, 0, Math.sin(i * 2) * .18); g.add(person); }
  const banner = box(g, [2.6, .15, .06], [0, 2.05, -.12], material(COLORS.yellow, .76, 0, 0, true)); banner.rotation.z = -.08;
  return g;
}
function createCow() {
  const g = new THREE.Group(); const hide = material(0xf1ead8, .95, 0, 0, true); const black = material(0x333b37, .97, 0, 0, true); const pink = material(0xe59483, .85, 0, 0, true); const horn = material(0xe9d9ad, .85, 0, 0, true);
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(.63, .83, 4, 8), hide); body.rotation.x = Math.PI / 2; body.position.y = 1.17; g.add(body);
  sphere(g, .35, [-.46, 1.37, -.16], black, 0); sphere(g, .28, [.35, .98, .18], black, 0); sphere(g, .23, [-.09, 1.7, -.35], black, 0);
  const head = new THREE.Mesh(new THREE.SphereGeometry(.42, 10, 7), hide); head.position.set(0, 1.45, -.88); g.add(head);
  const muzzle = new THREE.Mesh(new THREE.SphereGeometry(.24, 8, 6), pink); muzzle.position.set(0, 1.28, -1.24); g.add(muzzle);
  for (const side of [-1, 1]) {
    const hornMesh = new THREE.Mesh(new THREE.ConeGeometry(.11, .37, 5), horn); hornMesh.position.set(side * .3, 1.82, -.77); hornMesh.rotation.z = side * .3; g.add(hornMesh);
    const ear = new THREE.Mesh(new THREE.ConeGeometry(.12, .4, 5), pink); ear.position.set(side * .49, 1.52, -.66); ear.rotation.z = side * (Math.PI / 2 + .35); g.add(ear);
    const eye = new THREE.Mesh(new THREE.SphereGeometry(.047, 6, 5), material(0x292d29, .6, 0, 0, true)); eye.position.set(side * .22, 1.54, -1.23); g.add(eye);
    const leg = new THREE.Mesh(new THREE.CylinderGeometry(.105, .12, .57, 6), hide); leg.position.set(side * .36, .4, side * .31); g.add(leg);
    const hoof = new THREE.Mesh(new THREE.CylinderGeometry(.13, .16, .17, 6), material(0x524b3e, .9, 0, 0, true)); hoof.position.set(side * .36, .12, side * .31); g.add(hoof);
  }
  const bell = new THREE.Mesh(new THREE.SphereGeometry(.11, 7, 6), material(COLORS.yellow, .45, .3, 0, true)); bell.position.set(0, .79, -1.03); g.add(bell);
  return g;
}
function createTVMan() {
  const g = new THREE.Group(); const man = makePedestrian(0x6689a0); man.position.z = -.28; g.add(man);
  const tv = new THREE.Group(); box(tv, [1.08, .88, .72], [0, 1.08, -.7], material(0x4c514d, .59, .05, 0, true));
  const screen = new THREE.Mesh(new THREE.BoxGeometry(.86, .62, .045), material(0x6f8582, .27, .05, 0, true)); screen.position.set(0, 1.1, -1.08); tv.add(screen);
  for (const side of [-1, 1]) sphere(tv, .035, [side * .46, 1.5, -.86], material(0xd6d2be, .6, .4, 0, true), 0);
  tv.position.x = .12; tv.position.y = .18; g.add(tv);
  return g;
}
function createKidBall() {
  const g = new THREE.Group(); const child = makePedestrian(0xf0c75c); child.scale.setScalar(.72); child.position.set(-.62, 0, .18); g.add(child);
  const ball = new THREE.Mesh(new THREE.SphereGeometry(.4, 10, 8), material(0xef7158, .5, 0, 0, true)); ball.position.set(.53, .41, -.2); g.add(ball);
  const stripe = new THREE.Mesh(new THREE.TorusGeometry(.402, .028, 5, 14), material(COLORS.cream, .45, 0, 0, true)); stripe.position.copy(ball.position); stripe.rotation.x = Math.PI / 2; g.add(stripe);
  return g;
}
function createDog() {
  const g = new THREE.Group(); const fur = material(0xc89761, .94, 0, 0, true); const dark = material(0x544138, .91, 0, 0, true);
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(.25, .63, 3, 7), fur); body.rotation.x = Math.PI / 2; body.position.y = .55; g.add(body);
  const head = new THREE.Mesh(new THREE.SphereGeometry(.27, 9, 7), fur); head.position.set(0, .73, -.66); g.add(head);
  const muzzle = new THREE.Mesh(new THREE.ConeGeometry(.15, .37, 7), fur); muzzle.rotation.x = -Math.PI / 2; muzzle.position.set(0, .61, -.95); g.add(muzzle);
  const nose = new THREE.Mesh(new THREE.SphereGeometry(.07, 7, 5), dark); nose.position.set(0, .7, -1.11); g.add(nose);
  for (const side of [-1, 1]) {
    const ear = new THREE.Mesh(new THREE.CapsuleGeometry(.07, .29, 3, 5), dark); ear.position.set(side * .23, .87, -.62); ear.rotation.z = side * -.45; g.add(ear);
    const leg = new THREE.Mesh(new THREE.CapsuleGeometry(.07, .31, 3, 5), fur); leg.position.set(side * .16, .22, -.32); g.add(leg);
  }
  const tail = new THREE.Mesh(new THREE.CapsuleGeometry(.045, .39, 2, 5), fur); tail.position.set(0, .74, .52); tail.rotation.x = -.9; g.add(tail);
  return g;
}
function createCartWorker() {
  const g = new THREE.Group(); const worker = makePedestrian(COLORS.mint); worker.position.set(0, 0, .44); worker.scale.setScalar(.83); g.add(worker);
  const cart = buildPropCart(); cart.position.z = -.77; g.add(cart);
  const extra = buildPropCart(); extra.position.set(.45, .14, -1.27); extra.rotation.y = .12; extra.scale.setScalar(.74); g.add(extra);
  const third = buildPropCart(); third.position.set(-.4, .28, -1.56); third.rotation.y = -.12; third.scale.setScalar(.57); g.add(third);
  return g;
}
function createFridge() {
  const g = new THREE.Group(); const white = material(0xe9e5d7, .6, .06, 0, true); const edge = metal(0xaeb8ae);
  const body = new THREE.Mesh(new THREE.BoxGeometry(1.55, 2.55, 1.25), white); body.position.y = 1.28; body.rotation.z = .2; g.add(body);
  const split = box(g, [1.39, .055, .055], [0, 1.32, .65], edge); split.rotation.z = .2;
  const handle = new THREE.Mesh(new THREE.CapsuleGeometry(.045, .51, 3, 6), edge); handle.position.set(.49, 1.91, .7); handle.rotation.z = .2; g.add(handle);
  const veggie = new THREE.Mesh(new THREE.CircleGeometry(.24, 7), material(COLORS.mint, .7, 0, 0, true)); veggie.position.set(-.28, .56, .68); g.add(veggie);
  return g;
}
function createSofa() {
  const g = new THREE.Group(); const upholstery = material(0x9b6f86, .91, 0, 0, true); const piping = material(0xc99ca3, .91, 0, 0, true);
  const base = new THREE.Mesh(new THREE.BoxGeometry(2.9, .55, 1.23), upholstery); base.position.y = .55; g.add(base);
  const back = new THREE.Mesh(new THREE.BoxGeometry(2.9, 1.2, .36), upholstery); back.position.set(0, 1.24, .43); g.add(back);
  for (const x of [-.93, 0, .93]) {
    const cushion = new THREE.Mesh(new THREE.BoxGeometry(.89, .45, .97), piping); cushion.position.set(x, .95, -.05); g.add(cushion);
    const button = new THREE.Mesh(new THREE.SphereGeometry(.035, 5, 4), upholstery); button.position.set(x, 1.2, -.02); g.add(button);
  }
  for (const x of [-1.12, 1.12]) { const arm = new THREE.Mesh(new THREE.CapsuleGeometry(.22, .75, 3, 7), upholstery); arm.rotation.x = Math.PI / 2; arm.position.set(x, .91, -.04); g.add(arm); }
  for (const x of [-1.07, 1.07]) for (const z of [-.42, .4]) { const leg = new THREE.Mesh(new THREE.CylinderGeometry(.065, .085, .33, 6), material(0x71513f, .88, 0, 0, true)); leg.position.set(x, .16, z); g.add(leg); }
  return g;
}
function createSnowman() {
  const g = new THREE.Group(); const snow = material(0xf5f1da, .88, 0, 0, true); const scarf = material(COLORS.orange, .82, 0, 0, true);
  sphere(g, .58, [0, .6, 0], snow, 1); sphere(g, .43, [0, 1.45, 0], snow, 1); sphere(g, .3, [0, 2.06, 0], snow, 1);
  const hat = new THREE.Mesh(new THREE.CylinderGeometry(.23, .24, .43, 7), material(0x48645d, .9, 0, 0, true)); hat.position.y = 2.47; g.add(hat);
  const brim = new THREE.Mesh(new THREE.CylinderGeometry(.39, .39, .08, 8), material(0x48645d, .9, 0, 0, true)); brim.position.y = 2.25; g.add(brim);
  const wrap = new THREE.Mesh(new THREE.TorusGeometry(.39, .105, 5, 10), scarf); wrap.position.set(0, 1.73, 0); wrap.rotation.x = Math.PI / 2; g.add(wrap);
  for (const x of [-.12, .12]) sphere(g, .045, [x, 2.11, -.27], material(0x293a37, .7, 0, 0, true), 0);
  const carrot = new THREE.Mesh(new THREE.ConeGeometry(.095, .43, 5), material(0xec9251, .73, 0, 0, true)); carrot.rotation.x = -Math.PI / 2; carrot.position.set(0, 2, -.44); g.add(carrot);
  for (let i = 0; i < 3; i++) sphere(g, .05, [0, 1.35 - i * .26, -.39 + i * .05], material(0x52615a, .82, 0, 0, true), 0);
  return g;
}
function createPickup(kind) {
  const g = new THREE.Group(); const colors = { coin: 0x9bd8f4, burger: 0xd9955c, soda: COLORS.blue, coffee: 0x815746, coupon: COLORS.mint, chips: 0xecbe58, cash: 0x65a879, turbo: COLORS.orange, magnet: COLORS.coral, brake: 0x93acc1, 'coffee-power': 0xaf7a55 };
  const color = colors[kind] || COLORS.yellow; const mat = material(color, .38, .14, 0, true);
  const halo = new THREE.Mesh(new THREE.TorusGeometry(kind === 'coin' ? .43 : .53, .045, 6, 16), metal(color)); halo.rotation.x = Math.PI / 2; halo.position.y = .54; g.add(halo);
  let body;
  if (kind === 'coin') {
    body = new THREE.Mesh(new THREE.CylinderGeometry(.37, .37, .11, 10), new THREE.MeshStandardMaterial({ color, metalness: .72, roughness: .27, emissive: 0x514018, emissiveIntensity: .16 }));
    body.rotation.x = Math.PI / 2; body.position.y = .66; g.add(body);
    const center = new THREE.Mesh(new THREE.TorusGeometry(.2, .035, 5, 10), material(0xfff1bd, .4, .4, 0, true)); center.position.set(0, .66, .067); g.add(center);
  } else if (kind === 'burger') {
    const bottom = new THREE.Mesh(new THREE.CylinderGeometry(.34, .37, .16, 8), material(0xe7ac5b, .84, 0, 0, true)); bottom.position.y = .5; g.add(bottom);
    const patty = new THREE.Mesh(new THREE.CylinderGeometry(.34, .34, .14, 8), material(0x81513a, .97, 0, 0, true)); patty.position.y = .64; g.add(patty);
    const lettuce = new THREE.Mesh(new THREE.CylinderGeometry(.4, .38, .095, 8), material(0x7eaf68, .89, 0, 0, true)); lettuce.position.y = .74; g.add(lettuce);
    const bun = new THREE.Mesh(new THREE.SphereGeometry(.37, 8, 6, 0, Math.PI * 2, 0, Math.PI * .5), mat); bun.position.y = .77; bun.rotation.x = Math.PI; g.add(bun); body = bun;
  } else if (kind === 'soda') {
    body = new THREE.Mesh(new THREE.CylinderGeometry(.24, .28, .82, 9), mat); body.position.y = .68; g.add(body);
    const neck = new THREE.Mesh(new THREE.CylinderGeometry(.13, .2, .18, 8), material(0xd9ece1, .3, .05, 0, true)); neck.position.y = 1.17; g.add(neck);
    const straw = new THREE.Mesh(new THREE.CylinderGeometry(.035, .035, .44, 6), material(COLORS.orange, .5, 0, 0, true)); straw.position.set(.07, 1.44, 0); straw.rotation.z = -.17; g.add(straw);
    const label = new THREE.Mesh(new THREE.TorusGeometry(.238, .045, 5, 12), material(COLORS.cream, .67, 0, 0, true)); label.position.y = .68; g.add(label);
  } else if (kind === 'coffee' || kind === 'coffee-power') {
    const cup = new THREE.Mesh(new THREE.CylinderGeometry(.25, .32, .64, 8), mat); cup.position.y = .6; g.add(cup);
    const lid = new THREE.Mesh(new THREE.CylinderGeometry(.28, .28, .08, 8), material(0xf2e7d1, .72, 0, 0, true)); lid.position.y = .96; g.add(lid);
    const sleeve = new THREE.Mesh(new THREE.CylinderGeometry(.28, .3, .21, 8), material(0xe7d8b9, .89, 0, 0, true)); sleeve.position.y = .57; g.add(sleeve);
    for (let i = 0; i < 2; i++) { const steam = new THREE.Mesh(new THREE.TorusGeometry(.12 + i * .055, .018, 5, 9, Math.PI), material(0xffefd5, .7, 0, 0, true)); steam.position.set(-.08 + i * .2, 1.25 + i * .13, 0); g.add(steam); }
  } else if (kind === 'coupon') {
    const ticket = new THREE.Shape(); ticket.moveTo(-.49, -.28); ticket.lineTo(.49, -.28); ticket.lineTo(.49, .28); ticket.lineTo(-.49, .28); ticket.closePath();
    body = new THREE.Mesh(new THREE.ShapeGeometry(ticket), mat); body.position.y = .67; g.add(body);
    for (let i = 0; i < 3; i++) { const line = box(g, [.43 - i * .12, .028, .02], [0, .56 + i * .095, .02], material(0xf7efdb, .9, 0, 0, true)); }
  } else if (kind === 'chips') {
    body = new THREE.Mesh(new THREE.CylinderGeometry(.31, .24, .83, 7), mat); body.position.y = .66; g.add(body);
    const top = new THREE.Mesh(new THREE.CylinderGeometry(.24, .24, .07, 7), material(0xefe6ce, .8, 0, 0, true)); top.position.y = 1.12; g.add(top);
    sphere(g, .1, [0, .72, -.27], material(0xf0da9b, .6, 0, 0, true), 0);
  } else if (kind === 'cash') {
    body = new THREE.Mesh(new THREE.BoxGeometry(.76, .09, .45), mat); body.position.y = .68; g.add(body);
    for (let i = 0; i < 3; i++) box(g, [.06, .012, .45], [-.24 + i * .24, .735, 0], material(0xe4efc9, .8, 0, 0, true));
  } else {
    const shape = new THREE.Mesh(new THREE.OctahedronGeometry(.44, 0), mat); shape.position.y = .73; g.add(shape); body = shape;
    const rune = new THREE.Mesh(new THREE.TorusGeometry(.61, .035, 5, 14), metal(color)); rune.rotation.x = Math.PI / 2; rune.position.y = .47; g.add(rune);
    if (kind === 'magnet') {
      const u = new THREE.Mesh(new THREE.TorusGeometry(.25, .085, 6, 9, Math.PI), material(COLORS.orange, .46, .05, 0, true)); u.position.y = .78; u.rotation.z = Math.PI; g.add(u);
      for (const x of [-.25, .25]) box(g, [.14, .12, .15], [x, .53, 0], material(COLORS.cream, .48, .1, 0, true));
    }
    if (kind === 'turbo') { const arrow = new THREE.Mesh(new THREE.ConeGeometry(.19, .4, 3), material(0xfff1c9, .45, .06, 0, true)); arrow.position.set(0, .75, .28); g.add(arrow); }
  }
  return g;
}
try { window.game = new Game(); }
catch (error) { console.error('Falha ao iniciar o jogo 3D:', error); }
