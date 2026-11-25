let isPoweredOn = true;
let currentUnit = 'hazard';
let currentMode = 'standby';
let subTone = 1;
let currentVolume = 1.0;

const AudioCtx = window.AudioContext || window.webkitAudioContext;
let audioCtx = null;
let masterBus = null;
const bufferCache = {};
const trimBoundsCache = {};

let manualSource = null;
let manualGain = null;
let manualStartTime = 0;
let isManHeld = false;
let manPlayToken = 0;

let manTailRemaining = 0;
let manTailUntil = 0;
let manTailTimer = null;

const trackOffsets = {};

let hornSource = null;
let hornGain = null;
let isHornActive = false;
let isHornHeld = false;
let hornPlayToken = 0;

const HORN_VOL_MULT = 0.78;
const MAN_TAIL_DURATION = 0.42;

const modeOrder = ['hilo', 'yelp', 'wail', 'standby', 'pa', 'radio'];
const modeAngles = {
  hilo: -125,
  yelp: -75,
  wail: -25,
  standby: 25,
  pa: 75,
  radio: 125
};

const sirenModes = ['hilo', 'yelp', 'wail'];

function initAudioCtx() {
  if (!audioCtx) {
    audioCtx = new AudioCtx();

    const lowBoost = audioCtx.createBiquadFilter();
    lowBoost.type = 'lowshelf';
    lowBoost.frequency.value = 220;
    lowBoost.gain.value = 5.0;

    const hornBody = audioCtx.createBiquadFilter();
    hornBody.type = 'peaking';
    hornBody.frequency.value = 880;
    hornBody.Q.value = 1.1;
    hornBody.gain.value = 3.5;

    const smoothHighs = audioCtx.createBiquadFilter();
    smoothHighs.type = 'lowpass';
    smoothHighs.frequency.value = 5200;

    lowBoost.connect(hornBody);
    hornBody.connect(smoothHighs);
    smoothHighs.connect(audioCtx.destination);

    masterBus = lowBoost;
  }
  if (audioCtx.state === 'suspended') {
    audioCtx.resume().catch(() => {});
  }
}

function detectAudioBounds(audioBuf, url) {
  const data = audioBuf.getChannelData(0);
  const sampleRate = audioBuf.sampleRate;
  const endThreshold = 0.035;

  let lastActiveSample = data.length - 1;
  for (let i = data.length - 1; i >= 0; i--) {
    if (Math.abs(data[i]) > endThreshold) {
      lastActiveSample = i;
      break;
    }
  }

  const startSec = 0;
  let endSec = lastActiveSample / sampleRate;

  if (url.endsWith('_hilo_2.wav')) {
    endSec = Math.max(0.25, endSec - 0.32);
  } else if (url.endsWith('_wail_2.wav')) {
    endSec = Math.max(0.25, endSec - 0.38);
  }

  if (endSec <= 0.1 || endSec > audioBuf.duration) {
    endSec = audioBuf.duration;
  }

  return { start: startSec, end: endSec };
}

async function loadSoundBuffer(url) {
  if (bufferCache[url]) return bufferCache[url];
  initAudioCtx();
  try {
    const resp = await fetch(url);
    if (!resp.ok) return null;
    const arrayBuf = await resp.arrayBuffer();
    const audioBuf = await audioCtx.decodeAudioData(arrayBuf);
    if (!audioBuf || audioBuf.length === 0) return null;
    bufferCache[url] = audioBuf;
    trimBoundsCache[url] = detectAudioBounds(audioBuf, url);
    return audioBuf;
  } catch (e) {
    return null;
  }
}

function preloadUnitSounds(unit) {
  const names = [
    'wail_1', 'wail_2', 'yelp_1', 'yelp_2',
    'hilo_1', 'hilo_2', 'horn', 'manual'
  ];
  names.forEach(n => loadSoundBuffer(`sounds/${unit}_${n}.wav`));
}

function syncGains() {
  if (!audioCtx) return;
  const now = audioCtx.currentTime;
  const inManTail = !isManHeld && manTailUntil > now;

  if (manualGain) {
    manualGain.gain.cancelScheduledValues(now);
    if (isHornActive) {
      manualGain.gain.setTargetAtTime(0.0, now, 0.012);
    } else if (isManHeld) {
      manualGain.gain.setTargetAtTime(currentVolume, now, 0.008);
    } else if (inManTail) {
      const remaining = Math.max(0.03, manTailUntil - now);
      const ratio = Math.min(1, remaining / MAN_TAIL_DURATION);
      manualGain.gain.setValueAtTime(Math.max(0.001, currentVolume * ratio), now);
      manualGain.gain.linearRampToValueAtTime(0.0, manTailUntil);
    } else {
      manualGain.gain.setTargetAtTime(0.0, now, 0.01);
    }
  }

  if (hornGain) {
    hornGain.gain.cancelScheduledValues(now);
    const targetHornVol = isHornActive ? (currentVolume * HORN_VOL_MULT) : 0.0;
    hornGain.gain.setTargetAtTime(targetHornVol, now, 0.008);
  }
}

function setSignalLed(active) {
  const ledSig = document.getElementById('ledSig');
  if (!ledSig) return;
  if (active) ledSig.classList.add('sig-active');
  else ledSig.classList.remove('sig-active');
}

function setTactileLock(locked) {
  document.querySelectorAll('.tactile-lock-group').forEach(row => {
    if (locked) row.classList.add('locked');
    else row.classList.remove('locked');
  });
}

function updateModeReadouts(text) {
  document.querySelectorAll('.mode-readout').forEach(el => {
    el.innerText = text;
  });
}

function updateSubKnobState() {
  const isSiren = isPoweredOn && currentMode && sirenModes.includes(currentMode);

  document.querySelectorAll('.siren-dial-unit').forEach(unit => {
    if (isSiren) unit.classList.remove('locked');
    else unit.classList.add('locked');
  });

  document.querySelectorAll('.siren-knob-el').forEach(knob => {
    const angle = isSiren ? (subTone === 1 ? -45 : 45) : 0;
    knob.style.transform = `rotate(${angle}deg)`;
  });

  document.querySelectorAll('.siren-dial-readout').forEach(el => {
    if (isSiren) {
      el.innerText = `ТОН ${subTone}`;
    } else {
      el.innerText = 'LOCKED';
    }
  });
}
function togglePower() {
  initAudioCtx();
  isPoweredOn = !isPoweredOn;
  const pwrBtn = document.getElementById('pwrBtn');
  const faceplate = document.getElementById('faceplate');
  const pwrCaption = document.getElementById('pwrCaption');
  const ledPwr = document.getElementById('ledPwr');

  if (isPoweredOn) {
    pwrBtn.classList.remove('pwr-off');
    pwrBtn.classList.add('pwr-on');
    ledPwr.classList.add('pwr-active');
    faceplate.classList.remove('disabled');
    pwrCaption.innerText = 'СИСТЕМА АКТИВНА';
    selectMode('standby');
  } else {
    pwrBtn.classList.remove('pwr-on');
    pwrBtn.classList.add('pwr-off');
    ledPwr.classList.remove('pwr-active');
    setSignalLed(false);
    faceplate.classList.add('disabled');
    pwrCaption.innerText = 'ПИТАНИЕ ВЫКЛЮЧЕНО';
    stopAllSounds();
    currentMode = null;
    setTactileLock(true);
    updateSubKnobState();
    document.querySelectorAll('[data-mode]').forEach(b => b.classList.remove('active', 'siren-on'));
    document.getElementById('mainStatusText').innerText = 'OFF';
    updateModeReadouts('OFF');
  }
}

function openUnitSheet() {
  document.getElementById('sheetBackdrop').classList.add('open');
  document.getElementById('unitSheet').classList.add('open');
}

function closeUnitSheet() {
  document.getElementById('sheetBackdrop').classList.remove('open');
  document.getElementById('unitSheet').classList.remove('open');
}

function chooseUnit(unitKey, brandWord, modelWord, el) {
  initAudioCtx();
  currentUnit = unitKey;
  preloadUnitSounds(unitKey);
  document.getElementById('topBrandTitle').innerHTML = `${brandWord} <span>${modelWord}</span>`;

  document.body.classList.remove('unit-hazard', 'unit-federal', 'unit-elina');
  document.body.classList.add('unit-' + unitKey);

  document.querySelectorAll('.sheet-item').forEach(i => i.classList.remove('selected'));
  el.classList.add('selected');
  closeUnitSheet();
  updateSubKnobState();

  if (isManHeld) {
    startManualPlay();
  }
}

function selectMode(mode) {
  if (!isPoweredOn) return;
  initAudioCtx();
  if (currentMode !== mode) {
    subTone = 1;
  }
  currentMode = mode;
  stopManualSound();
  setTactileLock(false);

  document.querySelectorAll('.mode-knob-el').forEach(knob => {
    knob.style.transform = `rotate(${modeAngles[mode]}deg)`;
  });

  document.querySelectorAll('[data-mode]').forEach(b => b.classList.remove('active', 'siren-on'));
  const isSiren = sirenModes.includes(mode);

  document.querySelectorAll(`[data-mode="${mode}"]`).forEach(btn => {
    btn.classList.add(isSiren ? 'siren-on' : 'active');
  });

  updateSubKnobState();

  setSignalLed(isHornActive || isManHeld);
  const label = isSiren ? `${mode.toUpperCase()} ${subTone}` : mode.toUpperCase();
  updateModeReadouts(label);
  document.getElementById('mainStatusText').innerText = isHornActive ? 'AIR HORN' : label;

  if (isManHeld) {
    startManualPlay();
  }
}

function cycleMode() {
  if (!isPoweredOn) return;
  if (!currentMode) {
    selectMode(modeOrder);
    return;
  }
  const idx = modeOrder.indexOf(currentMode);
  const next = modeOrder[(idx + 1) % modeOrder.length];
  selectMode(next);
}

function cycleSirenTone() {
  if (!isPoweredOn || !currentMode || !sirenModes.includes(currentMode)) return;
  subTone = (subTone === 1) ? 2 : 1;

  updateSubKnobState();

  const label = `${currentMode.toUpperCase()} ${subTone}`;
  updateModeReadouts(label);
  if (!isHornActive) {
    document.getElementById('mainStatusText').innerText = label;
  }

  if (isManHeld) {
    startManualPlay();
  }
}

function getSoundUrlForManual() {
  if (sirenModes.includes(currentMode)) {
    return `sounds/${currentUnit}_${currentMode}_${subTone}.wav`;
  }
  if (currentMode === 'pa') return `sounds/${currentUnit}_yelp_2.wav`;
  if (currentMode === 'radio') return `sounds/${currentUnit}_hilo_2.wav`;
  return `sounds/${currentUnit}_manual.wav`;
}

function scheduleManTailDecay(durationSec) {
  if (!audioCtx || !manualSource || durationSec <= 0.02) {
    stopManualSound();
    if (isPoweredOn && !isHornActive) {
      setSignalLed(false);
      document.getElementById('mainStatusText').innerText = getIdleDisplayText();
    }
    return;
  }

  const now = audioCtx.currentTime;
  const token = manPlayToken;
  manTailRemaining = durationSec;
  manTailUntil = now + durationSec;
  syncGains();

  if (manTailTimer) clearTimeout(manTailTimer);
  manTailTimer = setTimeout(() => {
    if (token !== manPlayToken || isManHeld || isHornActive) return;
    stopManualSound();
    if (isPoweredOn) {
      setSignalLed(false);
      document.getElementById('mainStatusText').innerText = getIdleDisplayText();
    }
  }, durationSec * 1000);
}

function stopManualSound() {
  if (manTailTimer) {
    clearTimeout(manTailTimer);
    manTailTimer = null;
  }
  manTailUntil = 0;
  manTailRemaining = 0;

  if (manualSource) {
    const url = manualSource._url;
    const bounds = trimBoundsCache[url] || { start: 0, end: manualSource._duration || 0 };
    const playableSpan = bounds.end - bounds.start;
    if (url && playableSpan > 0 && audioCtx) {
      const elapsed = audioCtx.currentTime - manualStartTime;
      const prevRel = Math.max(0, (trackOffsets[url] || bounds.start) - bounds.start);
      trackOffsets[url] = bounds.start + ((prevRel + elapsed) % playableSpan);
    }
    try { manualSource.stop(); } catch (e) {}
    manualSource.disconnect();
    manualSource = null;
  }
  if (manualGain) {
    manualGain.disconnect();
    manualGain = null;
  }
}

function killHornSource() {
  if (hornGain && audioCtx) {
    hornGain.gain.cancelScheduledValues(audioCtx.currentTime);
    hornGain.gain.setValueAtTime(0.0, audioCtx.currentTime);
    hornGain.disconnect();
    hornGain = null;
  }
  if (hornSource) {
    try { hornSource.stop(); } catch (e) {}
    hornSource.disconnect();
    hornSource = null;
  }
}

function stopHornSound() {
  hornPlayToken++;
  killHornSource();
  isHornActive = false;
  syncGains();
}

function stopAllSounds() {
  manPlayToken++;
  isHornHeld = false;
  isManHeld = false;
  stopManualSound();
  stopHornSound();
}

function emergencyStop() {
  if (!isPoweredOn) return;
  stopAllSounds();
  setSignalLed(false);
  currentMode = null;
  subTone = 1;
  setTactileLock(true);
  updateSubKnobState();
  document.querySelectorAll('[data-mode]').forEach(b => b.classList.remove('active', 'siren-on'));
  document.querySelectorAll('.mode-knob-el').forEach(k => {
    k.style.transform = 'rotate(0deg)';
  });
  updateModeReadouts('—');
  document.getElementById('mainStatusText').innerText = '—';
}

function getIdleDisplayText() {
  if (!currentMode) return '—';
  return sirenModes.includes(currentMode)
    ? `${currentMode.toUpperCase()} ${subTone}`
    : currentMode.toUpperCase();
}
function releaseHornBtn() {
  if (!isHornHeld && !isHornActive) return;
  isHornHeld = false;
  document.querySelectorAll('.btn-horn-el').forEach(b => b.classList.remove('pressed'));

  hornPlayToken++;
  isHornActive = false;
  killHornSource();

  if (!isPoweredOn) return;

  if (isManHeld && currentMode) {
    syncGains();
    setSignalLed(true);
    const label = sirenModes.includes(currentMode)
      ? `${currentMode.toUpperCase()} ${subTone}`
      : 'MANUAL';
    document.getElementById('mainStatusText').innerText = label;
    if (!manualSource) {
      startManualPlay();
    }
    return;
  }

  if (manTailRemaining > 0.02 && manualSource && currentMode) {
    setSignalLed(true);
    const label = sirenModes.includes(currentMode)
      ? `${currentMode.toUpperCase()} ${subTone}`
      : 'MANUAL';
    document.getElementById('mainStatusText').innerText = label;
    scheduleManTailDecay(manTailRemaining);
    return;
  }

  syncGains();
  setSignalLed(false);
  document.getElementById('mainStatusText').innerText = getIdleDisplayText();
}

async function triggerHorn() {
  if (!isPoweredOn || !currentMode) return;

  initAudioCtx();
  const token = ++hornPlayToken;
  isHornHeld = true;
  document.querySelectorAll('.btn-horn-el').forEach(b => b.classList.add('pressed'));

  let url = `sounds/${currentUnit}_horn.wav`;
  let buf = bufferCache[url] || await loadSoundBuffer(url);
  if (!buf) {
    url = `sounds/${currentUnit}_manual.wav`;
    buf = bufferCache[url] || await loadSoundBuffer(url);
  }
  if (!buf || !isPoweredOn || !isHornHeld || token !== hornPlayToken) return;

  const now = audioCtx.currentTime;
  if (manualSource) {
    if (isManHeld) {
      manTailRemaining = MAN_TAIL_DURATION;
    } else if (manTailUntil > now) {
      manTailRemaining = Math.max(0, manTailUntil - now);
    }
    if (manTailTimer) {
      clearTimeout(manTailTimer);
      manTailTimer = null;
    }
    manTailUntil = 0;
  }

  killHornSource();
  isHornActive = true;
  syncGains();

  const bounds = trimBoundsCache[url] || { start: 0, end: buf.duration };
  hornSource = audioCtx.createBufferSource();
  hornSource.buffer = buf;
  hornSource.loop = true;
  hornSource.loopStart = bounds.start;
  hornSource.loopEnd = bounds.end;

  hornGain = audioCtx.createGain();
  hornGain.gain.setValueAtTime(0.001, audioCtx.currentTime);
  hornGain.gain.linearRampToValueAtTime(currentVolume * HORN_VOL_MULT, audioCtx.currentTime + 0.008);

  hornSource.connect(hornGain);
  hornGain.connect(masterBus);
  hornSource.start(0, bounds.start);

  setSignalLed(true);
  document.getElementById('mainStatusText').innerText = 'AIR HORN';
}

async function startManualPlay() {
  if (!isPoweredOn || !currentMode || !isManHeld) return;
  const token = ++manPlayToken;
  const targetUrl = getSoundUrlForManual();

  if (manualSource && manualSource._url === targetUrl) {
    if (manTailTimer) {
      clearTimeout(manTailTimer);
      manTailTimer = null;
    }
    manTailUntil = 0;
    manTailRemaining = 0;
    syncGains();
    setSignalLed(true);
    if (!isHornActive) {
      const label = sirenModes.includes(currentMode)
        ? `${currentMode.toUpperCase()} ${subTone}`
        : 'MANUAL';
      document.getElementById('mainStatusText').innerText = label;
    }
    return;
  }

  const buf = bufferCache[targetUrl] || await loadSoundBuffer(targetUrl);
  if (!buf || !isManHeld || !isPoweredOn || token !== manPlayToken) return;

  stopManualSound();

  const bounds = trimBoundsCache[targetUrl] || { start: 0, end: buf.duration };
  manualSource = audioCtx.createBufferSource();
  manualSource.buffer = buf;
  manualSource.loop = true;
  manualSource.loopStart = bounds.start;
  manualSource.loopEnd = bounds.end;
  manualSource._url = targetUrl;
  manualSource._duration = buf.duration;

  manualGain = audioCtx.createGain();
  const initialVol = isHornActive ? 0.0 : currentVolume;
  manualGain.gain.setValueAtTime(0.001, audioCtx.currentTime);
  manualGain.gain.linearRampToValueAtTime(initialVol, audioCtx.currentTime + 0.01);

  manualSource.connect(manualGain);
  manualGain.connect(masterBus);

  let savedOffset = trackOffsets[targetUrl] || bounds.start;
  if (savedOffset < bounds.start || savedOffset >= bounds.end) {
    savedOffset = bounds.start;
  }

  manualStartTime = audioCtx.currentTime;
  manualSource.start(0, savedOffset);

  setSignalLed(true);
  if (!isHornActive) {
    const label = sirenModes.includes(currentMode)
      ? `${currentMode.toUpperCase()} ${subTone}`
      : 'MANUAL';
    document.getElementById('mainStatusText').innerText = label;
  }
}

function pressMan() {
  if (!isPoweredOn || !currentMode) return;
  initAudioCtx();

  isManHeld = true;
  document.querySelectorAll('.btn-man-el').forEach(b => b.classList.add('pressed'));

  if (isHornActive) {
    stopHornSound();
    isHornHeld = false;
    document.querySelectorAll('.btn-horn-el').forEach(b => b.classList.remove('pressed'));
  }

  startManualPlay();
}

function releaseMan() {
  if (!isManHeld) return;
  isManHeld = false;
  document.querySelectorAll('.btn-man-el').forEach(b => b.classList.remove('pressed'));

  if (isPoweredOn && manualSource && manualGain && audioCtx) {
    if (isHornActive) {
      manTailRemaining = MAN_TAIL_DURATION;
      manTailUntil = 0;
      syncGains();
    } else {
      scheduleManTailDecay(MAN_TAIL_DURATION);
    }
    return;
  }

  stopManualSound();
  if (isPoweredOn && !isHornActive) {
    setSignalLed(false);
    document.getElementById('mainStatusText').innerText = getIdleDisplayText();
  }
}

function bindInstantHold(selector, downFn, upFn) {
  document.querySelectorAll(selector).forEach(el => {
    el.addEventListener('mousedown', (e) => {
      if (e.button === 0) downFn();
    });
    el.addEventListener('mouseup', upFn);
    el.addEventListener('mouseleave', upFn);
    el.addEventListener('touchstart', (e) => {
      e.preventDefault();
      downFn();
    }, { passive: false });
    el.addEventListener('touchend', (e) => {
      e.preventDefault();
      upFn();
    });
    el.addEventListener('touchcancel', upFn);
  });
}

bindInstantHold('.btn-horn-el', triggerHorn, releaseHornBtn);
bindInstantHold('.btn-man-el', pressMan, releaseMan);

let draggingVol = false;
let volStartY = 0;
let volStartVal = currentVolume;

function updateVolumeUI(val) {
  currentVolume = Math.max(0, Math.min(1, val));
  const deg = -135 + currentVolume * 270;
  document.querySelectorAll('.vol-knob-el').forEach(k => {
    k.style.transform = `rotate(${deg}deg)`;
  });

  const pct = Math.round(currentVolume * 100);
  document.querySelectorAll('.vol-readout').forEach(el => {
    el.innerText = pct + '%';
  });
  document.getElementById('meterPercent').innerText = pct + '%';

  const activeCount = Math.round(currentVolume * 10);
  document.querySelectorAll('.meter-seg').forEach((seg, idx) => {
    if (idx < activeCount) seg.classList.add('active');
    else seg.classList.remove('active');
  });

  syncGains();
}

updateVolumeUI(1.0);

document.querySelectorAll('.vol-knob-el').forEach(knob => {
  knob.addEventListener('mousedown', (e) => { draggingVol = true; volStartY = e.clientY; volStartVal = currentVolume; });
  knob.addEventListener('touchstart', (e) => { e.preventDefault(); draggingVol = true; volStartY = e.touches.clientY; volStartVal = currentVolume; }, { passive: false });
  knob.addEventListener('wheel', (e) => {
    e.preventDefault();
    updateVolumeUI(currentVolume + (e.deltaY < 0 ? 0.05 : -0.05));
  });
});

window.addEventListener('mousemove', (e) => { if (draggingVol) updateVolumeUI(volStartVal + (volStartY - e.clientY) / 140); });
window.addEventListener('mouseup', () => { draggingVol = false; });
window.addEventListener('touchmove', (e) => { if (draggingVol) updateVolumeUI(volStartVal + (volStartY - e.touches.clientY) / 140); });
window.addEventListener('touchend', () => { draggingVol = false; });

document.addEventListener('pointerdown', initAudioCtx, { once: true });
preloadUnitSounds(currentUnit);
selectMode('standby');