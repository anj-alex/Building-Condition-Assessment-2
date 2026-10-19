#!/usr/bin/env python3
"""Extract deterministic BCA capital-planning reference data from the sample workbook.

Usage:
  python3 scripts/extract-bca-reference-data.py
  python3 scripts/extract-bca-reference-data.py --check
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import re
import sys
import zipfile
import xml.etree.ElementTree as ET
from decimal import Decimal, ROUND_HALF_UP
from pathlib import Path

NS = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
REL_NS = {
    "r": "http://schemas.openxmlformats.org/package/2006/relationships",
    "pr": "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
}

ROOT = Path(__file__).resolve().parents[1]
WORKBOOK = ROOT / "samples" / "Asset-List_ASHC-Lodge-South-BCA_Worksheet_draft_v1.xlsx"
OUT_PRICING = ROOT / "data" / "uniformat_pricing.csv"
PRICING_SUPPLEMENT = ROOT / "data" / "uniformat_pricing_supplement.csv"
OUT_LOCATION = ROOT / "data" / "location_factors.csv"
OUT_RULES = ROOT / "data" / "capital_planning_rules.json"

COL_RE = re.compile(r"^([A-Z]+)(\d+)$")

PRICING_FIELDS = [
    "Uni-Format Pricing ID",
    "Level 1",
    "Level 1 Description",
    "Level 2",
    "Level 2 Description",
    "Level 3",
    "Level 3 Description",
    "Level 4",
    "Level 4 Description",
    "Material",
    "Mean Service Life (yrs)",
    "Practical Life (yrs)",
    "Unit Price",
    "Unit of Measure",
]

# Workbook formula templates we must continue to match.
EXPECTED_FORMULAS = {
    "remaining_life": 'IF(W4="",0,Y4-X4+AA4)',
    "replacement_year": 'IF(Z4="","",Legend!$B$2+Worksheet!Z4)',
    "action_year": 'IF(AC4="",AB4,AC4)',
    "absolute_life": 'IF(AD4="",Y4,AD4)',
    "unit_cost": (
        "IF(AI4<100,ROUND(AI4*VLOOKUP(C4,Legend!$A$4:$F$50,6,FALSE),0),"
        "IF(AI4<1000,ROUND(AI4*VLOOKUP(C4,Legend!$A$4:$F$50,6,FALSE),-1),"
        "ROUND(AI4*VLOOKUP(C4,Legend!$A$4:$F$50,6,FALSE),-2)))"
    ),
    "opc": "IF(AJ4*AH4>1000000,ROUND(AJ4*AH4,-3),ROUND(AJ4*AH4,-2))",
}

EXPECTED_FCI_FORMULAS = {
    "ifma": (
        'IF(AND(C39>0,C39<=0.025),"Very Good",'
        'IF(AND(C39>0.025,C39<=0.05),"Good",'
        'IF(AND(C39>0.05,C39<=0.1),"Fair",'
        'IF(AND(C39>0.1,C39<=0.3),"Poor",'
        'IF(AND(C39>0.3),"Critical",IF(C39=0,"Very Good"))))))'
    ),
    "revised_0_5": (
        'IF(E39<0.15, "Good", IF(AND(E39>=0.15, E39<=0.4), '
        '"Fair", IF(E39>0.4, "Poor", "N/A")))'
    ),
}


def col_index(letters: str) -> int:
    n = 0
    for ch in letters:
        n = n * 26 + (ord(ch) - 64)
    return n


def parse_ref(ref: str) -> tuple[str, int]:
    match = COL_RE.match(ref)
    if not match:
        raise ValueError(f"Bad cell ref: {ref}")
    return match.group(1), int(match.group(2))


def load_shared_strings(zf: zipfile.ZipFile) -> list[str]:
    if "xl/sharedStrings.xml" not in zf.namelist():
        return []
    root = ET.fromstring(zf.read("xl/sharedStrings.xml"))
    strings: list[str] = []
    for si in root.findall("m:si", NS):
        texts = [
            t.text or ""
            for t in si.iter("{http://schemas.openxmlformats.org/spreadsheetml/2006/main}t")
        ]
        strings.append("".join(texts))
    return strings


def sheet_targets(zf: zipfile.ZipFile) -> dict[str, str]:
    wb = ET.fromstring(zf.read("xl/workbook.xml"))
    rels = ET.fromstring(zf.read("xl/_rels/workbook.xml.rels"))
    rid_to_target = {
        rel.attrib["Id"]: rel.attrib["Target"]
        for rel in rels.findall("r:Relationship", REL_NS)
    }
    sheets: dict[str, str] = {}
    for sheet in wb.findall("m:sheets/m:sheet", NS):
        name = sheet.attrib["name"]
        rid = sheet.attrib[
            "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id"
        ]
        target = rid_to_target[rid]
        if not target.startswith("xl/"):
            target = "xl/" + target.lstrip("/")
        sheets[name] = target
    return sheets


def cell_value(cell: ET.Element, shared: list[str]) -> str | None:
    cell_type = cell.attrib.get("t")
    value_el = cell.find("m:v", NS)
    inline = cell.find("m:is", NS)
    if cell_type == "s" and value_el is not None and value_el.text is not None:
        return shared[int(value_el.text)]
    if cell_type == "inlineStr" and inline is not None:
        return "".join(
            t.text or ""
            for t in inline.iter(
                "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}t"
            )
        )
    if value_el is not None and value_el.text is not None:
        return value_el.text
    return None


def cell_formula(cell: ET.Element) -> str | None:
    formula = cell.find("m:f", NS)
    return formula.text if formula is not None else None


def read_sheet_rows(
    zf: zipfile.ZipFile, target: str, shared: list[str]
) -> dict[int, dict[int, tuple[str | None, str | None]]]:
    root = ET.fromstring(zf.read(target))
    rows: dict[int, dict[int, tuple[str | None, str | None]]] = {}
    for cell in root.iter("{http://schemas.openxmlformats.org/spreadsheetml/2006/main}c"):
        ref = cell.attrib.get("r")
        if not ref:
            continue
        letters, row = parse_ref(ref)
        rows.setdefault(row, {})[col_index(letters)] = (
            cell_value(cell, shared),
            cell_formula(cell),
        )
    return rows


def normalize_price(raw: str | None) -> str | None:
    if raw is None:
        return None
    text = str(raw).strip()
    if not text:
        return None
    # Preserve assessor-selected ranges / blanks as non-numeric catalogue text.
    if re.search(r"[a-zA-Z]| to |–|—", text, re.IGNORECASE) or "-" in text and not re.fullmatch(
        r"-?\d+(\.\d+)?", text
    ):
        if text.startswith("$"):
            return text
        if " to " in text.lower() or "–" in text or "—" in text:
            return text if text.startswith("$") else f"${text.lstrip('$')}"
        return text
    cleaned = text.replace("$", "").replace(",", "").strip()
    try:
        number = Decimal(cleaned)
    except Exception:
        return text
    quantized = number.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
    # Keep trailing zeros only when needed for two-decimal money values.
    if quantized == quantized.to_integral():
        return f"${quantized.to_integral()}"
    return f"${quantized}"


def format_index(value: str | None) -> str:
    if value is None or value == "":
        return ""
    number = Decimal(str(value))
    quantized = number.quantize(Decimal("0.1"), rounding=ROUND_HALF_UP)
    text = format(quantized, "f")
    if text.endswith(".0"):
        return text[:-2]
    return text


def format_factor(value: str | None) -> str:
    if value is None or value == "":
        return ""
    # Prefer total/100 when present; otherwise derive from total index.
    number = Decimal(str(value))
    quantized = (number).quantize(Decimal("0.001"), rounding=ROUND_HALF_UP)
    text = format(quantized, "f").rstrip("0").rstrip(".")
    return text or "0"


# The workbook title-cases its UNIFORMAT descriptions, which turns acronyms into
# ordinary words ("Hvac"). The client asked for the acronyms back, so restore
# them here rather than by hand-editing the generated CSV.
ACRONYMS = ("HVAC",)


def restore_acronyms(value: str) -> str:
    for acronym in ACRONYMS:
        value = re.sub(rf"\b{acronym}\b", acronym, value, flags=re.IGNORECASE)
    return value


def extract_pricing(rows: dict[int, dict[int, tuple[str | None, str | None]]]) -> list[dict]:
    records: list[dict] = []
    for row_num in sorted(rows):
        if row_num < 3:
            continue
        cells = rows[row_num]
        pricing_id = (cells.get(1, (None, None))[0] or "").strip()
        if not pricing_id:
            continue
        mean = cells.get(11, (None, None))[0]
        practical = cells.get(12, (None, None))[0]
        unit_price = normalize_price(cells.get(13, (None, None))[0])
        records.append(
            {
                "Uni-Format Pricing ID": pricing_id,
                "Level 1": (cells.get(2, (None, None))[0] or "").strip(),
                "Level 1 Description": restore_acronyms((cells.get(3, (None, None))[0] or "").strip()),
                "Level 2": (cells.get(4, (None, None))[0] or "").strip(),
                "Level 2 Description": restore_acronyms((cells.get(5, (None, None))[0] or "").strip()),
                "Level 3": (cells.get(6, (None, None))[0] or "").strip(),
                "Level 3 Description": restore_acronyms((cells.get(7, (None, None))[0] or "").strip()),
                "Level 4": (cells.get(8, (None, None))[0] or "").strip(),
                "Level 4 Description": restore_acronyms((cells.get(9, (None, None))[0] or "").strip()),
                "Material": restore_acronyms((cells.get(10, (None, None))[0] or "").strip()),
                "Mean Service Life (yrs)": "" if mean in (None, "") else str(int(Decimal(mean))),
                "Practical Life (yrs)": (
                    "" if practical in (None, "") else str(int(Decimal(practical)))
                ),
                "Unit Price": unit_price or "",
                "Unit of Measure": (cells.get(14, (None, None))[0] or "").strip(),
            }
        )
    return records


def read_pricing_supplement() -> list[dict]:
    if not PRICING_SUPPLEMENT.exists():
        raise SystemExit(f"Missing pricing supplement: {PRICING_SUPPLEMENT}")
    with PRICING_SUPPLEMENT.open(encoding="utf-8", newline="") as handle:
        reader = csv.DictReader(handle)
        if reader.fieldnames != PRICING_FIELDS:
            raise SystemExit(
                "Pricing supplement headers must exactly match uniformat_pricing.csv"
            )
        records = []
        for source_row, row in enumerate(reader, start=2):
            record = {field: (row.get(field) or "").strip() for field in PRICING_FIELDS}
            if not record["Uni-Format Pricing ID"]:
                continue
            for required in PRICING_FIELDS[:10]:
                if not record[required]:
                    raise SystemExit(
                        f"Pricing supplement row {source_row} is missing {required}"
                    )
            records.append(record)
    return records


def extract_location_factors(
    rows: dict[int, dict[int, tuple[str | None, str | None]]]
) -> list[dict]:
    records: list[dict] = []
    for row_num in range(109, 183):
        cells = rows.get(row_num, {})
        province = (cells.get(1, (None, None))[0] or "").strip()
        city = (cells.get(2, (None, None))[0] or "").strip()
        if not province or not city:
            continue
        material = cells.get(3, (None, None))[0]
        installation = cells.get(4, (None, None))[0]
        total = cells.get(5, (None, None))[0]
        factor_raw = cells.get(6, (None, None))[0]
        if factor_raw in (None, "") and total not in (None, ""):
            factor_raw = str(Decimal(total) / Decimal("100"))
        records.append(
            {
                "province": province,
                "city": city,
                "material_index": format_index(material),
                "installation_index": format_index(installation),
                "total_index": format_index(total),
                "factor": format_factor(factor_raw),
            }
        )
    return records


def capital_planning_rules() -> dict:
    return {
        "source": {
            "workbook": "samples/Asset-List_ASHC-Lodge-South-BCA_Worksheet_draft_v1.xlsx",
            "notes": [
                "Costs are constant assessment-year dollars; workbook inflation cell is unused.",
                "CRV uses the seven workbook soft-cost factors (86% uplift), not the PDF's extra 14%.",
                "Default building location factor in the app is 1.0 (neutral), not a sample site factor.",
            ],
        },
        "horizon": {
            "offsets": list(range(0, 26)),
            "label": "assessment year through +25 years (26 year columns)",
        },
        "terms": [
            {"id": "immediate", "label": "Immediate Term", "offset_from": 0, "offset_to": 0},
            {"id": "short", "label": "Short Term", "offset_from": 1, "offset_to": 2},
            {"id": "medium", "label": "Medium Term", "offset_from": 3, "offset_to": 5},
            {"id": "long", "label": "Long Term", "offset_from": 6, "offset_to": 10},
            {"id": "end_of_life", "label": "End of Life", "offset_from": 11, "offset_to": 25},
        ],
        "unit_cost_rounding": [
            {"max_exclusive": 100, "places": 0},
            {"max_exclusive": 1000, "places": -1},
            {"max_exclusive": None, "places": -2},
        ],
        "opc_rounding": {
            "threshold_exclusive": 1000000,
            "above_or_equal_places": -2,
            "above_threshold_places": -3,
            "note": "Workbook uses > 1000000 for thousands rounding; exactly 1000000 rounds to hundreds.",
        },
        "crv_uplift": {
            "profile": "workbook_86",
            "factors": [
                {"name": "Installation", "percent": 35},
                {"name": "Commissioning", "percent": 5},
                {"name": "Training", "percent": 1},
                {"name": "Engineering", "percent": 12},
                {"name": "Design Review", "percent": 3},
                {"name": "Contingency", "percent": 15},
                {"name": "Project Management", "percent": 15},
            ],
            "uplift_percent": 86,
            "multiplier": 1.86,
        },
        "fci": {
            "windows": [
                {"id": "years_0_2", "label": "Immediate + Short Term (0–2 years)", "offset_from": 0, "offset_to": 2, "grade_scale": "ifma"},
                {"id": "years_0_5", "label": "0–5 years", "offset_from": 0, "offset_to": 5, "grade_scale": "revised_0_5"},
                {"id": "years_0_10", "label": "0–10 years", "offset_from": 0, "offset_to": 10, "grade_scale": "ifma"},
                {"id": "years_0_25", "label": "End of Life (0–25 years)", "offset_from": 0, "offset_to": 25, "grade_scale": "ifma"},
            ],
            "grade_scales": {
                "ifma": [
                    {"max_inclusive": 0.025, "label": "Very Good"},
                    {"max_inclusive": 0.05, "label": "Good"},
                    {"max_inclusive": 0.10, "label": "Fair"},
                    {"max_inclusive": 0.30, "label": "Poor"},
                    {"max_inclusive": None, "label": "Critical"},
                ],
                "revised_0_5": [
                    {"max_exclusive": 0.15, "label": "Good"},
                    {"max_inclusive": 0.40, "label": "Fair"},
                    {"max_inclusive": None, "label": "Poor"},
                ],
            },
        },
        "condition_ratings": [
            {"score": 1, "stored_value": "Very good", "legacy_label": "Very Good", "letter": "A", "revised_label": "Excellent", "display": "A - Excellent"},
            {"score": 2, "stored_value": "Good", "legacy_label": "Good", "letter": "B", "revised_label": "Good", "display": "B - Good"},
            {"score": 3, "stored_value": "Fair", "legacy_label": "Fair", "letter": "C", "revised_label": "Acceptable", "display": "C - Acceptable"},
            {"score": 4, "stored_value": "Poor", "legacy_label": "Poor", "letter": "D", "revised_label": "Marginal", "display": "D - Marginal"},
            {"score": 5, "stored_value": "Very poor", "legacy_label": "Very Poor", "letter": "E", "revised_label": "Poor", "display": "E - Poor"},
            {"score": 6, "stored_value": "Critical", "legacy_label": "Critical", "letter": "F", "revised_label": "Critical", "display": "F - Critical"},
        ],
        "suppressed_actions": ["No Action"],
        "suppressed_terms": ["N/A"],
        "expected_counts": {
            "workbook_uniformat_pricing_rows": 1773,
            "supplement_uniformat_pricing_rows": 1,
            "location_factor_rows": 74,
        },
        "formula_templates": EXPECTED_FORMULAS,
    }


def render_csv(path_name: str, fieldnames: list[str], rows: list[dict]) -> str:
    lines: list[str] = []
    # Leading blank row preserves the existing Uniformat CSV contract.
    if path_name == "uniformat_pricing.csv":
        lines.append(",".join([""] * len(fieldnames)))
    buffer: list[str] = []

    class _Writer:
        def write(self, data: str) -> None:
            buffer.append(data)

    writer = csv.DictWriter(_Writer(), fieldnames=fieldnames, lineterminator="\n")
    writer.writeheader()
    for row in rows:
        writer.writerow(row)
    body = "".join(buffer)
    return "\n".join(lines + [body.rstrip("\n")]) + "\n"


def render_json(payload: dict) -> str:
    return json.dumps(payload, indent=2, sort_keys=False) + "\n"


def write_text(path: Path, text: str) -> str:
    path.write_text(text, encoding="utf-8")
    return sha256_text(text)


def sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def sha256_file(path: Path) -> str:
    return sha256_text(path.read_text(encoding="utf-8"))


def verify_formulas(worksheet_rows: dict[int, dict[int, tuple[str | None, str | None]]]) -> None:
    checks = {
        26: EXPECTED_FORMULAS["remaining_life"],
        28: EXPECTED_FORMULAS["replacement_year"],
        31: EXPECTED_FORMULAS["action_year"],
        32: EXPECTED_FORMULAS["absolute_life"],
        36: EXPECTED_FORMULAS["unit_cost"],
        37: EXPECTED_FORMULAS["opc"],
    }
    row = worksheet_rows.get(4, {})
    for col, expected in checks.items():
        actual = row.get(col, (None, None))[1]
        if actual != expected:
            raise SystemExit(
                f"Worksheet formula mismatch at column {col}: expected {expected!r}, got {actual!r}"
            )


def verify_rule_constants(
    legend_rows: dict[int, dict[int, tuple[str | None, str | None]]],
    fci_rows: dict[int, dict[int, tuple[str | None, str | None]]],
) -> None:
    """Keep hand-authored condition/FCI constants tied to the workbook legend."""
    rules = capital_planning_rules()
    for rating in rules["condition_ratings"]:
        workbook_row = 60 - rating["score"]
        cells = legend_rows.get(workbook_row, {})
        actual = {
            "score": int(cells.get(3, (0, None))[0] or 0),
            "legacy_label": cells.get(1, (None, None))[0],
            "letter": cells.get(4, (None, None))[0],
            "revised_label": cells.get(5, (None, None))[0],
            "display": cells.get(6, (None, None))[0],
        }
        expected = {
            key: rating[key]
            for key in ("score", "legacy_label", "letter", "revised_label", "display")
        }
        if actual != expected:
            raise SystemExit(
                f"Condition scale mismatch at Legend row {workbook_row}: "
                f"expected {expected!r}, got {actual!r}"
            )

    formula_checks = {
        (39, 4): EXPECTED_FCI_FORMULAS["ifma"],
        (39, 6): EXPECTED_FCI_FORMULAS["revised_0_5"],
    }
    for (row, col), expected in formula_checks.items():
        actual = fci_rows.get(row, {}).get(col, (None, None))[1]
        if actual != expected:
            raise SystemExit(
                f"FCI grade formula mismatch at row {row}, column {col}: "
                f"expected {expected!r}, got {actual!r}"
            )


def render_outputs() -> dict[str, str]:
    """Return name -> file text for a fresh extraction (no disk writes)."""
    if not WORKBOOK.exists():
        raise SystemExit(f"Missing workbook: {WORKBOOK}")

    with zipfile.ZipFile(WORKBOOK) as zf:
        shared = load_shared_strings(zf)
        sheets = sheet_targets(zf)
        pricing_rows = read_sheet_rows(zf, sheets["Uniformat Pricing"], shared)
        legend_rows = read_sheet_rows(zf, sheets["Legend"], shared)
        worksheet_rows = read_sheet_rows(zf, sheets["Worksheet"], shared)
        replacement_rows = read_sheet_rows(zf, sheets["Replacement Cost"], shared)
        fci_rows = read_sheet_rows(zf, sheets["FCI"], shared)

    verify_formulas(worksheet_rows)
    verify_rule_constants(legend_rows, fci_rows)

    # Soft-cost sanity check against Replacement Cost sheet.
    soft = []
    for row_num in range(1, 8):
        name = replacement_rows.get(row_num, {}).get(1, (None, None))[0]
        pct = replacement_rows.get(row_num, {}).get(2, (None, None))[0]
        if name and pct is not None:
            soft.append((name, Decimal(pct)))
    uplift = sum(pct for _, pct in soft)
    if uplift != Decimal("0.86"):
        raise SystemExit(f"Unexpected CRV uplift sum: {uplift}")

    workbook_pricing = extract_pricing(pricing_rows)
    supplement_pricing = read_pricing_supplement()
    pricing = workbook_pricing + supplement_pricing
    locations = extract_location_factors(legend_rows)
    rules = capital_planning_rules()

    if len(workbook_pricing) != rules["expected_counts"]["workbook_uniformat_pricing_rows"]:
        raise SystemExit(
            "Expected "
            f"{rules['expected_counts']['workbook_uniformat_pricing_rows']} workbook "
            f"pricing rows, got {len(workbook_pricing)}"
        )
    if len(supplement_pricing) != rules["expected_counts"]["supplement_uniformat_pricing_rows"]:
        raise SystemExit(
            "Expected "
            f"{rules['expected_counts']['supplement_uniformat_pricing_rows']} supplement "
            f"pricing rows, got {len(supplement_pricing)}"
        )
    if len(locations) != rules["expected_counts"]["location_factor_rows"]:
        raise SystemExit(
            f"Expected {rules['expected_counts']['location_factor_rows']} location rows, got {len(locations)}"
        )

    ids = [row["Uni-Format Pricing ID"] for row in pricing]
    if len(ids) != len(set(ids)):
        raise SystemExit("Duplicate Uni-Format Pricing IDs in extracted catalogue")

    return {
        "uniformat_pricing.csv": render_csv(
            "uniformat_pricing.csv",
            PRICING_FIELDS,
            pricing,
        ),
        "location_factors.csv": render_csv(
            "location_factors.csv",
            [
                "province",
                "city",
                "material_index",
                "installation_index",
                "total_index",
                "factor",
            ],
            locations,
        ),
        "capital_planning_rules.json": render_json(rules),
    }


def build_outputs() -> dict[str, str]:
    texts = render_outputs()
    OUT_PRICING.parent.mkdir(parents=True, exist_ok=True)
    path_by_name = {
        "uniformat_pricing.csv": OUT_PRICING,
        "location_factors.csv": OUT_LOCATION,
        "capital_planning_rules.json": OUT_RULES,
    }
    return {name: write_text(path_by_name[name], text) for name, text in texts.items()}


def check_outputs(expected_hashes: dict[str, str] | None = None) -> None:
    required = [OUT_PRICING, OUT_LOCATION, OUT_RULES]
    for path in required:
        if not path.exists():
            raise SystemExit(f"Missing generated file: {path}")

    current = {
        "uniformat_pricing.csv": sha256_file(OUT_PRICING),
        "location_factors.csv": sha256_file(OUT_LOCATION),
        "capital_planning_rules.json": sha256_file(OUT_RULES),
    }
    rendered = render_outputs()
    rebuilt = {name: sha256_text(text) for name, text in rendered.items()}
    mismatches = [
        name for name, digest in rebuilt.items() if current[name] != digest
    ]
    if mismatches:
        raise SystemExit(
            "Generated reference files are out of date or drifted: "
            + ", ".join(mismatches)
            + ". Re-run scripts/extract-bca-reference-data.py"
        )
    if expected_hashes:
        for name, digest in expected_hashes.items():
            if rebuilt.get(name) != digest:
                raise SystemExit(f"Hash mismatch for {name}")
    print("OK: extracted BCA reference data matches workbook formulas and file hashes")
    for name, digest in rebuilt.items():
        print(f"  {name}: {digest}")


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--check",
        action="store_true",
        help="Verify generated data/ files match a fresh extraction (read-only)",
    )
    args = parser.parse_args(argv)
    if args.check:
        check_outputs()
        return 0
    hashes = build_outputs()
    print("Wrote BCA reference data:")
    for name, digest in hashes.items():
        print(f"  {name}: {digest}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
