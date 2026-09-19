// ==========================================
// LinguaBoost Pro - Frontend Application Engine (v4.6)
// ==========================================

// ============================================================
// GESTIÓN DEL COLD START DE RENDER
// ============================================================
let backendStatus = "unknown"; // 'unknown' | 'waking' | 'ready' | 'down'
let warmupPromise = null;

// Para pruebas locales
//const API_BASE_URL = "http://127.0.0.1:8000";
// Para pruebas en Render
const API_BASE_URL = "https://english-coach-ekm0.onrender.com";
const SUPABASE_URL = "https://fybnnkzufbobktzuovba.supabase.co";
const SUPABASE_ANON_KEY =
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZ5Ym5ua3p1ZmJvYmt0enVvdmJhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODkxMDUwNjIsImV4cCI6MjEwNDY4MTA2Mn0.efz0qnh-r6XwfgiO4pdx6tBwXU4_DLUOlkGDWa3rbPM";
const supabaseClient = window.supabase.createClient(
    SUPABASE_URL,
    SUPABASE_ANON_KEY,
);

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

// ============================================================
// SEGURIDAD — ESCAPE Y UTILIDADES
// ============================================================
// Helper para escapar caracteres HTML y prevenir XSS
function escapeHtml(str) {
    return String(str ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

// Para atributos que ya están entre comillas dobles, es el mismo caso
const escapeAttr = escapeHtml;

// Helper para IDs seguros (evita colisiones y caracteres raros)
function makeSafeId(str) {
    return String(str).replace(/[^a-zA-Z0-9_-]/g, "_");
}

// Para el backend de Render, que puede entrar en "cold start" y tardar en responder
function setBackendStatus(status) {
    backendStatus = status;
    const banner = document.getElementById("backend-status-banner");
    if (!banner) return;

    const configs = {
        waking: {
            bg: "#fef3c7",
            color: "#78350f",
            border: "#fcd34d",
            icon: "fa-solid fa-server",
            iconAnim: "fa-spin",
            text: "El servidor está despertando… (hasta 60 s en la primera carga)",
        },
        ready: {
            bg: "#d1fae5",
            color: "#064e3b",
            border: "#6ee7b7",
            icon: "fa-solid fa-circle-check",
            iconAnim: "",
            text: "Servidor listo",
        },
        down: {
            bg: "#fee2e2",
            color: "#7f1d1d",
            border: "#fca5a5",
            icon: "fa-solid fa-triangle-exclamation",
            iconAnim: "",
            text: "No se pudo contactar con el servidor. Revisa tu conexión.",
        },
    };

    const cfg = configs[status];
    if (!cfg) {
        banner.style.display = "none";
        return;
    }

    banner.classList.remove("hidden");
    banner.style.cssText = `
        position: fixed;
        top: 0; left: 0; right: 0;
        z-index: 9999;
        padding: 10px 16px;
        font-family: inherit;
        font-size: 14px;
        font-weight: 600;
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 8px;
        background: ${cfg.bg};
        color: ${cfg.color};
        border-bottom: 1px solid ${cfg.border};
        box-shadow: 0 2px 6px rgba(0,0,0,0.08);
    `;
    banner.innerHTML = `<i class="${cfg.icon} ${cfg.iconAnim}"></i><span>${cfg.text}</span>`;

    if (status === "ready") {
        setTimeout(() => { banner.style.display = "none"; }, 2000);
    }
}

/**
 * Hace un ping ligero al backend. Si responde, marca 'ready'.
 * Si falla, marca 'waking' y reintenta hasta 90 s (cold start típico).
 */
async function wakeUpBackend(timeoutMs = 90000) {
    if (backendStatus === "ready") return true;
    if (warmupPromise) return warmupPromise;

    warmupPromise = (async () => {
        setBackendStatus("waking");

        const started = Date.now();
        // Reintentos progresivos mientras esté por debajo del timeout
        while (Date.now() - started < timeoutMs) {
            try {
                const ctrl = new AbortController();
                const t = setTimeout(() => ctrl.abort(), 15000);
                const res = await apiFetch(`${API_BASE_URL}/`, {
                    method: "GET",
                    signal: ctrl.signal,
                    cache: "no-store",
                });
                clearTimeout(t);
                if (res.ok || res.status < 500) {
                    setBackendStatus("ready");
                    backendStatus = "ready";
                    return true;
                }
            } catch (_) {
                // aún no despierta: esperamos 3 s y reintentamos
                await new Promise((r) => setTimeout(r, 3000));
            }
        }
        setBackendStatus("down");
        return false;
    })();

    try {
        return await warmupPromise;
    } finally {
        warmupPromise = null;
    }
}

console.log("[BOOT] app.js cargado");

// --- INICIALIZACIÓN ---
document.addEventListener("DOMContentLoaded", async () => {
    initDarkMode();
    setupSpeechRecognition();
    registerGlobalDelegatedListeners();

    // 🔥 Despertamos el backend en paralelo mientras el usuario ve el login
    wakeUpBackend().catch(() => {});

    // Verificación y restauración automática de sesión con Supabase
    await checkAutoLogin();

    // Event listener para el textarea de writing
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

    if (menuToggle && mainMenu) {
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
    }
});

async function checkAutoLogin() {
    try {
        // Supabase verifica el storage y refresca automáticamente el token si venció
        const {
            data: { session },
            error,
        } = await supabaseClient.auth.getSession();

        if (session && session.access_token && !error) {
            // Sesión válida o refrescada exitosamente
            authToken = session.access_token;
            currentUsername = session.user.email;
            localStorage.setItem("auth_token", authToken);
            localStorage.setItem("current_username", currentUsername);

            if (!localStorage.getItem("username")) {
                localStorage.setItem(
                    "username",
                    session.user.email.split("@")[0],
                );
            }

            hideLoginModal();
            initializeApp(); // Carga la app UNA SOLA VEZ con el token refrescado
        } else {
            // No hay sesión activa
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

function initDarkMode() {
    // 1. Determinar el tema según preferencia guardada o del sistema operativo
    const savedTheme = localStorage.getItem("dark-mode");

    const systemPrefersDark = window.matchMedia(
        "(prefers-color-scheme: dark)",
    ).matches;

    const isDark =
        savedTheme !== null ? savedTheme === "true" : systemPrefersDark;

    // 2. Función global para aplicar el tema en la etiqueta <html> e Iconos
    window.applyTheme = function (dark) {
        if (dark) {
            document.documentElement.classList.add("dark");
        } else {
            document.documentElement.classList.remove("dark");
        }

        // Actualizar todos los botones/iconos de modo oscuro presentes en el DOM
        const toggleButtons = document.querySelectorAll(
            "#dark-mode-toggle, .dark-mode-toggle",
        );
        toggleButtons.forEach((btn) => {
            btn.innerHTML = dark
                ? '<i class="fa-solid fa-sun text-amber-400"></i>'
                : '<i class="fa-solid fa-moon"></i>';
        });

        // Guardar preferencia
        localStorage.setItem("dark-mode", dark);

        // Re-renderizar gráfico de progreso si existe
        if (typeof progressChart !== "undefined" && progressChart) {
            fetchProgressData();
        }
    };

    // 3. Aplicar estado inicial
    window.applyTheme(isDark);

    // 4. Asignación delegada de eventos (sombra/escucha global de clics)
    document.addEventListener("click", (e) => {
        const toggleBtn = e.target.closest(
            "#dark-mode-toggle, .dark-mode-toggle",
        );
        if (toggleBtn) {
            e.preventDefault();
            const currentlyDark =
                document.documentElement.classList.contains("dark");
            window.applyTheme(!currentlyDark);
        }
    });
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
        const res = await conectarConServidorRender("/api/user/stats");
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
        const res = await conectarConServidorRender(
            "/api/user/update-xp?xp_gain=" + xpGain,
        );
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
        const res = await conectarConServidorRender(
            "/api/user/progress?days=30",
        );
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
        const userLevel = userStats.level || "A1";
        const res = await apiFetch(
            `/api/daily-challenge?level=${encodeURIComponent(userLevel)}`,
            { headers: { Authorization: `Bearer ${authToken}` } },
        );
        if (!res.ok) return;
        const data = await res.json();
        const container = document.getElementById("challenge-missions");
        if (!container) return;

        container.innerHTML = data.missions
            .map((m) => {
                const isCompleted = Boolean(m.completed);
                const safeText = escapeHtml(m.text);
                const safeLevel = escapeHtml(userLevel);
                const safeId = Number(m.id);

                return `
                <div class="p-4 rounded-xl border transition-all duration-200 ${
                    isCompleted
                        ? "bg-emerald-50/50 dark:bg-emerald-950/20 border-emerald-200 dark:border-emerald-800/50 opacity-80"
                        : "bg-slate-50 dark:bg-slate-700/60 border-slate-200 dark:border-slate-600"
                }">
                    <div class="flex items-center justify-between mb-2">
                        <span class="text-sm font-bold ${
                            isCompleted
                                ? "text-emerald-700 dark:text-emerald-400"
                                : "text-amber-700 dark:text-amber-400"
                        }">
                            Nivel ${safeLevel} - Misión ${safeId}
                        </span>
                        <button
                            type="button"
                            data-action="complete-mission"
                            data-mission-id="${safeId}"
                            ${isCompleted ? "disabled" : ""}
                            class="text-xs px-3 py-1 rounded-lg transition font-semibold flex items-center gap-1 ${
                                isCompleted
                                    ? "bg-slate-300 dark:bg-slate-700 text-slate-500 dark:text-slate-400 cursor-not-allowed"
                                    : "bg-amber-600 hover:bg-amber-700 text-white shadow-sm"
                            }">
                            ${
                                isCompleted
                                    ? '<span class="material-symbols-outlined text-[14px]">check</span> Completado'
                                    : "Completar"
                            }
                        </button>
                    </div>
                    <p class="text-slate-800 dark:text-slate-100 font-medium ${
                        isCompleted ? "line-through text-slate-500 dark:text-slate-400" : ""
                    }">${safeText}</p>
                </div>`;
            })
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
        btnElement.innerHTML = '<span class="material-symbols-outlined text-[14px] animate-spin">progress_activity</span>';
    }

    try {
        const res = await conectarConServidorRender(
            `/api/daily-challenge/complete?mission_id=${missionId}`,
            "POST",
        );
        if (res.ok) {
            const data = await res.json();

            if (btnElement) {
                btnElement.disabled = true;
                btnElement.className =
                    "text-xs px-3 py-1 rounded-lg font-semibold flex items-center gap-1 bg-slate-300 dark:bg-slate-700 text-slate-500 dark:text-slate-400 cursor-not-allowed";
                btnElement.innerHTML =
                    '<span class="material-symbols-outlined text-[14px]">check</span> Completado';
                const card = btnElement.closest("div.p-4");
                if (card) {
                    card.classList.add(
                        "bg-emerald-50/50",
                        "dark:bg-emerald-950/20",
                        "border-emerald-200",
                        "opacity-80",
                    );
                }
            }

            await Swal.fire({
                icon: "success",
                title: "¡Misión completada!",
                text: `+${data.xp_gained || 15} XP`,
                timer: 2000,
                showConfirmButton: false,
            });
            await fetchUserStats();
        } else {
            const errorData = await res.json().catch(() => ({}));
            throw new Error(errorData.detail || `Error ${res.status}`);
        }
    } catch (e) {
        console.error("Error al completar misión:", e);
        Swal.fire({
            icon: "error",
            title: "Error",
            text: e.message || "No se pudo registrar la misión.",
            confirmButtonColor: "#4f46e5",
        });
    } finally {
        processing.mission = false;
        // No re-habilitamos si ya estaba completada; el listener ya evita el doble click
    }
}

// --- CURRÍCULO & LECTURAS ---
async function fetchCurriculum() {
    const select = document.getElementById("material-select");
    const display = document.getElementById("text-display");

    try {
        const res = await conectarConServidorRender("/api/curriculum");
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
        const vocabChips = currentUnit.vocabulary
            .map((v) => {
                const safe = escapeHtml(v);
                return `
                    <span class="bg-slate-100 dark:bg-slate-700 text-slate-800 dark:text-slate-200
                                 px-2 py-0.5 rounded border border-slate-300 dark:border-slate-600
                                 cursor-pointer hover:bg-indigo-600 hover:text-white
                                 dark:hover:bg-indigo-600 dark:hover:text-white transition font-medium"
                          data-action="play-audio"
                          data-text="${safe}"
                          title="Escuchar pronunciación">
                        ${safe}
                    </span>`;
            })
            .join("");

        display.innerHTML = `
            <div class="mb-3 flex flex-wrap gap-2 items-center">
                <span class="text-xs bg-indigo-100 dark:bg-indigo-950/70 text-indigo-800 dark:text-indigo-200 px-2.5 py-1 rounded-md font-bold uppercase tracking-wide border border-indigo-200 dark:border-indigo-800/50">
                    Gramática: ${escapeHtml(currentUnit.grammar_focus)}
                </span>
            </div>
            <p class="text-slate-800 dark:text-slate-100 text-lg leading-relaxed font-medium">
                ${escapeHtml(currentUnit.text)}
            </p>
            <div class="mt-4 pt-3 border-t border-slate-200 dark:border-slate-700 flex flex-wrap items-center gap-1.5 text-xs text-slate-600 dark:text-slate-300">
                <strong class="text-slate-800 dark:text-slate-200">Vocabulario clave:</strong>
                ${vocabChips}
            </div>
        `;
    }

    const results = document.getElementById("reading-results");
    if (results) results.classList.add("hidden");
}

// --- AUDIO SÍNTESIS CON BLOQUEO Y SWEETALERT2 ---
function playNaturalAudio(text, voice = "en-US-AriaNeural") {
    if (!text || processing.audio) return;
    processing.audio = true;

    // 1. Mostrar aviso de carga con SweetAlert2 para bloquear clics
    Swal.fire({
        title: "Generando audio...",
        text: "Por favor espera la respuesta del servidor",
        allowOutsideClick: false,
        allowEscapeKey: false,
        showConfirmButton: false,
        didOpen: () => {
            Swal.showLoading();
        },
    });

    const audioUrl = `${API_BASE_URL}/api/tts-natural?text=${encodeURIComponent(text)}&voice=${voice}`;
    const audio = new Audio(audioUrl);

    // Función auxiliar para desbloquear el estado global
    const releaseAudio = () => {
        processing.audio = false;
        Swal.close();
    };

    // 2. Cuando el audio empieza a sonar, cerramos el aviso
    audio.onplay = () => {
        Swal.close();
    };

    // 3. Cuando termina de reproducirse
    audio.onended = () => {
        releaseAudio();
    };

    // 4. Si hay error en la API de Render, usar el fallback del navegador
    audio.onerror = () => {
        window.speechSynthesis.cancel();
        const utterance = new SpeechSynthesisUtterance(text);
        utterance.lang = "en-US";

        utterance.onstart = () => {
            Swal.close();
        };
        utterance.onend = () => {
            releaseAudio();
        };
        utterance.onerror = () => {
            releaseAudio();
        };

        window.speechSynthesis.speak(utterance);
    };

    // Intentar reproducir
    // --- AUDIO SÍNTESIS CON BLOQUEO Y SWEETALERT2 ---
    audio.play().catch(() => {
        // Fallback inmediato si el navegador bloquea la reproducción automática
        window.speechSynthesis.cancel();
        const utterance = new SpeechSynthesisUtterance(text);
        utterance.lang = "en-US";

        utterance.onstart = () => {
            Swal.close();
        };
        utterance.onend = () => {
            releaseAudio();
        };
        utterance.onerror = () => {
            releaseAudio();
        };

        window.speechSynthesis.speak(utterance);
    });
}

function playTargetAudio(btnElement = null) {
    if (processing.audio) return;

    if (btnElement) {
        btnElement.disabled = true;
        btnElement.classList.add("opacity-50", "cursor-not-allowed");

        // Re-habilitar botón tras 3 segundos o cuando el audio empiece
        setTimeout(() => {
            btnElement.disabled = false;
            btnElement.classList.remove("opacity-50", "cursor-not-allowed");
        }, 3000);
    }

    if (currentUnit) {
        playNaturalAudio(currentUnit.text);
    }
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
                const res = await apiFetch(
                    "/api/evaluate-reading",
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
        const response = await apiFetch("/api/evaluate-reading", {
            method: "POST",
            headers: {
                Authorization: `Bearer ${authToken}`,
                "Content-Type": "application/json",
            },
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
    scoreText.innerText = `Precisión: ${Number(data.accuracy_score) || 0}%`;

    annotatedText.innerHTML = data.word_analysis
        .map((item) => {
            const safeWord = escapeHtml(item.word);
            if (item.status === "correct") {
                return `<span class="correct text-emerald-600 dark:text-emerald-400 font-bold mr-1.5">${safeWord}</span>`;
            }
            return `
                <span class="inline-flex flex-col items-center bg-rose-50 dark:bg-rose-950/50
                             px-2 py-1 rounded border border-rose-200 dark:border-rose-800/60
                             cursor-pointer mx-1 my-1 hover:bg-rose-100 dark:hover:bg-rose-900/60 transition"
                      data-action="play-audio"
                      data-text="${safeWord}"
                      title="Escuchar pronunciación correcta">
                    <span class="text-rose-700 dark:text-rose-300 font-bold underline decoration-rose-400">${safeWord}</span>
                    <span class="text-[11px] text-slate-600 dark:text-slate-400 font-mono font-medium">${escapeHtml(item.ipa)}</span>
                </span>`;
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

    showLoadingAlert(
        "Analizando gramática",
        "Enviando tu texto al servidor...",
    );

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
            hideLoadingAlert();
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

        const response = await apiFetch("/api/check-writing", {
            method: "POST",
            headers: {
                Authorization: `Bearer ${authToken}`,
                "Content-Type": "application/json",
            },
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
        hideLoadingAlert();
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
        const res = await conectarConServidorRender("/api/srs/stats");

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
        const res = await conectarConServidorRender("/api/srs/due-words");

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
/*
 * Petición GET normal (sin cambios): const res = await conectarConServidorRender("/api/daily-challenge");
 *
 * Petición POST con Query Param (como el de tus misiones): const res = await conectarConServidorRender(`/api/daily-challenge/complete?mission_id=${missionId}`, "POST");
 *
 * Petición POST con cuerpo JSON: const res = await conectarConServidorRender("/api/user/update-xp", "POST", { xp: 15 });
 *
 */
async function conectarConServidorRender(
    endpoint,
    method = "GET",
    body = null,
    showLoading = false,
    ) {
    if (!authToken) {
        console.error("No hay token de autenticación.");
        showLoginModal();
        return { ok: false, status: 401 };
    }

    if (backendStatus !== "ready") await wakeUpBackend();

    let loadingTimer = null;
    if (showLoading) {
        showLoadingAlert("Conectando con el servidor", "Sincronizando datos…");
    } else {
        loadingTimer = setTimeout(() => {
            Swal.fire({
                toast: true,
                position: "top-end",
                icon: "info",
                title: "El servidor está tardando…",
                text: "Puede ser el arranque en frío de Render.",
                showConfirmButton: false,
                timer: 6000,
                timerProgressBar: true,
            });
        }, 2000);
    }

    try {
        const headers = { Authorization: `Bearer ${authToken}` };
        if (body && method !== "GET") headers["Content-Type"] = "application/json";

        const config = { method, headers };
        if (body && method !== "GET") config.body = JSON.stringify(body);

        // ✅ endpoint ya empieza por "/api/..."
        const response = await apiFetch(endpoint, config);

        if (response.status === 401) {
            console.error("Sesión expirada (401).");
            handleLogout();
            return { ok: false, status: 401 };
        }
        return response;
    } catch (error) {
        if (error.name === "AbortError") {
            console.error("Timeout al conectar con el backend.");
            Swal.fire({
                icon: "warning",
                title: "El servidor tardó demasiado",
                text: "Render puede tardar hasta 60 s en despertar. Intenta de nuevo en un momento.",
                confirmButtonColor: "#4f46e5",
            });
        } else {
            console.error("Error de conexión con la API:", error);
            setBackendStatus("down");
        }
        return { ok: false, status: 500 };
    } finally {
        if (loadingTimer) clearTimeout(loadingTimer);
        if (showLoading) hideLoadingAlert();
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
        const res = await apiFetch("/api/srs/review", {
            method: "POST",
            headers: {
                Authorization: `Bearer ${authToken}`,
                "Content-Type": "application/json",
            },
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
        const res = await conectarConServidorRender("/api/ipa-matrix");

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

const IPA_TYPE_DEFAULT_COLOR = "bg-slate-100 text-slate-700 dark:bg-slate-700 dark:text-slate-300";

function renderPhonemeCategory(containerId, items) {
    const grid = document.getElementById(containerId);
    if (!grid) return;

    grid.innerHTML = items
        .map((item, index) => {
            const truncate = (str, max) =>
                str.length > max ? str.slice(0, max) + "…" : str;

            const example     = escapeHtml(item.example);
            const symbol      = escapeHtml(item.symbol);
            const ipaEx       = escapeHtml(item.ipa_ex);
            const type        = escapeHtml(item.type);
            const shortHint   = escapeHtml(truncate(item.spanish_equivalent_or_hack, 300));
            const shortError  = escapeHtml(truncate(item.common_error_spanish, 300));
            const hintFull    = escapeHtml(item.spanish_equivalent_or_hack);
            const errorFull   = escapeHtml(item.common_error_spanish);
            const pairs       = escapeHtml(item.minimal_pairs.join(" · "));
            const pairsFull   = escapeHtml(item.minimal_pairs.join("; "));
            const spellings   = item.common_spellings.map(escapeHtml);
            const typeColor   = IPA_TYPE_COLORS[item.type] || IPA_TYPE_DEFAULT_COLOR;
            const cardId      = makeSafeId(`${containerId}-${index}`);

            return `
            <div class="phoneme-card group bg-white dark:bg-slate-800 rounded-2xl shadow-sm hover:shadow-lg
                        border border-slate-200 dark:border-slate-700 hover:border-cyan-400 dark:hover:border-cyan-500
                        transition-all duration-200 p-4"
                 data-card-id="${cardId}">

                <div class="flex flex-col items-center text-center gap-1 p-2">
                    <span class="text-3xl font-mono font-bold text-cyan-700 dark:text-cyan-400">/${symbol}/</span>
                    <span class="text-base font-medium text-slate-700 dark:text-slate-200">${example}</span>
                    <span class="text-xs text-slate-400 dark:text-slate-500 font-mono">${ipaEx}</span>
                    <button type="button"
                            class="js-play-phoneme mt-1 text-cyan-600 dark:text-cyan-400 hover:scale-110 transition"
                            data-example="${example}"
                            aria-label="Reproducir pronunciación de ${example}">
                        <span class="material-symbols-outlined">volume_up</span>
                    </button>
                </div>

                <div class="mt-1 text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider">${type}</div>

                <div class="mt-3 flex flex-wrap gap-1.5">
                    ${spellings.map((sp) =>
                        `<span class="px-2.5 py-0.5 bg-cyan-100 dark:bg-cyan-900/40 text-cyan-800 dark:text-cyan-300 text-[11px] rounded-full font-mono border border-cyan-200 dark:border-cyan-800">${sp}</span>`
                    ).join("")}
                </div>

                <div class="mt-3 text-xs text-slate-600 dark:text-slate-300">
                    <span class="material-symbols-outlined text-slate-500 dark:text-slate-400 text-[14px] align-middle mr-1">swap_horiz</span>
                    <span class="font-semibold">Contrasta con:</span>
                    <span class="ml-1">${pairs}</span>
                </div>

                <div class="mt-2 text-xs text-slate-600 dark:text-slate-300 italic line-clamp-2">
                    <span class="material-symbols-outlined text-amber-400 text-[14px] align-middle mr-1.5">lightbulb</span>
                    ${shortHint}
                </div>

                <div class="mt-1 text-[11px] text-rose-600 dark:text-rose-400 line-clamp-1">
                    <span class="material-symbols-outlined text-rose-500 text-[12px] align-middle mr-1.5">warning</span>
                    ${shortError}
                </div>

                <div class="mt-3 text-center">
                    <button type="button"
                            data-action="toggle-details"
                            class="text-[11px] font-medium text-cyan-600 dark:text-cyan-400 hover:underline flex items-center justify-center gap-1.5 w-full">
                        <span class="material-symbols-outlined text-[14px]">menu_book</span>
                        <span class="btn-toggle-text">Ver más</span>
                    </button>
                </div>

                <div data-details-panel
                     id="details-${cardId}"
                     class="hidden mt-3 pt-3 border-t border-slate-200 dark:border-slate-700 text-xs text-slate-600 dark:text-slate-300 space-y-2">
                    <div>
                        <span class="material-symbols-outlined text-amber-400 text-[14px] align-middle mr-1.5">lightbulb</span>
                        <span class="font-semibold">Similar a:</span> ${hintFull}
                    </div>
                    <div>
                        <span class="material-symbols-outlined text-rose-500 text-[14px] align-middle mr-1.5">close</span>
                        <span class="font-semibold">Error común:</span> ${errorFull}
                    </div>
                    <div>
                        <span class="material-symbols-outlined text-slate-500 text-[14px] align-middle mr-1.5">edit_note</span>
                        <span class="font-semibold">Grafías:</span> ${spellings.join(", ")}
                    </div>
                    <div>
                        <span class="material-symbols-outlined text-slate-500 text-[14px] align-middle mr-1.5">sync</span>
                        <span class="font-semibold">Pares mínimos:</span> ${pairsFull}
                    </div>
                </div>
            </div>`;
        })
        .join("");
}

function toggleDetails(btn) {
    const card = btn.closest(".phoneme-card");
    if (!card) return;
    const details = card.querySelector("[data-details-panel]");
    if (!details) return;

    const isHidden = details.classList.contains("hidden");
    details.classList.toggle("hidden");

    const textSpan = btn.querySelector(".btn-toggle-text");
    const icon = btn.querySelector(".material-symbols-outlined");
    if (textSpan) textSpan.textContent = isHidden ? "Ver menos" : "Ver más";
    if (icon) icon.textContent = isHidden ? "menu_book" : "auto_stories";
}

function registerGlobalDelegatedListeners() {
    document.addEventListener("click", (e) => {

        // ─── 1. Reproducir audio de vocabulario / fonema / palabra ───
        const audioTrigger = e.target.closest("[data-action='play-audio']");
        if (audioTrigger) {
            e.preventDefault();
            e.stopPropagation();
            const text = audioTrigger.dataset.text;
            if (text) playNaturalAudio(text);
            return;
        }

        // ─── 2. Reproducir audio de un botón concreto (icono volumen) ───
        const playBtn = e.target.closest(".js-play-phoneme");
        if (playBtn) {
            e.preventDefault();
            e.stopPropagation();
            const text = playBtn.dataset.example;
            if (text) playNaturalAudio(text);
            return;
        }

        // ─── 3. Toggle "Ver más" en tarjetas de fonemas ───
        const toggleBtn = e.target.closest("[data-action='toggle-details']");
        if (toggleBtn) {
            e.preventDefault();
            e.stopPropagation();
            toggleDetails(toggleBtn);
            return;
        }

        // ─── 4. Seleccionar unidad del currículo ───
        const unitCard = e.target.closest("[data-action='load-unit']");
        if (unitCard) {
            e.preventDefault();
            e.stopPropagation();
            const unitId = unitCard.dataset.unitId;
            const unlocked = unitCard.dataset.unlocked === "true";
            const levelKey = unitCard.dataset.level;
            if (unlocked) {
                loadUnitPractice(unitId);
            } else {
                Swal.fire({
                    icon: "warning",
                    title: "Unidad bloqueada",
                    text: `Debes alcanzar el nivel ${levelKey} en el Test de Nivel para desbloquear esta unidad.`,
                    confirmButtonColor: "#4f46e5",
                });
            }
            return;
        }

        // ─── 5. Completar misión diaria ───
        const missionBtn = e.target.closest("[data-action='complete-mission']");
        if (missionBtn && !missionBtn.disabled) {
            e.preventDefault();
            e.stopPropagation();
            const missionId = Number(missionBtn.dataset.missionId);
            completeMission(missionId, missionBtn);
            return;
        }

        // ─── 6. Iniciar escenario roleplay ───
        const scenarioCard = e.target.closest("[data-action='start-roleplay']");
        if (scenarioCard) {
            e.preventDefault();
            e.stopPropagation();
            startRoleplaySession(scenarioCard.dataset.scenarioId);
            return;
        }

        // ─── 7. Usar sugerencia de roleplay ───
        const suggestionBtn = e.target.closest("[data-action='use-suggestion']");
        if (suggestionBtn) {
            e.preventDefault();
            e.stopPropagation();
            const reply = suggestionBtn.dataset.reply;
            const input = document.getElementById("rp-transcript-input");
            if (input) input.value = reply;
            sendRoleplayMessage(e);
            return;
        }

        // ─── 8. Seleccionar opción del placement test ───
        const ptOpt = e.target.closest("[data-action='pt-select-option']");
        if (ptOpt) {
            e.preventDefault();
            e.stopPropagation();
            selectPlacementOption(Number(ptOpt.dataset.optionIndex));
            return;
        }
    });
}

// --- ROLEPLAY MODULO ---
async function initRoleplayModule() {
    try {
        const res = await conectarConServidorRender("/api/roleplay/scenarios");

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
        .map((sc) => {
            const safeId = escapeAttr(sc.id);
            const safeTitle = escapeHtml(sc.title);
            const safeDesc = escapeHtml(sc.description);
            const safeIcon = escapeAttr(sc.icon);

            return `
            <div data-action="start-roleplay"
                 data-scenario-id="${safeId}"
                 class="p-5 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700
                        rounded-xl hover:border-indigo-500 dark:hover:border-indigo-400
                        hover:shadow-md cursor-pointer transition flex flex-col justify-between">
                <div>
                    <div class="w-12 h-12 bg-indigo-50 dark:bg-indigo-950/70 text-indigo-600 dark:text-indigo-400
                                rounded-xl flex items-center justify-center text-2xl mb-4">
                        <i class="${safeIcon}"></i>
                    </div>
                    <h3 class="font-bold text-slate-800 dark:text-slate-100 text-lg mb-1">${safeTitle}</h3>
                    <p class="text-xs text-slate-600 dark:text-slate-300 mb-3">${safeDesc}</p>
                </div>
                <span class="text-xs font-semibold text-indigo-600 dark:text-indigo-400 flex items-center gap-1">
                    Iniciar práctica
                    <span class="material-symbols-outlined text-[14px]">arrow_forward</span>
                </span>
            </div>`;
        })
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
    const safeText = escapeHtml(text);
    const safeFeedback = feedback ? escapeHtml(feedback) : null;

    const msgHtml = `
        <div class="flex flex-col ${isBot ? "items-start" : "items-end"}">
            <div class="max-w-[80%] p-4 rounded-2xl ${
                isBot
                    ? "bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-800 dark:text-slate-100"
                    : "bg-indigo-600 text-white"
            } shadow-sm">
                <p class="text-sm font-medium">${safeText}</p>
            </div>
            ${
                safeFeedback
                    ? `<span class="text-[11px] text-amber-700 dark:text-amber-400 mt-1 font-semibold flex items-center gap-1">
                           <span class="material-symbols-outlined text-[12px]">lightbulb</span> ${safeFeedback}
                       </span>`
                    : ""
            }
        </div>`;

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
        .map((r) => {
            const safeReply = escapeAttr(r);
            const visible = escapeHtml(r);
            return `
            <button type="button"
                    data-action="use-suggestion"
                    data-reply="${safeReply}"
                    class="bg-slate-100 dark:bg-slate-700 hover:bg-indigo-50 dark:hover:bg-indigo-950/60
                           hover:text-indigo-700 dark:hover:text-indigo-300
                           text-slate-700 dark:text-slate-200 px-3 py-1.5 rounded-lg
                           border border-slate-200 dark:border-slate-600 transition font-medium text-left">
                <span class="material-symbols-outlined text-[14px] align-middle mr-1">lightbulb</span>
                "${visible}"
            </button>`;
        })
        .join("");
}

/*function useRPSuggestionFromData(btnEl, e) {
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
}*/

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

    showLoadingAlert(
        "Procesando respuesta roleplay",
        "El tutor AI está respondiendo...",
    );

    const btn = document.getElementById("btn-send-rp");
    btn.disabled = true;
    btn.classList.add("opacity-50", "cursor-not-allowed");
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';

    try {
        const input = document.getElementById("rp-transcript-input");
        if (!input) return;
        const userText = input.value.trim();
        if (!userText || !currentScenario) {
            hideLoadingAlert();
            return;
        }

        appendRPMessage("user", userText);
        roleplayHistory.push({ role: "user", content: userText });
        input.value = "";

        const res = await apiFetch("/api/roleplay/respond", {
            method: "POST",
            headers: {
                Authorization: `Bearer ${authToken}`,
                "Content-Type": "application/json",
            },
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
        hideLoadingAlert();
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

/*function selectSuggestedResponse(text, e) {
    if (e) {
        e.preventDefault();
        e.stopPropagation();
    }
    const input = document.getElementById("rp-transcript-input");
    if (input) {
        input.value = text;
    }
    sendRoleplayMessage(e);
}*/

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
        const res = await conectarConServidorRender("/api/placement/start");
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
        `Pregunta ${Number(data.step)} de ${Number(data.total_steps)}`;
    document.getElementById("pt-difficulty-indicator").innerText =
        `Dificultad: ${escapeHtml(data.level)}`;
    document.getElementById("pt-progress-bar").style.width =
        `${(data.step / data.total_steps) * 100}%`;
    document.getElementById("pt-question-text").innerText = data.question.question;

    const optionsContainer = document.getElementById("pt-options-container");
    optionsContainer.innerHTML = data.question.options
        .map((opt, idx) => `
            <button type="button"
                    data-action="pt-select-option"
                    data-option-index="${idx}"
                    class="pt-option-btn w-full text-left p-4 rounded-xl border border-slate-200 dark:border-slate-700
                           bg-white dark:bg-slate-800 hover:bg-amber-50 dark:hover:bg-amber-950/30
                           hover:border-amber-300 dark:hover:border-amber-600 font-medium text-sm
                           text-slate-800 dark:text-slate-100 transition">
                <span class="font-bold text-amber-600 dark:text-amber-400 mr-2">${String.fromCharCode(65 + idx)}.</span>
                ${escapeHtml(opt)}
            </button>
        `)
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
        const res = await apiFetch("/api/placement/next", {
            method: "POST",
            headers: {
                Authorization: `Bearer ${authToken}`,
                "Content-Type": "application/json",
            },
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
        const res = await conectarConServidorRender("/api/curriculum");
        if (!res.ok) return;
        const curriculum = await res.json();

        container.innerHTML = Object.keys(curriculum)
            .map((levelKey) => {
                const levelData = curriculum[levelKey];
                const unlocked = isLevelUnlocked(levelKey);
                const safeLevel = escapeAttr(levelKey);
                const safeLevelName = escapeHtml(levelData.level_name);

                return `
                <div class="mb-8 p-6 bg-slate-50 dark:bg-slate-800/40 border ${
                    unlocked
                        ? "border-slate-200 dark:border-slate-700"
                        : "border-slate-200 dark:border-slate-800 bg-slate-100/60 dark:bg-slate-900/60"
                } rounded-2xl transition">
                    <div class="flex justify-between items-center mb-4">
                        <div class="flex items-center gap-3">
                            <span class="px-3 py-1 text-xs font-black rounded-lg ${
                                unlocked
                                    ? "bg-indigo-600 text-white"
                                    : "bg-slate-300 dark:bg-slate-700 text-slate-600 dark:text-slate-400"
                            }">${safeLevel}</span>
                            <h3 class="text-lg font-bold ${
                                unlocked
                                    ? "text-slate-800 dark:text-slate-100"
                                    : "text-slate-400 dark:text-slate-500"
                            }">${safeLevelName}</h3>
                        </div>
                        ${
                            unlocked
                                ? `<span class="text-xs font-bold text-emerald-700 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-950/50 px-3 py-1 rounded-full border border-emerald-200 dark:border-emerald-800/60 flex items-center gap-1">
                                       <span class="material-symbols-outlined text-[14px]">lock_open</span> Desbloqueado
                                   </span>`
                                : `<span class="text-xs font-bold text-slate-500 dark:text-slate-400 bg-slate-200 dark:bg-slate-700 px-3 py-1 rounded-full flex items-center gap-1">
                                       <span class="material-symbols-outlined text-[14px]">lock</span> Requiere Nivel ${safeLevel}
                                   </span>`
                        }
                    </div>
                    <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
                        ${levelData.units
                            .map((unit) => {
                                const safeUnitId = escapeAttr(unit.id);
                                const safeTitle = escapeHtml(unit.title);
                                const safeGrammar = escapeHtml(unit.grammar_focus);
                                return `
                                <div data-action="load-unit"
                                     data-unit-id="${safeUnitId}"
                                     data-level="${safeLevel}"
                                     data-unlocked="${unlocked}"
                                     class="p-5 bg-white dark:bg-slate-800 border ${
                                         unlocked
                                             ? "border-slate-200 dark:border-slate-700 hover:border-indigo-500 dark:hover:border-indigo-400 cursor-pointer shadow-sm"
                                             : "border-slate-200 dark:border-slate-700 opacity-60 cursor-not-allowed"
                                     } rounded-xl transition flex justify-between items-center">
                                    <div>
                                        <h4 class="font-bold text-sm text-slate-800 dark:text-slate-100">${safeTitle}</h4>
                                        <p class="text-xs text-slate-600 dark:text-slate-400 mt-1">
                                            <span class="material-symbols-outlined text-indigo-500 text-[14px] align-middle mr-1">bookmark</span>
                                            ${safeGrammar}
                                        </p>
                                    </div>
                                    <div class="text-indigo-600 dark:text-indigo-400 font-bold text-sm">
                                        ${
                                            unlocked
                                                ? '<span class="material-symbols-outlined">chevron_right</span>'
                                                : '<span class="material-symbols-outlined text-slate-400 dark:text-slate-500">lock</span>'
                                        }
                                    </div>
                                </div>`;
                            })
                            .join("")}
                    </div>
                </div>`;
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
    const username = document.getElementById("login-username").value;

    localStorage.setItem("username", username);
    console.warn("Guardando username en localStorage:", username);
    updateNavUserProfile(username);

    btn.disabled = true;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Conectando...';
    errorText.classList.add("hidden");

    try {
        const { data, error } = await supabaseClient.auth.signInWithPassword({
            email,
            password,
        });
        if (error) throw error;

        authToken = data.session.access_token;
        currentUsername = data.user.email;

        // Guardar explícitamente en localStorage
        localStorage.setItem("auth_token", authToken);
        localStorage.setItem("current_username", currentUsername);

        hideLoginModal();
        initializeApp();
    } catch (err) {
        errorText.textContent =
            err.message === "Invalid login credentials"
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

// Envuelve las llamadas iniciales para ejecutarlas SÓLO tras confirmar la sesión activa
function initializeApp() {
    const savedUser =
        localStorage.getItem("username") ||
        localStorage.getItem("current_username") ||
        "Estudiante";
    updateNavUserProfile(savedUser);

    fetchCurriculum();
    fetchSRSStats();
    fetchSRSDueWords();
    initWaveform();

    // Encadenamos estadísticas para asegurar el NIVEL antes de pedir desafíos
    fetchUserStats().then(() => {
        fetchProgressData();
        fetchDailyChallenge();
    });
}

// --- ACTUALIZAR PERFIL DE USUARIO EN NAVBAR ---
function updateNavUserProfile(username, level = "A1") {
    const usernameElem = document.getElementById("nav-username");
    const avatarElem = document.getElementById("nav-user-avatar");
    const levelElem = document.getElementById("nav-user-level-badge");

    if (usernameElem) {
        usernameElem.textContent = username || "Usuario";
    }

    if (levelElem) {
        levelElem.textContent = `Nivel: ${level}`;
    }

    if (avatarElem && username) {
        // Genera un avatar automático con las iniciales del usuario usando UI-Avatars
        avatarElem.src = `https://ui-avatars.com/api/?name=${encodeURIComponent(username)}&background=4f46e5&color=fff&bold=true&length=2`;
    }
}

// Muestra el modal de carga bloqueando clics externos
function showLoadingAlert(
    title = "Procesando...",
    text = "Por favor espera mientras el servidor responde.",
    ) {
    Swal.fire({
        title: title,
        text: text,
        allowOutsideClick: false,
        allowEscapeKey: false,
        showConfirmButton: false,
        didOpen: () => {
            Swal.showLoading();
        },
    });
}

// Cierra la alerta activa
function hideLoadingAlert() {
    Swal.close();
}

// Helper específico que reutiliza el warmup
async function apiFetch(path, options = {}) {
    if (backendStatus !== "ready") await wakeUpBackend();

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 90000);

    // Si el caller pasó un signal, lo respetamos
    const ext = options.signal;
    if (ext) {
        if (ext.aborted) controller.abort();
        else ext.addEventListener("abort", () => controller.abort(), { once: true });
    }

    try {
        const res = await fetch(`${API_BASE_URL}${path}`, {
            ...options,
            signal: controller.signal,
        });
        if (res.status === 401) handleLogout();
        if (backendStatus !== "ready") setBackendStatus("ready");
        return res;
    } finally {
        clearTimeout(timeoutId);
    }
}

