// ==========================================
// LinguaBoost Pro - Frontend Application Engine (v4.6)
// ==========================================

// Para pruebas locales
//const API_BASE_URL = "http://127.0.0.1:8000";
// Para pruebas en Render
const API_BASE_URL = "https://english-coach-ekm0.onrender.com";
const SUPABASE_URL = "https://fybnnkzufbobktzuovba.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZ5Ym5ua3p1ZmJvYmt0enVvdmJhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODkxMDUwNjIsImV4cCI6MjEwNDY4MTA2Mn0.efz0qnh-r6XwfgiO4pdx6tBwXU4_DLUOlkGDWa3rbPM";
const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

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
    history: [],
};
// Variable global para autenticación
let authToken = localStorage.getItem("auth_token") || null;
let currentUsername = localStorage.getItem("current_username") || null;

const LEVEL_ORDER = ["A1", "A2", "B1", "B2", "C1", "C2"];

// ----- FLAGS DE PROCESAMIENTO (para evitar doble clic) -----
const processing = {
    recording: false,
    writing: false,
    dictation: false,
    shadowing: false,
    srs: false,
    roleplay: false,
    placement: false,
    mission: false,
    audio: false, // para playNaturalAudio
};

// --- 1. INICIALIZACIÓN ---
document.addEventListener("DOMContentLoaded", async () => {
    initDarkMode();

    // Verificación automática de sesión activa con Supabase
    await checkAutoLogin();

    // VERIFICACIÓN DE SESIÓN
    if (!authToken) {
        showLoginModal();
    } else {
        initializeApp();
    }

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
            if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                analyzeWriting(e);
            }
        });
    }

    // ----- Menú principal -----
    const menuToggle = document.getElementById("menu-toggle");
    const mainMenu = document.getElementById("main-menu");

    menuToggle.addEventListener("click", (e) => {
        e.stopPropagation();
        mainMenu.classList.toggle("hidden");
    });

    document.querySelectorAll("#main-menu a[data-tab]").forEach((link) => {
        link.addEventListener("click", (e) => {
            e.preventDefault();
            const tab = link.dataset.tab;
            switchTab(tab);
            mainMenu.classList.add("hidden");
        });
    });

    document.addEventListener("click", (e) => {
        if (
            !mainMenu.contains(e.target) &&
            e.target !== menuToggle &&
            !menuToggle.contains(e.target)
        ) {
            mainMenu.classList.add("hidden");
        }
    });
});

async function checkAutoLogin() {
    try {
        // Supabase comprueba el almacenamiento local y refresca el token si venció
        const { data: { session }, error } = await supabaseClient.auth.getSession();

        if (session && !error) {
            // Sesión válida: actualizamos variables y cargamos la app
            authToken = session.access_token;
            currentUsername = session.user.email;
            localStorage.setItem("auth_token", authToken);
            localStorage.setItem("current_username", currentUsername);

            hideLoginModal();
            initializeApp();
        } else {
            // No hay sesión o está expirada
            clearSessionStorage();
            showLoginModal();
        }
    } catch (err) {
        console.error("Error verificando sesión automática:", err);
        clearSessionStorage();
        showLoginModal();
    }
}

function clearSessionStorage() {
    authToken = null;
    currentUsername = null;
    localStorage.removeItem("auth_token");
    localStorage.removeItem("current_username");
}

// --- MODO OSCURO ---
function initDarkMode() {
    const toggle = document.getElementById("dark-mode-toggle");
    const isDark = localStorage.getItem("dark-mode") === "true";

    if (isDark) {
        document.documentElement.classList.add("dark");
        if (toggle)
            toggle.innerHTML = '<i class="fa-solid fa-sun text-amber-400"></i>';
    }

    if (toggle) {
        toggle.addEventListener("click", () => {
            document.documentElement.classList.toggle("dark");
            const activeDark =
                document.documentElement.classList.contains("dark");
            localStorage.setItem("dark-mode", activeDark);
            toggle.innerHTML = activeDark
                ? '<i class="fa-solid fa-sun text-amber-400"></i>'
                : '<i class="fa-solid fa-moon"></i>';
            if (progressChart) fetchProgressData();
        });
    }
}

// --- WAVEFORM AUDIO VISUALIZER ---
function initWaveform() {
    waveformCanvas = document.getElementById("waveform");
    if (waveformCanvas) waveformCtx = waveformCanvas.getContext("2d");
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

    const isDark = document.documentElement.classList.contains("dark");
    ctx.fillStyle = isDark ? "#1e293b" : "#e2e8f0";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.lineWidth = 2;
    ctx.strokeStyle = isDark ? "#818cf8" : "#4f46e5";
    ctx.beginPath();

    const bufferLength = dataArray.length;
    const sliceWidth = canvas.width / bufferLength;
    let x = 0;

    for (let i = 0; i < bufferLength; i++) {
        const v = dataArray[i] / 128.0;
        const y = (v * canvas.height) / 2;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
        x += sliceWidth;
    }
    ctx.stroke();
}

// --- ESTADÍSTICAS DEL USUARIO Y XP ---
async function fetchUserStats() {
    try {
        const res = await conectarConServidorRender('/api/user/stats');
        if (!res.ok) return;
        const stats = await res.json();
        userStats = stats;

        document.getElementById("user-level").innerText = stats.level;
        document.getElementById("user-xp").innerText = stats.xp;
        document.getElementById("user-streak").innerText = stats.streak;
        document.getElementById("user-badges").innerText = stats.badges.length;
        document.getElementById("nav-user-level-badge").innerText =
            `Nivel: ${stats.level}`;
    } catch (e) {
        console.error("Error al obtener estadisticas:", e);
    }
}

async function updateUserXP(xpGain) {
    try {
        const res = await conectarConServidorRender('/api/user/update-xp?xp_gain=' + xpGain);
        if (res.ok) {
            await fetchUserStats();
            showXPPopup(xpGain);
        }
    } catch (e) {
        console.error("Error al actualizar XP:", e);
    }
}

function showXPPopup(gain) {
    const popup = document.createElement("div");
    popup.className =
        "fixed top-20 right-4 bg-emerald-700 text-white font-extrabold px-4 py-2 rounded-xl shadow-lg z-50 animate-bounce";
    popup.innerText = `+${gain} XP`;
    document.body.appendChild(popup);
    setTimeout(() => popup.remove(), 2000);
}

// --- GRÁFICO DE PROGRESO ---
async function fetchProgressData() {
    try {
        const res = await conectarConServidorRender('/api/user/progress?days=30');
        if (!res.ok) return;
        const data = await res.json();
        const canvas = document.getElementById("progress-chart");
        if (!canvas) return;

        const ctx = canvas.getContext("2d");
        const isDark = document.documentElement.classList.contains("dark");

        if (progressChart) progressChart.destroy();

        progressChart = new Chart(ctx, {
            type: "line",
            data: {
                labels: data.dates,
                datasets: [
                    {
                        label: "XP",
                        data: data.xp,
                        borderColor: "#d97706",
                        backgroundColor: "#d97706",
                        tension: 0.2,
                    },
                    {
                        label: "Palabras",
                        data: data.words,
                        borderColor: "#2563eb",
                        backgroundColor: "#2563eb",
                        tension: 0.2,
                    },
                    {
                        label: "Roleplays",
                        data: data.roleplays,
                        borderColor: "#059669",
                        backgroundColor: "#059669",
                        tension: 0.2,
                    },
                ],
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: {
                        labels: {
                            color: isDark ? "#e2e8f0" : "#1e293b",
                            font: { weight: "bold" },
                        },
                    },
                },
                scales: {
                    x: {
                        ticks: { color: isDark ? "#94a3b8" : "#64748b" },
                        grid: { color: isDark ? "#334155" : "#e2e8f0" },
                    },
                    y: {
                        beginAtZero: true,
                        ticks: { color: isDark ? "#94a3b8" : "#64748b" },
                        grid: { color: isDark ? "#334155" : "#e2e8f0" },
                    },
                },
            },
        });
    } catch (e) {
        console.error("Error cargando gráfico:", e);
    }
}

// --- DESAFÍO DIARIO ACORDE AL NIVEL ---
async function fetchDailyChallenge() {
    try {
        // Obtenemos el nivel actual del usuario (por defecto A1 si está fallando)
        const userLevel = userStats.level || "A1";

        // Pasamos el nivel y el token como parámetros para que el backend devuelva desafíos personalizados
        const res = await fetch(
            `${API_BASE_URL}/api/daily-challenge?level=${userLevel}`,
            {
                headers: {
                    Authorization: `Bearer ${authToken}`, // Enviando token al backend
                },
            },
        );

        if (!res.ok) return;
        const data = await res.json();
        const container = document.getElementById("challenge-missions");
        if (!container) return;

        container.innerHTML = data.missions
            .map(
                (m) => `
            <div class="bg-slate-50 dark:bg-slate-700/60 p-4 rounded-xl border border-slate-200 dark:border-slate-600">
                <div class="flex items-center justify-between mb-2">
                    <span class="text-sm font-bold text-amber-700 dark:text-amber-400">
                        Nivel ${userLevel} - Misión ${m.id}
                    </span>
                    <button onclick="completeMission(${m.id}, this)" class="text-xs bg-amber-600 hover:bg-amber-700 text-white px-3 py-1 rounded-lg transition font-semibold">Completar</button>
                </div>
                <p class="text-slate-800 dark:text-slate-100 font-medium">${m.text}</p>
            </div>
        `,
            )
            .join("");
    } catch (e) {
        console.error("Error en Desafío Diario:", e);
    }
}

async function completeMission(missionId, btnElement) {
    if (processing.mission) return;
    processing.mission = true;
    if (btnElement) {
        btnElement.disabled = true;
        btnElement.classList.add("opacity-50", "cursor-not-allowed");
        btnElement.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';
    }

    try {
        const res = await fetch(
            `${API_BASE_URL}/api/daily-challenge/complete?mission_id=${missionId}`,
            { headers: {
                    Authorization: `Bearer ${authToken}`, // Enviando token al backend
                },
                method: "POST" },
        );
        if (res.ok) {
            const data = await res.json();
            await Swal.fire({
                icon: "success",
                title: "¡Misión completada!",
                text: `+${data.xp_gained} XP`,
                timer: 2000,
                showConfirmButton: false,
            });
            await fetchUserStats();
        } else {
            throw new Error("Error al completar misión");
        }
    } catch (e) {
        console.error("Error al completar misión:", e);
        Swal.fire({
            icon: "error",
            title: "Error",
            text: "No se pudo completar la misión. Intenta de nuevo.",
            confirmButtonColor: "#4f46e5",
        });
    } finally {
        processing.mission = false;
        if (btnElement) {
            btnElement.disabled = false;
            btnElement.classList.remove("opacity-50", "cursor-not-allowed");
            btnElement.innerHTML = "Completar";
        }
    }
}

// --- CURRÍCULO & LECTURAS ---
async function fetchCurriculum() {
    const select = document.getElementById("material-select");
    const display = document.getElementById("text-display");

    try {
        const res = await conectarConServidorRender('/api/curriculum');
        if (!res.ok) throw new Error("Servidor no disponible");

        curriculumData = await res.json();
        allUnitsMap = {};
        let selectHtml = "";
        let firstUnitId = null;

        for (const [levelKey, levelObj] of Object.entries(curriculumData)) {
            selectHtml += `<optgroup label="${levelObj.level_name}">`;
            levelObj.units.forEach((unit) => {
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
                ${currentUnit.vocabulary
                    .map(
                        (v) => `
                    <span class="bg-slate-100 dark:bg-slate-700 text-slate-800 dark:text-slate-200 px-2 py-0.5 rounded border border-slate-300 dark:border-slate-600 cursor-pointer hover:bg-indigo-600 hover:text-white dark:hover:bg-indigo-600 dark:hover:text-white transition font-medium" 
                          onclick="playNaturalAudio('${v}')" 
                          title="Escuchar pronunciación">
                        ${v}
                    </span>
                `,
                    )
                    .join("")}
            </div>
        `;
    }

    const results = document.getElementById("reading-results");
    if (results) results.classList.add("hidden");
}

// --- AUDIO SÍNTESIS CON BLOQUEO ---
function playNaturalAudio(text, voice = "en-US-AriaNeural") {
    if (!text || processing.audio) return;
    processing.audio = true;
    const audioUrl = `${API_BASE_URL}/api/tts-natural?text=${encodeURIComponent(text)}&voice=${voice}`;
    const audio = new Audio(audioUrl);

    audio.onended = () => {
        processing.audio = false;
    };
    audio.onerror = () => {
        processing.audio = false;
    };

    audio.play().catch(() => {
        window.speechSynthesis.cancel();
        const utterance = new SpeechSynthesisUtterance(text);
        utterance.lang = "en-US";
        utterance.onend = () => {
            processing.audio = false;
        };
        utterance.onerror = () => {
            processing.audio = false;
        };
        window.speechSynthesis.speak(utterance);
    });
}

function playTargetAudio() {
    if (currentUnit) playNaturalAudio(currentUnit.text);
}

// --- RECONOCIMIENTO Y EVALUACIÓN DE PRONUNCIACIÓN ---
function setupSpeechRecognition() {
    const SpeechRecognition =
        window.SpeechRecognition || window.webkitSpeechRecognition;
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
    if (processing.recording) return;
    processing.recording = true;
    const btn = document.getElementById("btn-record");
    const textSpan = document.getElementById("record-text");
    btn.disabled = true;
    btn.classList.add("opacity-50", "cursor-not-allowed");
    textSpan.innerText = "Grabando...";

    try {
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
            await Swal.fire({
                icon: "error",
                title: "Navegador no compatible",
                text: "Tu navegador no soporta entrada de audio.",
                confirmButtonColor: "#4f46e5",
            });
            return;
        }
        const stream = await navigator.mediaDevices.getUserMedia({
            audio: true,
        });
        mediaRecorder = new MediaRecorder(stream);
        recordedChunks = [];

        mediaRecorder.ondataavailable = (e) => recordedChunks.push(e.data);
        mediaRecorder.onstop = async () => {
            const blob = new Blob(recordedChunks, { type: "audio/wav" });
            const formData = new FormData();
            formData.append("audio_file", blob, "recording.wav");
            formData.append("target_text", currentUnit ? currentUnit.text : "");

            try {
                const res = await fetch(
                    `${API_BASE_URL}/api/evaluate-reading`,
                    {
                        headers: {
                            Authorization: `Bearer ${authToken}`, // Enviando token al backend
                        },
                        method: "POST",
                        body: formData,
                    },
                );
                if (res.ok) {
                    const data = await res.json();
                    displayReadingResults(data);
                    updateUserXP(5);
                }
            } catch (e) {
                console.error("Error al evaluar audio:", e);
            }
        };

        mediaRecorder.start();
        isRecording = true;
        textSpan.innerText = "Detener y Evaluar";
        btn.classList.replace("bg-rose-600", "bg-slate-800");
        await startAudioVisualization(stream, waveformCanvas, waveformCtx);
    } catch (e) {
        console.error(e);
        Swal.fire({
            icon: "error",
            title: "Activación de micrófono",
            text: "No se pudo activar el micrófono.",
            confirmButtonColor: "#4f46e5",
        });
    } finally {
        processing.recording = false;
        btn.disabled = false;
        btn.classList.remove("opacity-50", "cursor-not-allowed");
        if (!isRecording) {
            textSpan.innerText = "Empezar a Grabar";
            btn.classList.replace("bg-slate-800", "bg-rose-600");
        }
    }
}

function stopRecording() {
    if (mediaRecorder && isRecording) {
        mediaRecorder.stop();
        isRecording = false;
        document.getElementById("record-text").innerText = "Empezar a Grabar";
        document
            .getElementById("btn-record")
            .classList.replace("bg-slate-800", "bg-rose-600");
        if (mediaRecorder.stream)
            mediaRecorder.stream.getTracks().forEach((t) => t.stop());
        // Restaurar botón si no se hizo en finally (por si startRecording no terminó)
        const btn = document.getElementById("btn-record");
        btn.disabled = false;
        btn.classList.remove("opacity-50", "cursor-not-allowed");
        processing.recording = false;
    }
}

async function evaluatePronunciation(spokenText) {
    if (!currentUnit) return;
    try {
        const response = await fetch(`${API_BASE_URL}/api/evaluate-reading`, {
            method: "POST",
            headers: { Authorization: `Bearer ${authToken}`,"Content-Type": "application/json" },
            body: JSON.stringify({
                target_text: currentUnit.text,
                spoken_text: spokenText,
            }),
        });
        if (response.ok) {
            const data = await response.json();
            displayReadingResults(data);
            updateUserXP(5);
        }
    } catch (err) {
        console.error(err);
    }
}

function displayReadingResults(data) {
    const container = document.getElementById("reading-results");
    const scoreText = document.getElementById("accuracy-score");
    const annotatedText = document.getElementById("annotated-text");

    if (!container || !scoreText || !annotatedText) return;

    container.classList.remove("hidden");
    scoreText.innerText = `Precisión: ${data.accuracy_score}%`;

    annotatedText.innerHTML = data.word_analysis
        .map((item) => {
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
        })
        .join(" ");
}

// --- DICTADO & LISTENING ---
function playDictationAudio() {
    if (currentUnit) playNaturalAudio(currentUnit.text);
}

async function checkDictation() {
    if (processing.dictation) return;
    processing.dictation = true;
    const btn = document.getElementById("btn-check-dictation");
    btn.disabled = true;
    btn.classList.add("opacity-50", "cursor-not-allowed");
    btn.innerHTML =
        '<i class="fa-solid fa-spinner fa-spin"></i> Comprobando...';

    try {
        if (!currentUnit) return;
        const userInput = document
            .getElementById("dictation-input")
            .value.trim()
            .toLowerCase()
            .replace(/[^\w\s]/g, "");
        const targetText = currentUnit.text
            .trim()
            .toLowerCase()
            .replace(/[^\w\s]/g, "");
        const feedback = document.getElementById("dictation-feedback");

        if (!feedback) return;
        feedback.classList.remove("hidden");

        if (userInput === targetText) {
            feedback.className =
                "mt-4 p-4 rounded-xl bg-emerald-50 dark:bg-emerald-950/50 text-emerald-900 dark:text-emerald-200 font-bold border border-emerald-200 dark:border-emerald-800";
            feedback.innerText =
                "🎉 ¡Perfecto! Escribiste la frase con total exactitud.";
            updateUserXP(10);
        } else {
            feedback.className =
                "mt-4 p-4 rounded-xl bg-amber-50 dark:bg-amber-950/50 text-amber-900 dark:text-amber-200 border border-amber-200 dark:border-amber-800";
            feedback.innerHTML = `
                <p class="font-bold mb-1.5 text-amber-900 dark:text-amber-200">Casi lo logras. Compara lo que escribiste:</p>
                <p class="text-sm text-slate-700 dark:text-slate-300 mb-2"><strong>Tu respuesta:</strong> <span class="bg-white dark:bg-slate-800 px-2 py-0.5 rounded border border-amber-300 dark:border-amber-700 font-mono">${userInput || "(vacío)"}</span></p>
                <p class="text-sm text-emerald-800 dark:text-emerald-300"><strong>Original:</strong> ${currentUnit.text}</p>
            `;
        }
    } catch (e) {
        console.error(e);
        Swal.fire({
            icon: "error",
            title: "Error",
            text: "No se pudo verificar el dictado.",
        });
    } finally {
        processing.dictation = false;
        btn.disabled = false;
        btn.classList.remove("opacity-50", "cursor-not-allowed");
        btn.innerHTML = "Comprobar Dictado";
    }
}

// --- WRITING GRAMMAR CHECK ---
async function analyzeWriting(e) {
    if (e) {
        e.preventDefault();
        e.stopPropagation();
    }
    if (processing.writing) return;
    processing.writing = true;

    const btn = document.getElementById("btn-analyze-writing");
    btn.disabled = true;
    btn.classList.add("opacity-50", "cursor-not-allowed");
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Analizando...';

    try {
        const input = document.getElementById("writing-input");
        const resDiv = document.getElementById("writing-results");
        if (!input || !resDiv) return;

        const text = input.value.trim();
        if (!text) {
            await Swal.fire({
                icon: "warning",
                title: "Texto vacío",
                text: "Escribe o pega un texto en inglés.",
                confirmButtonColor: "#4f46e5",
            });
            return;
        }

        resDiv.classList.remove("hidden");
        resDiv.innerHTML = `
            <div class="p-4 bg-indigo-50 dark:bg-indigo-950/40 text-indigo-800 dark:text-indigo-200 rounded-xl font-medium animate-pulse flex items-center gap-2">
                <i class="fa-solid fa-circle-notch fa-spin"></i> Analizando texto...
            </div>`;

        const response = await fetch(`${API_BASE_URL}/api/check-writing`, {
            method: "POST",
            headers: { Authorization: `Bearer ${authToken}`, "Content-Type": "application/json" },
            body: JSON.stringify({ text }),
        });

        if (!response.ok) throw new Error(`HTTP Error ${response.status}`);
        const data = await response.json();

        let html = `
            <div class="p-4 bg-indigo-50 dark:bg-indigo-950/50 border border-indigo-200 dark:border-indigo-800 rounded-xl mb-4 flex justify-between items-center">
                <strong class="text-lg text-indigo-900 dark:text-indigo-200">Puntuación:</strong>
                <span class="text-2xl font-black text-indigo-600 dark:text-indigo-400">${data.score}/100</span>
            </div>`;

        if (!data.feedback || data.feedback.length === 0) {
            html += `
                <div class="p-4 bg-emerald-50 dark:bg-emerald-950/50 border border-emerald-200 dark:border-emerald-800 text-emerald-800 dark:text-emerald-200 rounded-xl font-bold flex items-center gap-3">
                    <i class="fa-solid fa-circle-check text-2xl text-emerald-500"></i>
                    <span>¡Excelente! Tu texto no contiene errores gramaticales detectables.</span>
                </div>`;
        } else {
            html += `<ul class="space-y-3">`;
            data.feedback.forEach((item) => {
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
        const resDiv = document.getElementById("writing-results");
        if (resDiv) {
            resDiv.innerHTML = `
                <div class="p-4 bg-rose-50 dark:bg-rose-950/50 text-rose-800 dark:text-rose-200 border border-rose-200 dark:border-rose-800 rounded-xl font-medium">
                    ⚠️ Ocurrió un error al conectar con el servidor.
                </div>`;
        }
        Swal.fire({
            icon: "error",
            title: "Error",
            text: "No se pudo analizar el texto.",
        });
    } finally {
        processing.writing = false;
        btn.disabled = false;
        btn.classList.remove("opacity-50", "cursor-not-allowed");
        btn.innerHTML = "Analizar Gramática";
    }
}

// --- SHADOWING ---
function startShadowingRoutine() {
    if (processing.shadowing) return;
    processing.shadowing = true;
    const btn = document.getElementById("btn-shadowing");
    btn.disabled = true;
    btn.classList.add("opacity-50", "cursor-not-allowed");
    btn.innerHTML =
        '<i class="fa-solid fa-spinner fa-spin"></i> Reproduciendo...';

    try {
        if (!currentUnit) return;
        const sentences = currentUnit.text.match(/[^.!?]+[.!?]+/g) || [
            currentUnit.text,
        ];
        let index = 0;

        function playNextSentence() {
            if (index < sentences.length) {
                const current = sentences[index].trim();
                const display = document.getElementById("shadowing-display");
                if (display) display.innerText = current;
                playNaturalAudio(current);
                index++;
                setTimeout(playNextSentence, 4500);
            } else {
                // Restaurar botón al finalizar
                processing.shadowing = false;
                btn.disabled = false;
                btn.classList.remove("opacity-50", "cursor-not-allowed");
                btn.innerHTML =
                    '<i class="fa-solid fa-play"></i> Iniciar Rutina de Shadowing';
            }
        }
        playNextSentence();
    } catch (e) {
        console.error(e);
        processing.shadowing = false;
        btn.disabled = false;
        btn.classList.remove("opacity-50", "cursor-not-allowed");
        btn.innerHTML =
            '<i class="fa-solid fa-play"></i> Iniciar Rutina de Shadowing';
    }
}

// --- REPETICIÓN ESPACIADA (SRS) ---
async function fetchSRSStats() {
    try {
        const res = await conectarConServidorRender('/api/srs/stats');

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
    } catch (err) {
        console.error("Error SRS stats:", err);
    }
}

async function fetchSRSDueWords() {
    try {
        const res = await conectarConServidorRender('/api/srs/due-words');

        if (!res.ok) return;
        const data = await res.json();
        srsDueWords = data.due_words;
        currentSRSIndex = 0;
        renderSRSCard();
    } catch (err) {
        console.error("Error SRS words:", err);
    }
}

//localStorage.clear();

async function conectarConServidorRender(endpoint) {
    if (!authToken) {
        console.error("No se encontró token de autenticación.");
        return { ok: false, status: 401 };
    }

    try {
        const response = await fetch(`${API_BASE_URL}${endpoint}`, {
            method: "GET",
            headers: { Authorization: `Bearer ${authToken}` },
        });

        if (response.status === 401) {
            console.error("Sesión expirada o no autorizada.");
            handleLogout();
        }

        return response; // Devuelve el objeto Response completo
    } catch (error) {
        console.error("Error de conexión con la API:", error);
        return { ok: false, status: 500 };
    }
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
    if (processing.srs) return;
    processing.srs = true;
    const btnNo = document.getElementById("btn-srs-no");
    const btnYes = document.getElementById("btn-srs-yes");
    [btnNo, btnYes].forEach((b) => {
        b.disabled = true;
        b.classList.add("opacity-50", "cursor-not-allowed");
    });

    try {
        if (srsDueWords.length === 0 || !srsDueWords[currentSRSIndex]) return;
        const currentCard = srsDueWords[currentSRSIndex];
        const res = await fetch(`${API_BASE_URL}/api/srs/review`, {
            method: "POST",
            headers: {  Authorization: `Bearer ${authToken}`, "Content-Type": "application/json" },
            body: JSON.stringify({ word: currentCard.word, success }),
        });
        if (res.ok) {
            currentSRSIndex++;
            renderSRSCard();
            fetchSRSStats();
            if (success) updateUserXP(10);
        } else {
            throw new Error("Error al enviar revisión");
        }
    } catch (err) {
        console.error("Error SRS review:", err);
        Swal.fire({
            icon: "error",
            title: "Error",
            text: "No se pudo registrar la revisión.",
        });
    } finally {
        processing.srs = false;
        [btnNo, btnYes].forEach((b) => {
            b.disabled = false;
            b.classList.remove("opacity-50", "cursor-not-allowed");
        });
    }
}

// --- IPA MATRIZ FONÉTICA ---
async function fetchIPAMatrix() {
    try {
        const res = await conectarConServidorRender('/api/ipa-matrix');

        if (!res.ok) return;
        const data = await res.json();

        renderPhonemeCategory("vowels-grid", data.vowels);
        renderPhonemeCategory("diphthongs-grid", data.diphthongs);
        renderPhonemeCategory("consonants-grid", data.consonants);
    } catch (err) {
        console.error("Error IPA:", err);
    }
}

const IPA_TYPE_COLORS = {
    "Long Vowel":
        "bg-cyan-100 text-cyan-800 dark:bg-cyan-900/50 dark:text-cyan-300",
    "Short Vowel":
        "bg-sky-100 text-sky-800 dark:bg-sky-900/50 dark:text-sky-300",
    Schwa: "bg-slate-200 text-slate-700 dark:bg-slate-700 dark:text-slate-300",
    Diphthong:
        "bg-purple-100 text-purple-800 dark:bg-purple-900/50 dark:text-purple-300",
    Voiced: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/50 dark:text-emerald-300",
    Unvoiced:
        "bg-amber-100 text-amber-800 dark:bg-amber-900/50 dark:text-amber-300",
    Nasal: "bg-rose-100 text-rose-800 dark:bg-rose-900/50 dark:text-rose-300",
    Approximant:
        "bg-indigo-100 text-indigo-800 dark:bg-indigo-900/50 dark:text-indigo-300",
};
const IPA_TYPE_DEFAULT_COLOR =
    "bg-slate-100 text-slate-700 dark:bg-slate-700 dark:text-slate-300";

function renderPhonemeCategory(containerId, items) {
    const grid = document.getElementById(containerId);
    if (!grid) return;

    grid.innerHTML = items
        .map((item, index) => {
            const truncate = (str, max) =>
                str.length > max ? str.slice(0, max) + "…" : str;
            const shortHint = truncate(item.spanish_equivalent_or_hack, 300);
            const shortError = truncate(item.common_error_spanish, 300);

            const typeColor =
                IPA_TYPE_COLORS[item.type] || IPA_TYPE_DEFAULT_COLOR;

            return `
      <div class="phoneme-card group bg-white dark:bg-slate-800 rounded-2xl shadow-sm hover:shadow-lg border border-slate-200 dark:border-slate-700 hover:border-cyan-400 dark:hover:border-cyan-500 transition-all duration-200 p-4 cursor-pointer"
           data-index="${index}"
           onclick="playNaturalAudio('${item.example}')">
        
        <div class="flex flex-col items-center text-center gap-1 p-2">
            <span class="text-3xl font-mono font-bold text-cyan-700 dark:text-cyan-400 group-hover:scale-110 transition-transform origin-left">/${item.symbol}/</span>
            <span class="text-base font-medium text-slate-700 dark:text-slate-200">${item.example}</span>
            <span class="text-xs text-slate-400 dark:text-slate-500 font-mono">${item.ipa_ex}</span>
        </div>

        <div class="mt-1 text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider ">${item.type}</div>

        <div class="mt-3 flex flex-wrap gap-1.5">
          ${item.common_spellings
              .map(
                  (sp) =>
                      `<span class="px-2.5 py-0.5 bg-cyan-100 dark:bg-cyan-900/40 text-cyan-800 dark:text-cyan-300 text-[11px] rounded-full font-mono border border-cyan-200 dark:border-cyan-800">${sp}</span>`,
              )
              .join("")}
        </div>

        <div class="mt-3 text-xs text-slate-600 dark:text-slate-300">
          <i class="fa-solid fa-arrows-rotate text-slate-500 dark:text-slate-400 text-xs mr-1"></i>
          <span class="font-semibold">Contrasta con:</span>
          <span class="ml-1">${item.minimal_pairs.join(" · ")}</span>
        </div>

        <div class="mt-2 text-xs text-slate-600 dark:text-slate-300 italic line-clamp-2">
          <i class="fa-regular fa-lightbulb text-amber-400 dark:text-amber-300 text-xs mr-1.5"></i>
          ${shortHint}
        </div>

        <div class="mt-1 text-[11px] text-rose-600 dark:text-rose-400 line-clamp-1">
          <i class="fa-solid fa-triangle-exclamation text-rose-500 dark:text-rose-400 text-[10px] mr-1.5"></i>
          ${shortError}
        </div>

        <div class="mt-3 text-center">
          <button onclick="event.stopPropagation(); toggleDetails(this, ${index})" 
                  class="text-[11px] font-medium text-cyan-600 dark:text-cyan-400 hover:underline focus:outline-none flex items-center justify-center gap-1.5 w-full">
            <i class="fa-regular fa-book-open text-cyan-600 dark:text-cyan-400 text-xs"></i>
            <span class="btn-toggle-text">Ver más</span>
          </button>
        </div>

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
            <span class="font-semibold">Grafías:</span> ${item.common_spellings.join(", ")}
          </div>
          <div>
            <i class="fa-solid fa-rotate-right text-slate-500 dark:text-slate-400 text-xs w-4"></i>
            <span class="font-semibold">Pares mínimos:</span> ${item.minimal_pairs.join("; ")}
          </div>
        </div>
      </div>
    `;
        })
        .join("");

    window.toggleDetails = function (btn, index) {
        const details = document.getElementById(`details-${index}`);
        if (details) {
            const isHidden = details.classList.contains("hidden");
            details.classList.toggle("hidden");
            const textSpan = btn.querySelector(".btn-toggle-text");
            const icon = btn.querySelector("i");
            if (textSpan) {
                textSpan.textContent = isHidden ? "Ver menos" : "Ver más";
            }
            if (icon) {
                icon.className = isHidden
                    ? "fa-regular fa-book text-cyan-600 dark:text-cyan-400 text-xs"
                    : "fa-regular fa-book-open text-cyan-600 dark:text-cyan-400 text-xs";
            }
        }
    };
}

// --- ROLEPLAY MODULO ---
async function initRoleplayModule() {
    try {
        const res = await conectarConServidorRender('/api/roleplay/scenarios');
   
        if (!res.ok) return;
        const scenarios = await res.json();

        roleplayScenariosMap = {};
        scenarios.forEach((sc) => {
            roleplayScenariosMap[sc.id] = sc;
        });

        renderScenariosGrid(scenarios);
    } catch (err) {
        console.error("Error Roleplay:", err);
    }
}

function renderScenariosGrid(scenarios) {
    const grid = document.getElementById("roleplay-scenarios-grid");
    if (!grid) return;

    grid.innerHTML = scenarios
        .map(
            (sc) => `
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
    `,
        )
        .join("");
}

function startRoleplaySession(scenarioId) {
    const sc = roleplayScenariosMap[scenarioId];
    if (!sc) return;

    currentScenario = sc;
    roleplayHistory = [];
    document.getElementById("roleplay-scenarios-grid").classList.add("hidden");
    document.getElementById("roleplay-chat-box").classList.remove("hidden");
    document.getElementById("rp-active-title").innerText = sc.title;
    document.getElementById("rp-active-role").innerText =
        `Interlocutor: ${sc.role}`;

    const messagesContainer = document.getElementById("rp-messages");
    messagesContainer.innerHTML = "";

    appendRPMessage("bot", sc.initial_message);
    playNaturalAudio(sc.initial_message);
    renderRPSuggestions(sc.suggested_replies);
    roleplayHistory.push({ role: "assistant", content: sc.initial_message });
}

function closeRoleplayChat() {
    document
        .getElementById("roleplay-scenarios-grid")
        .classList.remove("hidden");
    document.getElementById("roleplay-chat-box").classList.add("hidden");
    currentScenario = null;
}

function appendRPMessage(sender, text, feedback = null) {
    const container = document.getElementById("rp-messages");
    if (!container) return;

    const isBot = sender === "bot";
    const msgHtml = `
        <div class="flex flex-col ${isBot ? "items-start" : "items-end"}">
            <div class="max-w-[80%] p-4 rounded-2xl ${isBot ? "bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-800 dark:text-slate-100" : "bg-indigo-600 text-white"} shadow-sm">
                <p class="text-sm font-medium">${text}</p>
            </div>
            ${feedback ? `<span class="text-[11px] text-amber-700 dark:text-amber-400 mt-1 font-semibold flex items-center gap-1"><i class="fa-solid fa-lightbulb"></i> ${feedback}</span>` : ""}
        </div>
    `;

    container.insertAdjacentHTML("beforeend", msgHtml);
    container.scrollTop = container.scrollHeight;
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
    box.innerHTML = replies
        .map(
            (r) => `
        <button 
            type="button" 
            data-reply="${encodeURIComponent(r)}"
            onclick="useRPSuggestionFromData(this, event)" 
            class="bg-slate-100 dark:bg-slate-700 hover:bg-indigo-50 dark:hover:bg-indigo-950/60 hover:text-indigo-700 dark:hover:text-indigo-300 text-slate-700 dark:text-slate-200 px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-600 transition font-medium text-left"
        >
            💡 "${r}"
        </button>
    `,
        )
        .join("");
}

function useRPSuggestionFromData(btnEl, e) {
    if (e) {
        e.preventDefault();
        e.stopPropagation();
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

    const SpeechRecognition =
        window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
        Swal.fire({
            icon: "error",
            title: "Navegador no compatible",
            text: "Navegador no soporta reconocimiento de voz.",
            confirmButtonColor: "#4f46e5",
        });
        return;
    }

    if (isRPRecording) {
        if (roleplayRecognition) roleplayRecognition.stop();
        return;
    }

    roleplayRecognition = new SpeechRecognition();
    roleplayRecognition.lang = "en-US";

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
        e.preventDefault();
        e.stopPropagation();
    }
    if (processing.roleplay) return;
    processing.roleplay = true;
    const btn = document.getElementById("btn-send-rp");
    btn.disabled = true;
    btn.classList.add("opacity-50", "cursor-not-allowed");
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';

    try {
        const input = document.getElementById("rp-transcript-input");
        if (!input) return;
        const userText = input.value.trim();
        if (!userText || !currentScenario) return;

        appendRPMessage("user", userText);
        roleplayHistory.push({ role: "user", content: userText });
        input.value = "";

        const res = await fetch(`${API_BASE_URL}/api/roleplay/respond`, {
            method: "POST",
            headers: { Authorization: `Bearer ${authToken}`, "Content-Type": "application/json" },
            body: JSON.stringify({
                scenario_id: currentScenario.id,
                user_message: userText,
                conversation_history: roleplayHistory,
            }),
        });

        if (res.ok) {
            const data = await res.json();
            appendRPMessage("bot", data.bot_reply, data.feedback);
            playNaturalAudio(data.bot_reply);
            roleplayHistory.push({
                role: "assistant",
                content: data.bot_reply,
            });
            updateUserXP(10);
        } else {
            console.error("Error Roleplay: respuesta no OK", res.status);
            appendRPMessage(
                "bot",
                "Ups, hubo un problema de conexión con el tutor. Intenta de nuevo en unos segundos.",
            );
        }
    } catch (err) {
        console.error("Error Roleplay:", err);
        appendRPMessage(
            "bot",
            "Ups, hubo un problema de conexión con el tutor. Intenta de nuevo en unos segundos.",
        );
        Swal.fire({
            icon: "error",
            title: "Error",
            text: "No se pudo enviar el mensaje.",
        });
    } finally {
        processing.roleplay = false;
        btn.disabled = false;
        btn.classList.remove("opacity-50", "cursor-not-allowed");
        btn.innerHTML = '<i class="fa-solid fa-paper-plane"></i>';
    }
}

function selectSuggestedResponse(text, e) {
    if (e) {
        e.preventDefault();
        e.stopPropagation();
    }
    const input = document.getElementById("rp-transcript-input");
    if (input) {
        input.value = text;
    }
    sendRoleplayMessage(e);
}

function renderRoleplaySuggestions(suggestions) {
    const container = document.getElementById("rp-suggestions-container");
    if (!container) return;

    if (!suggestions || suggestions.length === 0) {
        container.innerHTML = "";
        container.classList.add("hidden");
        return;
    }

    container.classList.remove("hidden");
    container.innerHTML = suggestions
        .map(
            (sug) => `
        <button 
            type="button" 
            onclick="selectSuggestedResponse('${sug.replace(/'/g, "\\'")}', event)"
            class="px-3 py-1.5 bg-slate-100 dark:bg-slate-800 hover:bg-emerald-100 dark:hover:bg-emerald-900/50 text-slate-700 dark:text-slate-300 hover:text-emerald-700 dark:hover:text-emerald-300 text-xs font-semibold rounded-full border border-slate-200 dark:border-slate-700 transition-colors text-left"
        >
            💡 ${sug}
        </button>
    `,
        )
        .join("");
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
    ptState = {
        currentLevel: "A2",
        questionId: null,
        selectedOption: null,
        history: [],
    };
    try {
        const res = await conectarConServidorRender('/api/placement/start');
        if (!res.ok) return;
        const data = await res.json();

        document.getElementById("pt-start-view").classList.add("hidden");
        document.getElementById("pt-result-view").classList.add("hidden");
        document.getElementById("pt-quiz-view").classList.remove("hidden");
        renderPlacementQuestion(data);
    } catch (err) {
        console.error(err);
    }
}

function renderPlacementQuestion(data) {
    ptState.currentLevel = data.level;
    ptState.questionId = data.question.id;
    ptState.selectedOption = null;

    document.getElementById("pt-step-indicator").innerText =
        `Pregunta ${data.step} de ${data.total_steps}`;
    document.getElementById("pt-difficulty-indicator").innerText =
        `Dificultad: ${data.level}`;
    document.getElementById("pt-progress-bar").style.width =
        `${(data.step / data.total_steps) * 100}%`;
    document.getElementById("pt-question-text").innerText =
        data.question.question;

    const optionsContainer = document.getElementById("pt-options-container");
    optionsContainer.innerHTML = data.question.options
        .map(
            (opt, idx) => `
        <button onclick="selectPlacementOption(${idx})" 
                id="pt-opt-${idx}"
                class="pt-option-btn w-full text-left p-4 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 hover:bg-amber-50 dark:hover:bg-amber-950/30 hover:border-amber-300 dark:hover:border-amber-600 font-medium text-sm text-slate-800 dark:text-slate-100 transition">
            <span class="font-bold text-amber-600 dark:text-amber-400 mr-2">${String.fromCharCode(65 + idx)}.</span> ${opt}
        </button>
    `,
        )
        .join("");

    const nextBtn = document.getElementById("pt-next-btn");
    nextBtn.disabled = true;
    nextBtn.className =
        "w-full bg-slate-300 dark:bg-slate-700 text-slate-500 dark:text-slate-400 font-bold py-3.5 rounded-xl transition cursor-not-allowed";
}

function selectPlacementOption(optIdx) {
    ptState.selectedOption = optIdx;

    document.querySelectorAll(".pt-option-btn").forEach((btn, idx) => {
        if (idx === optIdx) {
            btn.className =
                "pt-option-btn w-full text-left p-4 rounded-xl border-2 border-amber-500 bg-amber-50 dark:bg-amber-950/40 font-bold text-sm text-amber-950 dark:text-amber-200 transition shadow-sm";
        } else {
            btn.className =
                "pt-option-btn w-full text-left p-4 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 hover:bg-amber-50 dark:hover:bg-amber-950/30 font-medium text-sm text-slate-700 dark:text-slate-300 transition opacity-70";
        }
    });

    const nextBtn = document.getElementById("pt-next-btn");
    nextBtn.disabled = false;
    nextBtn.className =
        "w-full bg-amber-600 hover:bg-amber-700 text-white font-bold py-3.5 rounded-xl shadow transition cursor-pointer";
}

async function submitPlacementAnswer() {
    if (ptState.selectedOption === null) return;
    if (processing.placement) return;
    processing.placement = true;
    const btn = document.getElementById("pt-next-btn");
    btn.disabled = true;
    btn.classList.add("opacity-50", "cursor-not-allowed");
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Enviando...';

    try {
        const res = await fetch(`${API_BASE_URL}/api/placement/next`, {
            method: "POST",
            headers: { Authorization: `Bearer ${authToken}`, "Content-Type": "application/json" },
            body: JSON.stringify({
                current_level: ptState.currentLevel,
                question_id: ptState.questionId,
                selected_option: ptState.selectedOption,
                history: ptState.history,
            }),
        });

        if (res.ok) {
            const data = await res.json();
            if (data.completed) {
                renderPlacementResult(data);
            } else {
                ptState.history = data.history;
                renderPlacementQuestion(data);
            }
        } else {
            throw new Error("Error al enviar respuesta");
        }
    } catch (err) {
        console.error(err);
        Swal.fire({
            icon: "error",
            title: "Error",
            text: "No se pudo enviar la respuesta.",
        });
    } finally {
        processing.placement = false;
        btn.disabled = false;
        btn.classList.remove("opacity-50", "cursor-not-allowed");
        btn.innerHTML = "Siguiente Pregunta";
    }
}

function renderPlacementResult(data) {
    document.getElementById("pt-quiz-view").classList.add("hidden");
    document.getElementById("pt-result-view").classList.remove("hidden");

    setUserLevel(data.final_level);
    document.getElementById("pt-final-level").innerText = data.final_level;
    document.getElementById("pt-accuracy").innerText = `${data.accuracy}%`;

    const descriptions = {
        A1: "Comprendes expresiones cotidianas muy frecuentes y frases sencillas orientadas a satisfacer necesidades básicas.",
        A2: "Comprendes frases y expresiones de uso frecuente relacionadas con situaciones relevantes de la vida diaria.",
        B1: "Comprendes los puntos principales de textos claros en lengua estándar sobre temas de trabajo o estudio.",
        B2: "Entiendes las ideas principales de textos complejos y conversas con suficiente fluidez con nativos.",
    };
    document.getElementById("pt-final-desc").innerText =
        descriptions[data.final_level] || "";
}

function goToUnlockedLessons() {
    switchTab("reading");
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
        const res = await conectarConServidorRender('/api/curriculum');
        if (!res.ok) return;
        const curriculum = await res.json();

        container.innerHTML = Object.keys(curriculum)
            .map((levelKey) => {
                const levelData = curriculum[levelKey];
                const unlocked = isLevelUnlocked(levelKey);

                return `
                <div class="mb-8 p-6 bg-slate-50 dark:bg-slate-800/40 border ${unlocked ? "border-slate-200 dark:border-slate-700" : "border-slate-200 dark:border-slate-800 bg-slate-100/60 dark:bg-slate-900/60"} rounded-2xl transition">
                    <div class="flex justify-between items-center mb-4">
                        <div class="flex items-center gap-3">
                            <span class="px-3 py-1 text-xs font-black rounded-lg ${unlocked ? "bg-indigo-600 text-white" : "bg-slate-300 dark:bg-slate-700 text-slate-600 dark:text-slate-400"}">
                                ${levelKey}
                            </span>
                            <h3 class="text-lg font-bold ${unlocked ? "text-slate-800 dark:text-slate-100" : "text-slate-400 dark:text-slate-500"}">
                                ${levelData.level_name}
                            </h3>
                        </div>

                        ${
                            unlocked
                                ? `
                            <span class="text-xs font-bold text-emerald-700 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-950/50 px-3 py-1 rounded-full border border-emerald-200 dark:border-emerald-800/60 flex items-center gap-1">
                                <i class="fa-solid fa-unlock"></i> Desbloqueado
                            </span>
                        `
                                : `
                            <span class="text-xs font-bold text-slate-500 dark:text-slate-400 bg-slate-200 dark:bg-slate-700 px-3 py-1 rounded-full flex items-center gap-1">
                                <i class="fa-solid fa-lock"></i> Requiere Nivel ${levelKey}
                            </span>
                        `
                        }
                    </div>

                    <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
                        ${levelData.units
                            .map(
                                (unit) => `
                            <div class="p-5 bg-white dark:bg-slate-800 border ${unlocked ? "border-slate-200 dark:border-slate-700 hover:border-indigo-500 dark:hover:border-indigo-400 cursor-pointer shadow-sm" : "border-slate-200 dark:border-slate-700 opacity-60 cursor-not-allowed"} rounded-xl transition flex justify-between items-center"
                                 onclick="${unlocked ? `loadUnitPractice('${unit.id}')` : `Swal.fire({icon:'warning',title:'Unidad bloqueada',text:'Debes alcanzar el nivel ${levelKey} en el Test de Nivel para desbloquear esta unidad.',confirmButtonColor:'#4f46e5'})`}">
                                <div>
                                    <h4 class="font-bold text-sm text-slate-800 dark:text-slate-100">${unit.title}</h4>
                                    <p class="text-xs text-slate-600 dark:text-slate-400 mt-1"><i class="fa-solid fa-book-bookmark text-indigo-500"></i> ${unit.grammar_focus}</p>
                                </div>
                                <div class="text-indigo-600 dark:text-indigo-400 font-bold text-sm">
                                    ${unlocked ? '<i class="fa-solid fa-chevron-right"></i>' : '<i class="fa-solid fa-lock text-slate-400 dark:text-slate-500"></i>'}
                                </div>
                            </div>
                        `,
                            )
                            .join("")}
                    </div>
                </div>
            `;
            })
            .join("");
    } catch (err) {
        console.error(err);
    }
}

function loadUnitPractice(unitId) {
    if (allUnitsMap[unitId]) {
        currentUnit = allUnitsMap[unitId];
        renderCurrentUnit();
        window.scrollTo({ top: 300, behavior: "smooth" });
    } else {
        Swal.fire({
            icon: "error",
            title: "Unidad no encontrada",
            text: "La unidad seleccionada no existe.",
            confirmButtonColor: "#4f46e5",
        });
    }
}

// --- GESTIÓN DE PESTAÑAS (TABS) ---
function switchTab(tabName) {
    // Ocultar todas las secciones
    document
        .querySelectorAll(".tab-content")
        .forEach((el) => el.classList.add("hidden"));

    // Mostrar la sección activa
    const activeSection = document.getElementById(`sec-${tabName}`);
    if (activeSection) activeSection.classList.remove("hidden");

    // Resaltar el ítem en el menú
    document.querySelectorAll("#main-menu a[data-tab]").forEach((link) => {
        link.classList.remove(
            "bg-indigo-50",
            "dark:bg-indigo-950/50",
            "border-l-4",
            "border-indigo-500",
        );
        if (link.dataset.tab === tabName) {
            link.classList.add(
                "bg-indigo-50",
                "dark:bg-indigo-950/50",
                "border-l-4",
                "border-indigo-500",
            );
        }
    });

    // Cargar datos específicos de cada sección
    switch (tabName) {
        case "srs":
            fetchSRSStats();
            fetchSRSDueWords();
            break;
        case "ipa-matrix":
            fetchIPAMatrix();
            break;
        case "roleplay":
            initRoleplayModule();
            break;
        case "placement":
            initPlacementTest();
            break;
        case "challenge":
            fetchDailyChallenge();
            break;
        case "reading":
            renderCurriculum();
            break;
    }
}

// --- FUNCIONES DE AUTENTICACIÓN ---
function showLoginModal() {
    const modal = document.getElementById("auth-modal");
    if (modal) {
        modal.classList.remove("hidden");
        document.body.style.overflow = "hidden"; // Bloquear scroll
    }
}

function hideLoginModal() {
    const modal = document.getElementById("auth-modal");
    if (modal) {
        modal.classList.add("hidden");
        document.body.style.overflow = "auto"; // Restaurar scroll
    }
}

async function handleLogin(e) {
    e.preventDefault();
    const btn = document.getElementById("btn-login");
    const errorText = document.getElementById("login-error");
    const email = document.getElementById("login-username").value; // ahora es email
    const password = document.getElementById("login-password").value;

    btn.disabled = true;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Conectando...';
    errorText.classList.add("hidden");

    try {
        const { data, error } = await supabaseClient.auth.signInWithPassword({ email, password });
        if (error) throw error;

        authToken = data.session.access_token;
        currentUsername = data.user.email;
        
        // Guardar explícitamente en localStorage
        localStorage.setItem("auth_token", authToken);
        localStorage.setItem("current_username", currentUsername);

        hideLoginModal();
        initializeApp();
    } catch (err) {
        errorText.textContent = err.message === "Invalid login credentials"
            ? "Correo o contraseña incorrectos."
            : "No se pudo conectar. Intenta de nuevo.";
        errorText.classList.remove("hidden");
    } finally {
        btn.disabled = false;
        btn.innerHTML = 'Entrar <i class="fa-solid fa-arrow-right"></i>';
    }
}

async function handleLogout() {
    try {
        await supabaseClient.auth.signOut(); // Cierra la sesión en el cliente de Supabase
    } catch (e) {
        console.error("Error al cerrar sesión en Supabase:", e);
    } finally {
        clearSessionStorage();
        window.location.reload(); // Recarga y muestra el modal de login
    }
}

// Envuelve las llamadas iniciales para ejecutarlas SÓLO tras iniciar sesión
function initializeApp() {
    fetchCurriculum();
    setupSpeechRecognition();
    fetchSRSStats();
    fetchSRSDueWords();
    // Encamenamos las estadísticas primero para asegurar que tenemos el NIVEL antes de pedir los desafíos
    fetchUserStats().then(() => {
        fetchProgressData();
        fetchDailyChallenge();
    });
    initWaveform();
}
