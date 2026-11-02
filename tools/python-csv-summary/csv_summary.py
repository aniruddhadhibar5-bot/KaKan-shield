#!/usr/bin/env python3
"""Summarize a client CSV locally without uploading or storing its contents."""

import argparse
import csv
import json
import re
import sys
from pathlib import Path
from typing import Any

MAX_FILE_BYTES = 5 * 1024 * 1024
MAX_DATA_ROWS = 100_000
csv.field_size_limit(MAX_FILE_BYTES)
EMAIL_PATTERN = re.compile(r"^[^\s@]+@[^\s@]+\.[^\s@]+$")
EMAIL_HEADER_PATTERN = re.compile(r"e.?mail", re.IGNORECASE)
COMPANY_HEADER_PATTERN = re.compile(
    r"client|company|customer|account|organization|business.?name",
    re.IGNORECASE,
)


def analyze_csv(file_path: Path) -> dict[str, Any]:
    if file_path.stat().st_size > MAX_FILE_BYTES:
        raise ValueError("CSV exceeds the 5 MiB file-size limit.")

    try:
        with file_path.open("r", encoding="utf-8-sig", newline="") as source:
            reader = csv.reader(source, strict=True)
            headers = next(reader, None)
            if not headers:
                raise ValueError("CSV contains no header row.")

            email_index = next(
                (index for index, value in enumerate(headers) if EMAIL_HEADER_PATTERN.search(value)),
                None,
            )
            company_index = next(
                (index for index, value in enumerate(headers) if COMPANY_HEADER_PATTERN.search(value)),
                None,
            )
            records = 0
            incomplete_rows = 0
            emails: set[str] = set()
            companies: set[str] = set()

            for row in reader:
                if not any(value.strip() for value in row):
                    continue
                records += 1
                if records > MAX_DATA_ROWS:
                    raise ValueError(f"CSV exceeds the {MAX_DATA_ROWS:,} data-row limit.")
                if len(row) != len(headers) or any(
                    index >= len(row) or not row[index].strip()
                    for index in range(len(headers))
                ):
                    incomplete_rows += 1

                if email_index is not None and email_index < len(row):
                    email = row[email_index].strip().lower()
                    if EMAIL_PATTERN.fullmatch(email):
                        emails.add(email)
                if company_index is not None and company_index < len(row):
                    company = row[company_index].strip().casefold()
                    if company:
                        companies.add(company)

    except UnicodeDecodeError as error:
        raise ValueError("CSV must be encoded as UTF-8.") from error
    except csv.Error as error:
        raise ValueError(f"CSV contains malformed quoted fields: {error}") from error

    return {
        "file": file_path.name,
        "data_rows": records,
        "columns": len(headers),
        "unique_email_contacts": len(emails),
        "unique_company_names": len(companies),
        "complete_rows_percent": (
            round((records - incomplete_rows) / records * 100) if records else 0
        ),
    }


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Summarize client CSVs locally; file contents are never uploaded."
    )
    parser.add_argument("csv_file", type=Path, help="path to a UTF-8 CSV file")
    args = parser.parse_args()

    try:
        result = analyze_csv(args.csv_file)
    except (OSError, ValueError) as error:
        print(f"CSV summary failed: {error}", file=sys.stderr)
        return 1

    print(json.dumps(result, indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
