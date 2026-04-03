"""
InvesCore Slide Studio — Template Engine v2
Uses ZIP-level slide manipulation for reliable cloning.
"""
import json, os, copy, shutil, tempfile, zipfile, re
from lxml import etree
from pptx import Presentation
from pptx.util import Pt
from pptx.oxml.ns import qn


# XML namespaces used in pptx files
NS_REL = "http://schemas.openxmlformats.org/package/2006/relationships"
NS_PML = "http://schemas.openxmlformats.org/presentationml/2006/main"
NS_RID = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"


class InvescoreTemplateEngine:
    def __init__(self, template_path: str, brand_guide_path: str):
        self.template_path = template_path
        with open(brand_guide_path, encoding="utf-8") as f:
            self.brand = json.load(f)
        self.category_map = {s["category"]: s for s in self.brand["slides"]}

    # ── Public API ──────────────────────────────────────────────────────────────

    def create_presentation(self, slide_plan: list[dict]) -> str:
        """
        Creates a new .pptx by cloning slides from the master template.
        Returns path to the output file (caller should delete after use).

        slide_plan: [{"template": "opening", "content": {...}}, ...]
        """
        # Resolve source slide indices for each plan entry
        source_indices = []
        for spec in slide_plan:
            cat = spec["template"]
            if cat not in self.category_map:
                raise ValueError(f"Unknown template: '{cat}'. Available: {list(self.category_map)}")
            source_indices.append(self.category_map[cat]["index"])

        # Build the output .pptx via ZIP manipulation
        output_path = self._build_pptx_via_zip(source_indices)

        # Apply text content replacements
        prs = Presentation(output_path)
        for i, (spec, slide) in enumerate(zip(slide_plan, prs.slides)):
            self._apply_content(slide, spec["template"], spec.get("content", {}))
        prs.save(output_path)

        return output_path

    def create_presentation_to_file(self, slide_plan: list[dict], output_path: str):
        """Create presentation and save to output_path."""
        tmp = self.create_presentation(slide_plan)
        shutil.move(tmp, output_path)

    # ── ZIP-level slide builder ─────────────────────────────────────────────────

    def _build_pptx_via_zip(self, source_indices: list[int]) -> str:
        """
        Core engine: opens the template ZIP, duplicates slides as needed,
        produces a new .pptx with exactly the requested slides in order.
        Returns path to temp output file.
        """
        with zipfile.ZipFile(self.template_path, 'r') as src_zip:
            # 1. Parse presentation.xml to get the slide rId list
            prs_xml_bytes = src_zip.read('ppt/presentation.xml')
            prs_xml = etree.fromstring(prs_xml_bytes)

            prs_rels_bytes = src_zip.read('ppt/_rels/presentation.xml.rels')
            prs_rels = etree.fromstring(prs_rels_bytes)

            # Map rId → Target (e.g. 'slides/slide1.xml')
            rId_to_target = {}
            for rel in prs_rels.findall(f'{{{NS_REL}}}Relationship'):
                rId_to_target[rel.get('Id')] = rel.get('Target')

            # Get ordered list of slide rIds from presentation.xml
            sldIdLst = prs_xml.find(f'.//{{{NS_PML}}}sldIdLst')
            original_slide_rids = []
            for sldId in sldIdLst.findall(f'{{{NS_PML}}}sldId'):
                rid = sldId.get(f'{{{NS_RID}}}id')
                original_slide_rids.append(rid)

            # Map slide index → file in ZIP (e.g. 'ppt/slides/slide1.xml')
            # The targets are relative to ppt/, so prepend 'ppt/'
            def target_to_zip_path(target):
                # target is like 'slides/slide3.xml' → 'ppt/slides/slide3.xml'
                return 'ppt/' + target.lstrip('/')

            original_slide_zippaths = [
                target_to_zip_path(rId_to_target[rid])
                for rid in original_slide_rids
            ]

            # 2. For each source index, get the slide zippath
            # source_indices are 0-based slide indices in the template
            desired_zippaths = [original_slide_zippaths[i] for i in source_indices]

            # 3. Build the new ZIP in memory
            with tempfile.NamedTemporaryFile(suffix='.pptx', delete=False) as tmp_f:
                tmp_path = tmp_f.name

            # We need to:
            # a) Copy all non-slide content from source (layouts, masters, media, etc.)
            # b) Include only the desired slide XML files (possibly duplicated)
            # c) Update presentation.xml and its .rels to reference only our slides

            # Collect all non-slide files
            slide_pattern = re.compile(r'^ppt/slides/slide\d+\.xml$')
            slide_rels_pattern = re.compile(r'^ppt/slides/_rels/slide\d+\.xml\.rels$')

            with zipfile.ZipFile(tmp_path, 'w', zipfile.ZIP_DEFLATED) as dst_zip:
                # Copy all non-slide files verbatim
                for name in src_zip.namelist():
                    if name in ('ppt/presentation.xml', 'ppt/_rels/presentation.xml.rels'):
                        continue  # we'll write these ourselves
                    if slide_pattern.match(name) or slide_rels_pattern.match(name):
                        continue  # we'll write these ourselves
                    dst_zip.writestr(name, src_zip.read(name))

                # Write the desired slides with NEW sequential names
                new_slide_rids = []
                new_slide_targets = []
                used_names = {}  # original zippath → count (for deduplication)

                for i, src_zippath in enumerate(desired_zippaths):
                    new_slide_num = i + 1
                    new_name = f'ppt/slides/slide{new_slide_num}.xml'
                    new_rels_name = f'ppt/slides/_rels/slide{new_slide_num}.xml.rels'
                    new_target = f'slides/slide{new_slide_num}.xml'

                    # Copy slide XML
                    dst_zip.writestr(new_name, src_zip.read(src_zippath))

                    # Copy slide .rels (if exists)
                    src_rels_path = src_zippath.replace(
                        'ppt/slides/', 'ppt/slides/_rels/') + '.rels'
                    if src_rels_path in src_zip.namelist():
                        dst_zip.writestr(new_rels_name, src_zip.read(src_rels_path))

                    new_slide_targets.append(new_target)
                    new_slide_rids.append(f'rId_slide{new_slide_num}')

                # Write updated presentation.xml
                new_prs_xml = self._update_presentation_xml(
                    prs_xml, new_slide_rids)
                dst_zip.writestr('ppt/presentation.xml',
                                 etree.tostring(new_prs_xml, xml_declaration=True,
                                                encoding='UTF-8', standalone=True))

                # Write updated presentation.xml.rels
                new_prs_rels = self._update_presentation_rels(
                    prs_rels, new_slide_rids, new_slide_targets)
                dst_zip.writestr('ppt/_rels/presentation.xml.rels',
                                 etree.tostring(new_prs_rels, xml_declaration=True,
                                                encoding='UTF-8', standalone=True))

        return tmp_path

    def _update_presentation_xml(self, original_xml, new_rids: list[str]):
        """Replace sldIdLst in presentation.xml with new slide references."""
        xml = copy.deepcopy(original_xml)
        sldIdLst = xml.find(f'.//{{{NS_PML}}}sldIdLst')
        if sldIdLst is None:
            return xml

        # Remove existing sldId elements
        for child in list(sldIdLst):
            sldIdLst.remove(child)

        # Add new ones
        for i, rId in enumerate(new_rids):
            sldId_elem = etree.SubElement(sldIdLst, f'{{{NS_PML}}}sldId')
            sldId_elem.set('id', str(256 + i))  # IDs start at 256 conventionally
            sldId_elem.set(f'{{{NS_RID}}}id', rId)

        return xml

    def _update_presentation_rels(self, original_rels, new_rids: list[str],
                                  new_targets: list[str]):
        """Replace slide relationships in presentation.xml.rels."""
        # Deep copy to avoid modifying original
        rels = copy.deepcopy(original_rels)

        # Find the SLIDE relationship type
        SLIDE_REL_TYPE = ('http://schemas.openxmlformats.org/officeDocument/2006/'
                          'relationships/slide')

        # Remove all existing slide relationships
        for rel in list(rels.findall(f'{{{NS_REL}}}Relationship')):
            if rel.get('Type') == SLIDE_REL_TYPE:
                rels.remove(rel)

        # Add new slide relationships
        for rId, target in zip(new_rids, new_targets):
            rel_elem = etree.SubElement(rels, f'{{{NS_REL}}}Relationship')
            rel_elem.set('Id', rId)
            rel_elem.set('Type', SLIDE_REL_TYPE)
            rel_elem.set('Target', target)

        return rels

    # ── Content replacement ─────────────────────────────────────────────────────

    def _apply_content(self, slide, category: str, content: dict):
        """Replace dynamic text fields in the slide."""
        if category not in self.category_map:
            return
        slide_info = self.category_map[category]

        for field in slide_info.get("dynamic_fields", []):
            field_name = field["name"]
            shape_id = field.get("shape_id")

            if field_name not in content:
                continue

            new_text = str(content[field_name])
            shape = self._find_shape_by_id(slide, shape_id)
            if shape and shape.has_text_frame:
                self._set_text_preserving_format(shape, new_text)

    def _find_shape_by_id(self, slide, shape_id: int):
        for shape in slide.shapes:
            if shape.shape_id == shape_id:
                return shape
        return None

    def _set_text_preserving_format(self, shape, new_text: str):
        """Replace text preserving original font/size/color/alignment."""
        if not shape.has_text_frame:
            return

        tf = shape.text_frame
        lines = new_text.split("|")

        # Capture first paragraph's first run for format reference
        ref_run_xml = None
        ref_para_xml = None
        if tf.paragraphs and tf.paragraphs[0].runs:
            ref_run_xml = copy.deepcopy(tf.paragraphs[0].runs[0]._r)
        if tf.paragraphs:
            ref_para_xml = copy.deepcopy(tf.paragraphs[0]._p)

        # Clear all extra paragraphs (keep only the first)
        txBody = tf._txBody
        paras = txBody.findall(qn('a:p'))
        for p in paras[1:]:
            txBody.remove(p)

        # Set line 0 in the first paragraph
        first_para = tf.paragraphs[0]
        self._set_paragraph_text(first_para, lines[0], ref_run_xml)

        # Add additional lines as new paragraphs
        for line in lines[1:]:
            if ref_para_xml is not None:
                new_p = copy.deepcopy(ref_para_xml)
                # Clear all runs from cloned paragraph
                for r in new_p.findall(qn('a:r')):
                    new_p.remove(r)
            else:
                new_p = etree.SubElement(txBody, qn('a:p'))

            # Add a run with the line text
            if ref_run_xml is not None:
                new_r = copy.deepcopy(ref_run_xml)
            else:
                new_r = etree.SubElement(new_p, qn('a:r'))

            t_elem = new_r.find(qn('a:t'))
            if t_elem is None:
                t_elem = etree.SubElement(new_r, qn('a:t'))
            t_elem.text = line
            new_p.append(new_r)
            txBody.append(new_p)

    def _set_paragraph_text(self, para, text: str, ref_run_xml=None):
        """Set text of a single paragraph, preserving run formatting."""
        # Remove extra runs
        runs = para.runs
        for run in runs[1:]:
            run._r.getparent().remove(run._r)

        if runs:
            runs[0].text = text
        else:
            # No runs — add one
            p_elem = para._p
            if ref_run_xml is not None:
                new_r = copy.deepcopy(ref_run_xml)
                t = new_r.find(qn('a:t'))
                if t is None:
                    t = etree.SubElement(new_r, qn('a:t'))
                t.text = text
                p_elem.append(new_r)
            else:
                new_r = etree.SubElement(p_elem, qn('a:r'))
                t = etree.SubElement(new_r, qn('a:t'))
                t.text = text

    # ── Utility ─────────────────────────────────────────────────────────────────

    def get_available_categories(self) -> list[str]:
        return [s["category"] for s in self.brand["slides"]]

    def get_category_info(self, category: str) -> dict:
        return self.category_map.get(category, {})


if __name__ == "__main__":
    import sys
    sys.stdout.reconfigure(encoding='utf-8')
    PROJECT = r"C:\Users\uilstbadrakh\OneDrive - InvesCore\Desktop\Invescore Slide Generator"
    engine = InvescoreTemplateEngine(
        os.path.join(PROJECT, "training", "InvesCore_Master_Template.pptx"),
        os.path.join(PROJECT, "backend", "brand_guide.json")
    )
    print("Available categories:", engine.get_available_categories())
    print("Template engine v2 loaded successfully.")
