# Configuración del LLM (usar OpenAI o Gemini)
import openai
import os
from pydantic import BaseModel
from typing import List

openai.api_key = os.getenv("OPENAI_API_KEY")

class RoleplayMessageRequest(BaseModel):
    scenario_id: str
    user_message: str
    conversation_history: List[dict] = []  # para mantener contexto

