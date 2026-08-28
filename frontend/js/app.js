// ==========================================
// LinguaBoost Pro - Frontend Application Engine (v4.5 High Contrast)
// ==========================================

const API_BASE_URL = "http://127.0.0.1:8000"; // Para pruebas locales
//const API_BASE_URL = "http://127.0.0.1:8000"; // Para pruebas en Render

// Estado global
let curriculumData = {};
let allUnitsMap = {};
let currentUnit = null;
let isRecording = false;
let recognition = null;
let srsDueWords = [];
let currentSRSIndex = 0;
let currentScenario = null;
let roleplayRecognition = null;
let isRPRecording = false;
let audioContext = null;
let analyser = null;
let dataArray = null;
let waveformCanvas = null;
let waveformCtx = null;
let mediaRecorder = null;
let recordedChunks = [];
let userStats = {};
let progressChart = null;
let roleplayHistory = [];
let roleplayScenariosMap = {};

let ptState = {
    currentLevel: "A2",
    questionId: null,
    selectedOption: null,
    history: []
};

const LEVEL_ORDER = ["A1", "A2", "B1", "B2", "C1", "C2"];

// --- 1. INICIALIZACIÓN ---
document.addEventListener("DOMContentLoaded", () => {
    initDarkMode();
    fetchCurriculum();
    setupSpeechRecognition();
    fetchSRSStats();
    fetchSRSDueWords();
    fetchUserStats();
    fetchProgressData();
    fetchDailyChallenge();
    initWaveform();

    const writingInput = document.getElementById("writing-input");
    if (writingInput) {
        writingInput.addEventListener("keydown", (e) => {
            // Si presionan Enter sin Shift, analizamos sin recargar
            if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                analyzeWriting(e);
            }
        });
    }
});

// --- MODO OSCURO ---
function initDarkMode() {
    const toggle = document.getElementById('dark-mode-toggle');
    const isDark = localStorage.getItem('dark-mode') === 'true';
    
    if (isDark) {
        document.documentElement.classList.add('dark');
        if (toggle) toggle.innerHTML = '<i class="fa-solid fa-sun text-amber-400"></i>';
    }

    if (toggle) {
        toggle.addEventListener('click', () => {
            document.documentElement.classList.toggle('dark');
            const activeDark = document.documentElement.classList.contains('dark');
            localStorage.setItem('dark-mode', activeDark);
            toggle.innerHTML = activeDark ? '<i class="fa-solid fa-sun text-amber-400"></i>' : '<i class="fa-solid fa-moon"></i>';
            if (progressChart) fetchProgressData(); // Recargar gráfico con paleta correspondiente
        });
    }
}

// --- WAVEFORM AUDIO VISUALIZER ---
function initWaveform() {
    waveformCanvas = document.getElementById('waveform');
    if (waveformCanvas) waveformCtx = waveformCanvas.getContext('2d');
}

async function startAudioVisualization(stream, canvas, ctx) {
    if (!canvas || !ctx) return;
    try {
        audioContext = new (window.AudioContext || window.webkitAudioContext)();
        analyser = audioContext.createAnalyser();
        const source = audioContext.createMediaStreamSource(stream);
        source.connect(analyser);
        analyser.fftSize = 256;
        dataArray = new Uint8Array(analyser.frequencyBinCount);
        drawWaveform(canvas, ctx);
    } catch (e) {
        console.error("Visualización no soportada:", e);
    }
}

function drawWaveform(canvas, ctx) {
    if (!analyser) return;
    requestAnimationFrame(() => drawWaveform(canvas, ctx));
    analyser.getByteTimeDomainData(dataArray);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    
    const isDark = document.documentElement.classList.contains('dark');
    ctx.fillStyle = isDark ? '#1e293b' : '#e2e8f0';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    
    ctx.lineWidth = 2;
    ctx.strokeStyle = isDark ? '#818cf8' : '#4f46e5';
    ctx.beginPath();
    
    const bufferLength = dataArray.length;
    const sliceWidth = canvas.width / bufferLength;
    let x = 0;
    
    for (let i = 0; i < bufferLength; i++) {
        const v = dataArray[i] / 128.0;
        const y = v * canvas.height / 2;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
        x += sliceWidth;
    }
    ctx.stroke();
}

// --- ESTADÍSTICAS DEL USUARIO Y XP ---
async function fetchUserStats() {
    try {
        const res = await fetch(`${API_BASE_URL}/api/user/stats`);
        if (!res.ok) return;
        const stats = await res.json();
        userStats = stats;
        
        document.getElementById('user-level').innerText = stats.level;
        document.getElementById('user-xp').innerText = stats.xp;
        document.getElementById('user-streak').innerText = stats.streak;
        document.getElementById('user-badges').innerText = stats.badges.length;
        document.getElementById('nav-user-level-badge').innerText = `Nivel: ${stats.level}`;
    } catch (e) { console.error('Error al obtener estadisticas:', e); }
}

async function updateUserXP(xpGain) {
    try {
        const res = await fetch(`${API_BASE_URL}/api/user/update-xp?xp_gain=${xpGain}`);
        if (res.ok) {
            await fetchUserStats();
            showXPPopup(xpGain);
        }
    } catch (e) { console.error('Error al actualizar XP:', e); }
}

function showXPPopup(gain) {
    const popup = document.createElement('div');
    popup.className = 'fixed top-20 right-4 bg-emerald-700 text-white font-extrabold px-4 py-2 rounded-xl shadow-lg z-50 animate-bounce';
    popup.innerText = `+${gain} XP`;
    document.body.appendChild(popup);
    setTimeout(() => popup.remove(), 2000);
}

// --- GRÁFICO DE PROGRESO Adaptado a Contrastes ---
async function fetchProgressData() {
    try {
        const res = await fetch(`${API_BASE_URL}/api/user/progress?days=30`);
        if (!res.ok) return;
        const data = await res.json();
        const canvas = document.getElementById('progress-chart');
        if (!canvas) return;
        
        const ctx = canvas.getContext('2d');
        const isDark = document.documentElement.classList.contains('dark');
        
        if (progressChart) progressChart.destroy();
        
        progressChart = new Chart(ctx, {
            type: 'line',
            data: {
                labels: data.dates,
                datasets: [
                    { label: 'XP', data: data.xp, borderColor: '#d97706', backgroundColor: '#d97706', tension: 0.2 },
                    { label: 'Palabras', data: data.words, borderColor: '#2563eb', backgroundColor: '#2563eb', tension: 0.2 },
                    { label: 'Roleplays', data: data.roleplays, borderColor: '#059669', backgroundColor: '#059669', tension: 0.2 }
                ]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: {
                        labels: { color: isDark ? '#e2e8f0' : '#1e293b', font: { weight: 'bold' } }
                    }
                },
                scales: {
                    x: { ticks: { color: isDark ? '#94a3b8' : '#64748b' }, grid: { color: isDark ? '#334155' : '#e2e8f0' } },
                    y: { beginAtZero: true, ticks: { color: isDark ? '#94a3b8' : '#64748b' }, grid: { color: isDark ? '#334155' : '#e2e8f0' } }
                }
            }
        });
    } catch (e) { console.error('Error cargando gráfico:', e); }
}

// --- DESAFÍO DIARIO CON ALTO CONTRASTE ---
async function fetchDailyChallenge() {
    try {
        const res = await fetch(`${API_BASE_URL}/api/daily-challenge`);
        if (!res.ok) return;
        const data = await res.json();
        const container = document.getElementById('challenge-missions');
        if (!container) return;

        container.innerHTML = data.missions.map(m => `
            <div class="bg-slate-50 dark:bg-slate-700/60 p-4 rounded-xl border border-slate-200 dark:border-slate-600">
                <div class="flex items-center justify-between mb-2">
                    <span class="text-sm font-bold text-amber-700 dark:text-amber-400">Misión ${m.id}</span>
                    <button onclick="completeMission(${m.id})" class="text-xs bg-amber-600 hover:bg-amber-700 text-white px-3 py-1 rounded-lg transition font-semibold">Completar</button>
                </div>
                <p class="text-slate-800 dark:text-slate-100 font-medium">${m.text}</p>
            </div>
        `).join('');
    } catch (e) { console.error('Error en Desafío Diario:', e); }
}

async function completeMission(missionId) {
    try {
        const res = await fetch(`${API_BASE_URL}/api/daily-challenge/complete?mission_id=${missionId}`, { method: 'POST' });
        if (res.ok) {
            const data = await res.json();
             await Swal.fire({
                icon: 'success',
                title: '¡Misión completada!',
                text: `+${data.xp_gained} XP`,
                timer: 2000,
                showConfirmButton: false
            });
            await fetchUserStats();
        }
    } catch (e) { console.error('Error al completar misión:', e); }
}

// --- CURRÍCULO & LECTURAS ---
async function fetchCurriculum() {
    const select = document.getElementById("material-select");
    const display = document.getElementById("text-display");

    try {
        const res = await fetch(`${API_BASE_URL}/api/curriculum`);
        if (!res.ok) throw new Error("Servidor no disponible");
        
        curriculumData = await res.json();
        allUnitsMap = {};
        let selectHtml = "";
        let firstUnitId = null;

        for (const [levelKey, levelObj] of Object.entries(curriculumData)) {
            selectHtml += `<optgroup label="${levelObj.level_name}">`;
            levelObj.units.forEach(unit => {
                allUnitsMap[unit.id] = unit;
                if (!firstUnitId) firstUnitId = unit.id;
                selectHtml += `<option value="${unit.id}">${unit.title}</option>`;
            });
            selectHtml += `</optgroup>`;
        }

        if (select) select.innerHTML = selectHtml;
        if (firstUnitId) {
            currentUnit = allUnitsMap[firstUnitId];
            renderCurrentUnit();
        }
    } catch (err) {
        console.error("Error al cargar plan de estudios:", err);
        if (display) {
            display.innerHTML = `
                <div class="p-4 bg-rose-50 dark:bg-rose-950/50 border border-rose-200 dark:border-rose-800 rounded-xl text-rose-800 dark:text-rose-200">
                    <strong>⚠️ Conexión no establecida con el backend API.</strong>
                </div>
            `;
        }
    }
}

function loadMaterial() {
    const select = document.getElementById("material-select");
    if (!select) return;
    const selectedId = select.value;
    if (allUnitsMap[selectedId]) {
        currentUnit = allUnitsMap[selectedId];
        renderCurrentUnit();
    }
}

function renderCurrentUnit() {
    if (!currentUnit) return;
    const display = document.getElementById("text-display");
    if (display) {
        display.innerHTML = `
            <div class="mb-3 flex flex-wrap gap-2 items-center">
                <span class="text-xs bg-indigo-100 dark:bg-indigo-950/70 text-indigo-800 dark:text-indigo-200 px-2.5 py-1 rounded-md font-bold uppercase tracking-wide border border-indigo-200 dark:border-indigo-800/50">
                    Gramática: ${currentUnit.grammar_focus}
                </span>
            </div>
            <p class="text-slate-800 dark:text-slate-100 text-lg leading-relaxed font-medium">${currentUnit.text}</p>
            <div class="mt-4 pt-3 border-t border-slate-200 dark:border-slate-700 flex flex-wrap items-center gap-1.5 text-xs text-slate-600 dark:text-slate-300">
                <strong class="text-slate-800 dark:text-slate-200">Vocabulario clave:</strong> 
                ${currentUnit.vocabulary.map(v => `
                    <span class="bg-slate-100 dark:bg-slate-700 text-slate-800 dark:text-slate-200 px-2 py-0.5 rounded border border-slate-300 dark:border-slate-600 cursor-pointer hover:bg-indigo-600 hover:text-white dark:hover:bg-indigo-600 dark:hover:text-white transition font-medium" 
                          onclick="playNaturalAudio('${v}')" 
                          title="Escuchar pronunciación">
                        ${v}
                    </span>
                `).join("")}
            </div>
        `;
    }

    const results = document.getElementById("reading-results");
    if (results) results.classList.add("hidden");
}

// --- AUDIO SÍNTESIS ---
function playNaturalAudio(text, voice = "en-US-AriaNeural") {
    if (!text) return;
    const audioUrl = `${API_BASE_URL}/api/tts-natural?text=${encodeURIComponent(text)}&voice=${voice}`;
    const audio = new Audio(audioUrl);
    
    audio.play().catch(() => {
        window.speechSynthesis.cancel();
        const utterance = new SpeechSynthesisUtterance(text);
        utterance.lang = "en-US";
        window.speechSynthesis.speak(utterance);
    });
}

function playTargetAudio() {
    if (currentUnit) playNaturalAudio(currentUnit.text);
}

// --- RECONOCIMIENTO Y EVALUACIÓN DE PRONUNCIACIÓN ---
function setupSpeechRecognition() {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) return;

    recognition = new SpeechRecognition();
    recognition.lang = "en-US";
    recognition.continuous = false;
    recognition.interimResults = false;

    recognition.onresult = async (event) => {
        const transcript = event.results[0][0].transcript;
        await evaluatePronunciation(transcript);
    };

    recognition.onerror = () => stopRecording();
}

function toggleRecording() {
    if (!isRecording) startRecording();
    else stopRecording();
}

async function startRecording() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        await Swal.fire({
            icon: 'error',
            title: 'Navegador no compatible',
            text: 'Tu navegador no soporta entrada de audio.',
            confirmButtonColor: '#4f46e5'
        });
        return;
    }
    try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        mediaRecorder = new MediaRecorder(stream);
        recordedChunks = [];
        
        mediaRecorder.ondataavailable = e => recordedChunks.push(e.data);
        mediaRecorder.onstop = async () => {
            const blob = new Blob(recordedChunks, { type: 'audio/wav' });
            const formData = new FormData();
            formData.append('audio_file', blob, 'recording.wav');
            formData.append('target_text', currentUnit ? currentUnit.text : '');
            
            try {
                const res = await fetch(`${API_BASE_URL}/api/evaluate-reading`, {
                    method: 'POST',
                    body: formData
                });
                if (res.ok) {
                    const data = await res.json();
                    displayReadingResults(data);
                    updateUserXP(5);
                }
            } catch (e) { console.error('Error al evaluar audio:', e); }
        };
        
        mediaRecorder.start();
        isRecording = true;
        document.getElementById('record-text').innerText = "Detener y Evaluar";
        document.getElementById('btn-record').classList.replace('bg-rose-600', 'bg-slate-800');
        await startAudioVisualization(stream, waveformCanvas, waveformCtx);
    } catch (e) {
        Swal.fire({
            icon: 'error',
            title: 'Activación de micrófono',
            text: 'No se pudo activar el micrófono..',
            confirmButtonColor: '#4f46e5'
        });
    }
}

function stopRecording() {
    if (mediaRecorder && isRecording) {
        mediaRecorder.stop();
        isRecording = false;
        document.getElementById('record-text').innerText = "Empezar a Grabar";
        document.getElementById('btn-record').classList.replace('bg-slate-800', 'bg-rose-600');
        if (mediaRecorder.stream) mediaRecorder.stream.getTracks().forEach(t => t.stop());
    }
}

async function evaluatePronunciation(spokenText) {
    if (!currentUnit) return;
    try {
        const response = await fetch(`${API_BASE_URL}/api/evaluate-reading`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ target_text: currentUnit.text, spoken_text: spokenText })
        });
        if (response.ok) {
            const data = await response.json();
            displayReadingResults(data);
            updateUserXP(5);
        }
    } catch (err) { console.error(err); }
}

function displayReadingResults(data) {
    const container = document.getElementById("reading-results");
    const scoreText = document.getElementById("accuracy-score");
    const annotatedText = document.getElementById("annotated-text");

    if (!container || !scoreText || !annotatedText) return;

    container.classList.remove("hidden");
    scoreText.innerText = `Precisión: ${data.accuracy_score}%`;

    annotatedText.innerHTML = data.word_analysis.map(item => {
        if (item.status === "correct") {
            return `<span class="correct text-emerald-600 dark:text-emerald-400 font-bold mr-1.5">${item.word}</span>`;
        } else {
            return `
                <span class="inline-flex flex-col items-center bg-rose-50 dark:bg-rose-950/50 px-2 py-1 rounded border border-rose-200 dark:border-rose-800/60 cursor-pointer mx-1 my-1 hover:bg-rose-100 dark:hover:bg-rose-900/60 transition" 
                      onclick="playNaturalAudio('${item.word}')" 
                      title="Escuchar pronunciación correcta">
                    <span class="text-rose-700 dark:text-rose-300 font-bold underline decoration-rose-400">${item.word}</span>
                    <span class="text-[11px] text-slate-600 dark:text-slate-400 font-mono font-medium">${item.ipa}</span>
                </span>`;
        }
    }).join(" ");
}

// --- DICTADO & LISTENING ---
function playDictationAudio() {
    if (currentUnit) playNaturalAudio(currentUnit.text);
}

function checkDictation() {
    if (!currentUnit) return;
    const userInput = document.getElementById("dictation-input").value.trim().toLowerCase().replace(/[^\w\s]/g, "");
    const targetText = currentUnit.text.trim().toLowerCase().replace(/[^\w\s]/g, "");
    const feedback = document.getElementById("dictation-feedback");

    if (!feedback) return;
    feedback.classList.remove("hidden");

    if (userInput === targetText) {
        feedback.className = "mt-4 p-4 rounded-xl bg-emerald-50 dark:bg-emerald-950/50 text-emerald-900 dark:text-emerald-200 font-bold border border-emerald-200 dark:border-emerald-800";
        feedback.innerText = "🎉 ¡Perfecto! Escribiste la frase con total exactitud.";
        updateUserXP(10);
    } else {
        feedback.className = "mt-4 p-4 rounded-xl bg-amber-50 dark:bg-amber-950/50 text-amber-900 dark:text-amber-200 border border-amber-200 dark:border-amber-800";
        feedback.innerHTML = `
            <p class="font-bold mb-1.5 text-amber-900 dark:text-amber-200">Casi lo logras. Compara lo que escribiste:</p>
            <p class="text-sm text-slate-700 dark:text-slate-300 mb-2"><strong>Tu respuesta:</strong> <span class="bg-white dark:bg-slate-800 px-2 py-0.5 rounded border border-amber-300 dark:border-amber-700 font-mono">${userInput || "(vacío)"}</span></p>
            <p class="text-sm text-emerald-800 dark:text-emerald-300"><strong>Original:</strong> ${currentUnit.text}</p>
        `;
    }
}

// --- WRITING GRAMMAR CHECK ---
async function analyzeWriting(e) {
    // Frena cualquier comportamiento por defecto inmediatamente
    if (e) {
        if (typeof e.preventDefault === "function") e.preventDefault();
        if (typeof e.stopPropagation === "function") e.stopPropagation();
    }

    const input = document.getElementById("writing-input");
    const resDiv = document.getElementById("writing-results");
    if (!input || !resDiv) return;

    const text = input.value.trim();
    if (!text) {
        await Swal.fire({
            icon: 'warning',
            title: 'Texto vacío',
            text: 'Escribe o pega un texto en inglés.',
            confirmButtonColor: '#4f46e5'
        });
        return;
    }

    // Mostrar el indicador de carga
    resDiv.classList.remove("hidden");
    resDiv.innerHTML = `
        <div class="p-4 bg-indigo-50 dark:bg-indigo-950/40 text-indigo-800 dark:text-indigo-200 rounded-xl font-medium animate-pulse flex items-center gap-2">
            <i class="fa-solid fa-circle-notch fa-spin"></i> Analizando texto...
        </div>`;

    try {
        const response = await fetch(`${API_BASE_URL}/api/check-writing`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ text })
        });

        if (!response.ok) throw new Error(`HTTP Error ${response.status}`);
        const data = await response.json();

        let html = `
            <div class="p-4 bg-indigo-50 dark:bg-indigo-950/50 border border-indigo-200 dark:border-indigo-800 rounded-xl mb-4 flex justify-between items-center">
                <strong class="text-lg text-indigo-900 dark:text-indigo-200">Puntuación:</strong>
                <span class="text-2xl font-black text-indigo-600 dark:text-indigo-400">${data.score}/100</span>
            </div>`;

        // Renderizar resultado cuando NO HAY errores
        if (!data.feedback || data.feedback.length === 0) {
            html += `
                <div class="p-4 bg-emerald-50 dark:bg-emerald-950/50 border border-emerald-200 dark:border-emerald-800 text-emerald-800 dark:text-emerald-200 rounded-xl font-bold flex items-center gap-3">
                    <i class="fa-solid fa-circle-check text-2xl text-emerald-500"></i>
                    <span>¡Excelente! Tu texto no contiene errores gramaticales detectables.</span>
                </div>`;
        } else {
            // Renderizar listado de sugerencias
            html += `<ul class="space-y-3">`;
            data.feedback.forEach(item => {
                html += `
                    <li class="p-4 bg-rose-50 dark:bg-rose-950/40 border-l-4 border-rose-500 text-sm rounded-r-xl shadow-sm">
                        <strong class="text-rose-800 dark:text-rose-300 font-bold">${item.short_message}:</strong> 
                        <span class="text-slate-800 dark:text-slate-200">${item.message}</span>
                    </li>`;
            });
            html += `</ul>`;
        }

        resDiv.innerHTML = html;

    } catch (err) {
        console.error("Writing Error:", err);
        resDiv.innerHTML = `
            <div class="p-4 bg-rose-50 dark:bg-rose-950/50 text-rose-800 dark:text-rose-200 border border-rose-200 dark:border-rose-800 rounded-xl font-medium">
                ⚠️ Ocurrió un error al conectar con el servidor.
            </div>`;
    }
}

// --- SHADOWING ---
function startShadowingRoutine() {
    if (!currentUnit) return;
    const sentences = currentUnit.text.match(/[^.!?]+[.!?]+/g) || [currentUnit.text];
    let index = 0;

    function playNextSentence() {
        if (index < sentences.length) {
            const current = sentences[index].trim();
            const display = document.getElementById('shadowing-display');
            if (display) display.innerText = current;
            playNaturalAudio(current);
            index++;
            setTimeout(playNextSentence, 4500);
        }
    }
    playNextSentence();
}

// --- REPETICIÓN ESPACIADA (SRS) ---
async function fetchSRSStats() {
    try {
        const res = await fetch(`${API_BASE_URL}/api/srs/stats`);
        if (!res.ok) return;
        const stats = await res.json();
        const badge = document.getElementById("srs-badge");

        if (badge) {
            if (stats.due_today > 0) {
                badge.innerText = stats.due_today;
                badge.classList.remove("hidden");
            } else {
                badge.classList.add("hidden");
            }
        }
    } catch (err) { console.error("Error SRS stats:", err); }
}

async function fetchSRSDueWords() {
    try {
        const res = await fetch(`${API_BASE_URL}/api/srs/due-words`);
        if (!res.ok) return;
        const data = await res.json();
        srsDueWords = data.due_words;
        currentSRSIndex = 0;
        renderSRSCard();
    } catch (err) { console.error("Error SRS words:", err); }
}

function renderSRSCard() {
    const container = document.getElementById("srs-card-container");
    const emptyState = document.getElementById("srs-empty-state");
    const wordDisplay = document.getElementById("srs-word-display");
    const ipaDisplay = document.getElementById("srs-ipa-display");

    if (!container || !emptyState) return;

    if (srsDueWords.length === 0 || currentSRSIndex >= srsDueWords.length) {
        container.classList.add("hidden");
        emptyState.classList.remove("hidden");
        return;
    }

    container.classList.remove("hidden");
    emptyState.classList.add("hidden");

    const currentCard = srsDueWords[currentSRSIndex];
    if (wordDisplay) wordDisplay.innerText = currentCard.word;
    if (ipaDisplay) ipaDisplay.innerText = currentCard.ipa;
}

function playSRSWordAudio() {
    if (srsDueWords.length > 0 && srsDueWords[currentSRSIndex]) {
        playNaturalAudio(srsDueWords[currentSRSIndex].word);
    }
}

async function submitSRSReview(success) {
    if (srsDueWords.length === 0 || !srsDueWords[currentSRSIndex]) return;
    const currentCard = srsDueWords[currentSRSIndex];
    try {
        const res = await fetch(`${API_BASE_URL}/api/srs/review`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ word: currentCard.word, success })
        });
        if (res.ok) {
            currentSRSIndex++;
            renderSRSCard();
            fetchSRSStats();
            if (success) updateUserXP(10);
        }
    } catch (err) { console.error("Error SRS review:", err); }
}

// --- IPA MATRIZ FONÉTICA ---
async function fetchIPAMatrix() {
    try {
        const res = await fetch(`${API_BASE_URL}/api/ipa-matrix`);
        if (!res.ok) return;
        const data = await res.json();

        renderPhonemeCategory("vowels-grid", data.vowels);
        renderPhonemeCategory("diphthongs-grid", data.diphthongs);
        renderPhonemeCategory("consonants-grid", data.consonants);
    } catch (err) { console.error("Error IPA:", err); }
}

// Mapa de color por tipo de fonema — evita repetir clases y mantiene
// consistencia visual entre vocales, diptongos y consonantes.
const IPA_TYPE_COLORS = {
    "Long Vowel": "bg-cyan-100 text-cyan-800 dark:bg-cyan-900/50 dark:text-cyan-300",
    "Short Vowel": "bg-sky-100 text-sky-800 dark:bg-sky-900/50 dark:text-sky-300",
    "Schwa": "bg-slate-200 text-slate-700 dark:bg-slate-700 dark:text-slate-300",
    "Diphthong": "bg-purple-100 text-purple-800 dark:bg-purple-900/50 dark:text-purple-300",
    "Voiced": "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/50 dark:text-emerald-300",
    "Unvoiced": "bg-amber-100 text-amber-800 dark:bg-amber-900/50 dark:text-amber-300",
    "Nasal": "bg-rose-100 text-rose-800 dark:bg-rose-900/50 dark:text-rose-300",
    "Approximant": "bg-indigo-100 text-indigo-800 dark:bg-indigo-900/50 dark:text-indigo-300",
};
const IPA_TYPE_DEFAULT_COLOR = "bg-slate-100 text-slate-700 dark:bg-slate-700 dark:text-slate-300";

function renderPhonemeCategory(containerId, items) {
  const grid = document.getElementById(containerId);
  if (!grid) return;

  grid.innerHTML = items.map((item, index) => {
    // Recortar textos largos para la vista previa
    const truncate = (str, max) => str.length > max ? str.slice(0, max) + '…' : str;
    const shortHint = truncate(item.spanish_equivalent_or_hack, 300);
    const shortError = truncate(item.common_error_spanish, 300);

    const typeColor = IPA_TYPE_COLORS[item.type] || IPA_TYPE_DEFAULT_COLOR;

    return `
      <div class="phoneme-card group bg-white dark:bg-slate-800 rounded-2xl shadow-sm hover:shadow-lg border border-slate-200 dark:border-slate-700 hover:border-cyan-400 dark:hover:border-cyan-500 transition-all duration-200 p-4 cursor-pointer"
           data-index="${index}"
           onclick="playNaturalAudio('${item.example}')">
        
        <!-- Fila superior: símbolo + ejemplo + transcripción -->
        <div class="flex flex-col items-center text-center gap-1 p-2">
            <span class="text-3xl font-mono font-bold text-cyan-700 dark:text-cyan-400 group-hover:scale-110 transition-transform origin-left">/${item.symbol}/</span>
            <span class="text-base font-medium text-slate-700 dark:text-slate-200">${item.example}</span>
            <span class="text-xs text-slate-400 dark:text-slate-500 font-mono">${item.ipa_ex}</span>
        </div>

        <!-- Tipo -->
        <div class="mt-1 text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider ">${item.type}</div>

        <!-- Common spellings (badges) -->
        <div class="mt-3 flex flex-wrap gap-1.5">
          ${item.common_spellings.map(sp => 
            `<span class="px-2.5 py-0.5 bg-cyan-100 dark:bg-cyan-900/40 text-cyan-800 dark:text-cyan-300 text-[11px] rounded-full font-mono border border-cyan-200 dark:border-cyan-800">${sp}</span>`
          ).join('')}
        </div>

        <!-- Minimal pairs (con icono FA) -->
        <div class="mt-3 text-xs text-slate-600 dark:text-slate-300">
          <i class="fa-solid fa-arrows-rotate text-slate-500 dark:text-slate-400 text-xs mr-1"></i>
          <span class="font-semibold">Contrasta con:</span>
          <span class="ml-1">${item.minimal_pairs.join(' · ')}</span>
        </div>

        <!-- Truco / hack (resumen) con icono FA -->
        <div class="mt-2 text-xs text-slate-600 dark:text-slate-300 italic line-clamp-2">
          <i class="fa-regular fa-lightbulb text-amber-400 dark:text-amber-300 text-xs mr-1.5"></i>
          ${shortHint}
        </div>

        <!-- Error común (resumen) con icono FA -->
        <div class="mt-1 text-[11px] text-rose-600 dark:text-rose-400 line-clamp-1">
          <i class="fa-solid fa-triangle-exclamation text-rose-500 dark:text-rose-400 text-[10px] mr-1.5"></i>
          ${shortError}
        </div>

        <!-- Botón para expandir (toggle) con iconos FA -->
        <div class="mt-3 text-center">
          <button onclick="event.stopPropagation(); toggleDetails(this, ${index})" 
                  class="text-[11px] font-medium text-cyan-600 dark:text-cyan-400 hover:underline focus:outline-none flex items-center justify-center gap-1.5 w-full">
            <i class="fa-regular fa-book-open text-cyan-600 dark:text-cyan-400 text-xs"></i>
            <span class="btn-toggle-text">Ver más</span>
          </button>
        </div>

        <!-- Contenedor de detalles ocultos (se expande) -->
        <div id="details-${index}" class="hidden mt-3 pt-3 border-t border-slate-200 dark:border-slate-700 text-xs text-slate-600 dark:text-slate-300 space-y-2">
          <div>
            <i class="fa-regular fa-lightbulb text-amber-400 dark:text-amber-300 text-xs mr-1.5"></i>
            <span class="font-semibold">Similar a:</span> ${item.spanish_equivalent_or_hack}
          </div>
          <div>
            <i class="fa-solid fa-xmark text-rose-500 dark:text-rose-400 text-xs w-4"></i>
            <span class="font-semibold">Error común:</span> ${item.common_error_spanish}
          </div>
          <div>
            <i class="fa-regular fa-pen-to-square text-slate-500 dark:text-slate-400 text-xs w-4"></i>
            <span class="font-semibold">Grafías:</span> ${item.common_spellings.join(', ')}
          </div>
          <div>
            <i class="fa-solid fa-rotate-right text-slate-500 dark:text-slate-400 text-xs w-4"></i>
            <span class="font-semibold">Pares mínimos:</span> ${item.minimal_pairs.join('; ')}
          </div>
        </div>
      </div>
    `;
  }).join("");

  // Función toggle (se declara global para usarse desde el onclick)
  window.toggleDetails = function(btn, index) {
    const details = document.getElementById(`details-${index}`);
    if (details) {
      const isHidden = details.classList.contains('hidden');
      details.classList.toggle('hidden');
      const textSpan = btn.querySelector('.btn-toggle-text');
      const icon = btn.querySelector('i');
      if (textSpan) {
        textSpan.textContent = isHidden ? 'Ver menos' : 'Ver más';
      }
      if (icon) {
        icon.className = isHidden 
          ? 'fa-regular fa-book text-cyan-600 dark:text-cyan-400 text-xs' 
          : 'fa-regular fa-book-open text-cyan-600 dark:text-cyan-400 text-xs';
      }
    }
  };
}

// --- ROLEPLAY MODULO ---
async function initRoleplayModule() {
    try {
        const res = await fetch(`${API_BASE_URL}/api/roleplay/scenarios`);
        if (!res.ok) return;
        const scenarios = await res.json();
        
        // Mapeo por ID para evitar JSON.stringify dentro del HTML
        roleplayScenariosMap = {};
        scenarios.forEach(sc => { roleplayScenariosMap[sc.id] = sc; });
        
        renderScenariosGrid(scenarios);
    } catch (err) { console.error("Error Roleplay:", err); }
}

function renderScenariosGrid(scenarios) {
    const grid = document.getElementById("roleplay-scenarios-grid");
    if (!grid) return;

    grid.innerHTML = scenarios.map(sc => `
        <div onclick="startRoleplaySession('${sc.id}')" 
             class="p-5 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl hover:border-indigo-500 dark:hover:border-indigo-400 hover:shadow-md cursor-pointer transition flex flex-col justify-between">
            <div>
                <div class="w-12 h-12 bg-indigo-50 dark:bg-indigo-950/70 text-indigo-600 dark:text-indigo-400 rounded-xl flex items-center justify-center text-2xl mb-4">
                    <i class="fa-solid ${sc.icon}"></i>
                </div>
                <h3 class="font-bold text-slate-800 dark:text-slate-100 text-lg mb-1">${sc.title}</h3>
                <p class="text-xs text-slate-600 dark:text-slate-300 mb-3">${sc.description}</p>
            </div>
            <span class="text-xs font-semibold text-indigo-600 dark:text-indigo-400 flex items-center gap-1">
                Iniciar práctica <i class="fa-solid fa-arrow-right"></i>
            </span>
        </div>
    `).join("");
}

function startRoleplaySession(scenarioId) {
    const sc = roleplayScenariosMap[scenarioId];
    if (!sc) return;

    currentScenario = sc;
    roleplayHistory = [];
    document.getElementById("roleplay-scenarios-grid").classList.add("hidden");
    document.getElementById("roleplay-chat-box").classList.remove("hidden");
    document.getElementById("rp-active-title").innerText = sc.title;
    document.getElementById("rp-active-role").innerText = `Interlocutor: ${sc.role}`;
    
    const messagesContainer = document.getElementById("rp-messages");
    messagesContainer.innerHTML = "";
    
    appendRPMessage("bot", sc.initial_message);
    playNaturalAudio(sc.initial_message);
    renderRPSuggestions(sc.suggested_replies);
    roleplayHistory.push({ role: "assistant", content: sc.initial_message });
}

function closeRoleplayChat() {
    document.getElementById("roleplay-scenarios-grid").classList.remove("hidden");
    document.getElementById("roleplay-chat-box").classList.add("hidden");
    currentScenario = null;
}

function appendRPMessage(sender, text, feedback = null) {
    const container = document.getElementById("rp-messages");
    if (!container) return;

    const isBot = sender === "bot";
    const msgHtml = `
        <div class="flex flex-col ${isBot ? 'items-start' : 'items-end'}">
            <div class="max-w-[80%] p-4 rounded-2xl ${isBot ? 'bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-800 dark:text-slate-100' : 'bg-indigo-600 text-white'} shadow-sm">
                <p class="text-sm font-medium">${text}</p>
            </div>
            ${feedback ? `<span class="text-[11px] text-amber-700 dark:text-amber-400 mt-1 font-semibold flex items-center gap-1"><i class="fa-solid fa-lightbulb"></i> ${feedback}</span>` : ''}
        </div>
    `;

    container.insertAdjacentHTML("beforeend", msgHtml);
    container.scrollTop = container.scrollHeight;
}

// Renderiza las sugerencias dinámicas usando type="button"
function renderRPSuggestions(replies) {
    const box = document.getElementById("rp-suggestions");
    if (!box) return;

    if (!replies || replies.length === 0) {
        box.innerHTML = "";
        box.classList.add("hidden");
        return;
    }

    box.classList.remove("hidden");
    box.innerHTML = replies.map(r => `
        <button 
            type="button" 
            onclick="useRPSuggestion('${r.replace(/'/g, "\\'")}', event)" 
            class="bg-slate-100 dark:bg-slate-700 hover:bg-indigo-50 dark:hover:bg-indigo-950/60 hover:text-indigo-700 dark:hover:text-indigo-300 text-slate-700 dark:text-slate-200 px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-600 transition font-medium text-left"
        >
            💡 "${r}"
        </button>
    `).join("");
}

function renderRPSuggestions(replies) {
    const box = document.getElementById("rp-suggestions");
    if (!box) return;

    if (!replies || replies.length === 0) {
        box.innerHTML = "";
        box.classList.add("hidden");
        return;
    }

    box.classList.remove("hidden");
    // Se usa encodeURIComponent para evitar que comillas o apóstrofes rompan el HTML
    box.innerHTML = replies.map(r => `
        <button 
            type="button" 
            data-reply="${encodeURIComponent(r)}"
            onclick="useRPSuggestionFromData(this, event)" 
            class="bg-slate-100 dark:bg-slate-700 hover:bg-indigo-50 dark:hover:bg-indigo-950/60 hover:text-indigo-700 dark:hover:text-indigo-300 text-slate-700 dark:text-slate-200 px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-600 transition font-medium text-left"
        >
            💡 "${r}"
        </button>
    `).join("");
}

function useRPSuggestionFromData(btnEl, e) {
    if (e) {
        if (typeof e.preventDefault === "function") e.preventDefault();
        if (typeof e.stopPropagation === "function") e.stopPropagation();
    }

    const rawText = btnEl.getAttribute("data-reply");
    if (!rawText) return;

    const text = decodeURIComponent(rawText);
    const input = document.getElementById("rp-transcript-input");
    if (input) {
        input.value = text;
    }
    
    sendRoleplayMessage(e);
}

function toggleRoleplayMic() {
    const btn = document.getElementById("rp-mic-btn");
    const statusText = document.getElementById("rp-status-text");

    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
        Swal.fire({
            icon: 'error',
            title: 'Navegador no compatible',
            text: 'Navegador no soporta reconocimiento de voz.',
            confirmButtonColor: '#4f46e5'
        });
        return;
    }

    if (isRPRecording) {
        if (roleplayRecognition) roleplayRecognition.stop();
        return;
    }

    roleplayRecognition = new SpeechRecognition();
    roleplayRecognition.lang = 'en-US';

    roleplayRecognition.onstart = () => {
        isRPRecording = true;
        btn.classList.add("bg-rose-600", "animate-pulse");
        btn.classList.remove("bg-indigo-600");
        statusText.innerText = "Escuchando... habla ahora en inglés";
        statusText.classList.add("text-rose-600", "dark:text-rose-400");
    };

    roleplayRecognition.onresult = (event) => {
        const transcript = event.results[0][0].transcript;
        document.getElementById("rp-transcript-input").value = transcript;
    };

    roleplayRecognition.onend = () => {
        isRPRecording = false;
        btn.classList.remove("bg-rose-600", "animate-pulse");
        btn.classList.add("bg-indigo-600");
        statusText.innerText = "Presiona el micrófono para hablar...";
        statusText.classList.remove("text-rose-600", "dark:text-rose-400");
    };

    roleplayRecognition.start();
}

async function sendRoleplayMessage(e) {
    if (e) {
        if (typeof e.preventDefault === "function") e.preventDefault();
        if (typeof e.stopPropagation === "function") e.stopPropagation();
    }

    const input = document.getElementById("rp-transcript-input");
    if (!input) return;
    const userText = input.value.trim();
    if (!userText || !currentScenario) return;

    appendRPMessage("user", userText);
    roleplayHistory.push({ role: "user", content: userText });
    input.value = "";

    try {
        const res = await fetch(`${API_BASE_URL}/api/roleplay/respond`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                scenario_id: currentScenario.id,
                user_message: userText,
                conversation_history: roleplayHistory
            })
        });

        if (res.ok) {
            const data = await res.json();
            appendRPMessage("bot", data.bot_reply, data.feedback);
            playNaturalAudio(data.bot_reply);
            roleplayHistory.push({ role: "assistant", content: data.bot_reply });
            updateUserXP(10);
        } else {
            // FIX: antes, si el backend respondía con un status de error
            // (4xx/5xx), no pasaba nada visible: `res.ok` era false y el
            // bloque simplemente no hacía nada. El usuario veía la interfaz
            // "colgada" sin ningún mensaje, indistinguible de un fallo real
            // del LLM devolviendo la respuesta genérica.
            console.error("Error Roleplay: respuesta no OK", res.status);
            appendRPMessage("bot", "Ups, hubo un problema de conexión con el tutor. Intenta de nuevo en unos segundos.");
        }
    } catch (err) {
        console.error("Error Roleplay:", err);
        appendRPMessage("bot", "Ups, hubo un problema de conexión con el tutor. Intenta de nuevo en unos segundos.");
    }
}

// Función para seleccionar e inmediatamente enviar una sugerencia
function selectSuggestedResponse(text, e) {
    if (e) {
        if (typeof e.preventDefault === "function") e.preventDefault();
        if (typeof e.stopPropagation === "function") e.stopPropagation();
    }

    const input = document.getElementById("rp-transcript-input");
    if (input) {
        input.value = text;
    }
    
    // Ejecutamos el envío pasando el evento
    sendRoleplayMessage(e);
}

// Renderizado de las opciones/sugerencias de respuesta en el Roleplay
function renderRoleplaySuggestions(suggestions) {
    const container = document.getElementById("rp-suggestions-container");
    if (!container) return;

    if (!suggestions || suggestions.length === 0) {
        container.innerHTML = "";
        container.classList.add("hidden");
        return;
    }

    container.classList.remove("hidden");
    // IMPORTANTE: type="button" explícito y pasa (event) en el onclick
    container.innerHTML = suggestions.map(sug => `
        <button 
            type="button" 
            onclick="selectSuggestedResponse('${sug.replace(/'/g, "\\'")}', event)"
            class="px-3 py-1.5 bg-slate-100 dark:bg-slate-800 hover:bg-emerald-100 dark:hover:bg-emerald-900/50 text-slate-700 dark:text-slate-300 hover:text-emerald-700 dark:hover:text-emerald-300 text-xs font-semibold rounded-full border border-slate-200 dark:border-slate-700 transition-colors text-left"
        >
            💡 ${sug}
        </button>
    `).join('');
}

// --- PLACEMENT TEST ---
function initPlacementTest() {
    if (ptState.history.length === 0) {
        document.getElementById("pt-start-view").classList.remove("hidden");
        document.getElementById("pt-quiz-view").classList.add("hidden");
        document.getElementById("pt-result-view").classList.add("hidden");
    }
}

async function startPlacementTestProcess() {
    ptState = { currentLevel: "A2", questionId: null, selectedOption: null, history: [] };
    try {
        const res = await fetch(`${API_BASE_URL}/api/placement/start`);
        if (!res.ok) return;
        const data = await res.json();

        document.getElementById("pt-start-view").classList.add("hidden");
        document.getElementById("pt-result-view").classList.add("hidden");
        document.getElementById("pt-quiz-view").classList.remove("hidden");
        renderPlacementQuestion(data);
    } catch (err) { console.error(err); }
}

function renderPlacementQuestion(data) {
    ptState.currentLevel = data.level;
    ptState.questionId = data.question.id;
    ptState.selectedOption = null;

    document.getElementById("pt-step-indicator").innerText = `Pregunta ${data.step} de ${data.total_steps}`;
    document.getElementById("pt-difficulty-indicator").innerText = `Dificultad: ${data.level}`;
    document.getElementById("pt-progress-bar").style.width = `${(data.step / data.total_steps) * 100}%`;
    document.getElementById("pt-question-text").innerText = data.question.question;

    const optionsContainer = document.getElementById("pt-options-container");
    optionsContainer.innerHTML = data.question.options.map((opt, idx) => `
        <button onclick="selectPlacementOption(${idx})" 
                id="pt-opt-${idx}"
                class="pt-option-btn w-full text-left p-4 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 hover:bg-amber-50 dark:hover:bg-amber-950/30 hover:border-amber-300 dark:hover:border-amber-600 font-medium text-sm text-slate-800 dark:text-slate-100 transition">
            <span class="font-bold text-amber-600 dark:text-amber-400 mr-2">${String.fromCharCode(65 + idx)}.</span> ${opt}
        </button>
    `).join("");

    const nextBtn = document.getElementById("pt-next-btn");
    nextBtn.disabled = true;
    nextBtn.className = "w-full bg-slate-300 dark:bg-slate-700 text-slate-500 dark:text-slate-400 font-bold py-3.5 rounded-xl transition cursor-not-allowed";
}

function selectPlacementOption(optIdx) {
    ptState.selectedOption = optIdx;

    document.querySelectorAll(".pt-option-btn").forEach((btn, idx) => {
        if (idx === optIdx) {
            btn.className = "pt-option-btn w-full text-left p-4 rounded-xl border-2 border-amber-500 bg-amber-50 dark:bg-amber-950/40 font-bold text-sm text-amber-950 dark:text-amber-200 transition shadow-sm";
        } else {
            btn.className = "pt-option-btn w-full text-left p-4 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 hover:bg-amber-50 dark:hover:bg-amber-950/30 font-medium text-sm text-slate-700 dark:text-slate-300 transition opacity-70";
        }
    });

    const nextBtn = document.getElementById("pt-next-btn");
    nextBtn.disabled = false;
    nextBtn.className = "w-full bg-amber-600 hover:bg-amber-700 text-white font-bold py-3.5 rounded-xl shadow transition cursor-pointer";
}

async function submitPlacementAnswer() {
    if (ptState.selectedOption === null) return;
    try {
        const res = await fetch(`${API_BASE_URL}/api/placement/next`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                current_level: ptState.currentLevel,
                question_id: ptState.questionId,
                selected_option: ptState.selectedOption,
                history: ptState.history
            })
        });

        if (res.ok) {
            const data = await res.json();
            if (data.completed) {
                renderPlacementResult(data);
            } else {
                ptState.history = data.history;
                renderPlacementQuestion(data);
            }
        }
    } catch (err) { console.error(err); }
}

function renderPlacementResult(data) {
    document.getElementById("pt-quiz-view").classList.add("hidden");
    document.getElementById("pt-result-view").classList.remove("hidden");

    setUserLevel(data.final_level);
    document.getElementById("pt-final-level").innerText = data.final_level;
    document.getElementById("pt-accuracy").innerText = `${data.accuracy}%`;

    const descriptions = {
        "A1": "Comprendes expresiones cotidianas muy frecuentes y frases sencillas orientadas a satisfacer necesidades básicas.",
        "A2": "Comprendes frases y expresiones de uso frecuente relacionadas con situaciones relevantes de la vida diaria.",
        "B1": "Comprendes los puntos principales de textos claros en lengua estándar sobre temas de trabajo o estudio.",
        "B2": "Entiendes las ideas principales de textos complejos y conversas con suficiente fluidez con nativos."
    };
    document.getElementById("pt-final-desc").innerText = descriptions[data.final_level] || "";
}

function goToUnlockedLessons() {
    switchTab('reading');
}

function getUserLevel() {
    return localStorage.getItem("user_mcer_level") || "A1";
}

function setUserLevel(level) {
    localStorage.setItem("user_mcer_level", level);
    const badge = document.getElementById("nav-user-level-badge");
    if (badge) badge.innerText = `Nivel: ${level}`;
}

function isLevelUnlocked(unitLevel) {
    const userLevel = getUserLevel();
    return LEVEL_ORDER.indexOf(unitLevel) <= LEVEL_ORDER.indexOf(userLevel);
}

// --- CURRÍCULO INTERACTIVO ---
async function renderCurriculum() {
    const container = document.getElementById("curriculum-container");
    if (!container) return;

    try {
        const res = await fetch(`${API_BASE_URL}/api/curriculum`);
        if (!res.ok) return;
        const curriculum = await res.json();

        container.innerHTML = Object.keys(curriculum).map(levelKey => {
            const levelData = curriculum[levelKey];
            const unlocked = isLevelUnlocked(levelKey);

            return `
                <div class="mb-8 p-6 bg-slate-50 dark:bg-slate-800/40 border ${unlocked ? 'border-slate-200 dark:border-slate-700' : 'border-slate-200 dark:border-slate-800 bg-slate-100/60 dark:bg-slate-900/60'} rounded-2xl transition">
                    <div class="flex justify-between items-center mb-4">
                        <div class="flex items-center gap-3">
                            <span class="px-3 py-1 text-xs font-black rounded-lg ${unlocked ? 'bg-indigo-600 text-white' : 'bg-slate-300 dark:bg-slate-700 text-slate-600 dark:text-slate-400'}">
                                ${levelKey}
                            </span>
                            <h3 class="text-lg font-bold ${unlocked ? 'text-slate-800 dark:text-slate-100' : 'text-slate-400 dark:text-slate-500'}">
                                ${levelData.level_name}
                            </h3>
                        </div>

                        ${unlocked ? `
                            <span class="text-xs font-bold text-emerald-700 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-950/50 px-3 py-1 rounded-full border border-emerald-200 dark:border-emerald-800/60 flex items-center gap-1">
                                <i class="fa-solid fa-unlock"></i> Desbloqueado
                            </span>
                        ` : `
                            <span class="text-xs font-bold text-slate-500 dark:text-slate-400 bg-slate-200 dark:bg-slate-700 px-3 py-1 rounded-full flex items-center gap-1">
                                <i class="fa-solid fa-lock"></i> Requiere Nivel ${levelKey}
                            </span>
                        `}
                    </div>

                    <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
                        ${levelData.units.map(unit => `
                            <div class="p-5 bg-white dark:bg-slate-800 border ${unlocked ? 'border-slate-200 dark:border-slate-700 hover:border-indigo-500 dark:hover:border-indigo-400 cursor-pointer shadow-sm' : 'border-slate-200 dark:border-slate-700 opacity-60 cursor-not-allowed'} rounded-xl transition flex justify-between items-center"
                                 onclick="${unlocked ? `loadUnitPractice('${unit.id}')` :  `Swal.fire({icon:'warning',title:'Unidad bloqueada',text:'Debes alcanzar el nivel ${levelKey} en el Test de Nivel para desbloquear esta unidad.',confirmButtonColor:'#4f46e5'})`}">
                                <div>
                                    <h4 class="font-bold text-sm text-slate-800 dark:text-slate-100">${unit.title}</h4>
                                    <p class="text-xs text-slate-600 dark:text-slate-400 mt-1"><i class="fa-solid fa-book-bookmark text-indigo-500"></i> ${unit.grammar_focus}</p>
                                </div>
                                <div class="text-indigo-600 dark:text-indigo-400 font-bold text-sm">
                                    ${unlocked ? '<i class="fa-solid fa-chevron-right"></i>' : '<i class="fa-solid fa-lock text-slate-400 dark:text-slate-500"></i>'}
                                </div>
                            </div>
                        `).join("")}
                    </div>
                </div>
            `;
        }).join("");
    } catch (err) { console.error(err); }
}

function loadUnitPractice(unitId) {
    if (allUnitsMap[unitId]) {
        currentUnit = allUnitsMap[unitId];
        renderCurrentUnit();
        window.scrollTo({ top: 300, behavior: 'smooth' });
    }else {
        // Este caso no debería ocurrir, pero por si acaso
        Swal.fire({
            icon: 'error',
            title: 'Unidad no encontrada',
            text: 'La unidad seleccionada no existe.',
            confirmButtonColor: '#4f46e5'
        });
    }
}

// --- GESTIÓN DE PESTAÑAS (TABS) ---
function switchTab(tabName) {
    document.querySelectorAll('.tab-content').forEach(el => el.classList.add('hidden'));
    document.querySelectorAll('.tab-btn').forEach(btn => {
        if (btn.id === 'tab-challenge') {
            btn.className = 'tab-btn bg-amber-600 hover:bg-amber-700 text-white p-3.5 px-5 rounded-xl shadow-sm font-bold flex items-center justify-center gap-2 transition';
        } else {
            btn.className = 'tab-btn bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-200 border border-slate-200 dark:border-slate-700 p-3.5 px-5 rounded-xl shadow-sm hover:bg-slate-100 dark:hover:bg-slate-700 font-semibold flex items-center justify-center gap-2 transition';
        }
    });

    const activeSection = document.getElementById(`sec-${tabName}`);
    const activeTabBtn = document.getElementById(`tab-${tabName}`);

    if (activeSection) activeSection.classList.remove('hidden');
    if (activeTabBtn && tabName !== 'challenge') {
        activeTabBtn.className = 'tab-btn bg-indigo-600 text-white p-3.5 px-5 rounded-xl shadow-sm font-semibold flex items-center justify-center gap-2 transition';
    }

    switch (tabName) {
        case 'srs': fetchSRSStats(); fetchSRSDueWords(); break;
        case 'ipa-matrix': fetchIPAMatrix(); break;
        case 'roleplay': initRoleplayModule(); break;
        case 'placement': initPlacementTest(); break;
        case 'challenge': fetchDailyChallenge(); break;
        case 'reading': renderCurriculum(); break;
    }
}