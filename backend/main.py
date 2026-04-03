"""
InvesCore Slide Studio — FastAPI Backend
"""
import os
import json
import tempfile
from pathlib import Path
from typing import Any

import anthropic
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel

from template_engine import InvescoreTemplateEngine

# ── Paths ─────────────────────────────────────────────────────────────────────
BASE_DIR = Path(__file__).parent
TEMPLATE_PATH = BASE_DIR / "templates" / "InvesCore_Master_Template.pptx"
BRAND_GUIDE_PATH = BASE_DIR / "brand_guide.json"

# ── App ───────────────────────────────────────────────────────────────────────
app = FastAPI(title="InvesCore Slide Studio API", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],   # In production, restrict to your frontend domain
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── Models ────────────────────────────────────────────────────────────────────
class InterpretRequest(BaseModel):
    api_key: str
    prompt: str

class GenerateRequest(BaseModel):
    api_key: str
    slide_plan: list[dict]

class InterpretResponse(BaseModel):
    presentation_title: str
    slides: list[dict]
    token_usage: dict

# ── System prompt for Interpreter Agent ──────────────────────────────────────
with open(BRAND_GUIDE_PATH, encoding="utf-8") as f:
    _brand = json.load(f)

INTERPRETER_SYSTEM_PROMPT = """You are the InvesCore Slide Studio Interpreter. Convert the user's presentation request into a structured JSON slide plan.

InvesCore Property is a Mongolian real estate and investment management company.

Available slide templates (actual branded slides that will be cloned):
- "opening"           — Cover slide. Dynamic: presentation_title
- "ending"            — Closing slide. Dynamic: closing_message, contact_info
- "agenda"            — Contents/agenda. Dynamic: section_1_title, section_2_title, section_3_title, section_1_pages, section_2_pages, section_3_pages
- "section_divider"   — Section header. Dynamic: section_title, section_description
- "content_text"      — Text/bullets. Dynamic: subtitle_label, title, body_text (use | to separate bullet lines)
- "content_table"     — Data table. Dynamic: title (table data must be pre-formatted in body_text as rows)
- "content_comparison" — Two columns. Dynamic: section_label, left_title, right_title, left_content, right_content (use | for line breaks)
- "content_timeline"  — Goals/milestones. Dynamic: title, column_1_title, column_2_title, column_3_title, column_1_items, column_2_items, column_3_items (use | for items)
- "content_chart"     — Data analysis. Dynamic: title, subtitle, body_text
- "content_quote"     — Key statement. Dynamic: quote_text, attribution
- "content_team"      — Team/departments. Dynamic: title, unit_1_name, unit_2_name, unit_3_name

RULES:
1. ALWAYS start with "opening" and end with "ending"
2. Include "agenda" as slide 2 if the presentation has 5+ content slides
3. Use "section_divider" between major topic shifts
4. Keep body_text concise — use | as line separator for bullets (max 6 items per slide)
5. Write ALL text that should appear on each slide — do not leave blanks
6. Match professional financial/investment services tone
7. For Mongolian-language requests, write all slide content in Mongolian
8. For English requests, write all content in English
9. Make intelligent assumptions for vague requests — create a complete, professional presentation

Respond with ONLY valid JSON (no markdown code fences, no explanations):
{
  "presentation_title": "...",
  "slides": [
    {
      "template": "opening",
      "content": {
        "presentation_title": "..."
      }
    },
    {
      "template": "agenda",
      "content": {
        "section_1_title": "...",
        "section_2_title": "...",
        "section_3_title": "...",
        "section_1_pages": "pg. 3-5",
        "section_2_pages": "pg. 6-8",
        "section_3_pages": "pg. 9-11"
      }
    },
    ...
    {
      "template": "ending",
      "content": {
        "closing_message": "THANK YOU",
        "contact_info": "InvesCore Property Research"
      }
    }
  ]
}"""

# ── Endpoints ─────────────────────────────────────────────────────────────────

@app.get("/api/health")
async def health():
    return {"status": "ok", "template": str(TEMPLATE_PATH.name)}


@app.post("/api/interpret")
async def interpret(req: InterpretRequest):
    """Call Interpreter Agent (Claude Sonnet) to parse the user's request into a slide plan."""
    if not req.api_key.startswith("sk-ant-"):
        raise HTTPException(400, "Invalid Anthropic API key format")

    try:
        client = anthropic.Anthropic(api_key=req.api_key)
        message = client.messages.create(
            model="claude-sonnet-4-6",
            max_tokens=8000,
            temperature=0.3,
            system=INTERPRETER_SYSTEM_PROMPT,
            messages=[{"role": "user", "content": req.prompt}]
        )

        raw_text = message.content[0].text.strip()

        # Strip markdown code fences if present
        if raw_text.startswith("```"):
            raw_text = raw_text.split("```")[1]
            if raw_text.startswith("json"):
                raw_text = raw_text[4:]
        raw_text = raw_text.strip()

        plan = json.loads(raw_text)

        return {
            "presentation_title": plan.get("presentation_title", "Presentation"),
            "slides": plan.get("slides", []),
            "token_usage": {
                "input_tokens": message.usage.input_tokens,
                "output_tokens": message.usage.output_tokens,
                "estimated_cost_usd": round(
                    (message.usage.input_tokens * 3 + message.usage.output_tokens * 15) / 1_000_000, 4
                )
            }
        }

    except json.JSONDecodeError as e:
        raise HTTPException(500, f"Interpreter returned invalid JSON: {e}")
    except anthropic.AuthenticationError:
        raise HTTPException(401, "Invalid API key")
    except anthropic.RateLimitError:
        raise HTTPException(429, "API rate limit exceeded")
    except Exception as e:
        raise HTTPException(500, f"Interpretation failed: {str(e)}")


@app.post("/api/generate")
async def generate(req: GenerateRequest):
    """Generate a .pptx file from a slide plan."""
    if not req.api_key.startswith("sk-ant-"):
        raise HTTPException(400, "Invalid Anthropic API key format")

    if not req.slide_plan:
        raise HTTPException(400, "slide_plan cannot be empty")

    try:
        engine = InvescoreTemplateEngine(str(TEMPLATE_PATH), str(BRAND_GUIDE_PATH))
        output_path = engine.create_presentation(req.slide_plan)

        # Determine filename from first slide's content
        title = "presentation"
        if req.slide_plan and req.slide_plan[0].get("content", {}).get("presentation_title"):
            raw = req.slide_plan[0]["content"]["presentation_title"]
            title = raw[:40].replace("/", "-").replace("\\", "-").replace(" ", "_")

        filename = f"InvesCore_{title}.pptx"

        return FileResponse(
            path=output_path,
            media_type="application/vnd.openxmlformats-officedocument.presentationml.presentation",
            filename=filename,
            background=None,  # Let FastAPI handle cleanup
        )

    except ValueError as e:
        raise HTTPException(400, str(e))
    except Exception as e:
        raise HTTPException(500, f"Generation failed: {str(e)}")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
