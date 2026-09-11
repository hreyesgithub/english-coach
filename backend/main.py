import difflib
import io
import json
import logging
import os
import re
import tempfile
import httpx
from pathlib import Path
from datetime import date, datetime, timedelta
from typing import Any, List, Optional, cast, Dict

import assemblyai as aai

import edge_tts  # type: ignore
import eng_to_ipa as ipa  # type: ignore
from dotenv import load_dotenv
from fastapi import (
    FastAPI,
    File,
    Form,
    Header,
    HTTPException,
    Query,
    Request,
    UploadFile,
    Depends,
)
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse

import google.generativeai as genai
from pydantic import BaseModel
from starlette.middleware.base import BaseHTTPMiddleware
from uvicorn.protocols.utils import ClientDisconnected
from supabase import create_client, Client

from postgrest.types import CountMethod

load_dotenv()

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("linguaboost")

app = FastAPI(title="LinguaBoost Pro API", version="5.0.0")

# --- CORS: restringido a orígenes explícitos (nunca "*" en producción) ---
ALLOWED_ORIGINS = [
    o.strip() for o in os.getenv("ALLOWED_ORIGINS", "").split(",") if o.strip()
]
if not ALLOWED_ORIGINS:
    logger.warning(
        "ALLOWED_ORIGINS no configurado: no se permitirá ningún origen por CORS."
    )

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)

# --- CONFIGURACIÓN DE SUPABASE ---
SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_KEY = os.getenv(
    "SUPABASE_KEY"
)  # debe ser la SERVICE ROLE KEY (nunca expuesta al frontend)
supabase: Optional[Client] = None

if SUPABASE_URL and SUPABASE_KEY:
    supabase = create_client(SUPABASE_URL, SUPABASE_KEY)
    logger.info("Cliente Supabase configurado correctamente.")
else:
    logger.warning(
        "SUPABASE_URL o SUPABASE_KEY no configuradas en las variables de entorno."
    )

# --- CONFIGURACIÓN DE IA Y SERVICIOS ---
ASSEMBLYAI_API_KEY = os.getenv("ASSEMBLYAI_API_KEY")
if not ASSEMBLYAI_API_KEY:
    logger.warning(
        "ASSEMBLYAI_API_KEY no está configurada: la evaluación de lectura no funcionará."
    )
else:
    aai.settings.api_key = ASSEMBLYAI_API_KEY
    logger.info("AssemblyAI configurado correctamente.")

GEMINI_API_KEY = os.getenv("GEMINI_API_KEY")
GEMINI_MODEL_NAME = os.getenv("GEMINI_MODEL_NAME", "gemini-1.5-flash")
_gemini_model = None
if GEMINI_API_KEY:
    genai.configure(api_key=GEMINI_API_KEY)  # type: ignore
    logger.info("Gemini configurado correctamente.")
else:
    logger.warning(
        "GEMINI_API_KEY no configurada: el Roleplay usará respuestas de respaldo."
    )


def get_gemini_model(system_instruction: str):
    """Crea (o reutiliza) el modelo Gemini con instrucción de sistema nativa."""
    global _gemini_model
    if _gemini_model is None and GEMINI_API_KEY:
        _gemini_model = genai.GenerativeModel(  # type: ignore
            GEMINI_MODEL_NAME,
            system_instruction=system_instruction,
        )
    return _gemini_model


# --- CARGA DE CONTENIDO DESDE ARCHIVOS JSON ---
CONTENT_DIR = Path(__file__).resolve().parent / "content"


def load_content(filename: str):
    path = CONTENT_DIR / filename
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except FileNotFoundError:
        raise RuntimeError(f"No se encontró el archivo de contenido '{path}'.")
    except json.JSONDecodeError as e:
        raise RuntimeError(f"El archivo '{path}' tiene un error de sintaxis JSON: {e}")


SRS_INTERVALS = {1: 1, 2: 3, 3: 7, 4: 14, 5: 60}

CURRICULUM = load_content("content/curriculum.json")
IPA_PHONEMES = load_content("content/ipa_phonemes.json")
ROLEPLAY_SCENARIOS = load_content("content/roleplay_scenarios.json")
PLACEMENT_QUESTIONS = load_content("content/placement_questions.json")
LEVEL_ORDER = ["A1", "A2", "B1", "B2", "C1", "C2"]

MAX_TEXT_LEN = 500  # límite defensivo para endpoints de texto libre


def seed_srs_from_curriculum():
    """Sincroniza el vocabulario del currículo directamente en Supabase."""
    if not supabase:
        return
    today_str = datetime.now().date().isoformat()
    words_to_upsert = []

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

                words_to_upsert.append(
                    {
                        "word": clean_word,
                        "ipa": ipa_transcription,
                        "level": 1,
                        "next_review": today_str,
                    }
                )

    if words_to_upsert:
        try:
            supabase.table("srs_words").upsert(
                words_to_upsert, on_conflict="word", ignore_duplicates=True
            ).execute()
            logger.info("Seed SRS Supabase: Vocabulario sincronizado exitosamente.")
        except Exception as e:
            logger.error(f"Error al sembrar vocabulario en Supabase: {e}")


# --- MODELOS PYDANTIC ---
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
    mission_id: int = 1


# --- MIDDLEWARE ---
class SuppressDisconnectMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        try:
            return await call_next(request)
        except ClientDisconnected:
            return JSONResponse(
                status_code=499, content={"detail": "Client Closed Request"}
            )


app.add_middleware(SuppressDisconnectMiddleware)


# --- AUTENTICACIÓN ---
async def get_current_user(authorization: Optional[str] = Header(None)) -> str:
    """
    Deriva el user_id de un token de Supabase Auth verificado en el header
    Authorization: Bearer <token>. Nunca confiar en un user_id enviado por
    el cliente en query params o body.
    """
    if not supabase:
        raise HTTPException(
            status_code=503, detail="Servicio de autenticación no disponible."
        )
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status_code=401, detail="Falta el token de autorización.")

    token = authorization.split(" ", 1)[1].strip()
    try:
        user_response = supabase.auth.get_user(token)
        user = getattr(user_response, "user", None)
        if not user:
            raise HTTPException(status_code=401, detail="Token inválido.")
        return user.id
    except HTTPException:
        raise
    except Exception as e:
        logger.warning(f"Fallo de autenticación: {e}")
        raise HTTPException(status_code=401, detail="Token inválido o expirado.")


# --- FUNCIONES AUXILIARES CON SUPABASE ---
def get_user_stats(user_id: str):
    if not supabase:
        return {
            "level": 1,
            "xp": 0,
            "streak": 0,
            "last_active": str(date.today()),
            "badges": [],
        }

    try:
        res = supabase.table("user_stats").select("*").eq("user_id", user_id).execute()
    except Exception as e:
        logger.error(f"Error Supabase (get_user_stats): {e}")
        raise HTTPException(
            status_code=503, detail="Servicio de base de datos no disponible."
        )

    if not res.data:
        today_str = date.today().isoformat()
        new_user = {
            "user_id": user_id,
            "level": 1,
            "xp": 0,
            "streak": 0,
            "last_active": today_str,
            "badges": [],
        }
        try:
            supabase.table("user_stats").insert(new_user).execute()
        except Exception as e:
            logger.error(f"Error Supabase (insert user_stats): {e}")
            raise HTTPException(
                status_code=503, detail="No se pudo crear el perfil de usuario."
            )
        return new_user

    row = cast(dict[str, Any], res.data[0])
    if not isinstance(row, dict):
        raise HTTPException(
            status_code=500, detail="Formato de datos del usuario inválido."
        )

    badges = row.get("badges", [])
    if isinstance(badges, str):
        badges = json.loads(badges)

    return {
        "level": row.get("level", 1),
        "xp": row.get("xp", 0),
        "streak": row.get("streak", 0),
        "last_active": row.get("last_active"),
        "badges": badges,
    }


def update_user_xp(user_id: str, xp_gain: int):
    """
    Incrementa el XP de forma atómica vía la función RPC `increment_xp`
    (ver migración SQL). Esto evita condiciones de carrera del patrón
    leer-calcular-escribir en Python.
    """
    if not supabase:
        return {"xp": 0, "level": 1, "streak": 0}

    # Asegura que el usuario exista antes del RPC (crea fila si es la primera vez)
    get_user_stats(user_id)

    try:
        rpc_res = supabase.rpc(
            "increment_xp", {"p_user_id": user_id, "p_xp": xp_gain}
        ).execute()
    except Exception as e:
        logger.error(f"Error Supabase (increment_xp RPC): {e}")
        raise HTTPException(status_code=503, detail="No se pudo actualizar el XP.")

    if not rpc_res.data:
        raise HTTPException(
            status_code=500, detail="Respuesta inesperada al actualizar XP."
        )

    raw_row = rpc_res.data[0] if isinstance(rpc_res.data, list) else rpc_res.data
    if not isinstance(raw_row, dict):
        raise HTTPException(
            status_code=500, detail="Formato inesperado en la respuesta del XP."
        )

    xp_value = raw_row.get("xp", 0)
    level_value = raw_row.get("level", 1)
    streak_value = raw_row.get("streak", 0)
    new_xp = int(xp_value) if isinstance(xp_value, (int, float, str)) else 0
    new_level = int(level_value) if isinstance(level_value, (int, float, str)) else 1
    streak = int(streak_value) if isinstance(streak_value, (int, float, str)) else 0

    # Racha e historial diario (no crítico para consistencia de XP, se maneja aparte)
    today = date.today()
    today_str = today.isoformat()
    try:
        stats_res = (
            supabase.table("user_stats")
            .select("last_active, streak")
            .eq("user_id", user_id)
            .execute()
        )
        stats_row = (
            stats_res.data[0]
            if isinstance(stats_res.data, list) and stats_res.data
            else None
        )
        if isinstance(stats_row, dict):
            last_active_str = stats_row.get("last_active")
            streak_value = stats_row.get("streak", 0)
            prev_streak = (
                int(streak_value) if isinstance(streak_value, (int, float, str)) else 0
            )
        else:
            last_active_str = None
            prev_streak = 0

        last_active = (
            datetime.strptime(last_active_str, "%Y-%m-%d").date()
            if isinstance(last_active_str, str) and last_active_str
            else today - timedelta(days=1)
        )
        if (today - last_active).days == 1:
            streak = prev_streak + 1
        elif (today - last_active).days > 1:
            streak = 0
        else:
            streak = prev_streak

        supabase.table("user_stats").update(
            {"streak": streak, "last_active": today_str}
        ).eq("user_id", user_id).execute()

        dp_res = (
            supabase.table("daily_progress")
            .select("xp_gained")
            .eq("user_id", user_id)
            .eq("date", today_str)
            .execute()
        )
        if dp_res.data:
            dp_row = dp_res.data[0] if isinstance(dp_res.data, list) else dp_res.data
            if isinstance(dp_row, dict):
                xp_raw = dp_row.get("xp_gained", 0)
                curr_xp = (
                    int(xp_raw)
                    if isinstance(xp_raw, (int, float, str))
                    and not isinstance(xp_raw, bool)
                    else 0
                )
            else:
                curr_xp = 0
            supabase.table("daily_progress").update(
                {"xp_gained": curr_xp + xp_gain}
            ).eq("user_id", user_id).eq("date", today_str).execute()
        else:
            supabase.table("daily_progress").insert(
                {"user_id": user_id, "date": today_str, "xp_gained": xp_gain}
            ).execute()
    except Exception as e:
        logger.error(f"Error Supabase (racha/progreso diario): {e}")
        # No abortamos la respuesta por esto: el XP ya se guardó de forma atómica.

    return {"xp": new_xp, "level": new_level, "streak": streak}


def update_daily_progress(user_id: str, words: int = 0, roleplays: int = 0):
    if not supabase:
        return
    today_str = date.today().isoformat()
    try:
        dp_res = (
            supabase.table("daily_progress")
            .select("*")
            .eq("user_id", user_id)
            .eq("date", today_str)
            .execute()
        )
        if dp_res.data:
            rec = dp_res.data[0]
            if isinstance(rec, dict):
                words_raw = rec.get("words_passed", 0)
                roleplays_raw = rec.get("roleplays_completed", 0)
                try:
                    current_words = (
                        int(words_raw)
                        if isinstance(words_raw, (int, float, str))
                        and not isinstance(words_raw, bool)
                        else 0
                    )
                except (TypeError, ValueError):
                    current_words = 0
                try:
                    current_roleplays = (
                        int(roleplays_raw)
                        if isinstance(roleplays_raw, (int, float, str))
                        and not isinstance(roleplays_raw, bool)
                        else 0
                    )
                except (TypeError, ValueError):
                    current_roleplays = 0
                supabase.table("daily_progress").update(
                    {
                        "words_passed": current_words + words,
                        "roleplays_completed": current_roleplays + roleplays,
                    }
                ).eq("user_id", user_id).eq("date", today_str).execute()
        else:
            supabase.table("daily_progress").insert(
                {
                    "user_id": user_id,
                    "date": today_str,
                    "words_passed": words,
                    "roleplays_completed": roleplays,
                }
            ).execute()
    except Exception as e:
        logger.error(f"Error Supabase (update_daily_progress): {e}")


def calculate_final_level(history):
    level_weights = {"A1": 1, "A2": 2, "B1": 3, "B2": 4}
    correct_levels = [
        level_weights[h["level"]]
        for h in history
        if h["correct"] and h["level"] in level_weights
    ]
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


# --- STARTUP: siembra diferida y protegida ---
@app.on_event("startup")
async def startup_event():
    try:
        seed_srs_from_curriculum()
    except Exception as e:
        logger.error(f"Fallo al sembrar SRS en el arranque: {e}")


# --- ENDPOINTS GENERALES ---
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
    text: str = Query(
        ..., max_length=MAX_TEXT_LEN, description="Texto en inglés a convertir"
    )
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
    text: str = Query(..., max_length=MAX_TEXT_LEN),
    voice: str = Query("en-US-AriaNeural"),
):
    try:
        clean_text = text.replace("'", "").replace("’", "")
        communicate = edge_tts.Communicate(clean_text, voice)
        audio_buffer = io.BytesIO()
        async for chunk in communicate.stream():
            chunk_type = chunk.get("type")
            chunk_data = chunk.get("data")
            if chunk_type == "audio" and chunk_data:
                audio_buffer.write(chunk_data)
        audio_buffer.seek(0)
        return StreamingResponse(audio_buffer, media_type="audio/mpeg")
    except Exception as e:
        logger.error(f"Error en Edge-TTS: {e}")
        raise HTTPException(
            status_code=503, detail="El servicio de voz no está disponible."
        )


@app.post("/api/evaluate-pronunciation")
def evaluate_pronunciation(data: PronunciationEvaluationRequest):
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
            else "Buena articulación, pero vocaliza más claro."
        ),
    }


# --- ENDPOINTS DEL SISTEMA SRS (SUPABASE) — requieren usuario autenticado ---
@app.get("/api/srs/due-words")
def get_due_words(user_id: str = Depends(get_current_user)):
    if not supabase:
        return {"due_words": [], "count": 0}
    today_str = datetime.now().date().isoformat()
    try:
        res = (
            supabase.table("srs_words")
            .select("id, word, ipa, level, times_failed, times_passed")
            .lte("next_review", today_str)
            .order("level", desc=False)
            .order("times_failed", desc=True)
            .execute()
        )
    except Exception as e:
        logger.error(f"Error Supabase (due-words): {e}")
        raise HTTPException(
            status_code=503, detail="Servicio de base de datos no disponible."
        )
    return {"due_words": res.data, "count": len(res.data)}


@app.post("/api/srs/review")
def review_srs_word(data: SRSReviewRequest, user_id: str = Depends(get_current_user)):
    if not supabase:
        raise HTTPException(status_code=500, detail="Supabase no inicializado.")
    word = data.word.lower().strip()
    today = datetime.now().date()

    try:
        res = (
            supabase.table("srs_words")
            .select("level, times_passed, times_failed")
            .eq("word", word)
            .execute()
        )
    except Exception as e:
        logger.error(f"Error Supabase (review select): {e}")
        raise HTTPException(
            status_code=503, detail="Servicio de base de datos no disponible."
        )

    if not res.data:
        raise HTTPException(
            status_code=404, detail="Palabra no encontrada en el banco SRS"
        )

    row_data = res.data[0]
    if not isinstance(row_data, dict):
        raise HTTPException(
            status_code=500, detail="Formato inválido del registro SRS."
        )

    row = cast(dict[str, Any], row_data)
    current_level = int(row.get("level", 1) or 1)

    try:
        if data.success:
            new_level = min(current_level + 1, 5)
            next_review = (today + timedelta(days=SRS_INTERVALS[new_level])).isoformat()
            supabase.table("srs_words").update(
                {
                    "level": new_level,
                    "next_review": next_review,
                    "times_passed": int(row.get("times_passed", 0) or 0) + 1,
                }
            ).eq("word", word).execute()
        else:
            new_level = 1
            next_review = today.isoformat()
            supabase.table("srs_words").update(
                {
                    "level": 1,
                    "next_review": next_review,
                    "times_failed": int(row.get("times_failed", 0) or 0) + 1,
                }
            ).eq("word", word).execute()
    except Exception as e:
        logger.error(f"Error Supabase (review update): {e}")
        raise HTTPException(status_code=503, detail="No se pudo actualizar la palabra.")

    return {
        "word": word,
        "new_level": new_level,
        "next_review": str(next_review),
        "status": "promoted" if data.success else "reset",
    }


@app.get("/api/srs/stats")
def get_srs_stats():
    if not supabase:
        return {"total_words": 0, "due_today": 0, "mastered_words": 0}
    today_str = datetime.now().date().isoformat()
    try:
        res_total = (
            supabase.table("srs_words").select("id", count=CountMethod.exact).execute()
        )
        res_due = (
            supabase.table("srs_words")
            .select("id", count=CountMethod.exact)
            .lte("next_review", today_str)
            .execute()
        )
        res_mastered = (
            supabase.table("srs_words")
            .select("id", count=CountMethod.exact)
            .eq("level", 5)
            .execute()
        )
    except Exception as e:
        logger.error(f"Error Supabase (srs stats): {e}")
        raise HTTPException(
            status_code=503, detail="Servicio de base de datos no disponible."
        )

    return {
        "total_words": (
            res_total.count if res_total.count is not None else len(res_total.data)
        ),
        "due_today": res_due.count if res_due.count is not None else len(res_due.data),
        "mastered_words": (
            res_mastered.count
            if res_mastered.count is not None
            else len(res_mastered.data)
        ),
    }


# --- ROLEPLAY & PLACEMENT TEST ---
@app.get("/api/roleplay/scenarios")
def get_roleplay_scenarios():
    return ROLEPLAY_SCENARIOS


@app.post("/api/roleplay/respond")
async def roleplay_respond(data: RoleplayMessageRequest, request: Request):
    if await request.is_disconnected():
        return {"status": "cancelled"}

    if len(data.user_message) > MAX_TEXT_LEN:
        raise HTTPException(status_code=413, detail="Mensaje demasiado largo.")

    scenario = next(
        (s for s in ROLEPLAY_SCENARIOS if s["id"] == data.scenario_id), None
    )
    if not scenario:
        raise HTTPException(status_code=404, detail="Escenario no encontrado")

    system_prompt = (
        "Eres un tutor de inglés (AI Language Coach) empático y motivador. "
        "Responde de forma natural, corrigiendo gramática y pronunciación sin romper la fluidez. "
        f"Escenario: {scenario['title']}. Tu rol: {scenario['role']}."
    )

    history = list(data.conversation_history)
    last = history[-1] if history else None
    if not (
        last and last.get("role") == "user" and last.get("content") == data.user_message
    ):
        history.append({"role": "user", "content": data.user_message})

    try:
        model = get_gemini_model(system_prompt)
        if model:
            gemini_history = []
            for msg in history[:-1]:
                role = "model" if msg.get("role") == "assistant" else "user"
                gemini_history.append({"role": role, "parts": [msg.get("content", "")]})

            chat = model.start_chat(history=gemini_history)
            response = chat.send_message(data.user_message)
            bot_reply = response.text
        else:
            bot_reply = "Thank you. I have received your message!"
    except Exception as e:
        logger.exception(f"Error en Gemini Roleplay: {e}")
        bot_reply = "I'm sorry, I couldn't process that. Could you repeat?"

    return {
        "bot_reply": bot_reply,
        "feedback": (
            "¡Excelente fluidez!"
            if len(data.user_message.split()) > 5
            else "Intenta usar frases más largas."
        ),
    }


@app.get("/api/placement/start")
def start_placement_test():
    q = PLACEMENT_QUESTIONS["A2"][0]
    return {
        "level": "A2",
        "question": {"id": q["id"], "question": q["question"], "options": q["options"]},
        "step": 1,
        "total_steps": 6,
    }


@app.post("/api/placement/next")
def next_placement_question(data: PlacementStepRequest):
    if data.current_level not in LEVEL_ORDER:
        raise HTTPException(status_code=400, detail="Nivel inválido.")
    if data.current_level not in PLACEMENT_QUESTIONS:
        raise HTTPException(status_code=400, detail="No hay preguntas para ese nivel.")

    curr_level = data.current_level
    curr_idx = LEVEL_ORDER.index(curr_level)
    q_data = next(
        (
            item
            for item in PLACEMENT_QUESTIONS[curr_level]
            if item["id"] == data.question_id
        ),
        None,
    )
    if not q_data:
        raise HTTPException(status_code=400, detail="Pregunta inválida para ese nivel.")

    is_correct = q_data["correct"] == data.selected_option
    updated_history = data.history + [
        {"level": curr_level, "question_id": data.question_id, "correct": is_correct}
    ]

    if len(updated_history) >= 6:
        return {
            "completed": True,
            "final_level": calculate_final_level(updated_history),
            "history": updated_history,
        }

    next_idx = (
        min(curr_idx + 1, len(LEVEL_ORDER) - 1) if is_correct else max(curr_idx - 1, 0)
    )
    next_level = LEVEL_ORDER[next_idx]
    if next_level not in PLACEMENT_QUESTIONS:
        next_level = curr_level

    answered_ids = [h.get("question_id") for h in updated_history]
    available_qs = [
        q for q in PLACEMENT_QUESTIONS[next_level] if q["id"] not in answered_ids
    ]
    if not available_qs:
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
        "step": len(updated_history) + 1,
        "total_steps": 6,
        "history": updated_history,
    }


# --- WRITING CHECK ---
@app.post("/api/check-writing")
async def check_writing(data: WritingCheckRequest):
    text = data.text.strip()
    if not text:
        return {"feedback": [], "score": 100}
    if len(text) > 2000:
        raise HTTPException(
            status_code=413, detail="Texto demasiado largo (máx. 2000 caracteres)."
        )
    try:
        async with httpx.AsyncClient(timeout=20.0) as client:
            response = await client.post(
                "https://api.languagetool.org/v2/check",
                data={"text": text, "language": "en-US"},
            )
        response.raise_for_status()
        matches = response.json().get("matches", [])
        feedback = [
            {
                "message": m.get("message", ""),
                "replacements": [
                    r.get("value")
                    for r in m.get("replacements", [])[:3]
                    if r.get("value")
                ],
            }
            for m in matches
        ]
        return {"feedback": feedback, "score": max(0, 100 - len(matches) * 5)}
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(
            status_code=503, detail="No se pudo realizar la corrección gramatical."
        )


# --- GAMIFICACIÓN Y DESAFÍOS (SUPABASE) — requieren usuario autenticado ---
@app.get("/api/user/stats")
def user_stats(user_id: str = Depends(get_current_user)):
    return get_user_stats(user_id)


@app.post("/api/user/update-xp")
def user_update_xp(xp_gain: int = 10, user_id: str = Depends(get_current_user)):
    if xp_gain <= 0 or xp_gain > 1000:
        raise HTTPException(status_code=400, detail="Cantidad de XP inválida.")
    return update_user_xp(user_id, xp_gain)


@app.get("/api/daily-challenge")
def get_daily_challenge():
    if not supabase:
        return {"date": str(date.today()), "missions": []}
    today_str = date.today().isoformat()
    try:
        res = (
            supabase.table("daily_challenges")
            .select("challenge_data")
            .eq("date", today_str)
            .execute()
        )

        challenge_data: Any
        if not res.data:
            missions = [
                {"id": 1, "text": "Repasa 5 tarjetas SRS", "type": "srs", "target": 5},
                {
                    "id": 2,
                    "text": "Práctica 2 minutos de Shadowing",
                    "type": "shadowing",
                    "target": 2,
                },
                {
                    "id": 3,
                    "text": "Completa un Roleplay",
                    "type": "roleplay",
                    "target": 1,
                },
            ]
            supabase.table("daily_challenges").insert(
                {"date": today_str, "challenge_data": missions}
            ).execute()
            challenge_data = missions
        else:
            first_row = cast(Dict[str, Any], res.data[0])
            challenge_data = first_row["challenge_data"]
            if isinstance(challenge_data, str):
                challenge_data = json.loads(challenge_data)
    except Exception as e:
        logger.error(f"Error Supabase (daily-challenge): {e}")
        raise HTTPException(
            status_code=503, detail="Servicio de base de datos no disponible."
        )

    return {"date": today_str, "missions": challenge_data}


@app.post("/api/daily-challenge/complete")
def complete_challenge(
    mission_id: int = Query(...), user_id: str = Depends(get_current_user)
):
    """
    Requiere la tabla `completed_missions` con constraint único
    (user_id, date, mission_id) para impedir reclamar la misma misión
    más de una vez por día (ver migración SQL).
    """
    if not supabase:
        raise HTTPException(status_code=500, detail="Supabase no inicializado.")

    today_str = date.today().isoformat()
    try:
        existing = (
            supabase.table("completed_missions")
            .select("mission_id")
            .eq("user_id", user_id)
            .eq("date", today_str)
            .eq("mission_id", mission_id)
            .execute()
        )
        if existing.data:
            raise HTTPException(
                status_code=400, detail="Esta misión ya fue completada hoy."
            )

        supabase.table("completed_missions").insert(
            {"user_id": user_id, "date": today_str, "mission_id": mission_id}
        ).execute()
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error Supabase (complete_challenge): {e}")
        raise HTTPException(
            status_code=503, detail="No se pudo registrar la misión completada."
        )

    xp_reward = 15
    stats = update_user_xp(user_id, xp_reward)
    return {
        "message": f"Misión {mission_id} completada",
        "xp_gained": xp_reward,
        **stats,
    }


@app.get("/api/user/progress")
def get_user_progress(days: int = 30, user_id: str = Depends(get_current_user)):
    if not supabase:
        return {"dates": [], "xp": [], "words": [], "roleplays": []}
    days = max(1, min(days, 365))
    start_date_str = (date.today() - timedelta(days=days)).isoformat()
    try:
        res = (
            supabase.table("daily_progress")
            .select("date, xp_gained, words_passed, roleplays_completed")
            .eq("user_id", user_id)
            .gte("date", start_date_str)
            .order("date")
            .execute()
        )
    except Exception as e:
        logger.error(f"Error Supabase (user progress): {e}")
        raise HTTPException(
            status_code=503, detail="Servicio de base de datos no disponible."
        )

    rows = cast(List[Dict[str, Any]], res.data)
    return {
        "dates": [r["date"] for r in rows],
        "xp": [r["xp_gained"] for r in rows],
        "words": [r["words_passed"] for r in rows],
        "roleplays": [r["roleplays_completed"] for r in rows],
    }


@app.post("/api/evaluate-reading")
async def evaluate_reading(
    target_text: str = Form(..., max_length=MAX_TEXT_LEN),
    audio_file: UploadFile = File(...),
    user_id: str = Depends(get_current_user),
):
    if not ASSEMBLYAI_API_KEY:
        raise HTTPException(status_code=503, detail="Requiere ASSEMBLYAI_API_KEY.")

    MAX_AUDIO_SIZE = 10 * 1024 * 1024  # 10 MB
    ALLOWED_AUDIO_TYPES = {
        "audio/wav",
        "audio/mpeg",
        "audio/mp4",
        "audio/webm",
        "audio/x-wav",
    }

    if audio_file.content_type not in ALLOWED_AUDIO_TYPES:
        raise HTTPException(
            status_code=415,
            detail=f"Formato de audio no soportado: {audio_file.content_type}",
        )

    suffix = Path(audio_file.filename or "audio.wav").suffix or ".wav"
    tmp_path = None
    try:
        content = await audio_file.read()
        if len(content) > MAX_AUDIO_SIZE:
            raise HTTPException(
                status_code=413, detail="El archivo de audio supera el límite de 10 MB."
            )

        with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
            tmp.write(content)
            tmp_path = tmp.name

        transcriber = aai.Transcriber()
        transcript = transcriber.transcribe(tmp_path)
        spoken_text = (getattr(transcript, "text", "") or "").strip()
    finally:
        if tmp_path and os.path.exists(tmp_path):
            os.unlink(tmp_path)

    if not spoken_text:
        raise HTTPException(400, detail="No se pudo reconocer audio.")

    target_ipa = ipa.convert(target_text)
    spoken_ipa = ipa.convert(spoken_text)
    score = round(
        difflib.SequenceMatcher(None, target_ipa, spoken_ipa).ratio() * 100, 1
    )

    target_words = target_text.split()
    failed_words = []
    word_analysis = []
    for tw in target_words:
        if tw.lower() in spoken_text.lower():
            word_analysis.append(
                {"word": tw, "status": "correct", "ipa": f"/{ipa.convert(tw)}/"}
            )
        else:
            word_analysis.append(
                {"word": tw, "status": "incorrect", "ipa": f"/{ipa.convert(tw)}/"}
            )
            failed_words.append(tw)

    if failed_words and supabase:
        today_str = date.today().isoformat()
        try:
            for fw in failed_words:
                clean_fw = fw.strip().lower()
                existing = (
                    supabase.table("srs_words")
                    .select("times_failed")
                    .eq("word", clean_fw)
                    .execute()
                )
                if existing.data:
                    existing_word = existing.data[0]
                    previous_failures = (
                        existing_word.get("times_failed", 0)
                        if isinstance(existing_word, dict)
                        else 0
                    )
                    tf = (
                        previous_failures + 1
                        if isinstance(previous_failures, int)
                        and not isinstance(previous_failures, bool)
                        else 1
                    )
                    supabase.table("srs_words").update(
                        {"level": 1, "next_review": today_str, "times_failed": tf}
                    ).eq("word", clean_fw).execute()
                else:
                    supabase.table("srs_words").insert(
                        {
                            "word": clean_fw,
                            "ipa": f"/{ipa.convert(clean_fw)}/",
                            "level": 1,
                            "next_review": today_str,
                            "times_failed": 1,
                        }
                    ).execute()
        except Exception as e:
            logger.error(f"Error Supabase (evaluate-reading srs update): {e}")

    update_daily_progress(user_id=user_id, words=len(target_words) - len(failed_words))

    return {
        "accuracy_score": score,
        "spoken_text": spoken_text,
        "word_analysis": word_analysis,
        "failed_words_count": len(failed_words),
    }
