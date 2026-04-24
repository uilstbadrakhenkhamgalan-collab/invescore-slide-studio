"""
Isolated worker for rendering a single AI-generated content slide.
"""
import json
import sys
from contextlib import redirect_stdout

from pptx import Presentation

from template_engine import InvescoreTemplateEngine


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: slide_builder_worker.py <task.json>", file=sys.stderr)
        return 2

    task_path = sys.argv[1]
    with open(task_path, encoding="utf-8") as fh:
        task = json.load(fh)

    engine = InvescoreTemplateEngine(
        task["template_path"],
        task["brand_guide_path"],
    )

    with redirect_stdout(sys.stderr):
        prs = Presentation(task["source_path"])
        slide = prs.slides[task["slide_index"]]
        warning = engine._apply_ai_content_to_slide(
            slide,
            section_name=task["section_name"],
            all_sections=task["all_sections"],
            page_number=task["page_number"],
            slide_title=task["slide_title"],
            code=task["code"],
            slide_label=task["slide_label"],
        )
        prs.save(task["output_path"])

    print(json.dumps({"warning": warning}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
