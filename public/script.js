/* ===========================
   TECHSCREEN — SCRIPT.JS
   Full interview flow:
   Q1 → read timer → auto-mic → silence detect → transcribe
   → GPT follow-up → repeat → final score
=========================== */

// ── State ──────────────────────────────────────────────
const state = {
  phase: 'intro',           // intro | reading | recording | processing | followup | scoring
  currentRound: 1,          // 1 = main question, 2 = follow-up
  readTimer: null,
  silenceTimer: null,
  recorder: null,
  chunks: [],
  audioContext: null,
  analyser: null,

  // ── Adaptive silence detection ──────────────────────
  // Instead of a fixed RMS threshold, we sample the ambient
  // noise floor for CALIBRATION_MS ms before recording starts,
  // then set the threshold = noiseFloor * SPEECH_MULTIPLIER.
  // This means a fan, AC, or hum is baked into the baseline
  // and only actual speech (much louder) triggers "sound".
  noiseFloor: 10,           // updated after calibration
  SPEECH_MULTIPLIER: 2.5,   // speech must be this × louder than noise floor
  CALIBRATION_MS: 600,      // how long to sample ambient noise (ms)
  silenceThreshold: 10,     // set dynamically after calibration
  silenceDelay: 2500,       // ms of silence before stopping (post-speech)
  MIN_SPEECH_MS: 1500,      // don't stop if candidate spoke < this long
  speechStartTime: null,    // when speech first exceeded threshold
  lastSoundTime: null,
  animFrame: null,

  conversation: {
    q1: '',
    a1: '',
    q2: '',
    a2: ''
  }
};

// ── DOM ────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const stageIntro    = $('stageIntro');
const stageQuestion = $('stageQuestion');
const stageScore    = $('stageScore');

const btnStart      = $('btnStart');
const btnRestart    = $('btnRestart');
const questionText  = $('questionText');
const questionLabel = $('questionLabel');
const qBadge        = $('qBadge');
const timerNum      = $('timerNum');
const timerLabel    = $('timerLabel');
const ringProgress  = $('ringProgress');
const micRingOuter  = $('micRingOuter');
const micStatus     = $('micStatus');
const micSub        = $('micSub');
const waveform      = $('waveform');
const tpText        = $('tpText');
const processingBar = $('processingBar');
const processingMsg = $('processingMsg');
const statusDot     = $('statusDot');
const statusText    = $('statusText');
const scoreNum      = $('scoreNum');
const scoreArc      = $('scoreArc');
const scoreBreakdown = $('scoreBreakdown');
const scoreTranscript = $('scoreTranscript');
const btnStopRecording = $('btnStopRecording');

// Ring circumference for timer (r=50): 2*π*50 ≈ 314
const TIMER_CIRCUMFERENCE = 314;
// Ring circumference for score (r=85): 2*π*85 ≈ 534
const SCORE_CIRCUMFERENCE = 534;
const READ_TIME = 30; // seconds

// ── Tech question bank ─────────────────────────────────
const QUESTIONS = [
  "Explain the difference between synchronous and asynchronous JavaScript. When would you prefer one over the other, and can you describe how the event loop plays a role in this?",
  "What is the difference between SQL and NoSQL databases? Can you describe a real-world scenario where you would choose one over the other?",
  "Explain how HTTP caching works. What are the key headers involved and how do they affect performance in a web application?",
  "What is the CAP theorem in distributed systems? Can you explain each of the three properties and describe a trade-off you'd make in a real system?",
  "Describe the concept of closure in JavaScript. Can you give a practical use case where closures solve a real problem?",
];

function pickQuestion() {
  return QUESTIONS[Math.floor(Math.random() * QUESTIONS.length)];
}

// ── Status helpers ─────────────────────────────────────
function setStatus(mode, text) {
  statusDot.className = 'status-dot ' + (mode || '');
  statusText.textContent = text;
}

function setProcessing(visible, msg = '') {
  processingBar.classList.toggle('visible', visible);
  if (msg) processingMsg.textContent = msg;
}

// ── Stage transitions ──────────────────────────────────
function showStage(stage) {
  [stageIntro, stageQuestion, stageScore].forEach(s => s.classList.add('hidden'));
  stage.classList.remove('hidden');
}

// ── Timer ring ─────────────────────────────────────────
function updateRing(secondsLeft, total) {
  const fraction = secondsLeft / total;
  const offset = TIMER_CIRCUMFERENCE * (1 - fraction);
  ringProgress.style.strokeDashoffset = offset;
  ringProgress.classList.toggle('urgent', secondsLeft <= 5);
}

// ── Start reading phase ────────────────────────────────
function startReadingPhase(question, label) {
  state.phase = 'reading';
  questionText.textContent = question;
  questionLabel.textContent = label;
  qBadge.textContent = 'Reading';
  qBadge.className = 'q-badge';
  timerLabel.textContent = 'Reading time remaining';
  micStatus.textContent = 'Mic inactive';
  micSub.textContent = 'Timer must reach 0 to activate';
  micRingOuter.classList.remove('active');
  micStatus.classList.remove('active');
  waveform.classList.remove('active');
  tpText.textContent = '';
  ringProgress.style.strokeDashoffset = 0;
  ringProgress.classList.remove('urgent');
  setStatus('active', 'Reading question...');

  let secondsLeft = READ_TIME;
  timerNum.textContent = secondsLeft;
  updateRing(secondsLeft, READ_TIME);

  state.readTimer = setInterval(() => {
    secondsLeft--;
    timerNum.textContent = secondsLeft;
    updateRing(secondsLeft, READ_TIME);

    if (secondsLeft <= 0) {
      clearInterval(state.readTimer);
      startRecordingPhase();
    }
  }, 1000);
}

// ── Start recording phase ──────────────────────────────
async function startRecordingPhase() {
  state.phase = 'recording';
  state.chunks = [];
  state.speechStartTime = null;
  ringProgress.style.strokeDashoffset = TIMER_CIRCUMFERENCE;
  setStatus('recording', 'Calibrating mic...');

  // Show calibrating state briefly
  qBadge.textContent = 'Calibrating';
  qBadge.className = 'q-badge processing';
  micStatus.textContent = 'Calibrating...';
  micSub.textContent = 'Measuring ambient noise...';
  timerNum.textContent = '~';
  timerLabel.textContent = 'Sampling noise floor';

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });

    // Set up Web Audio API
    state.audioContext = new AudioContext();
    state.analyser = state.audioContext.createAnalyser();
    state.analyser.fftSize = 512; // higher resolution for better calibration
    const source = state.audioContext.createMediaStreamSource(stream);
    source.connect(state.analyser);

    // ── Calibration: sample ambient RMS for CALIBRATION_MS ──
    // This captures fan noise, AC hum, mic self-noise — anything
    // present before the user speaks — as the noise floor baseline.
    await calibrateNoiseFloor();

    console.log(`[Calibration] Noise floor RMS: ${state.noiseFloor.toFixed(2)}`);
    console.log(`[Calibration] Speech threshold set to: ${state.silenceThreshold.toFixed(2)}`);

    // Now switch UI to recording mode
    qBadge.textContent = 'Recording';
    qBadge.className = 'q-badge recording';
    timerNum.textContent = '●';
    timerLabel.textContent = 'Recording your answer';
    micRingOuter.classList.add('active');
    micStatus.textContent = '● Recording';
    micStatus.classList.add('active');
    micSub.textContent = 'Silence after speaking will auto-submit';
    waveform.classList.add('active');
    btnStopRecording.classList.remove('hidden');   // ← show stop button
    setStatus('recording', 'Recording...');

    state.lastSoundTime = Date.now();

    // MediaRecorder starts AFTER calibration so we don't capture silence
    state.recorder = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus' });
    state.recorder.ondataavailable = e => { if (e.data.size > 0) state.chunks.push(e.data); };
    state.recorder.start(100);

    monitorAudio(stream);

  } catch (err) {
    console.error('Mic error:', err);
    micStatus.textContent = 'Mic access denied';
    setStatus('', 'Error');
  }
}

// ── Calibrate noise floor ──────────────────────────────
// Samples RMS over CALIBRATION_MS and stores the average
// as the ambient noise floor, then sets threshold above it.
function calibrateNoiseFloor() {
  return new Promise(resolve => {
    const dataArray = new Uint8Array(state.analyser.frequencyBinCount);
    const samples = [];
    const start = Date.now();

    function sample() {
      state.analyser.getByteFrequencyData(dataArray);

      let sum = 0;
      for (let i = 0; i < dataArray.length; i++) sum += dataArray[i] * dataArray[i];
      samples.push(Math.sqrt(sum / dataArray.length));

      if (Date.now() - start < state.CALIBRATION_MS) {
        requestAnimationFrame(sample);
      } else {
        // Use the 80th percentile sample as the noise floor
        // (not mean, so occasional transient sounds during calibration don't skew it)
        samples.sort((a, b) => a - b);
        const p80index = Math.floor(samples.length * 0.8);
        state.noiseFloor = samples[p80index];

        // Speech threshold = noise floor × multiplier, minimum of 8
        state.silenceThreshold = Math.max(8, state.noiseFloor * state.SPEECH_MULTIPLIER);
        resolve();
      }
    }

    sample();
  });
}

// ── Audio monitoring (adaptive silence detection + waveform) ──
// Uses the calibrated threshold instead of the fixed value.
// Also guards against stopping too early with MIN_SPEECH_MS.
function monitorAudio(stream) {
  const dataArray = new Uint8Array(state.analyser.frequencyBinCount);
  const bars = document.querySelectorAll('.wave-bar');

  // Relative bar heights: scale waveform relative to noise floor
  // so it looks flat during background noise and animated during speech
  function getRelativeHeight(rawValue) {
    const above = rawValue - state.noiseFloor;
    return Math.max(4, Math.min(44, (above / state.silenceThreshold) * 44));
  }

  function loop() {
    if (state.phase !== 'recording') return;

    state.analyser.getByteFrequencyData(dataArray);

    // RMS of current frame
    let sum = 0;
    for (let i = 0; i < dataArray.length; i++) sum += dataArray[i] * dataArray[i];
    const rms = Math.sqrt(sum / dataArray.length);

    // Drive waveform bars relative to noise floor —
    // fan noise produces flat bars, speech produces tall ones
    bars.forEach((bar, i) => {
      const value = dataArray[i * 5] || 0; // spread across spectrum
      bar.style.height = getRelativeHeight(value) + 'px';
    });

    const isSpeech = rms > state.silenceThreshold;

    if (isSpeech) {
      // Mark first time speech detected
      if (!state.speechStartTime) {
        state.speechStartTime = Date.now();
        console.log(`[Monitor] Speech detected. Threshold: ${state.silenceThreshold.toFixed(1)}, RMS: ${rms.toFixed(1)}`);
      }
      state.lastSoundTime = Date.now();
    }

    const silentFor = Date.now() - state.lastSoundTime;
    const spokenFor = state.speechStartTime ? Date.now() - state.speechStartTime : 0;

    // Only trigger stop if:
    // 1. Candidate has spoken at all (speechStartTime set)
    // 2. They've spoken for at least MIN_SPEECH_MS (avoids cutting off instantly)
    // 3. Silence has lasted for silenceDelay ms
    if (
      state.speechStartTime &&
      spokenFor >= state.MIN_SPEECH_MS &&
      silentFor >= state.silenceDelay
    ) {
      console.log(`[Monitor] Silence detected for ${silentFor}ms after ${spokenFor}ms of speech. Stopping.`);
      stopRecording(stream);
      return;
    }

    state.animFrame = requestAnimationFrame(loop);
  }

  loop();
}

// ── Stop recording & transcribe ────────────────────────
function stopRecording(stream) {
  state.phase = 'processing';
  cancelAnimationFrame(state.animFrame);
  btnStopRecording.classList.add('hidden');   // ← hide stop button

  if (state.recorder && state.recorder.state !== 'inactive') {
    state.recorder.stop();
  }
  stream.getTracks().forEach(t => t.stop());
  if (state.audioContext) state.audioContext.close();

  micRingOuter.classList.remove('active');
  micStatus.classList.remove('active');
  waveform.classList.remove('active');
  qBadge.textContent = 'Processing';
  qBadge.className = 'q-badge processing';
  setStatus('processing', 'Transcribing...');
  setProcessing(true, 'Transcribing your answer...');

  state.recorder.onstop = async () => {
    const blob = new Blob(state.chunks, { type: 'audio/webm' });
    const transcript = await sendToTranscription(blob);

    if (state.currentRound === 1) {
      state.conversation.a1 = transcript;
      tpText.textContent = transcript;
      await generateFollowUp();
    } else {
      state.conversation.a2 = transcript;
      tpText.textContent = transcript;
      await generateScore();
    }
  };
}

// ── Transcription API call ─────────────────────────────
async function sendToTranscription(blob) {
  const formData = new FormData();
  formData.append('audio', blob, 'recording.webm');

  try {
    const res = await fetch('/transcribe', { method: 'POST', body: formData });
    const data = await res.json();
    return data.text || '[No transcript]';
  } catch (err) {
    console.error('Transcription error:', err);
    return '[Transcription failed]';
  }
}

// ── Generate follow-up question via GPT ───────────────
async function generateFollowUp() {
  setProcessing(true, 'Generating follow-up question...');
  setStatus('processing', 'Generating follow-up...');

  try {
    const res = await fetch('/followup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        question: state.conversation.q1,
        answer: state.conversation.a1
      })
    });
    const data = await res.json();
    state.conversation.q2 = data.followup || 'Can you elaborate on your answer?';
  } catch (err) {
    console.error('Follow-up error:', err);
    state.conversation.q2 = 'Can you elaborate further on your answer?';
  }

  setProcessing(false);
  state.currentRound = 2;
  startReadingPhase(state.conversation.q2, 'Follow-up Question');
}

// ── Generate final score via GPT ───────────────────────
async function generateScore() {
  setProcessing(true, 'Evaluating your performance...');
  setStatus('processing', 'Scoring...');

  try {
    const res = await fetch('/score', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(state.conversation)
    });
    const data = await res.json();
    setProcessing(false);
    renderScore(data);
  } catch (err) {
    console.error('Score error:', err);
    setProcessing(false);
    renderScore({
      score: 0,
      breakdown: {},
      feedback: 'Could not evaluate. Please try again.',
      conversation: state.conversation
    });
  }
}

// ── Render score page ──────────────────────────────────
function renderScore(data) {
  showStage(stageScore);
  setStatus('active', 'Complete');

  // Animate score ring
  const finalScore = Math.min(100, Math.max(0, data.score || 0));
  const offset = SCORE_CIRCUMFERENCE * (1 - finalScore / 100);

  // Count up number
  let current = 0;
  const step = finalScore / 60;
  const counter = setInterval(() => {
    current = Math.min(current + step, finalScore);
    scoreNum.textContent = Math.round(current);
    if (current >= finalScore) clearInterval(counter);
  }, 25);

  // Animate ring after short delay
  setTimeout(() => {
    scoreArc.style.strokeDashoffset = offset;
  }, 100);

  // Color based on score
  const color = finalScore >= 75 ? 'var(--green)' : finalScore >= 50 ? 'var(--amber)' : 'var(--red)';
  scoreArc.style.stroke = color;
  scoreArc.style.filter = `drop-shadow(0 0 6px ${color})`;

  // Breakdown cards
  scoreBreakdown.innerHTML = '';
  const breakdown = data.breakdown || {};
  Object.entries(breakdown).forEach(([key, val]) => {
    const div = document.createElement('div');
    div.className = 'breakdown-item';
    div.innerHTML = `
      <div class="bi-label">${key}</div>
      <div class="bi-value" style="color:${color}">${val.score}/10</div>
      <div class="bi-comment">${val.comment}</div>
    `;
    scoreBreakdown.appendChild(div);
  });

  // Transcript review
  scoreTranscript.innerHTML = `
    <div class="st-item">
      <div class="st-role">Round 01 — Technical Question</div>
      <div class="st-q">${state.conversation.q1}</div>
      <div class="st-a">"${state.conversation.a1}"</div>
    </div>
    <div class="st-item">
      <div class="st-role">Round 02 — Follow-up Question</div>
      <div class="st-q">${state.conversation.q2}</div>
      <div class="st-a">"${state.conversation.a2}"</div>
    </div>
    ${data.feedback ? `<div class="score-feedback">${data.feedback}</div>` : ''}
  `;
}

// ── Reset state ────────────────────────────────────────
function resetState() {
  clearInterval(state.readTimer);
  cancelAnimationFrame(state.animFrame);
  state.phase = 'intro';
  state.currentRound = 1;
  state.chunks = [];
  state.speechStartTime = null;
  state.noiseFloor = 10;
  state.silenceThreshold = 10;
  btnStopRecording.classList.add('hidden');
  state.conversation = { q1: '', a1: '', q2: '', a2: '' };
  scoreArc.style.strokeDashoffset = SCORE_CIRCUMFERENCE;
  tpText.textContent = '';
  setProcessing(false);
  setStatus('', 'Ready');
}

// ── Event listeners ────────────────────────────────────
btnStart.addEventListener('click', () => {
  resetState();
  showStage(stageQuestion);
  state.conversation.q1 = pickQuestion();
  startReadingPhase(state.conversation.q1, 'Question 01');
});

btnRestart.addEventListener('click', () => {
  resetState();
  showStage(stageIntro);
});

// Manual stop — treated exactly like silence detection triggering
btnStopRecording.addEventListener('click', () => {
  if (state.phase !== 'recording') return;
  // Force speechStartTime so the MIN_SPEECH_MS guard doesn't block it
  if (!state.speechStartTime) state.speechStartTime = Date.now() - state.MIN_SPEECH_MS;
  // Grab the active stream from the recorder and stop
  const tracks = state.recorder?.stream?.getTracks() ?? [];
  const fakeStream = { getTracks: () => tracks };
  stopRecording(fakeStream);
});