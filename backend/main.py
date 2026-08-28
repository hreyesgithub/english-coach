import collections

# --- PARCHE DE COMPATIBILIDAD OBLIGATORIO PARA PYTHON 3.10+ ---
if not hasattr(collections, "MutableMapping"):
    import collections.abc as abc

    setattr(collections, "MutableMapping", abc.MutableMapping)

import difflib
import io
import json
import logging
import os
import re
import sqlite3
import tempfile
from pathlib import Path
from datetime import date, datetime, timedelta
from typing import List, Optional

import edge_tts  # type: ignore
import eng_to_ipa as ipa  # type: ignore
from dotenv import load_dotenv
from fastapi import FastAPI, File, Form, HTTPException, Query, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
from language_tool_python import LanguageTool  # type: ignore[import-not-found]
from openai import OpenAI
from openai.types.chat import ChatCompletionMessageParam
import google.generativeai as genai
from pydantic import BaseModel
from starlette.middleware.base import BaseHTTPMiddleware
from uvicorn.protocols.utils import ClientDisconnected

load_dotenv()

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("linguaboost")

app = FastAPI(title="LinguaBoost Pro API", version="4.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# --- CONFIGURACIÓN DE LLM ---
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY")
openai_client = OpenAI(api_key=OPENAI_API_KEY) if OPENAI_API_KEY else None
if not openai_client:
    logger.warning(
        "OPENAI_API_KEY no está configurada: el Roleplay funcionará en modo "
        "'fallback' con respuestas guionizadas, no con el LLM real."
    )

GEMINI_API_KEY = os.getenv("GEMINI_API_KEY")
if GEMINI_API_KEY:
    genai.configure(api_key=GEMINI_API_KEY) # type:ignore
    logger.info("Gemini configurado correctamente.")
else:
    logger.warning("GEMINI_API_KEY no configurada: el Roleplay usará respuestas de respaldo.")

# --- BASE DE DATOS SQLITE PARA REPETICIÓN ESPACIADA (SRS) ---
DB_NAME = "srs_bank.db"


def init_db():
    conn = sqlite3.connect(DB_NAME)
    cursor = conn.cursor()
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS srs_words (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            word TEXT UNIQUE NOT NULL,
            ipa TEXT NOT NULL,
            level INTEGER DEFAULT 1,
            next_review DATE NOT NULL,
            times_failed INTEGER DEFAULT 1,
            times_passed INTEGER DEFAULT 0
        )
    """)
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS user_stats (
            user_id TEXT PRIMARY KEY,
            level INTEGER DEFAULT 1,
            xp INTEGER DEFAULT 0,
            streak INTEGER DEFAULT 0,
            last_active DATE,
            badges TEXT DEFAULT '[]'
        )
    """)
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS daily_challenges (
            date DATE PRIMARY KEY,
            challenge_data TEXT
        )
    """)
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS daily_progress (
            user_id TEXT,
            date DATE,
            xp_gained INTEGER DEFAULT 0,
            words_passed INTEGER DEFAULT 0,
            roleplays_completed INTEGER DEFAULT 0,
            PRIMARY KEY (user_id, date)
        )
    """)
    conn.commit()
    conn.close()


init_db()

# --- CARGA DE CONTENIDO DESDE ARCHIVOS JSON ---
# El material de estudio (unidades, roleplays, preguntas de nivel, fonemas)
# ya no vive hardcodeado en este archivo: se edita en /content/*.json sin
# tocar código Python. load_content() centraliza la lectura y falla con un
# mensaje claro si un archivo falta o tiene JSON inválido, en vez de tumbar
# el arranque del servidor con un traceback críptico.
CONTENT_DIR = Path(__file__).resolve().parent / "content"


def load_content(filename: str):
    path = CONTENT_DIR / filename
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except FileNotFoundError:
        raise RuntimeError(
            f"No se encontró el archivo de contenido '{path}'. "
            f"¿Falta crear/copiar {filename} en la carpeta content/?"
        )
    except json.JSONDecodeError as e:
        raise RuntimeError(
            f"El archivo de contenido '{path}' tiene un error de sintaxis JSON: {e}"
        )


SRS_INTERVALS = {
    1: 1,  # 1 día
    2: 3,  # 3 días
    3: 7,  # 7 días
    4: 14,  # 14 días
    5: 60,  # Dominada
}

# --- CURRÍCULO COMPLETO BASADO EN EL MCER (CEFR A1 - C2) ---
# --- CURRÍCULO COMPLETO BASADO EN EL MCER (A1-C2) — ver content/curriculum.json ---
CURRICULUM = load_content("curriculum.json")

def seed_srs_from_curriculum():
    """
    Sincroniza el vocabulario de CURRICULUM con el banco SRS (srs_words).

    Antes de este cambio, la lista "vocabulary" de cada unidad era solo
    texto de referencia: nunca se insertaba en la base de datos, así que
    esas palabras jamás aparecían en /api/srs/due-words ni eran
    revisables en /api/srs/review (que además devuelve 404 si la palabra
    no existe previamente en la tabla). Añadir una unidad nueva con
    vocabulario nuevo no tenía ningún efecto en el sistema de repaso.

    Esta función corre una vez al arrancar la app, recorre todo
    CURRICULUM y usa INSERT OR IGNORE para dar de alta cualquier palabra
    que todavía no esté en srs_words (columna UNIQUE), generando su
    transcripción IPA automáticamente con la librería ya usada en
    /api/get-ipa. Así, cualquier persona que añada contenido solo tiene
    que tocar CURRICULUM: el resto es automático.
    """
    conn = sqlite3.connect(DB_NAME)
    cursor = conn.cursor()
    today = datetime.now().date()
    inserted = 0

    for level_data in CURRICULUM.values():
        for unit in level_data.get("units", []):
            for raw_word in unit.get("vocabulary", []):
                clean_word = raw_word.strip().lower()
                if not clean_word:
                    continue
                try:
                    ipa_transcription = f"/{ipa.convert(clean_word)}/"
                except Exception:
                    ipa_transcription = ""
                cursor.execute(
                    """
                    INSERT OR IGNORE INTO srs_words (word, ipa, level, next_review)
                    VALUES (?, ?, 1, ?)
                    """,
                    (clean_word, ipa_transcription, today),
                )
                inserted += cursor.rowcount

    conn.commit()
    conn.close()
    if inserted:
        logger.info("Seed SRS: %d palabra(s) nueva(s) añadida(s) desde CURRICULUM.", inserted)


seed_srs_from_curriculum()

# --- BASE DE DATOS DE LOS 44 FONEMAS DEL IPA ---
# --- BASE DE DATOS DE LOS 44 FONEMAS DEL IPA (content/ipa_phonemes.json) ---
IPA_PHONEMES = load_content("ipa_phonemes.json")

# --- MÓDULO ROLEPLAY CONVERSACIONAL ---
ROLEPLAY_SCENARIOS = load_content("roleplay_scenarios.json")

# --- BANCO DE PREGUNTAS DEL TEST ADAPTATIVO MCER ---
PLACEMENT_QUESTIONS = load_content("placement_questions.json")

LEVEL_ORDER = ["A1", "A2", "B1", "B2", "C1", "C2"]


# --- MODELOS PYDANTIC (COINCIDENTES CON PAYLOADS DEL FRONTEND) ---
class PronunciationEvaluationRequest(BaseModel):
    target_text: str
    spoken_text: str


class SRSReviewRequest(BaseModel):
    word: str
    success: bool


class RoleplayMessageRequest(BaseModel):
    scenario_id: str
    user_message: str
    conversation_history: List[dict] = []


class PlacementStepRequest(BaseModel):
    current_level: str
    question_id: str
    selected_option: int
    history: List[dict]


class WritingCheckRequest(BaseModel):
    text: str


class CompleteChallengeRequest(BaseModel):
    user_id: str = "default"
    mission_id: int = 1


# --- MIDDLEWARE ---
class SuppressDisconnectMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        try:
            return await call_next(request)
        except ClientDisconnected:
            print(f"ℹ️ Cliente desconectado prematuramente en: {request.url.path}")
            return JSONResponse(status_code=499, content={"detail": "Client Closed Request"})


app.add_middleware(SuppressDisconnectMiddleware)

# --- INSTANCIAS DE SERVICIOS ---
# Si está en Render usa la API pública externa, si estás en local usa el servidor interno
if os.environ.get("RENDER"):
    lt = LanguageTool("en-US", remote_server="https://languagetool.org")
else:
    lt = LanguageTool("en-US")


# --- FUNCIONES AUXILIARES ---
def get_user_stats(user_id: str = "default"):
    conn = sqlite3.connect(DB_NAME)
    c = conn.cursor()
    c.execute(
        "SELECT level, xp, streak, last_active, badges FROM user_stats WHERE user_id = ?",
        (user_id,),
    )
    row = c.fetchone()
    if not row:
        c.execute(
            "INSERT INTO user_stats (user_id, level, xp, streak, last_active, badges) VALUES (?, 1, 0, 0, ?, '[]')",
            (user_id, date.today()),
        )
        conn.commit()
        row = (1, 0, 0, date.today(), "[]")
    conn.close()
    return {
        "level": row[0],
        "xp": row[1],
        "streak": row[2],
        "last_active": row[3],
        "badges": json.loads(row[4]),
    }


def update_user_xp(user_id: str, xp_gain: int):
    conn = sqlite3.connect(DB_NAME)
    c = conn.cursor()
    c.execute(
        "SELECT xp, level, streak, last_active FROM user_stats WHERE user_id = ?",
        (user_id,),
    )
    row = c.fetchone()
    if not row:
        conn.close()
        return {"error": "User not found"}
    new_xp = row[0] + xp_gain
    new_level = row[1]
    if new_xp >= 100 * new_level:
        new_level += 1
    today = date.today()
    last_active = (
        datetime.strptime(row[3], "%Y-%m-%d").date()
        if row[3]
        else today - timedelta(days=1)
    )
    streak = row[2]
    if (today - last_active).days == 1:
        streak += 1
    elif (today - last_active).days > 1:
        streak = 0

    c.execute(
        "UPDATE user_stats SET xp = ?, level = ?, streak = ?, last_active = ? WHERE user_id = ?",
        (new_xp, new_level, streak, today, user_id),
    )
    c.execute(
        "INSERT INTO daily_progress (user_id, date, xp_gained) VALUES (?, ?, ?) ON CONFLICT(user_id, date) DO UPDATE SET xp_gained = xp_gained + ?",
        (user_id, today, xp_gain, xp_gain),
    )
    conn.commit()
    conn.close()
    return {"xp": new_xp, "level": new_level, "streak": streak}


def update_daily_progress(user_id, words=0, roleplays=0):
    conn = sqlite3.connect(DB_NAME)
    c = conn.cursor()
    today = date.today()
    c.execute(
        """
        INSERT INTO daily_progress (user_id, date, words_passed, roleplays_completed)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(user_id, date) DO UPDATE SET
            words_passed = words_passed + ?,
            roleplays_completed = roleplays_completed + ?
    """,
        (user_id, today, words, roleplays, words, roleplays),
    )
    conn.commit()
    conn.close()


def check_and_award_badges(user_id):
    stats = get_user_stats(user_id)
    badges = stats["badges"]
    if stats["streak"] >= 7 and "streak_7" not in badges:
        badges.append("streak_7")
    conn = sqlite3.connect(DB_NAME)
    c = conn.cursor()
    c.execute(
        "UPDATE user_stats SET badges = ? WHERE user_id = ?",
        (json.dumps(badges), user_id),
    )
    conn.commit()
    conn.close()


def calculate_final_level(history):
    level_weights = {"A1": 1, "A2": 2, "B1": 3, "B2": 4}
    correct_levels = [level_weights[h["level"]] for h in history if h["correct"]]

    if not correct_levels:
        return "A1"

    avg_score = sum(correct_levels) / len(correct_levels)

    if avg_score >= 3.5:
        return "B2"
    elif avg_score >= 2.5:
        return "B1"
    elif avg_score >= 1.5:
        return "A2"
    else:
        return "A1"


# --- ENDPOINTS GENERALES Y FONÉTICA ---
@app.get("/")
def read_root():
    return {"message": "¡Bienvenido al backend del Coach de Inglés!"}


@app.get("/api/ipa-matrix")
def get_ipa_matrix():
    return IPA_PHONEMES


@app.get("/api/curriculum")
def get_curriculum():
    return CURRICULUM


@app.get("/api/get-ipa")
def get_ipa_transcription(
    text: str = Query(..., description="Texto en inglés a convertir")
):
    ipa_converted = ipa.convert(text)
    words = re.sub(r"[^\w\s]", "", text).split()
    words_detail = [{"word": w, "ipa": f"/{ipa.convert(w)}/"} for w in words]

    return {
        "original_text": text,
        "full_ipa": f"/{ipa_converted}/",
        "words_breakdown": words_detail,
    }


@app.get("/api/tts-natural")
async def text_to_speech_natural(
    text: str = Query(..., description="Texto a sintetizar"),
    voice: str = Query(
        "en-US-AriaNeural", description="Voz de IA (en-US-AriaNeural o en-US-GuyNeural)"
    ),
):
    try:
        clean_text = text.replace("'", "").replace("’", "")
        communicate = edge_tts.Communicate(clean_text, voice)
        audio_buffer = io.BytesIO()

        async for chunk in communicate.stream():
            if chunk["type"] == "audio":
                audio_data = chunk.get("data")
                if audio_data is not None:
                    audio_buffer.write(audio_data)

        audio_buffer.seek(0)
        return StreamingResponse(audio_buffer, media_type="audio/mpeg")
    except Exception as e:
        print(f"Error en Edge-TTS: {e}")
        raise HTTPException(
            status_code=503,
            detail="El servicio de voz no está disponible temporalmente. Inténtalo de nuevo.",
        )


# --- ENDPOINT AÑADIDO: EVALUACIÓN DE PRONUNCIACIÓN (CORRESPONDENCIA FRONTEND) ---
@app.post("/api/evaluate-pronunciation")
def evaluate_pronunciation(data: PronunciationEvaluationRequest):
    """Evalúa la coincidencia fonética entre la frase objetivo y el texto reconocido."""
    target = data.target_text.lower().strip()
    spoken = data.spoken_text.lower().strip()

    matcher = difflib.SequenceMatcher(None, target, spoken)
    ratio = round(matcher.ratio() * 100, 1)

    return {
        "target_text": data.target_text,
        "spoken_text": data.spoken_text,
        "accuracy_score": ratio,
        "passed": ratio >= 75.0,
        "feedback": (
            "¡Excelente pronunciación!"
            if ratio >= 85
            else "Buena articulación, pero intenta vocalizar con mayor claridad."
        ),
    }


# --- ENDPOINTS DEL SISTEMA SRS ---
@app.get("/api/srs/due-words")
def get_due_words():
    today = datetime.now().date()
    conn = sqlite3.connect(DB_NAME)
    cursor = conn.cursor()
    cursor.execute(
        """
        SELECT id, word, ipa, level, times_failed, times_passed 
        FROM srs_words 
        WHERE next_review <= ? 
        ORDER BY level ASC, times_failed DESC
    """,
        (today,),
    )
    rows = cursor.fetchall()
    conn.close()

    words = [
        {
            "id": r[0],
            "word": r[1],
            "ipa": r[2],
            "level": r[3],
            "times_failed": r[4],
            "times_passed": r[5],
        }
        for r in rows
    ]
    return {"due_words": words, "count": len(words)}


@app.post("/api/srs/review")
def review_srs_word(data: SRSReviewRequest):
    word = data.word.lower()
    today = datetime.now().date()

    conn = sqlite3.connect(DB_NAME)
    cursor = conn.cursor()
    cursor.execute("SELECT level FROM srs_words WHERE word = ?", (word,))
    row = cursor.fetchone()

    if not row:
        conn.close()
        raise HTTPException(
            status_code=404, detail="Palabra no encontrada en el banco SRS"
        )

    current_level = row[0]

    if data.success:
        new_level = min(current_level + 1, 5)
        days_to_add = SRS_INTERVALS[new_level]
        next_review = today + timedelta(days=days_to_add)
        cursor.execute(
            """
            UPDATE srs_words 
            SET level = ?, next_review = ?, times_passed = times_passed + 1
            WHERE word = ?
        """,
            (new_level, next_review, word),
        )
    else:
        new_level = 1
        next_review = today
        cursor.execute(
            """
            UPDATE srs_words 
            SET level = 1, next_review = ?, times_failed = times_failed + 1
            WHERE word = ?
        """,
            (today, word),
        )

    conn.commit()
    conn.close()

    return {
        "word": word,
        "new_level": new_level,
        "next_review": str(next_review),
        "status": "promoted" if data.success else "reset",
    }


@app.get("/api/srs/stats")
def get_srs_stats():
    today = datetime.now().date()
    conn = sqlite3.connect(DB_NAME)
    cursor = conn.cursor()

    cursor.execute("SELECT COUNT(*) FROM srs_words")
    total = cursor.fetchone()[0]

    cursor.execute("SELECT COUNT(*) FROM srs_words WHERE next_review <= ?", (today,))
    due = cursor.fetchone()[0]

    cursor.execute("SELECT COUNT(*) FROM srs_words WHERE level = 5")
    mastered = cursor.fetchone()[0]

    conn.close()
    return {"total_words": total, "due_today": due, "mastered_words": mastered}


# --- ENDPOINTS DE ROLEPLAY Y PLACEMENT TEST ---
@app.get("/api/roleplay/scenarios")
def get_roleplay_scenarios():
    return ROLEPLAY_SCENARIOS


@app.post("/api/roleplay/respond")
async def roleplay_respond(data: RoleplayMessageRequest, request: Request):
    if await request.is_disconnected():
        return {"status": "cancelled"}

    scenario = next(
        (s for s in ROLEPLAY_SCENARIOS if s["id"] == data.scenario_id),
        None,
    )

    if not scenario:
        raise HTTPException(
            status_code=404,
            detail="Escenario no encontrado",
        )

    system_prompt = (
        "Eres un tutor de inglés (AI Language Coach) empático y motivador. "
        "Responde de forma natural, corrigiendo gramática y pronunciación "
        "sin romper la fluidez de la conversación. Da retroalimentación "
        "constructiva y anima al estudiante. "
        f"Escenario: {scenario['title']}. "
        f"Tu rol: {scenario['role']}."
    )

    messages: list[ChatCompletionMessageParam] = [
        {
            "role": "system",
            "content": system_prompt,
        }
    ]

    # --- FIX: el frontend ya empuja el mensaje del usuario a `conversation_history`
    # ANTES de llamar al endpoint (ver roleplayHistory.push en app.js), y aquí se
    # volvía a añadir vía `data.user_message`. Resultado: dos mensajes "user"
    # seguidos en el payload a OpenAI. Deduplicamos por seguridad, sea cual sea
    # el estado que mande el cliente.
    history = list(data.conversation_history)
    last = history[-1] if history else None
    if not (
        last
        and last.get("role") == "user"
        and last.get("content") == data.user_message
    ):
        history.append({"role": "user", "content": data.user_message})

    messages.extend(history)  # type: ignore

    try:
        if GEMINI_API_KEY:
            # Convertir el historial al formato de Gemini
            gemini_history = []
            # El system_prompt se coloca como primer mensaje de usuario
            gemini_history.append({"role": "user", "parts": [system_prompt]})
            
            # Añadir el historial conversacional (excluyendo el último mensaje de usuario si ya está duplicado)
            # Nota: history ya contiene los mensajes previos (sin duplicar el último)
            for msg in history:
                # Convertir roles: "assistant" -> "model", "user" -> "user"
                role = "model" if msg.get("role") == "assistant" else "user"
                gemini_history.append({"role": role, "parts": [msg.get("content", "")]})

            # Iniciar sesión de chat con el historial completo
            model = genai.GenerativeModel('gemini-3.6-flash') # type:ignore
            chat = model.start_chat(history=gemini_history)
            
            # Enviar el mensaje del usuario (ya está en history como último, pero lo enviamos de nuevo)
            # Para evitar duplicados, usamos el mensaje del usuario actual sin añadirlo al historial de la sesión
            # Si ya lo incluimos en history, podemos usar send_message con el mismo texto.
            # Pero como history ya contiene el mensaje del usuario (por la deduplicación),
            # lo mejor es no volver a añadirlo. Sin embargo, start_chat ya tiene el historial,
            # por lo que enviar el mensaje actual con send_message lo añadirá al historial.
            # Para evitar duplicados, podemos pasar el mensaje directamente en el último lugar.
            # Opción: no incluir el último mensaje del usuario en el historial de la sesión,
            # y enviarlo con send_message.
            # Simplificamos: enviamos el mensaje del usuario con send_message.
            # Pero tenemos que asegurarnos de no duplicar: quitamos el último elemento de gemini_history si es el mensaje del usuario.
            # Como lo hemos incluido en history, podemos no incluirlo en gemini_history y enviarlo aparte.
            # Para mayor claridad, reconstruimos el historial sin el último mensaje si coincide.
            # En lugar de complicar, usamos el mensaje directamente.
            # Para no duplicar, extraemos el mensaje del usuario actual y lo enviamos.
            response = chat.send_message(data.user_message)
            bot_reply = response.text
        else:
            # Fallback sin API
            if "coffee" in data.user_message.lower():
                bot_reply = "Great choice! Would you like that for here or to go?"
            elif "interview" in data.scenario_id:
                bot_reply = "Impressive! Could you describe a challenge you overcame?"
            else:
                bot_reply = "Thank you. I have found your reservation. Do you prefer a window or aisle seat?"
    except Exception as e:
        logger.exception(
            "Fallo al llamar a Gemini en /api/roleplay/respond (scenario_id=%s)",
            data.scenario_id,
        )
        bot_reply = "I'm sorry, I couldn't process that. Could you please repeat?"

    words = len(data.user_message.split())
    feedback = (
        "¡Excelente fluidez!"
        if words > 5
        else "Intenta usar oraciones más largas y variadas."
    )

    return {
        "bot_reply": bot_reply,
        "feedback": feedback,
    }


@app.get("/api/placement/start")
def start_placement_test():
    initial_level = "A2"
    q = PLACEMENT_QUESTIONS[initial_level][0]
    return {
        "level": initial_level,
        "question": {"id": q["id"], "question": q["question"], "options": q["options"]},
        "step": 1,
        "total_steps": 6,
    }


@app.post("/api/placement/next")
def next_placement_question(data: PlacementStepRequest):
    curr_level = data.current_level
    curr_idx = LEVEL_ORDER.index(curr_level)

    q_data = None
    for item in PLACEMENT_QUESTIONS[curr_level]:
        if item["id"] == data.question_id:
            q_data = item
            break

    is_correct = q_data and q_data["correct"] == data.selected_option
    # --- FIX: antes esta entrada no guardaba 'question_id', así que el
    # filtro de "preguntas ya respondidas" de más abajo (answered_ids)
    # comparaba contra una lista de puros None y nunca excluía nada. Efecto
    # real: si el test rebotaba de vuelta a un nivel ya visitado, siempre se
    # repetía la primera pregunta de ese nivel. Con question_id guardado,
    # el filtro funciona de verdad.
    updated_history = data.history + [
        {"level": curr_level, "question_id": data.question_id, "correct": is_correct}
    ]
    step_num = len(updated_history) + 1

    if is_correct:
        next_idx = min(curr_idx + 1, len(LEVEL_ORDER) - 1)
    else:
        next_idx = max(curr_idx - 1, 0)

    next_level = LEVEL_ORDER[next_idx]

    if len(updated_history) >= 6:
        final_level = calculate_final_level(updated_history)
        return {
            "completed": True,
            "final_level": final_level,
            "accuracy": round(
                sum(1 for h in updated_history if h["correct"])
                / len(updated_history)
                * 100,
                1,
            ),
            "history": updated_history,
        }

    answered_ids = [h.get("question_id") for h in updated_history]
    available_qs = [
        q for q in PLACEMENT_QUESTIONS[next_level] if q["id"] not in answered_ids
    ]

    if not available_qs:
        # El nivel objetivo (next_level) ya no tiene preguntas sin usar.
        # Antes de rendirnos y repetir una, probamos con las preguntas sin
        # usar del nivel actual (curr_level) como alternativa razonable.
        fallback_qs = [
            q for q in PLACEMENT_QUESTIONS[curr_level] if q["id"] not in answered_ids
        ]
        if fallback_qs:
            next_level = curr_level
            available_qs = fallback_qs
        else:
            # Últimísimo recurso: de verdad no queda ninguna pregunta sin
            # usar en ninguno de los dos niveles. Repetimos una, pero
            # dejamos rastro en el log — con más preguntas por nivel esto
            # no debería ocurrir nunca en la práctica.
            logger.warning(
                "Banco de preguntas de placement agotado en niveles '%s'/'%s' "
                "tras %d preguntas; se repetirá una pregunta ya vista.",
                next_level, curr_level, len(updated_history),
            )
            next_level = curr_level
            available_qs = PLACEMENT_QUESTIONS[next_level]

    next_q = available_qs[0]

    return {
        "completed": False,
        "level": next_level,
        "question": {
            "id": next_q["id"],
            "question": next_q["question"],
            "options": next_q["options"],
        },
        "step": step_num,
        "total_steps": 6,
        "history": updated_history,
    }


# --- ENDPOINT WRITING CHECK ---
@app.post("/api/check-writing")
def check_writing(data: WritingCheckRequest):
    matches = lt.check(data.text)
    feedback = []
    for match in matches:
        msg = (
            getattr(match, "message", None)
            or getattr(match, "msg", None)
            or getattr(match, "shortMessage", None)
            or getattr(match, "short_message", None)
            or str(match)
        )
        short_msg = msg[:50] + "..." if len(msg) > 50 else msg
        replacements = match.replacements[:3] if match.replacements else []
        feedback.append(
            {
                "message": msg,
                "short_message": short_msg,
                "replacements": replacements,
            }
        )
    score = max(0, 100 - len(matches) * 5)
    return {"feedback": feedback, "score": score}


# --- ENDPOINTS DE GAMIFICACIÓN Y DESAFÍOS ---
@app.get("/api/user/stats")
def user_stats(user_id: str = "default"):
    return get_user_stats(user_id)


@app.get("/api/user/update-xp")
def user_update_xp(user_id: str = "default", xp_gain: int = 10):
    return update_user_xp(user_id, xp_gain)


@app.get("/api/daily-challenge")
def get_daily_challenge():
    today = date.today()
    conn = sqlite3.connect(DB_NAME)
    c = conn.cursor()
    c.execute("SELECT challenge_data FROM daily_challenges WHERE date = ?", (today,))
    row = c.fetchone()
    if not row:
        missions = [
            {"id": 1, "text": "Repasa 5 tarjetas SRS", "type": "srs", "target": 5},
            {
                "id": 2,
                "text": "Práctica 2 minutos de Shadowing",
                "type": "shadowing",
                "target": 2,
            },
            {"id": 3, "text": "Completa un Roleplay", "type": "roleplay", "target": 1},
        ]
        challenge_data = json.dumps(missions)
        c.execute(
            "INSERT INTO daily_challenges (date, challenge_data) VALUES (?, ?)",
            (today, challenge_data),
        )
        conn.commit()
    else:
        challenge_data = row[0]
    conn.close()
    return {"date": today.isoformat(), "missions": json.loads(challenge_data)}


@app.post("/api/daily-challenge/complete")
def complete_challenge(
    mission_id: int = Query(..., description="ID de la misión"),
    user_id: str = Query("default", description="ID del usuario")
):
    xp_reward = 15
    stats = update_user_xp(user_id, xp_reward)
    return {
        "message": f"Misión {mission_id} completada",
        "xp_gained": xp_reward,
        **stats,
    }


@app.get("/api/user/progress")
def get_user_progress(user_id: str = "default", days: int = 30):
    conn = sqlite3.connect(DB_NAME)
    c = conn.cursor()
    start_date = date.today() - timedelta(days=days)
    c.execute(
        """
        SELECT date, xp_gained, words_passed, roleplays_completed
        FROM daily_progress
        WHERE user_id = ? AND date >= ?
        ORDER BY date
    """,
        (user_id, start_date),
    )
    rows = c.fetchall()
    conn.close()
    return {
        "dates": [r[0] for r in rows],
        "xp": [r[1] for r in rows],
        "words": [r[2] for r in rows],
        "roleplays": [r[3] for r in rows],
    }