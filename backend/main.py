"""
InvesCore Slide Studio — FastAPI Backend v2
"""
import asyncio
import hashlib
import json
import os
import re
import secrets
import shutil
import time
import uuid
from pathlib import Path
from typing import Any, AsyncGenerator

import anthropic
from fastapi import FastAPI, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel

from template_engine import InvescoreTemplateEngine

# ── Paths ─────────────────────────────────────────────────────────────────────
BASE_DIR        = Path(__file__).parent
TEMPLATE_PATH   = BASE_DIR / "templates" / "InvesCore_Master_Template.pptx"
BRAND_GUIDE_PATH = BASE_DIR / "brand_guide.json"
TMP_DIR         = BASE_DIR / "tmp"
ARTIFACT_TTL_SECONDS = int(os.environ.get("ARTIFACT_TTL_SECONDS", "21600"))

# ── App ───────────────────────────────────────────────────────────────────────
app = FastAPI(title="InvesCore Slide Studio API", version="2.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── Pydantic models ───────────────────────────────────────────────────────────
class InterpretRequest(BaseModel):
    api_key: str
    prompt: str

class GenerateRequest(BaseModel):
    api_key: str
    slide_plan: list[dict]   # V1: flat list of {template, content}

class GenerateV2Request(BaseModel):
    api_key: str
    slide_plan: dict         # V2: {presentation_title, sections:[...]}

class IntakeRequest(BaseModel):
    api_key: str
    messages: list[dict]     # [{role, content}, ...]

# ── Load brand guide ──────────────────────────────────────────────────────────
with open(BRAND_GUIDE_PATH, encoding="utf-8") as f:
    _brand = json.load(f)

# ── Content-area bounds (passed to Builder Agent) ─────────────────────────────
_engine_tmp = InvescoreTemplateEngine(str(TEMPLATE_PATH), str(BRAND_GUIDE_PATH))
_CONTENT_BOUNDS = _engine_tmp.get_content_area_bounds()

# ═════════════════════════════════════════════════════════════════════════════
# SYSTEM PROMPTS
# ═════════════════════════════════════════════════════════════════════════════

INTAKE_SYSTEM_PROMPT = """You are the InvesCore Slide Studio intake assistant. Your job is to interview the user to gather everything needed to create a perfect branded presentation.

Ask questions ONE AT A TIME. Keep them short and conversational. After each answer, acknowledge briefly and ask the next question. Adapt your follow-up questions based on their answers.

If the user's first message is exactly "START", greet them briefly and ask the first question.

REQUIRED INFORMATION TO GATHER (in roughly this order):

1. TOPIC & PURPOSE
   "What is this presentation about?"
   Then follow up: "Who is the audience? (e.g., internal team, investors, clients, board)"

2. LANGUAGE
   "Should the slides be in English, Mongolian, or a mix of both?"

3. SCOPE & LENGTH
   "How many slides do you have in mind? Or should I decide based on the content?"
   (If they say "you decide", suggest a number based on the topic complexity)

4. SECTIONS / STRUCTURE
   "What main sections or topics should the presentation cover?"
   (If they're unsure, suggest logical sections based on the topic and ask them to confirm or adjust)

5. KEY DATA & NUMBERS
   "Do you have any specific numbers, statistics, or data points you want included?"
   "Any specific dates, deadlines, or time periods to reference?"

6. TONE & STYLE
   "What tone should this have? (e.g., formal/executive, informational, persuasive, casual update)"

7. SPECIAL REQUIREMENTS
   "Anything else I should know? Any slides that need a specific layout like a table, chart, comparison, or org chart?"

RULES:
- Never ask more than 2 questions in a single message
- If the user gives a detailed answer that covers multiple questions, skip the ones already answered
- If the user says "that's it" or "nothing else" or seems done, stop asking and confirm
- Keep your tone professional but warm, like a helpful colleague
- After gathering everything, send a final confirmation message summarizing the plan
- Total conversation should be 5-8 exchanges, not more
- If the user's very first message is already detailed (200+ characters), skip most questions and just confirm

WHEN YOU HAVE ENOUGH INFORMATION, end your response with exactly this format (after your conversational sign-off):

---INTAKE COMPLETE---
{
  "topic": "...",
  "audience": "...",
  "language": "...",
  "slide_count": "...",
  "sections": ["...", "..."],
  "key_data": ["...", "..."],
  "tone": "...",
  "special_requests": "...",
  "full_brief": "A comprehensive paragraph combining all gathered info into a detailed prompt for the Interpreter Agent"
}
---END---

The full_brief field is the most important — it should read like a detailed, specific presentation request that incorporates every piece of information the user provided."""


INTERPRETER_SYSTEM_PROMPT = """You are the InvesCore Slide Studio Interpreter. Convert a presentation brief into a structured slide plan for a professional Mongolian real estate and investment company.

IMPORTANT — OUTPUT FORMAT:
Return ONLY valid JSON, no markdown fences, no explanation. The schema:

{
  "presentation_title": "TITLE IN CAPS",
  "sections": [
    {
      "name": "SECTION NAME IN CAPS",
      "slides": [
        {
          "slide_type": "content",
          "title": "SLIDE TITLE",
          "description": "Detailed description of what this slide shows, what layout works best, what visual elements to include. Be specific. This directly guides the Builder Agent that will write python-pptx code.",
          "content_spec": {
            "layout": "metric_callout | two_column | table_focus | chart_focus | timeline | comparison | bullets | mixed | freeform",
            "elements": [
              { "type": "title", "text": "THE SLIDE TITLE" },
              { "type": "subtitle", "text": "Optional subtitle or section label" },
              { "type": "bullets", "items": ["Point 1", "Point 2", "Point 3"] },
              {
                "type": "table",
                "headers": ["Col A", "Col B", "Col C"],
                "rows": [["R1A","R1B","R1C"], ["R2A","R2B","R2C"]]
              },
              {
                "type": "chart",
                "chart_type": "bar | column | line | pie | stacked_bar",
                "title": "Chart Title",
                "categories": ["Cat1","Cat2","Cat3"],
                "series": [{"name": "Series1", "values": [10,20,30]}]
              },
              { "type": "metric", "value": "₮15.2B", "label": "Revenue", "delta": "+18% YoY" },
              { "type": "text_block", "heading": "Key Insight", "body": "..." },
              { "type": "callout", "text": "Important highlighted statement" },
              {
                "type": "comparison",
                "left": {"title": "Option A", "points": ["..."]},
                "right": {"title": "Option B", "points": ["..."]}
              },
              {
                "type": "timeline",
                "steps": [{"label": "Q1 2025", "description": "Phase 1 launch"}]
              },
              {
                "type": "diagram_description",
                "description": "Describe a visual: e.g. '3-step flow: Acquisition → Development → Exit, each in a dark navy box with connecting arrows'"
              }
            ]
          }
        },
        {
          "slide_type": "section_divider",
          "title": "SECTION TITLE",
          "description": "One-sentence overview of this section"
        }
      ]
    }
  ]
}

RULES:
1. Opening, agenda, and closing slides are automatic — do NOT include them
2. Define sections (max 8) — the agenda is auto-generated from them
3. Each section: 1–5 slides
4. Total: 5–20 content slides
5. Write ALL actual text, numbers, and data — be specific; use plausible InvesCore data
6. Choose the right visual for each slide's purpose:
   - Financial data → table or chart
   - KPIs / key numbers → metric_callout (big numbers, card layout)
   - Strategy / narrative → bullets or text_block
   - Process / phases → timeline or diagram_description
   - Side-by-side alternatives → comparison
   - Mixed data + commentary → mixed or two_column
7. Vary layouts — do not repeat the same layout on consecutive slides
8. The description field is critical — the Builder Agent reads it to decide how to lay out shapes
9. Support Mongolian (Cyrillic) content when language is Mongolian
10. Think like an investment analyst preparing a board-level presentation"""


BUILDER_SYSTEM_PROMPT = f"""You are the InvesCore Slide Studio Builder. You generate python-pptx code that creates the CONTENT AREA of a single PowerPoint slide.

SLIDE DIMENSIONS: 10 inches wide × 5.625 inches tall.

YOUR CONTENT AREA (stay strictly within these bounds):
  Top:    {_CONTENT_BOUNDS['top']} inches from slide top
  Bottom: {_CONTENT_BOUNDS['bottom']} inches from slide top
  Left:   {_CONTENT_BOUNDS['left']} inches from slide left
  Right:  {_CONTENT_BOUNDS['right']} inches from slide left
  → Working area ≈ {_CONTENT_BOUNDS['right'] - _CONTENT_BOUNDS['left']:.2f}" wide × {_CONTENT_BOUNDS['bottom'] - _CONTENT_BOUNDS['top']:.2f}" tall

The brand frame (header bar, logo, nav bar, page number) is already on the slide — do NOT add these.

BRAND COLORS (use ONLY these):
  PRIMARY_DARK = RGBColor(0x3B, 0x3B, 0x3B)   # main text
  WHITE        = RGBColor(0xFF, 0xFF, 0xFF)    # text on dark bg
  ACCENT_RED   = RGBColor(0xC8, 0x10, 0x2E)   # emphasis only, use sparingly
  LIGHT_GRAY   = RGBColor(0xA0, 0xAC, 0xBD)   # secondary / labels
  DARK_NAVY    = RGBColor(0x0C, 0x29, 0x3B)   # dark card backgrounds
  MEDIUM_GRAY  = RGBColor(0x66, 0x66, 0x66)   # supporting text
  LIGHT_BG     = RGBColor(0xF5, 0xF5, 0xF5)   # subtle backgrounds
  BORDER_GRAY  = RGBColor(0xE0, 0xE0, 0xE0)   # borders / dividers

FONTS (Montserrat only):
  Section label  :  9 pt, Regular,  LIGHT_GRAY   (e.g. "EXECUTIVE SUMMARY")
  Slide title    : 13 pt, SemiBold, PRIMARY_DARK
  Subtitle       :  9 pt, Regular,  MEDIUM_GRAY
  Body / bullets :  7 pt, Regular,  PRIMARY_DARK
  Caption        :  6 pt, Regular,  MEDIUM_GRAY
  Big metric     : 22–28 pt, Bold,  DARK_NAVY or ACCENT_RED

QUALITY STANDARDS:
- Think like a McKinsey/Goldman designer — clear hierarchy, intentional whitespace
- Tables: dark navy header row (white text), alternating LIGHT_BG / WHITE rows
- Charts: brand colors for series, no gridlines unless essential, minimal axes
- Metrics: large font (22–28 pt), card background (LIGHT_BG), label in LIGHT_GRAY below
- Layouts must feel balanced — do not cram everything in
- No drop shadows, no 3D, no WordArt

OUTPUT FORMAT — return ONLY this Python function, no explanation, no markdown fences:

def build_content(slide, Inches, Pt, Emu, RGBColor):
    \"\"\"Build content area.\"\"\"
    from pptx.util import Inches, Pt
    from pptx.dml.color import RGBColor
    from pptx.enum.text import PP_ALIGN
    # ... your code ...

IMPORTANT:
- All imports must be INSIDE the function
- Use only: pptx, math, datetime, random, itertools, collections, decimal, statistics
- Do NOT use: os, sys, subprocess, open(), exec(), eval(), requests, socket, pathlib
- The function will be executed with exec() — it must be self-contained
- Shape type constant for rectangles: use 1 (MSO_SHAPE_TYPE.RECTANGLE equivalent)
- For charts, import from pptx.chart.data import ChartData and from pptx.enum.chart import XL_CHART_TYPE
- Always add a slide title text box as the very first element

EXAMPLE — metric callout slide:

def build_content(slide, Inches, Pt, Emu, RGBColor):
    from pptx.util import Inches, Pt
    from pptx.dml.color import RGBColor
    from pptx.enum.text import PP_ALIGN

    # Title
    tb = slide.shapes.add_textbox(Inches(0.57), Inches(1.35), Inches(7.5), Inches(0.40))
    tf = tb.text_frame
    p  = tf.paragraphs[0]
    r  = p.add_run()
    r.text = "KEY PERFORMANCE INDICATORS"
    r.font.name = "Montserrat"
    r.font.size = Pt(13)
    r.font.bold = True
    r.font.color.rgb = RGBColor(0x3B, 0x3B, 0x3B)

    metrics = [
        ("\\u20ae15.2B", "Revenue",      "+18% YoY"),
        ("23%",          "Market Share", "+2.1pp"),
        ("98.5%",        "Occupancy",    "-0.3pp"),
    ]
    card_w = Inches(2.50); card_h = Inches(2.60)
    gap    = Inches(0.18); top    = Inches(1.88); left0 = Inches(0.57)

    for i, (value, label, delta) in enumerate(metrics):
        left = left0 + i * (card_w + gap)
        bg = slide.shapes.add_shape(1, left, top, card_w, card_h)
        bg.fill.solid(); bg.fill.fore_color.rgb = RGBColor(0xF5, 0xF5, 0xF5)
        bg.line.fill.background()

        nb = slide.shapes.add_textbox(left+Inches(0.18), top+Inches(0.28), card_w-Inches(0.36), Inches(0.72))
        tf = nb.text_frame; p = tf.paragraphs[0]; r = p.add_run()
        r.text = value; r.font.name = "Montserrat"; r.font.size = Pt(26)
        r.font.bold = True; r.font.color.rgb = RGBColor(0x0C, 0x29, 0x3B)

        lb = slide.shapes.add_textbox(left+Inches(0.18), top+Inches(1.12), card_w-Inches(0.36), Inches(0.28))
        tf = lb.text_frame; p = tf.paragraphs[0]; r = p.add_run()
        r.text = label.upper(); r.font.name = "Montserrat"; r.font.size = Pt(7)
        r.font.color.rgb = RGBColor(0xA0, 0xAC, 0xBD)

        db = slide.shapes.add_textbox(left+Inches(0.18), top+Inches(1.52), card_w-Inches(0.36), Inches(0.25))
        tf = db.text_frame; p = tf.paragraphs[0]; r = p.add_run()
        r.text = delta; r.font.name = "Montserrat"; r.font.size = Pt(8)
        r.font.color.rgb = RGBColor(0xC8,0x10,0x2E) if delta.startswith("+") else RGBColor(0x66,0x66,0x66)"""


# ═════════════════════════════════════════════════════════════════════════════
# Helper — call Builder Agent (Opus)
# ═════════════════════════════════════════════════════════════════════════════

def _call_builder_agent(
    api_key: str,
    slide_spec: dict,
    presentation_title: str,
    section_name: str,
    all_sections: list[str],
) -> str:
    """
    Calls claude-opus-4-6 to generate a build_content() python-pptx function
    for a single content slide. Returns the raw code string.
    """
    client = anthropic.Anthropic(api_key=api_key)

    user_msg = f"""Generate build_content() for this slide:

PRESENTATION: {presentation_title}
SECTION: {section_name}
ALL SECTIONS: {', '.join(all_sections)}

SLIDE SPEC:
{json.dumps(slide_spec, indent=2, ensure_ascii=False)}

Return ONLY the Python function — no explanation, no markdown fences."""

    response = client.messages.create(
        model="claude-opus-4-6",
        max_tokens=16000,
        temperature=0.2,
        system=BUILDER_SYSTEM_PROMPT,
        messages=[{"role": "user", "content": user_msg}],
    )

    code = response.content[0].text.strip()
    # Strip markdown fences if present
    code = re.sub(r"^```python\s*", "", code)
    code = re.sub(r"^```\s*",       "", code)
    code = re.sub(r"\s*```$",       "", code)
    return code.strip()


# ═════════════════════════════════════════════════════════════════════════════
# SSE helper
# ═════════════════════════════════════════════════════════════════════════════

def _sse(event: str, data: Any = None) -> str:
    """Format a Server-Sent Event string."""
    line = f"event: {event}\n"
    line += f"data: {json.dumps(data) if data is not None else ''}\n\n"
    return line


def _run_intake_request(api_key: str, messages: list[dict]) -> str:
    client = anthropic.Anthropic(api_key=api_key)
    message = client.messages.create(
        model="claude-sonnet-4-6",
        max_tokens=2000,
        temperature=0.4,
        system=INTAKE_SYSTEM_PROMPT,
        messages=messages,
    )
    return message.content[0].text


def _run_interpreter_request(api_key: str, prompt: str):
    client = anthropic.Anthropic(api_key=api_key)
    with client.messages.stream(
        model="claude-sonnet-4-6",
        max_tokens=32000,
        temperature=0.3,
        system=INTERPRETER_SYSTEM_PROMPT,
        messages=[{"role": "user", "content": prompt}],
    ) as stream:
        raw = stream.get_final_text()
        usage = stream.get_final_message().usage
    return raw, usage


def _sanitize_download_filename(raw_title: str) -> str:
    cleaned = re.sub(r'[\x00-\x1f\x7f]+', "", raw_title).strip()
    cleaned = cleaned.replace("/", "-").replace("\\", "-").replace(":", " -")
    cleaned = re.sub(r"\s+", " ", cleaned)
    if not cleaned:
        cleaned = "Presentation"
    return f"InvesCore_{cleaned[:80]}.pptx"


def _artifact_file_path(artifact_id: str) -> Path:
    return TMP_DIR / f"{artifact_id}.pptx"


def _artifact_meta_path(artifact_id: str) -> Path:
    return TMP_DIR / f"{artifact_id}.json"


def _hash_download_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def _cleanup_expired_artifacts():
    TMP_DIR.mkdir(parents=True, exist_ok=True)
    current_ts = time.time()

    for meta_path in TMP_DIR.glob("*.json"):
        try:
            meta = json.loads(meta_path.read_text(encoding="utf-8"))
            expires_at = float(meta.get("expires_at", 0))
        except Exception:
            expires_at = 0

        artifact_id = meta_path.stem
        file_path = _artifact_file_path(artifact_id)
        if expires_at and expires_at > current_ts and file_path.exists():
            continue

        if file_path.exists():
            file_path.unlink()
        meta_path.unlink(missing_ok=True)


def _store_download_artifact(source_path: str, presentation_title: str) -> dict[str, str]:
    TMP_DIR.mkdir(parents=True, exist_ok=True)
    _cleanup_expired_artifacts()

    artifact_id = uuid.uuid4().hex
    download_token = secrets.token_urlsafe(32)
    filename = _sanitize_download_filename(presentation_title)
    artifact_path = _artifact_file_path(artifact_id)
    meta_path = _artifact_meta_path(artifact_id)

    shutil.move(source_path, artifact_path)
    metadata = {
        "filename": filename,
        "token_sha256": _hash_download_token(download_token),
        "created_at": time.time(),
        "expires_at": time.time() + ARTIFACT_TTL_SECONDS,
    }
    meta_path.write_text(json.dumps(metadata), encoding="utf-8")

    return {
        "artifact_id": artifact_id,
        "download_token": download_token,
        "filename": filename,
    }


# ═════════════════════════════════════════════════════════════════════════════
# ENDPOINTS
# ═════════════════════════════════════════════════════════════════════════════

@app.get("/api/health")
async def health():
    return {"status": "ok", "template": str(TEMPLATE_PATH.name), "version": "2.0.0"}


# ── Intake (unchanged) ─────────────────────────────────────────────────────────

@app.post("/api/intake")
async def intake_conversation(req: IntakeRequest):
    """Conversational intake agent."""
    if not req.api_key.startswith("sk-ant-"):
        raise HTTPException(400, "Invalid Anthropic API key format")
    if not req.messages:
        raise HTTPException(400, "messages cannot be empty")
    try:
        content = await asyncio.to_thread(
            _run_intake_request,
            req.api_key,
            req.messages,
        )
        return {"content": content}
    except anthropic.AuthenticationError:
        raise HTTPException(401, "Invalid API key")
    except anthropic.RateLimitError:
        raise HTTPException(429, "API rate limit exceeded")
    except Exception as e:
        raise HTTPException(500, f"Intake failed: {str(e)}")


# ── Interpret (upgraded prompt, same endpoint) ─────────────────────────────────

@app.post("/api/interpret")
async def interpret(req: InterpretRequest):
    """
    Interpreter Agent — converts brief into structured slide plan (v2 schema).
    """
    if not req.api_key.startswith("sk-ant-"):
        raise HTTPException(400, "Invalid Anthropic API key format")
    try:
        def _is_overloaded(exc: Exception) -> bool:
            s = str(exc).lower()
            return "overloaded" in s or (hasattr(exc, "status_code") and exc.status_code == 529)

        # Retry up to 3 times on overloaded errors with exponential backoff
        max_retries = 3
        last_exc: Exception | None = None
        for attempt in range(max_retries):
            try:
                raw, usage = await asyncio.to_thread(
                    _run_interpreter_request,
                    req.api_key,
                    req.prompt,
                )
                last_exc = None
                break  # success
            except Exception as e:
                if _is_overloaded(e) and attempt < max_retries - 1:
                    last_exc = e
                    await asyncio.sleep(5 * (attempt + 1))
                    continue
                raise
        if last_exc is not None:
            raise HTTPException(503, "Anthropic API is overloaded — please try again in a moment")

        raw = raw.strip()
        # Strip markdown fences
        raw = re.sub(r"^```json\s*", "", raw)
        raw = re.sub(r"^```\s*",     "", raw)
        raw = re.sub(r"\s*```$",     "", raw)
        raw = raw.strip()

        plan = json.loads(raw)

        # Count total content slides for cost estimate
        total_content = sum(
            len(sec.get("slides", []))
            for sec in plan.get("sections", [])
        )

        return {
            "presentation_title": plan.get("presentation_title", "Presentation"),
            "sections":           plan.get("sections", []),
            "token_usage": {
                "input_tokens":       usage.input_tokens,
                "output_tokens":      usage.output_tokens,
                "estimated_cost_usd": round(
                    (usage.input_tokens * 3 +
                     usage.output_tokens * 15) / 1_000_000, 4
                ),
            },
            "total_content_slides": total_content,
            "estimated_builder_cost_usd": round(
                total_content * (2000 * 15 + 3000 * 75) / 1_000_000, 2
            ),
        }

    except json.JSONDecodeError as e:
        raise HTTPException(500, f"Interpreter returned invalid JSON: {e}")
    except anthropic.AuthenticationError:
        raise HTTPException(401, "Invalid API key")
    except anthropic.RateLimitError:
        raise HTTPException(429, "API rate limit exceeded")
    except Exception as e:
        if "overloaded" in str(e).lower() or (hasattr(e, "status_code") and e.status_code == 529):
            raise HTTPException(503, "Anthropic API is overloaded — please try again in a moment")
        raise HTTPException(500, f"Interpretation failed: {str(e)}")


# ── V1 Generate (unchanged — kept for backwards compat) ────────────────────────

@app.post("/api/generate")
async def generate(req: GenerateRequest):
    """V1: Generate .pptx from flat slide_plan (clone + text swap)."""
    if not req.api_key.startswith("sk-ant-"):
        raise HTTPException(400, "Invalid Anthropic API key format")
    if not req.slide_plan:
        raise HTTPException(400, "slide_plan cannot be empty")
    try:
        engine = InvescoreTemplateEngine(str(TEMPLATE_PATH), str(BRAND_GUIDE_PATH))
        output_path = engine.create_presentation(req.slide_plan)

        title = "presentation"
        if req.slide_plan and req.slide_plan[0].get("content", {}).get("presentation_title"):
            raw   = req.slide_plan[0]["content"]["presentation_title"]
            title = raw[:40].replace("/", "-").replace("\\", "-").replace(" ", "_")

        filename = f"InvesCore_{title}.pptx"
        return FileResponse(
            path        = output_path,
            media_type  = "application/vnd.openxmlformats-officedocument.presentationml.presentation",
            filename    = filename,
            background  = None,
        )
    except ValueError as e:
        raise HTTPException(400, str(e))
    except Exception as e:
        raise HTTPException(500, f"Generation failed: {str(e)}")


# ── V2 Generate — SSE streaming, Builder Agent per slide ──────────────────────

@app.post("/api/generate_v2")
async def generate_v2(req: GenerateV2Request):
    """
    V2: Hybrid generate with per-slide Builder Agent calls.
    Streams Server-Sent Events so the frontend can show per-slide progress.

    Event types:
      interpreting          — starting (no data)
      building_slide        — {current, total, title}
      slide_error           — {slide_index, title, error}  (non-fatal)
      finalizing            — assembling .pptx (no data)
      done                  — {artifact_id, download_token, filename, warning_count}
      error                 — {message}    (fatal, stream ends)
    """
    if not req.api_key.startswith("sk-ant-"):
        raise HTTPException(400, "Invalid Anthropic API key format")
    if not req.slide_plan:
        raise HTTPException(400, "slide_plan cannot be empty")

    slide_plan = req.slide_plan
    api_key    = req.api_key

    async def event_stream() -> AsyncGenerator[str, None]:
        try:
            yield _sse("interpreting")

            # ── Collect all content slides ────────────────────────────────
            all_sections   = [s["name"] for s in slide_plan.get("sections", [])]
            content_slides = []   # (section_name, slide_spec, content_idx)
            for section in slide_plan.get("sections", []):
                for slide_spec in section.get("slides", []):
                    if slide_spec.get("slide_type", "content") == "content":
                        content_slides.append(
                            (section["name"], slide_spec, len(content_slides))
                        )

            total = len(content_slides)
            content_code_map: dict[int, str] = {}
            builder_failures: set[int] = set()

            # ── Call Builder Agent for each content slide ─────────────────
            for current_num, (section_name, slide_spec, cidx) in enumerate(
                content_slides, start=1
            ):
                title = slide_spec.get("title", f"Slide {current_num}")
                yield _sse("building_slide", {
                    "current": current_num,
                    "total":   total,
                    "title":   title,
                })

                try:
                    code = await asyncio.to_thread(
                        _call_builder_agent,
                        api_key            = api_key,
                        slide_spec         = slide_spec,
                        presentation_title = slide_plan.get("presentation_title", ""),
                        section_name       = section_name,
                        all_sections       = all_sections,
                    )
                    print(f"[main] slide {current_num}/{total} OK — {len(code)} chars — '{title}'")
                    content_code_map[cidx] = code
                except Exception as build_err:
                    print(f"[main] Builder Agent FAILED for slide {current_num}/{total} "
                          f"section='{section_name}' title='{title}': {build_err}")
                    builder_failures.add(cidx)
                    yield _sse("slide_error", {
                        "slide_index": cidx,
                        "title":       title,
                        "error":       str(build_err),
                    })
                    # Fallback: empty string → engine will use fallback title
                    content_code_map[cidx] = ""

            # ── Assemble .pptx ────────────────────────────────────────────
            yield _sse("finalizing")

            engine = InvescoreTemplateEngine(str(TEMPLATE_PATH), str(BRAND_GUIDE_PATH))
            output_path, engine_warnings = await asyncio.to_thread(
                engine.create_presentation_v2,
                slide_plan,
                content_code_map,
            )

            warning_ids = set(builder_failures)
            for warning in engine_warnings:
                warning_idx = warning.get("builder_index")
                if warning_idx in warning_ids:
                    continue
                warning_ids.add(warning_idx)
                yield _sse("slide_error", {
                    "slide_index": warning_idx,
                    "title": warning.get("title"),
                    "error": warning.get("message"),
                })

            artifact = await asyncio.to_thread(
                _store_download_artifact,
                output_path,
                slide_plan.get("presentation_title", "Presentation"),
            )

            yield _sse("done", {
                "artifact_id": artifact["artifact_id"],
                "download_token": artifact["download_token"],
                "filename": artifact["filename"],
                "warning_count": len(warning_ids),
            })

        except anthropic.AuthenticationError:
            yield _sse("error", {"message": "Invalid API key"})
        except anthropic.RateLimitError:
            yield _sse("error", {"message": "API rate limit exceeded"})
        except Exception as e:
            yield _sse("error", {"message": str(e)})

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control":             "no-cache",
            "X-Accel-Buffering":         "no",
            "Access-Control-Allow-Origin": "*",
        },
    )


# ── Download endpoint (serves the assembled .pptx after SSE done) ─────────────

@app.get("/api/download/{artifact_id}")
async def download(artifact_id: str, x_download_token: str | None = Header(default=None)):
    """Serve a generated .pptx file via an opaque artifact id and download token."""
    _cleanup_expired_artifacts()

    if not re.fullmatch(r"[0-9a-f]{32}", artifact_id):
        raise HTTPException(400, "Invalid artifact id")
    if not x_download_token:
        raise HTTPException(401, "Missing download token")

    meta_path = _artifact_meta_path(artifact_id)
    file_path = _artifact_file_path(artifact_id)
    if not meta_path.exists() or not file_path.exists():
        raise HTTPException(404, "File not found — may have expired")

    try:
        metadata = json.loads(meta_path.read_text(encoding="utf-8"))
    except Exception as exc:
        raise HTTPException(500, f"Failed to read artifact metadata: {exc}")

    if float(metadata.get("expires_at", 0)) <= time.time():
        file_path.unlink(missing_ok=True)
        meta_path.unlink(missing_ok=True)
        raise HTTPException(404, "File not found — may have expired")

    expected_hash = metadata.get("token_sha256", "")
    presented_hash = _hash_download_token(x_download_token)
    if not secrets.compare_digest(expected_hash, presented_hash):
        raise HTTPException(403, "Invalid download token")

    return FileResponse(
        path=str(file_path),
        media_type="application/vnd.openxmlformats-officedocument.presentationml.presentation",
        filename=metadata.get("filename", f"{artifact_id}.pptx"),
    )


# ── Entry point ────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
