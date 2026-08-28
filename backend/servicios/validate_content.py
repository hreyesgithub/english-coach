#!/usr/bin/env python3
# backend/servicios/validate_content.py

"""
Valida los archivos content/*.json antes de subir contenido nuevo o desplegar.

Uso:
    python3 validate_content.py

Sale con código 0 si todo está bien, o 1 si encuentra errores (útil para
un hook de pre-commit o un paso de CI).
"""
import json
import sys
from pathlib import Path

CONTENT_DIR = Path(__file__).resolve().parent / "content"
LEVEL_ORDER = ["A1", "A2", "B1", "B2", "C1", "C2"]

errors: list[str] = []
warnings: list[str] = []


def load(filename: str):
    path = CONTENT_DIR / filename
    if not path.exists():
        errors.append(f"[{filename}] No existe el archivo en {path}")
        return None
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except json.JSONDecodeError as e:
        errors.append(f"[{filename}] JSON inválido: {e}")
        return None


def validate_curriculum(data):
    if data is None:
        return
    seen_ids = set()
    for level, level_data in data.items():
        if level not in LEVEL_ORDER:
            warnings.append(f"[curriculum.json] Nivel '{level}' no está en LEVEL_ORDER {LEVEL_ORDER}")
        units = level_data.get("units", [])
        if not units:
            warnings.append(f"[curriculum.json] Nivel '{level}' no tiene unidades")
        for unit in units:
            uid = unit.get("id")
            if not uid:
                errors.append(f"[curriculum.json] Unidad sin 'id' en nivel {level}")
                continue
            if uid in seen_ids:
                errors.append(f"[curriculum.json] id duplicado: '{uid}'")
            seen_ids.add(uid)

            for field in ("title", "grammar_focus", "vocabulary", "text", "listening_prompt"):
                if field not in unit or not unit[field]:
                    errors.append(f"[curriculum.json] Unidad '{uid}' no tiene '{field}'")

            vocab = unit.get("vocabulary", [])
            text = unit.get("text", "").lower()
            for word in vocab:
                # comprobación simple: la palabra (o su raíz) debe aparecer en el texto
                if word.lower() not in text:
                    warnings.append(
                        f"[curriculum.json] Unidad '{uid}': la palabra '{word}' "
                        f"no aparece literalmente en 'text' (revisa si es una forma flexionada)"
                    )


def validate_roleplay(data):
    if data is None:
        return
    seen_ids = set()
    required = ("id", "title", "icon", "role", "description", "initial_message", "suggested_replies")
    for scenario in data:
        sid = scenario.get("id")
        if not sid:
            errors.append("[roleplay_scenarios.json] Escenario sin 'id'")
            continue
        if sid in seen_ids:
            errors.append(f"[roleplay_scenarios.json] id duplicado: '{sid}'")
        seen_ids.add(sid)
        for field in required:
            if field not in scenario or not scenario[field]:
                errors.append(f"[roleplay_scenarios.json] Escenario '{sid}' no tiene '{field}'")
        if len(scenario.get("suggested_replies", [])) < 1:
            warnings.append(f"[roleplay_scenarios.json] Escenario '{sid}' no tiene 'suggested_replies'")


def validate_placement(data):
    if data is None:
        return
    for level, questions in data.items():
        if level not in LEVEL_ORDER:
            warnings.append(f"[placement_questions.json] Nivel '{level}' no está en LEVEL_ORDER")
        seen_ids = set()
        for q in questions:
            qid = q.get("id")
            if not qid:
                errors.append(f"[placement_questions.json] Pregunta sin 'id' en nivel {level}")
                continue
            if qid in seen_ids:
                errors.append(f"[placement_questions.json] id duplicado: '{qid}'")
            seen_ids.add(qid)

            options = q.get("options", [])
            if len(options) != 4:
                errors.append(
                    f"[placement_questions.json] Pregunta '{qid}' tiene {len(options)} "
                    f"opciones (debe tener exactamente 4)"
                )
            correct = q.get("correct")
            if not isinstance(correct, int) or not (0 <= correct < len(options)):
                errors.append(
                    f"[placement_questions.json] Pregunta '{qid}': 'correct'={correct!r} "
                    f"fuera de rango para {len(options)} opciones"
                )
    missing_levels = [lvl for lvl in LEVEL_ORDER if lvl not in data]
    if missing_levels:
        warnings.append(
            f"[placement_questions.json] Faltan preguntas para: {', '.join(missing_levels)}"
        )


def main():
    validate_curriculum(load("curriculum.json"))
    validate_roleplay(load("roleplay_scenarios.json"))
    validate_placement(load("placement_questions.json"))
    load("ipa_phonemes.json")  # solo valida que el JSON sea parseable

    if warnings:
        print(f"⚠️  {len(warnings)} advertencia(s):")
        for w in warnings:
            print(f"   - {w}")
        print()

    if errors:
        print(f"❌ {len(errors)} error(es) — corrígelos antes de desplegar:")
        for e in errors:
            print(f"   - {e}")
        sys.exit(1)

    print("✅ Todo el contenido en content/*.json es válido.")
    sys.exit(0)


if __name__ == "__main__":
    main()